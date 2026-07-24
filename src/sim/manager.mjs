// ============================================================================
// 監督ポリシー（フェーズA S2 / §S2 / 設計原則「采配はすべて監督ポリシー経由」）
//
// 采配・起用の判断ロジックをここに集約する（game.mjs は状態機械と記録に徹する）。
// フェーズCで人間の采配に差し替えるフックとなるため、各関数は
// 「状況（試合状態のビュー）→ 判断（確率 or 起用対象）」の純粋関数として書く。
//
// 三層構造の原則（req: 起用AIが trueAbility を直接見てよいのは編成の初期値のみ）:
//   - 打者の強弱判断 = 観測statline（observedWoba: 生カウント＋リーグ平均への回帰）
//   - 交代候補の序列 = buildPregameEval（試合開始時に固めた「監督の当日メモ」＝編成時評価）
//   - 左右（bats/throws）は公開情報として参照してよい
// シーズン中のレギュラー見直しは S3 usage.mjs（観測＋スカウトノイズ）が担う。
// ============================================================================
import { logit, expit, ratingDelta } from './rates.mjs';
import { rawRunValuePerPA, LINEAR_WEIGHTS } from './leagueConstants.mjs';
import { isSameHand } from '../model/player.mjs';
import { FIELD_POSITIONS } from '../model/positions.mjs';
import { hitScore } from './team.mjs';
import { rangeRating } from './fielding.mjs';

/** 中立の監督プロファイル（未指定時の既定。生成は generate.generateManager） */
export function neutralManager() {
  return { buntTend: 50, stealTend: 50, ibbTend: 50, quickHook: 50 };
}

/**
 * 観測wOBA（インゲーム判断用の近似）。観測statlineの生カウントから
 * 得点価値/PA を出し、少打席はリーグ平均へ回帰させる（config.tuning.mgr）。
 * リーグ定数導出（2パス目）前でも使えるよう wobaScale は簡易ノブで代用。
 */
export function observedWoba(batLine, cfg) {
  const m = cfg.tuning.mgr;
  const raw = rawRunValuePerPA(batLine, LINEAR_WEIGHTS) * m.wobaScale;
  const pa = batLine.pa || 0;
  return (raw * pa + m.wobaPrior * m.wobaPriorPA) / (pa + m.wobaPriorPA);
}

/**
 * 試合開始時の「監督の当日メモ」（編成時評価＝trueAbility 参照はここまで）。
 * 以降のインゲーム判断（代打/代走/守備固め）はこのメモと観測statlineのみを見る。
 * @returns {Map<string,{hit:number,speed:number,def:Object}>}
 */
export function buildPregameEval(byId, cfg) {
  const d = cfg.tuning.depth;
  const m = new Map();
  for (const [pid, p] of byId) {
    const def = {};
    const range = rangeRating(p, cfg);
    for (const pos of FIELD_POSITIONS) {
      def[pos] = p.trueAbility.fielding.positionProf[pos] + d.posToolW * (range - 50);
    }
    m.set(pid, { hit: hitScore(p), speed: p.trueAbility.common.speed, def });
  }
  return m;
}

/** 側オブジェクトから未使用・未退場のブルペン投手を返す（可用リスト前提・§S2-7） */
export function availableRelievers(side) {
  return side.bullpen.filter((pid) => !side.usedPitchers.has(pid) && !side.retired.has(pid));
}

// --- RE（得点期待値）表 §tactics_re -------------------------------------------
//
// 「監督の頭の中のRE表」（cfg.tuning.tactics.reTable・24状態=塁8×アウト3・導出手順は
// config.mjs のコメント参照）を使い、バント/敬遠/盗塁の戦術判断をRE比較で駆動する。
// index式は context.mjs の ctxReIndex (outs*8+base) と完全に一致させる（import循環回避の
// ため自前定義。test/tactics_re.test.mjs で context.deriveTables の実測と近似一致を検証）。

/** RE表のインデックス（塁ビット0..7 × アウト0..2）。context.mjs ctxReIndex と同一式。 */
function tacticsReIndex(base, outs) {
  return outs * 8 + base;
}

/** RE表から値を引く（範囲外アウト=3アウト後=回終了はRE0として扱う）。 */
function reAt(reTable, base, outs) {
  if (outs >= 3) return 0;
  return reTable[tacticsReIndex(base, outs)] ?? 0;
}

/** situ.bases（[1B,2B,3B]の走者id/null配列）→ 塁状況ビット（game.mjs baseBits と同一規則）。 */
export function tacticsBaseBits(bases) {
  return (bases[0] ? 1 : 0) | (bases[1] ? 2 : 0) | (bases[2] ? 4 : 0);
}

/**
 * 犠打3遷移（成功/失敗/内野安打）後の塁状況ビットを、resolveBunt（sim/game.mjs）の実挙動と
 * 一致させて返す。バント局面は三塁走者なし=bits∈{1,2,3}のみ（buntAttemptProbの成立条件で保証）。
 *   成功: 全走者が1つずつ進塁・打者アウト（resolveBuntのsuccessProb分岐と一致）
 *   失敗: R1がいればフォースで先頭の強制走者アウト・打者は一塁生還（FC）。R2単独はフォース
 *     不成立＝打者が普通にアウトになるだけで走者は動かない（resolveBuntのfailProb分岐と一致）
 *   内野安打: 全走者1つ進塁＋打者一塁（resolveBuntのhitProb分岐と一致）
 * export: test/tactics_re.test.mjs が resolveBunt（sim/game.mjs）の実挙動と突き合わせて検証する。
 */
export function buntTransitionBits(bits) {
  const success = bits === 1 ? 2 : bits === 2 ? 4 : bits === 3 ? 6 : bits;
  const fail = bits === 1 ? 1 : bits === 2 ? 2 : bits === 3 ? 3 : bits;
  const hit = bits === 1 ? 3 : bits === 2 ? 5 : bits === 3 ? 7 : bits;
  return { success, fail, hit };
}

/**
 * 犠打のRE比較 decisionScore（§tactics_re タスク2）。正で「送った方が得点期待価値が高い」。
 * gate系（2死/強打者/投手打席/大差 等）は buntAttemptProb 側で処理済みの生の値＝テスト用に公開。
 *   ΔRE_bunt = Σ_outcome prob×[RE(遷移先) − RE(now)]（resolveBuntの遷移と一致・buntTransitionBits）
 *   ΔRE_swing = (batterWoba−wobaPrior)/wobaScale相当（打者が打席に立つ場合の期待run価値の近似）
 *   nextAdj  = (nextBatterWoba−wobaPrior)/wobaScale相当 × nextBatterW（次打者へ渡す得点圏の価値。
 *     nextIsPitcherはこの項で自然に強い減点になる＝投手の観測wOBAは極端に低い）
 * @param {number} bits 現在の塁状況ビット（1=1B,2=2B,4=3B）
 * @param {number} outs 現在アウト数（0 or 1）
 * @param {number} batterWoba 打者の観測wOBA
 * @param {number} nextBatterWoba 次打者の観測wOBA
 */
export function buntDecisionScore(bits, outs, batterWoba, nextBatterWoba, cfg) {
  const t = cfg.tuning.bunt;
  const m = cfg.tuning.mgr;
  const reTable = cfg.tuning.tactics.reTable;
  const reNow = reAt(reTable, bits, outs);
  const trans = buntTransitionBits(bits);
  const dReBunt =
    t.successProb * (reAt(reTable, trans.success, outs + 1) - reNow) +
    t.failProb * (reAt(reTable, trans.fail, outs + 1) - reNow) +
    t.hitProb * (reAt(reTable, trans.hit, outs) - reNow);
  const dReSwing = (batterWoba - m.wobaPrior) / m.wobaScale;
  const nextAdj = ((nextBatterWoba - m.wobaPrior) / m.wobaScale) * t.nextBatterW;
  return dReBunt - dReSwing + nextAdj;
}

// --- 盗塁の采配ゲート（§S2-6） ----------------------------------------------

/**
 * 盗塁試行への監督ゲート（logit加算値）。stealTend の個性＋状況ゲート:
 * 大差（±gateBigDiff以上）では走らない / 2死×強打者では自重 / §tactics_re タスク3:
 * 損益分岐サニティゲート＝推定成功率(situ.estSuccessProb)がRE損益分岐を大きく下回れば自重
 * （breakeven = [RE(now)−RE(失敗後)] / [RE(成功後)−RE(失敗後)]。盗塁の試行/成否モデル自体は
 * 全面置換しない＝発現帯を壊さない追加のロジット減点のみ）。
 */
export function stealLogitAdjust(manager, situ, cfg) {
  const s = cfg.tuning.steal;
  let adj = ratingDelta(manager.stealTend, s.tendW);
  if (Math.abs(situ.scoreDiff) >= s.gateBigDiff) adj -= s.gateBigDiffLogit;
  if (situ.outs === 2 && situ.batterWoba >= cfg.tuning.ibb.strongBatterWoba) adj -= s.gateStrong2OutLogit;
  if (situ.estSuccessProb != null) {
    const reTable = cfg.tuning.tactics.reTable;
    const reNow = reAt(reTable, 1, situ.outs); // 一塁走者のみ（盗塁の成立条件）
    const reSucc = reAt(reTable, 2, situ.outs); // 成功=二塁へ
    const reFail = reAt(reTable, 0, situ.outs + 1); // 失敗=走者アウト・アウト+1
    const denom = reSucc - reFail;
    if (denom > 0) {
      const breakeven = (reNow - reFail) / denom;
      const gap = breakeven - situ.estSuccessProb - s.breakevenGapGate;
      if (gap > 0) adj -= s.breakevenLogit * gap;
    }
  }
  return adj;
}

// --- 犠打（§S2-4） -----------------------------------------------------------

/**
 * 犠打の試行確率。局面不成立（2死/三塁走者あり/走者なし）は0。
 * 投手打席はほぼ必ずバント。野手は接戦×非強打者（観測wOBA）×監督buntTend×RE比較（§tactics_re）。
 * 采配妥当性の保険ゲート（原則②・ユーザー指摘 2026-07-23「一死二塁で投手の前の打者が送りバント」）:
 *   - 一死×二塁単独: 野手には送らせない。成功しても二死三塁でほぼ常に得点期待の損＝実NPBでも
 *     まず見ない采配。無死二塁は従来どおり許可。投手打席は従来どおり。
 *   - 次打者が投手: 野手には送らせない（「投手の前の8番に送らせる」悪手の根絶）。
 *   両ゲートとも buntDecisionScore のRE比較だけで自然に負（送らない）へ寄ることを
 *   test/tactics_re.test.mjs で検証済み＝ここでは計算コスト削減と保険を兼ねた明示的早期returnとして残す。
 */
export function buntAttemptProb(situ, cfg) {
  const t = cfg.tuning.bunt;
  if (situ.outs >= 2) return 0;
  if (situ.bases[2] || (!situ.bases[0] && !situ.bases[1])) return 0; // 走者1B/2B×三塁空きのみ
  if (situ.isPitcher) {
    // 投手は野手より広い点差でバントするが、大差では打たせる（点差ゲートを先に評価）
    return Math.abs(situ.scoreDiff) > t.pitcherMaxScoreDiff ? 0 : t.pitcherAttempt;
  }
  if (!situ.bases[0] && situ.bases[1] && situ.outs >= 1) return 0; // 一死×二塁単独（保険ゲート・上記）
  if (situ.nextIsPitcher) return 0; // 次打者が投手（保険ゲート・上記）
  if (Math.abs(situ.scoreDiff) > t.maxScoreDiff) return 0;
  if (situ.batterWoba >= t.weakBatterWoba) return 0; // 強打者にはバントさせない
  const bits = tacticsBaseBits(situ.bases);
  const nextWoba = situ.nextBatterWoba ?? cfg.tuning.mgr.wobaPrior;
  const decisionScore = buntDecisionScore(bits, situ.outs, situ.batterWoba, nextWoba, cfg);
  return expit(
    logit(t.attemptBase) + t.reScale * decisionScore + t.npbBias + ratingDelta(situ.manager.buntTend, t.tendW),
  );
}

// --- 敬遠（§S2-5） -----------------------------------------------------------

/**
 * 敬遠の実施確率（守備側監督の判断）。一塁空き×一死or二死×終盤接戦×
 * （強打者 or 次打者が投手）でのみ正の値。
 * §tactics_re タスク3: RE損益のサニティゲート（軽量・既存条件は維持）。IBBは常にRE損
 * （走者を無償で増やす＝一塁を歩かせて埋める＝この関数の成立条件上つねに満塁化を伴う）。
 * ibbMaxReLoss はこのRE損の異常値だけを弾く保険（通常の較正済み運用では作動しない・
 * config.mjs のコメント参照）。既存の強打者/終盤接戦などの条件は維持。
 */
export function ibbProb(situ, cfg) {
  const t = cfg.tuning.ibb;
  if (situ.inning < t.minInning) return 0;
  if (situ.outs < 1) return 0; // 一死or二死のみ
  if (situ.bases[0]) return 0; // 一塁空きのみ
  if (!situ.bases[1] && !situ.bases[2]) return 0; // 得点圏に走者がいる時のみ
  if (Math.abs(situ.scoreDiff) > t.maxScoreDiff) return 0;
  if (!(situ.batterWoba >= t.strongBatterWoba || situ.nextIsPitcher)) return 0;
  const tt = cfg.tuning.tactics;
  const bits = tacticsBaseBits(situ.bases);
  const dRE = reAt(tt.reTable, bits | 1, situ.outs) - reAt(tt.reTable, bits, situ.outs);
  if (dRE > tt.ibbMaxReLoss) return 0; // RE損の異常値のみ禁止（保険）
  return expit(logit(t.base) + ratingDelta(situ.manager.ibbTend, t.tendW));
}

// --- 代打/代走/守備固め（§S2-3） ---------------------------------------------

/**
 * 代打の起用判断。条件成立時、ベンチ最良打者（当日メモ＋プラトーン込み）を返す。
 * - 投手へ: phPitcherInning 以降のビハインド（±phMaxBehind内）or 同点以下の得点機。
 *   次の回に新投手を出せる救援が残っている時のみ。
 * - 野手へ: phInning 以降・同点orビハインド（phMaxBehind内）の得点機で、
 *   実効打力差（プラトーン込みhitScore相当）が phGainMin 以上の時のみ。
 * @returns {?string} 代打のplayerId（起用しないなら null）
 */
export function choosePinchHitter(ctx, cfg) {
  const t = cfg.tuning.sub;
  const side = ctx.side;
  if (!side.bench.length) return null;
  const diff = side.score - ctx.oppScore;
  const risp = !!(ctx.bases[1] || ctx.bases[2]);
  if (ctx.isPitcher) {
    if (ctx.inning < t.phPitcherInning) return null;
    const behind = diff < 0 && -diff <= t.phMaxBehind;
    if (!behind && !(diff <= 0 && risp)) return null;
    if (availableRelievers(side).length === 0) return null; // 次の回の新投手が出せない
  } else {
    if (ctx.inning < t.phInning) return null;
    if (!(diff <= 0 && -diff <= t.phMaxBehind)) return null;
    if (!risp) return null; // 得点機のみ
  }
  // 実効打力 = 当日メモのhitScore − 同利きペナルティ（スイッチは常に有利側=減点なし）
  const eff = (pid) => {
    const e = side.pregame.get(pid);
    return e.hit - (isSameHand(side.byId.get(pid), ctx.oppPitcher) ? t.phPlatoonW : 0);
  };
  let best = null;
  let bestV = -Infinity;
  for (const pid of side.bench) {
    const v = eff(pid);
    if (v > bestV) {
      bestV = v;
      best = pid;
    }
  }
  if (bestV - eff(ctx.batterId) < t.phGainMin) return null;
  return best;
}

/**
 * 代走の起用判断。prInning 以降・prMaxScoreDiff 以内の接戦で、塁上の鈍足走者と
 * ベンチ最速の走力差が prSpeedGainMin 以上なら {baseIdx, pid} を返す。
 * 投手走者は対象外（投手退場が絡むため・DH無し試合）。
 */
export function choosePinchRunner(ctx, cfg) {
  const t = cfg.tuning.sub;
  const side = ctx.side;
  if (!side.bench.length) return null;
  if (ctx.inning < t.prInning) return null;
  if (Math.abs(side.score - ctx.oppScore) > t.prMaxScoreDiff) return null;
  let fast = null;
  let fastSp = -Infinity;
  for (const pid of side.bench) {
    const sp = side.pregame.get(pid).speed;
    if (sp > fastSp) {
      fastSp = sp;
      fast = pid;
    }
  }
  let baseIdx = -1;
  let bestGain = -Infinity;
  for (let i = 0; i < 3; i++) {
    const r = ctx.bases[i];
    if (!r || r === side.curPid) continue;
    const gain = fastSp - side.pregame.get(r).speed;
    if (gain > bestGain) {
      bestGain = gain;
      baseIdx = i;
    }
  }
  if (baseIdx < 0 || bestGain < t.prSpeedGainMin) return null;
  return { baseIdx, pid: fast };
}

/**
 * 守備固めの判断。defInning 以降・リード defLeadMin〜defLeadMax で、
 * 守備最弱ポジ（当日メモの習熟＋素材）にベンチから defGainMin 以上の
 * 上位互換がいる時のみ {pos, pid} を返す。
 */
export function chooseDefensiveSub(ctx, cfg) {
  const t = cfg.tuning.sub;
  const side = ctx.side;
  if (!side.bench.length) return null;
  if (ctx.inning < t.defInning) return null;
  const lead = side.score - ctx.oppScore;
  if (lead < t.defLeadMin || lead > t.defLeadMax) return null;
  let worstPos = null;
  let worstV = Infinity;
  for (const pos of Object.keys(side.defense)) {
    const pid = side.defense[pos];
    if (!pid) continue;
    const v = side.pregame.get(pid).def[pos];
    if (v < worstV) {
      worstV = v;
      worstPos = pos;
    }
  }
  if (!worstPos) return null;
  let best = null;
  let bestV = -Infinity;
  for (const pid of side.bench) {
    const v = side.pregame.get(pid).def[worstPos];
    if (v > bestV) {
      bestV = v;
      best = pid;
    }
  }
  if (!best || bestV - worstV < t.defGainMin) return null;
  return { pos: worstPos, pid: best };
}

/**
 * 負傷退場の代替を選ぶ（R3・§S2-3と同輪）。壊れた選手のポジションを継げるベンチ最良。
 *   守備位置 → その位置の守備評価（pregame.def）が最良 ／ DH → 打撃評価が最良。
 * ベンチが枯れていれば null（＝痛みを押して出場継続。翌日以降に抹消される）。
 * 決定論: 乱数不使用・bench 配列順で安定（同値は先着）。
 */
export function chooseInjuryReplacement(side, pos, cfg) {
  if (!side.bench.length) return null;
  const evalOf = (pid) => {
    const pg = side.pregame.get(pid);
    if (!pg) return -Infinity;
    return pos === 'DH' ? pg.hit : pg.def[pos] ?? -Infinity;
  };
  let best = null;
  let bestV = -Infinity;
  for (const pid of side.bench) {
    const v = evalOf(pid);
    if (v > bestV) {
      bestV = v;
      best = pid;
    }
  }
  return best;
}

// --- 継投v2（§S2-7） ---------------------------------------------------------

/** 先発の球数上限（スタミナ×監督quickHook。高quickHookほど早く代える） */
export function starterPitchLimit(manager, pitcher, cfg) {
  const pen = cfg.tuning.pen;
  return (
    pen.starterPitchBase +
    pitcher.trueAbility.pitching.stamina * pen.starterPitchStamW -
    (manager.quickHook - 50) * pen.quickHookW
  );
}

/**
 * レバレッジ代理（LI近似・§8.3 D4）。回・点差・走者/アウトから接戦度を合成した状態の純関数。
 *   pass1（LI表導出前）と pass2（加算）で同値＝救援選択が両パスで一致＝WPA telescoping を壊さない
 *   （経験的LI表は pass1 に存在しないため使えない。代理LIは状態のみから算出＝決定論）。
 *   概ねリーグ平均≈1.0・終盤×接戦×走者ありで上昇。高レバレッジ閾値は pen.highLevThreshold。
 * @param {number} inning 回 / @param {number} lead 投手側リード（負=ビハインド）
 * @param {number} baseBits 走者ビット（1=1B,2=2B,4=3B） / @param {number} outs アウト数
 */
export function leverageProxy(inning, lead, baseBits, outs, pen) {
  const inn = Math.min(inning, pen.levInningCap);
  const inningW = 1 + Math.max(0, inn - pen.levInningPivot) * pen.levInningSlope;
  const closeW = Math.exp(-Math.abs(lead) / pen.levCloseScale); // 同点=1.0・離れるほど指数減衰
  const onBase = (baseBits & 1 ? 1 : 0) + (baseBits & 2 ? 1 : 0) + (baseBits & 4 ? 1 : 0);
  const risp = baseBits & 6 ? 1 : 0;
  const baseOutW = Math.max(0, 1 + pen.levRunnerW * onBase + pen.levRispW * risp - pen.levOutW * outs);
  return inningW * closeW * baseOutW;
}

/**
 * 状況→レバレッジ駆動の救援選択（§S2-7＋§8.3 D4）。可用リスト（連投制限等でフィルタ済み・S3）のみ使用。
 *   セーブ機会（9回以降=closer / 8回=setup8 / 7回=setup7）は従来の役割固定を基本とし、SV/HLD分布を維持。
 *   ただし走者を背負った火消し等の高レバレッジ局面では最良のセットアッパーを投入（LI駆動＝§8.3の完成）。
 *   同点・僅差ビハインドの高レバレッジ終盤も middle でなく勝ちパターン救援へ（好救援が高LIに集まり
 *   gmLI/WPA が質と相関＝「WARは平凡だがWPA抜群のセットアッパー」）。払底時は middle(B級)へフォールスルー
 *   （＝薄いブルペンが接戦でB級を高LIに晒す・WAR予測を下回る構造）。closer は温存し SV を守る。
 * @param {{baseBits?:number, outs?:number}} [situ] 現局面の走者/アウト（省略時=走者なし0死＝回頭）。
 * @returns {?string} 登板させる投手id（適任なし=現投手続投なら null）
 */
export function chooseReliever(side, statFor, inning, lead, cfg, situ) {
  const pen = cfg.tuning.pen;
  const avail = availableRelievers(side);
  if (!avail.length) return null;
  const r = side.roles;
  const has = (pid) => pid != null && avail.includes(pid);
  const saveSitu = lead >= 1 && lead <= pen.saveLeadMax;
  const lev = leverageProxy(inning, lead, situ?.baseBits ?? 0, situ?.outs ?? 0, pen);
  const highLev = lev >= pen.highLevThreshold;
  // 勝ちパターン序列を質順（bullpen配列=relieverScore降順）で best-first に返す（最良救援の投入）。
  const bestCorps = (ids) => {
    for (const pid of side.bullpen) if (ids.includes(pid) && has(pid)) return pid;
    return null;
  };

  if (saveSitu && inning >= 9) {
    if (has(r.closer)) return r.closer;
    return avail[0]; // 抑え不在: 序列最上位（bullpenはrelieverScore順）
  }
  if (saveSitu && (inning === 8 || inning === 7)) {
    // 高レバレッジのセーブ機会（走者を背負った火消し）は最良のセットアッパーを投入（LI駆動・§8.3）。
    // 回頭（走者なし）の通常セーブ機会は回固定（8→setup8 / 7→setup7）＝HLD分布を維持。
    if (highLev) {
      const best = bestCorps([r.setup8, r.setup7]);
      if (best) return best;
    }
    if (inning === 8) {
      if (has(r.setup8)) return r.setup8;
      return avail.find((pid) => pid !== r.closer) ?? null; // closerは9回のセーブ機会に温存
    }
    if (has(r.setup7)) return r.setup7;
    return avail.find((pid) => pid !== r.closer && pid !== r.setup8) ?? avail.find((pid) => pid !== r.closer) ?? null;
  }
  // 高レバレッジの非セーブ終盤（同点・僅差ビハインド）: middle でなく勝ちパターン救援へ（§8.3 D4）。
  if (!saveSitu && highLev && inning >= pen.leverageMinInning && lead > -pen.bigBehind) {
    const best = bestCorps([r.setup8, r.setup7]);
    if (best) return best;
  }
  if (lead <= -pen.bigBehind && has(r.long)) return r.long; // 敗戦処理

  // その他（僅差ビハインド・同点・大差リード等）: middle を負荷分散。
  // closer/setup8 に加え setup7 も温存（7回接戦の役割登板と兼務させると登板数王が
  // 70台へ膨らむため・S5較正。middle が尽きた時のみ setup7→closer 以外の順で繰り上げ）。
  let pool = avail.filter((pid) => pid !== r.closer && pid !== r.setup8 && pid !== r.setup7);
  if (!pool.length) pool = avail.filter((pid) => pid !== r.closer && pid !== r.setup8);
  if (!pool.length) pool = avail.filter((pid) => pid !== r.closer);
  if (!pool.length) return null; // closerしか残っていない → 現投手続投
  // 負荷分散はG(登板数)基準・同数ならouts（S5較正: outs基準だと細切れ登板の投手に
  // 登板数が偏り登板数王が70台へ膨らむ。Gを均せば45-65へ収まる）
  let best = null;
  let bestG = Infinity;
  let bestOuts = Infinity;
  for (const pid of pool) {
    const p = statFor(pid, side.teamId).pitching;
    const g = p.g ?? 0;
    if (g < bestG || (g === bestG && p.outs < bestOuts)) {
      bestG = g;
      bestOuts = p.outs;
      best = pid;
    }
  }
  return best;
}

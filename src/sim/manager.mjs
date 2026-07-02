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

// --- 盗塁の采配ゲート（§S2-6） ----------------------------------------------

/**
 * 盗塁試行への監督ゲート（logit加算値）。stealTend の個性＋状況ゲート:
 * 大差（±gateBigDiff以上）では走らない / 2死×強打者では自重。
 */
export function stealLogitAdjust(manager, situ, cfg) {
  const s = cfg.tuning.steal;
  let adj = ratingDelta(manager.stealTend, s.tendW);
  if (Math.abs(situ.scoreDiff) >= s.gateBigDiff) adj -= s.gateBigDiffLogit;
  if (situ.outs === 2 && situ.batterWoba >= cfg.tuning.ibb.strongBatterWoba) adj -= s.gateStrong2OutLogit;
  return adj;
}

// --- 犠打（§S2-4） -----------------------------------------------------------

/**
 * 犠打の試行確率。局面不成立（2死/三塁走者あり/走者なし）は0。
 * 投手打席はほぼ必ずバント。野手は接戦×非強打者（観測wOBA）×監督buntTend。
 */
export function buntAttemptProb(situ, cfg) {
  const t = cfg.tuning.bunt;
  if (situ.outs >= 2) return 0;
  if (situ.bases[2] || (!situ.bases[0] && !situ.bases[1])) return 0; // 走者1B/2B×三塁空きのみ
  if (situ.isPitcher) return t.pitcherAttempt;
  if (Math.abs(situ.scoreDiff) > t.maxScoreDiff) return 0;
  if (situ.batterWoba >= t.weakBatterWoba) return 0; // 強打者にはバントさせない
  return expit(logit(t.attemptBase) + ratingDelta(situ.manager.buntTend, t.tendW));
}

// --- 敬遠（§S2-5） -----------------------------------------------------------

/**
 * 敬遠の実施確率（守備側監督の判断）。一塁空き×一死or二死×終盤接戦×
 * （強打者 or 次打者が投手）でのみ正の値。
 */
export function ibbProb(situ, cfg) {
  const t = cfg.tuning.ibb;
  if (situ.inning < t.minInning) return 0;
  if (situ.outs < 1) return 0; // 一死or二死のみ
  if (situ.bases[0]) return 0; // 一塁空きのみ
  if (!situ.bases[1] && !situ.bases[2]) return 0; // 得点圏に走者がいる時のみ
  if (Math.abs(situ.scoreDiff) > t.maxScoreDiff) return 0;
  if (!(situ.batterWoba >= t.strongBatterWoba || situ.nextIsPitcher)) return 0;
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
 * 状況→役割ベースの救援選択（§S2-7）。可用リスト（連投制限等でフィルタ済み・S3）のみ使用。
 *   9回以降セーブ機会 = closer / 8回 = setup8 / 7回 = setup7 /
 *   大差ビハインド = long（敗戦処理・長め） / その他 = middle をシーズン負荷最少で。
 * closer はセーブ機会（9回以降）にのみ登板させ、僅差以外では温存する。
 * @returns {?string} 登板させる投手id（適任なし=現投手続投なら null）
 */
export function chooseReliever(side, statFor, inning, lead, cfg) {
  const pen = cfg.tuning.pen;
  const avail = availableRelievers(side);
  if (!avail.length) return null;
  const r = side.roles;
  const has = (pid) => pid != null && avail.includes(pid);
  const saveSitu = lead >= 1 && lead <= pen.saveLeadMax;

  if (saveSitu && inning >= 9) {
    if (has(r.closer)) return r.closer;
    return avail[0]; // 抑え不在: 序列最上位（bullpenはrelieverScore順）
  }
  if (saveSitu && inning === 8) {
    if (has(r.setup8)) return r.setup8;
    return avail.find((pid) => pid !== r.closer) ?? null; // closerは9回のセーブ機会に温存
  }
  if (saveSitu && inning === 7) {
    if (has(r.setup7)) return r.setup7;
    return avail.find((pid) => pid !== r.closer && pid !== r.setup8) ?? avail.find((pid) => pid !== r.closer) ?? null;
  }
  if (lead <= -pen.bigBehind && has(r.long)) return r.long; // 敗戦処理

  // その他（僅差ビハインド・同点・大差リード等）: middle を負荷分散。closer/setup8 は温存。
  let pool = avail.filter((pid) => pid !== r.closer && pid !== r.setup8);
  if (!pool.length) pool = avail.filter((pid) => pid !== r.closer);
  if (!pool.length) return null; // closerしか残っていない → 現投手続投
  let best = null;
  let bestOuts = Infinity;
  for (const pid of pool) {
    const o = statFor(pid, side.teamId).pitching.outs;
    if (o < bestOuts) {
      bestOuts = o;
      best = pid;
    }
  }
  return best;
}

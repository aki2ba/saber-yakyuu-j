// ============================================================================
// 日次スタメンAI・疲労管理（フェーズA S3 / §S3-2 / 設計原則「起用はポリシー経由」）
//
// season.mjs から試合ごとに呼ばれる純関数群＋チームごとの起用状態（UsageState）:
//   selectStarter    → 中5日以上のローテ先発を選ぶ（投手可用性）
//   bullpenAvailable → 連投制限（3連投禁止）・前日30球以上をフィルタした救援可用リスト
//   selectLineup     → 休養（捕手は厚め・連続出場で確率↑）、相手先発の利き手プラトーン、
//                      観測ベースの担当（regular/challenger の先発シェア）で当日スタメンを組む。
//                      休養日DHスライド（B-7・tuning.rest.dhSlide）: 休養判定になった野手が
//                      DH予定者より明確に打てるなら、完全ベンチでなくDHへスライドさせる
//                      （守備免除だがバットは残す＝実球団の支配的パターン。捕手は既定で対象外）
//   recordGameUsage  → 出場・登板履歴を更新し、25試合ごとに reviewAssignments を回す
//   reviewAssignments→ 観測成績ベースの見直し: 不振レギュラーの先発頻度が下がり、
//                      好調の控えが「シェア」を上げて徐々に昇格する（急な全交代はしない。
//                      これが「WAR -6 が出ない」仕組みの本体・§S3-2）
//
// 三層構造の原則: シーズン中の見直しは trueAbility を直接見ない。
//   評価 = 観測wOBA（PAで信頼度加重・少PAはリーグ平均へ回帰）
//        ＋ スカウト評価（真値 + scoutSeed 由来の決定論ノイズ。状態作成時に一度だけ固める）
// 初期の担当（regular）とポジション候補（positionRank）だけは編成時評価（S1）を引き継ぐ。
// 采配（試合中の判断）は manager.mjs、ここは「試合前の起用」を担う（フェーズCの差し替えフック）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { observedWoba, buildPregameEval } from './manager.mjs';
import { hitScore } from './team.mjs';
import { rangeRating } from './fielding.mjs';
import { isSameHand } from '../model/player.mjs';
import { POSITION_DIFFICULTY } from '../model/positions.mjs';

/**
 * チームの起用状態を作る（シーズン開始時に1回）。
 * @param {{id:string}} team
 * @param {{dh:Object, noDh:Object}} charts buildDepthChart のDH有/無ペア（byId等は共通）
 */
export function createUsageState(team, charts, cfg, priorPitch = null) {
  const u = cfg.tuning.usage;
  const chart = charts.dh; // byId / positionRank / rotation / bullpen は dh/noDh で共通
  // スカウト打撃評価（真値 + scoutSeed由来の決定論ノイズ。50中心rating相当）: ここで一度だけ固める
  const scoutEval = new Map();
  for (const [pid, p] of chart.byId) {
    if (p.role !== 'fielder') continue;
    const noise = makeRng(hashSeed(p.scoutSeed ?? hashSeed(pid, 'scout'), 'usageScout')).normal(0, u.scoutSd);
    scoutEval.set(pid, hitScore(p) / 4.5 - 50 + noise);
  }
  // 守備の当日メモ（編成時評価と同じ扱い＝manager.buildPregameEval と同輪。S5較正:
  // 見直し/日次起用が打撃観測のみだと「打撃並×守備最悪」の選手が降格されず
  // WAR下限を破る＝守備をwOBA換算で加味してポジション適性を守る）
  const defEval = buildPregameEval(chart.byId, cfg);
  // レンジ評価（S5較正）: 実際の守備run産出（OAA→UZR）は習熟でなく rangeRating に比例する。
  // 習熟主導の defEval だけでは「習熟高×レンジ最悪」のCF/LFが定着し UZR -20級 → WAR-3級を生むため、
  // 50中心のレンジ項を別途持つ（rangeWobaPerPt で換算）。
  // D1-3（三層構造の徹底）: 守備評価も真値の無ノイズ参照をやめ、scoutSeed由来の決定論ノイズを付与。
  //   1選手＝単一のノイズを rangeEval と def[pos] 双方へ一貫適用（球団の守備の読み違えは首尾一貫）。
  //   scoutDefSd=0 なら旧挙動（真値参照）と bit 同一。門番（WAR下限）維持のため小さめのSD。
  const rangeEval = new Map();
  for (const [pid, p] of chart.byId) {
    if (p.role !== 'fielder') continue;
    const dn = u.scoutDefSd
      ? makeRng(hashSeed(p.scoutSeed ?? hashSeed(pid, 'scout'), 'usageDefScout')).normal(0, u.scoutDefSd)
      : 0;
    rangeEval.set(pid, rangeRating(p, cfg) + dn);
    const e = defEval.get(pid); // 同一ノイズを守備習熟評価にも一貫付与（rangeと符号を揃える）
    if (dn && e) for (const pos of Object.keys(e.def)) e.def[pos] += dn;
  }
  // ポジション担当: regular=編成時のスタメン、challenger=見直しで浮上した控え（share=先発シェア）
  const assign = {};
  for (const pos of Object.keys(chart.defense)) {
    assign[pos] = { regular: chart.defense[pos], challenger: null, share: 0 };
  }
  const dhSlot = chart.lineup.find((s) => s.pos === 'DH');
  assign.DH = { regular: dhSlot ? dhSlot.playerId : null, challenger: null, share: 0 };
  return {
    teamId: team.id,
    charts,
    scoutEval,
    defEval,
    rangeEval,
    assign,
    lastSnap: null, // 直近フォーム窓の起点（前回見直し時の観測スナップショット・S5較正）
    games: 0, // 消化試合数（見直しタイマー）
    consecStarts: new Map(), // 野手 pid → 連続先発出場数（休養確率の入力）
    startsByPid: new Map(), // 野手 pid → 先発出場数（較正・検証用）
    startsAtPos: new Map(), // 野手 pid → Map(pos→先発数)（正捕手出場の較正・検証用）
    lastStartDay: new Map(), // 先発投手 pid → 前回先発day
    startDaysByPid: new Map(), // 先発投手 pid → [day,...]（登板間隔の検証用）
    pitchedByDay: new Map(), // 投手 pid → Map(day→球数)（連投制限・前日球数の判定）
    rotIdx: 0, // ローテの次の先発候補index
    // 故障離脱(IL・C2.4/§10.5): pid → その日まで出場不可（day < untilDay で離脱）。
    //   1年目は空＝一切無影響（simulateSeason/1年目ゲームは既存50較正と bit 同一）。
    //   startSeasonRuntime が直前オフの故障(gamesLost)からシーズン開幕時に一度だけ埋める。
    injuredUntil: new Map(),
    // 破綻救援ガード（多年運用・原則2「WAR-6の根絶」の投手版）の"前歴": pid → 前年の観測投手ライン。
    //   前年に破綻水準(RA9)の失点を晒した救援を当年の観測不振とあわせて可用から間引く判定に使う。
    //   1年目は空(null)＝ガード完全不作動＝較正53指標が byte 不変（startYear が2年目以降のみ埋める）。
    priorPitch: priorPitch || null,
  };
}

/**
 * 破綻救援ガード（§S3-2投手可用性・原則2）: 捕手の壊滅ガードと同型の投手版。
 * 「前年の観測失点率(RA9)が破綻水準」という"前歴"があり、かつ「当年も観測で不振を確認」できる
 * 救援を、当日ブルペン可用リストから確率的に外す（連投蓄積を止め、破綻救援のIP膨張＝
 * 投手WARの単調悪化を防ぐ）。三層構造: 真値は一切見ず、前年＋当年の観測失点率のみで判定する。
 * 1年目は priorPitch が空ゆえ全員 前歴なし＝一切作動しない（較正53指標・SV/HLD/登板数王が byte 不変）。
 * 完全排除でなく確率間引きにしてリーグの救援登板分布（登板数王45-65・SV/HLD分布）を壊さない。
 * @returns {boolean} true=当日は可用から外す
 */
function relieverGuardExcludes(state, pid, cfg, getPitch, penRng) {
  const g = cfg.tuning.pen;
  if (!state.priorPitch || !getPitch || !penRng) return false; // 前歴無/配線無（単体テスト等）は不作動
  const prior = state.priorPitch.get(pid);
  if (!prior || prior.bf < g.relieverGuardPriorBF) return false; // 前歴なし/僅少（新人・前年ほぼ未登板）
  const priorRA9 = prior.outs > 0 ? (prior.r * 27) / prior.outs : 0;
  if (priorRA9 < g.relieverGuardPriorRA9) return false; // 前年は破綻水準でない（実績ある救援は守る）
  const cur = getPitch(pid);
  if (!cur || cur.bf < g.relieverGuardCurrBF) return false; // 当年の標本不足＝序盤は干渉しない
  const curRA9 = cur.outs > 0 ? (cur.r * 27) / cur.outs : 0;
  if (curRA9 < g.relieverGuardCurrRA9) return false; // 当年は持ち直している→従来通り起用（バウンスバックを妨げない）
  return penRng.next() < g.relieverGuardExcludeProb;
}

/** 故障離脱中か（day < 復帰日）。injuredUntil が空/未設定（1年目）なら常に false＝既存挙動と bit 同一。 */
export function isInjured(state, pid, day) {
  return (state.injuredUntil?.get(pid) ?? 0) > day;
}

/**
 * 混合評価（§S3-2）: 観測wOBA（回帰込み）を打席数で信頼度加重し、スカウト評価と混合。
 * 真値は直接見ない（観測statline＋scoutSeedノイズのみ）。
 * @param {Function} getBat pid → 観測battingライン（読み取り専用）
 */
export function blendedWoba(state, pid, getBat, cfg) {
  const u = cfg.tuning.usage;
  const b = getBat(pid);
  const obs = observedWoba(b, cfg);
  const w = b.pa / (b.pa + u.trustPA); // PAが積み上がるほど観測を信じる
  const scout = cfg.tuning.mgr.wobaPrior + (state.scoutEval.get(pid) ?? 0) * u.scoutWobaPerPt;
  return w * obs + (1 - w) * scout;
}

/** ポジション守備の wOBA換算加点（S5較正）。DHは守備なし=0。同一ポジション内の比較にのみ使う
 *  （習熟項の絶対値は50中心でないため、ポジションをまたぐ比較には持ち込まない）。
 *  習熟（ポジション適性）＋レンジ（実際のUZR産出に比例する成分・50中心）の2項構成。 */
function defWobaAt(state, pid, pos, cfg) {
  if (pos === 'DH' || !state.defEval) return 0;
  const u = cfg.tuning.usage;
  const e = state.defEval.get(pid);
  if (!e) return 0;
  const range = state.rangeEval ? (state.rangeEval.get(pid) ?? 50) : 50;
  return u.defWobaPerPt * e.def[pos] + u.rangeWobaPerPt * (range - 50);
}

// --- 直近フォーム窓（S5較正・WAR下限>-2.5の門番） --------------------------------
// 累積観測は「好スタート→長い不振」の選手の真の不調を数百打席も隠す（WAR-4級の主因）。
// 見直しは前回スナップショット以降（≈25試合）の観測ウィンドウで評価し、
// 窓の打席が windowMinPA 未満（控え・出場僅少）は従来通り累積を使う。
// （窓のノイズは blendedWoba の trustPA 回帰と share の漸進昇格が受け止める）

/** 打撃ラインの数値カウントだけを複製（スナップショット用。ネストのスプリットは対象外） */
function copyBatCounts(b) {
  const o = {};
  for (const k of Object.keys(b)) if (typeof b[k] === 'number') o[k] = b[k];
  return o;
}

/** 現在の累積 − スナップショット ＝ ウィンドウ観測ライン */
function diffBatCounts(cur, snap) {
  const o = {};
  for (const k of Object.keys(snap)) o[k] = (cur[k] ?? 0) - snap[k];
  return o;
}

/** 当日の先発投手（中 starterRestDays 日以上のローテ投手をローテ順に）。§S3-2投手可用性 */
export function selectStarter(state, day, cfg) {
  const rot = state.charts.dh.rotation;
  const needRest = cfg.tuning.fatigue.starterRestDays;
  let fallback = rot[state.rotIdx % rot.length];
  let fallbackRest = -1;
  for (let k = 0; k < rot.length; k++) {
    const pid = rot[(state.rotIdx + k) % rot.length];
    if (isInjured(state, pid, day)) continue; // 離脱中の先発は飛ばす（次のローテ投手が繰り上がる）
    const last = state.lastStartDay.get(pid);
    const rest = last == null ? Infinity : day - last - 1;
    if (rest >= needRest) return pid;
    if (rest > fallbackRest) {
      fallbackRest = rest;
      fallback = pid;
    }
  }
  // ★R3 代替先発: 故障でローテが枯れると、健康な先発が全員「中6日未満」になる
  //   （ローテ6人から1人抜ければ5人で回さざるを得ない＝構造的に中5日になる）。
  //   旧実装はここで短い中5日の先発を強行していた（登板間隔の不変量を破っていた）。
  //   現実の球団は二軍から先発を上げるか、**ブルペンの長いイニング要員に代役先発させる**。
  //   ゲーム層では IL補充（roster_moves）が二軍から昇格させるが、それが効くまでの隙間と、
  //   farm を持たない sim 層（＝較正の土台）では、ここでブルペンから代役を立てる。
  if (fallbackRest < needRest) {
    const spot = pickSpotStarter(state, day, cfg);
    if (spot) return spot;
  }
  return fallback; // 全員が枯れている（安全弁: 最も休めた投手）
}

/**
 * 代替先発（R3）: 十分に休養したブルペン投手を1人選ぶ（long＝敗戦処理/ロングリリーフを優先）。
 * 連投・前日の球数・離脱を避ける（bullpenAvailable と同じ疲労の物差し）。
 * 決定論: 乱数不使用・bullpen の配列順で安定。
 */
function pickSpotStarter(state, day, cfg) {
  const f = cfg.tuning.fatigue;
  const pen = state.charts.dh.bullpen;
  const roles = state.charts.dh.bullpenRoles ?? {};
  /** restDays 日以内に投げておらず、直近の先発から中6日空いていて、離脱していない投手か。 */
  const rested = (pid, restDays) => {
    if (isInjured(state, pid, day)) return false;
    const last = state.lastStartDay.get(pid);
    if (last != null && day - last - 1 < need(cfg)) return false; // 代役先発の連投も禁止
    const m = state.pitchedByDay.get(pid);
    if (!m) return true;
    for (let d = 1; d <= restDays; d++) if ((m.get(day - d) ?? 0) > 0) return false;
    return true;
  };
  // 1st: long（ロングリリーフ）→ middle（非役割）。勝ちパターン（closer/setup）は崩さない。
  const skip = new Set([roles.closer, roles.setup8, roles.setup7].filter(Boolean));
  const order = [roles.long, ...(roles.middle ?? []), ...pen].filter(Boolean);
  for (const pid of order) {
    if (skip.has(pid)) continue;
    if (rested(pid, f.spotStarterRestDays)) return pid;
  }
  // 2nd: それでも見つからない（故障＋連投でブルペンまで枯れた）＝勝ちパターンも含め、
  //   前日に投げていない健康な投手なら誰でも立てる。ここまでやって初めて「中6日を割る先発」より
  //   代役先発を優先する（登板間隔の不変量を守るのが目的）。
  for (const pid of order) {
    if (rested(pid, 1)) return pid;
  }
  return null;
}

/** 先発の必要休養日数（中6日＝日差6以上なら rest>=starterRestDays）。 */
function need(cfg) {
  return cfg.tuning.fatigue.starterRestDays;
}

/**
 * 救援の可用リスト: 直近 maxConsecDays 日連続登板（=3連投になる）と前日30球以上を除外。§S3-2
 * さらに多年運用では破綻救援ガード（前年＋当年の観測失点率が破綻水準の救援を確率間引き・原則2）を適用。
 * @param {?Function} getPitch pid → 当年の観測投手ライン（読み取り専用・破綻ガード用）
 * @param {?Object} penRng ガードの確率判定用RNG（試合×サイドで独立の階層シード・決定論）
 */
export function bullpenAvailable(state, day, cfg, getPitch, penRng) {
  const f = cfg.tuning.fatigue;
  return state.charts.dh.bullpen.filter((pid) => {
    if (isInjured(state, pid, day)) return false; // 離脱中の救援は可用リストから外す（C2.4）
    const m = state.pitchedByDay.get(pid);
    if (m) {
      if ((m.get(day - 1) ?? 0) >= f.prevDayPitchLimit) return false; // 前日30球以上は不可
      let consec = 0;
      for (let d = 1; d <= f.maxConsecDays; d++) {
        if ((m.get(day - d) ?? 0) > 0) consec++;
        else break;
      }
      if (consec >= f.maxConsecDays) return false; // 2連投まで（3連投禁止）
    }
    // 破綻救援ガード（多年運用・原則2）: 前歴＋当年観測で破綻確認の救援を確率排除。1年目は不作動。
    if (relieverGuardExcludes(state, pid, cfg, getPitch, penRng)) return false;
    return true;
  });
}

/**
 * 当日スタメンを組む（§S3-2）。担当（regular/challengerシェア）→休養→プラトーン入替の順で解決。
 * 捕手はリード面の継続性を優先しプラトーン入替の対象外（休養と見直しのみ）。
 * @param {{day:number, dh:boolean, oppPitcher:?Object, rng:Object, getBat:Function}} ctx
 * @returns {{lineup:Array<{playerId:?string,pos:string}>, bench:string[], rested:string[]}}
 */
export function selectLineup(state, ctx, cfg) {
  const u = cfg.tuning.usage;
  const r = cfg.tuning.rest;
  const ds = r.dhSlide; // 休養日DHスライド（B-7）
  const chart = ctx.dh ? state.charts.dh : state.charts.noDh;
  const byId = chart.byId;
  const fielders = [];
  for (const [pid, p] of byId) if (p.role === 'fielder') fielders.push(pid);

  // 評価（当日メモ）: 混合評価＋相手先発とのプラトーン補正（スイッチは常に有利側=減点なし）
  // ＋守備のwOBA換算（同一ポジション内の比較のみ・S5較正: 守備破綻選手の起用を防ぐ）
  const cache = new Map();
  const baseEval = (pid) => {
    let v = cache.get(pid);
    if (v === undefined) {
      v = blendedWoba(state, pid, ctx.getBat, cfg);
      cache.set(pid, v);
    }
    return v;
  };
  const effEval = (pid, pos) =>
    baseEval(pid) -
    (ctx.oppPitcher && isSameHand(byId.get(pid), ctx.oppPitcher) ? u.platoonWobaPenalty : 0) +
    defWobaAt(state, pid, pos, cfg);

  const used = new Set(); // 今日すでにスタメンへ入れた選手
  const resting = new Set(); // 今日休養させる選手（スタメン候補から外す。代打等ベンチ待機は可）
  // 休養日DHスライド（B-7）候補: (2)の疲労由来の休養のみを積む（(2b)の不振ベンチは含まない＝
  //   打撃不振で外れた選手をDHへ回す動機はない）。DIFFICULTY順で先に処理される守備位置の休養者を
  //   最後に処理するDH位置でスライド判定する（POSITION_DIFFICULTYは常にDHの手前で尽きる）。
  const restDay = new Set();
  // 離脱中(IL)は候補から完全に除外＝担当が離脱なら控え/挑戦者が穴を埋める（C2.4/§10.5・phaseA資産）。
  const excluded = (pid) => used.has(pid) || resting.has(pid) || isInjured(state, pid, ctx.day);
  const today = {}; // pos → 当日スタメン

  const positions = ctx.dh ? [...POSITION_DIFFICULTY, 'DH'] : POSITION_DIFFICULTY;
  for (const pos of positions) {
    const a = state.assign[pos] ?? { regular: null, challenger: null, share: 0 };
    // 候補プール: 守備ポジは編成時 positionRank 上位（守備適性の担保）、DHは全野手
    const pool = pos === 'DH' ? fielders : chart.positionRank[pos].slice(0, u.candidatesPerPos);
    const bestOf = (list) => {
      let best = null;
      let bv = -Infinity;
      for (const pid of list) {
        if (excluded(pid)) continue;
        const v = effEval(pid, pos);
        if (v > bv) {
          bv = v;
          best = pid;
        }
      }
      return best;
    };

    // (1) 担当: challenger は share の頻度で先発（観測ベース見直しの漸進昇格）
    let pid = a.regular != null && !excluded(a.regular) ? a.regular : null;
    if (a.challenger && !excluded(a.challenger) && ctx.rng.next() < a.share) pid = a.challenger;

    // (2) 休養: 捕手は厚めに、連続出場が長いほど確率↑（正捕手100-135試合の機序）
    if (pid != null) {
      const restP =
        (pos === 'C' ? r.catcherRestProb : r.fielderRestProb) + r.streakW * (state.consecStarts.get(pid) ?? 0);
      if (ctx.rng.next() < restP) {
        resting.add(pid);
        // 捕手は既定で対象外（dhSlide.excludeCatcher・正捕手出場帯[100,135]の較正安定を優先）。
        if (!(pos === 'C' && ds.excludeCatcher)) restDay.add(pid);
        pid = null;
      }
    }
    // (2b) 不振ベンチ（S5較正・WAR下限>-2.5の門番）: 観測ベース評価＋レンジ評価（50中心・
    // UZR産出に比例する静的成分）がベンチ水準を割る担当は、見直し(25試合)の周期を待たず
    // 日次でPA蓄積を絞る（打撃崩壊型・レンジ破綻型の双方が数百打席積むのを防ぐ）。
    // 逆に「守備の名手×貧打」はレンジ加点で先発が保たれる（現実のNPBの守備型レギュラー）。
    // 捕手は守備優先の起用が現実につき通常は対象外だが、「壊滅的」水準（catcherDisasterWoba未満＝
    // wRAA最悪級×守備破綻）に限り控えと分担させ、WAR-3級の定着を防ぐ（原則2）。
    if (pid != null) {
      const isC = pos === 'C';
      const benchEval =
        baseEval(pid) + (pos === 'DH' ? 0 : u.rangeWobaPerPt * ((state.rangeEval?.get(pid) ?? 50) - 50));
      const thr = isC ? r.catcherDisasterWoba : r.benchWoba;
      const prob = isC ? r.catcherDisasterBenchProb : r.slumpBenchProb;
      if (benchEval < thr && ctx.rng.next() < prob) {
        resting.add(pid);
        pid = null;
      }
    }

    // (3) 空席の充填: 候補プールの実効評価最良（全滅なら positionRank/全野手から最初の未使用）
    if (pid == null) {
      const all = pos === 'DH' ? fielders : chart.positionRank[pos];
      pid =
        bestOf(pool) ??
        all.find((x) => !excluded(x)) ??
        // F2-2 最終安全弁: 出場登録29人制（野手15人）では休養の集中＋IL重複で候補が尽き得る。
        // 休養は柔らかい希望なので解除して充当（IL相当は最後まで避ける）。スタメン9人を必ず埋め、
        // 候補が残る通常時は一切通らない＝挙動不変。乱数非消費（決定論）。
        all.find((x) => !used.has(x) && !isInjured(state, x, ctx.day)) ??
        all.find((x) => !used.has(x));
      if (pid != null) {
        resting.delete(pid); // 休養解除で先発する場合は rested から外す
        restDay.delete(pid); // 自ポジで再出場が決まった選手はDHスライド候補からも外す（二重起用防止）
      }
    } else if (pos !== 'C' && ctx.oppPitcher && isSameHand(byId.get(pid), ctx.oppPitcher)) {
      // (4) プラトーン: 同利きの担当に対し、実効評価（守備込み）で上回る候補がいれば当日限りの入替
      const alt = bestOf(pool.filter((x) => x !== pid));
      if (alt != null && effEval(alt, pos) - effEval(pid, pos) > u.platoonMargin) pid = alt;
    }

    // (5) 休養日DHスライド（B-7・thyroxin/research/dh_usage_research_20260725.md §2.2・§5）:
    //   実球団の支配的パターン「守備免除だがバットは残す」の近似。今日 restDay 入りした野手の
    //   実効評価（DHとしての当日評価・守備0点固定）が、当日のDH予定者(pid)より gainMin を超えて
    //   明確に上なら、休養者をDHへ・DH予定者をベンチ（休養扱い）へ入替える。決定論（乱数不使用・
    //   全 restDay を effEval で比較し最良を採るだけ）。POSITION_DIFFICULTY→DHの処理順のため、
    //   この時点で restDay には当日の全守備位置の休養者(捕手除く)が出揃っている。
    //   maxConsecStarts ガード（実測で発見・S3較正）: スライドは「守備免除」であって「出場免除」
    //   ではないため、gainMinだけでは連続出場ストリークが途切れず、突出した打力の選手が
    //   1シーズン全143試合に出場し続ける退化ケースが生じうる（実測: 12球団×1seedで2人が143/143
    //   ＝dhSlide無効時139/135から実際に押し上げられたことを確認）。これは「休養AIの発現＝
    //   フル出場の野手がいない」という既存不変量（S3較正の門番）を破る。streakW と同じ
    //   consecStarts（連続出場カウンタ）を再利用し、これがこの値以上の選手はスライド対象から
    //   除外＝その日は素直に完全ベンチへ回し、真の休養を強制する（過剰な新機構を作らず既存の
    //   疲労管理指標を流用・実測で全ケース解消を確認）。
    if (pos === 'DH' && ds.enabled && restDay.size) {
      let bestPid = null;
      let bestV = -Infinity;
      for (const cand of restDay) {
        // used.has: 通常は起こらない防御チェック（自ポジで再出場が決まった選手は上でrestDayから
        //   除去済み）。二重起用（同一選手が2ポジションに入る）を構造的に禁じる最終防波堤。
        if (used.has(cand) || (state.consecStarts.get(cand) ?? 0) >= ds.maxConsecStarts) continue;
        const v = effEval(cand, 'DH');
        if (v > bestV) {
          bestV = v;
          bestPid = cand;
        }
      }
      const curV = pid != null ? effEval(pid, 'DH') : -Infinity;
      if (bestPid != null && bestV - curV > ds.gainMin) {
        if (pid != null) resting.add(pid); // 元のDH予定者は休養(ベンチ)扱いへ
        resting.delete(bestPid);
        restDay.delete(bestPid);
        pid = bestPid;
      }
    }
    used.add(pid);
    today[pos] = pid;
  }

  // 打順の反映。dynamicLineup=ON（実プレイ）なら現代のラインナップ理論で毎試合再構成、
  //   OFF（headless既定＝テスト/較正/realism/前史）なら編成時アーキタイプの打順を守備位置に固定
  //   （＝baselineとbit同一）。守備位置は各エントリ(playerId,pos)へ紐づくため並べ替えは純粋な置換で
  //   安全（initSideはposで投手/守備を解決する）。9番'P'はスロット固定＝投手9番。
  let lineup;
  if (cfg.game?.dynamicLineup) {
    // その日のスタメン9人（noDhは野手8人）を観測ベースの総合打力＋スタイル傾斜で各打順へ配置。
    const batters = [];
    for (const s of chart.lineup) if (s.pos !== 'P') batters.push({ playerId: today[s.pos], pos: s.pos });
    const ordered = orderBattingLineup(state, batters, ctx, cfg);
    let bi = 0;
    lineup = chart.lineup.map((s) => (s.pos === 'P' ? { playerId: null, pos: 'P' } : ordered[bi++]));
  } else {
    // 旧挙動（交代者は同じ打順スロットを引き継ぐ）。9番'P'は initSide が当日先発を充填。
    lineup = chart.lineup.map((s) => ({ playerId: s.pos === 'P' ? null : today[s.pos], pos: s.pos }));
  }
  const inLineup = new Set(lineup.map((s) => s.playerId));
  // 休養者は代打要員としてベンチに残るが、離脱中(IL)は代打にも出せないので除外する（C2.4）。
  const bench = fielders.filter((pid) => !inLineup.has(pid) && !isInjured(state, pid, ctx.day));
  return { lineup, bench, rested: [...resting] };
}

/**
 * 当日スタメンを打順スロットへ配置する（現代のラインナップ理論・§S3-2 打順）。
 * 各打者の「総合打力(ov=blendedWoba・観測＋スカウト)」と「スタイル傾斜（出塁/長打の偏差）」を
 * 観測statlineから算出し（真値非参照＝三層構造）、スロット別重み（cfg.tuning.lineup）で最適配置する。
 *   value(打者,スロット)= ov·ovW[s] + obpTilt·obpW[s] + powTilt·powW[s]
 * スロットを重要度(ovW)降順に貪欲充填 → 最強打者から #2>#4>#1>#5>#3>… の順で座る（決定論・乱数不使用）。
 * スタイル傾斜は少打席ほど 0 へ回帰（w=PA/(PA+trustPA)）＝データの薄い選手は総合打力のみで並ぶ。
 * @param {Array<{playerId:string,pos:string}>} batters その日のスタメン（投手を除く）
 * @returns {Array<{playerId:string,pos:string}>} 打順順に並べ替えたエントリ（先頭=1番）
 */
export function orderBattingLineup(state, batters, ctx, cfg) {
  const L = cfg.tuning.lineup;
  const u = cfg.tuning.usage;
  const byId = state.charts.dh.byId;
  const feat = batters.map(({ playerId, pos }) => {
    const b = ctx.getBat(playerId);
    // 総合打力: 当日評価と揃える（プラトーン減点も反映＝相手先発に対する当日の打力で並べる）
    const platoon =
      ctx.oppPitcher && isSameHand(byId.get(playerId), ctx.oppPitcher) ? u.platoonWobaPenalty : 0;
    const ov = blendedWoba(state, playerId, ctx.getBat, cfg) - platoon;
    // スタイル傾斜（観測・少打席は0へ回帰）: 出塁=OBP偏差 / 長打=ISO(=SLG−AVG)偏差
    const pa = b.pa || 0;
    const w = pa / (pa + u.trustPA);
    const obDen = b.ab + b.bb + b.hbp + b.sf;
    const obp = obDen > 0 ? (b.b1 + b.b2 + b.b3 + b.hr + b.bb + b.hbp) / obDen : L.refOBP;
    const iso = b.ab > 0 ? (b.b2 + 2 * b.b3 + 3 * b.hr) / b.ab : L.refISO;
    return { playerId, pos, ov, obpTilt: w * (obp - L.refOBP), powTilt: w * (iso - L.refISO) };
  });

  const n = feat.length;
  const slots = new Array(n).fill(null);
  const used = new Set();
  // スロットを重要度(ovW)降順に処理（同値は添字昇順で安定）。各スロットへ実効価値最良の未使用打者。
  const bySlotImportance = Array.from({ length: n }, (_, s) => s).sort(
    (a, c) => L.ovW[c] - L.ovW[a] || a - c,
  );
  for (const s of bySlotImportance) {
    let best = -1;
    let bv = -Infinity;
    for (let i = 0; i < n; i++) {
      if (used.has(i)) continue;
      const v = feat[i].ov * L.ovW[s] + feat[i].obpTilt * L.obpW[s] + feat[i].powTilt * L.powW[s];
      if (v > bv) {
        bv = v;
        best = i;
      }
    }
    used.add(best);
    slots[s] = { playerId: feat[best].playerId, pos: feat[best].pos };
  }
  return slots;
}

/**
 * 試合後の起用履歴の更新。ローテ進行・投手の日次球数（S2投手使用ログの接続）・
 * 野手の連続出場/先発数を記録し、reviewInterval 試合ごとに見直しを回す。
 */
export function recordGameUsage(state, { day, starterPid, lineup, pitcherLog }, getBat, cfg) {
  // 先発ローテの進行と登板日の記録
  const rot = state.charts.dh.rotation;
  const ri = rot.indexOf(starterPid);
  if (ri >= 0) state.rotIdx = (ri + 1) % rot.length;
  state.lastStartDay.set(starterPid, day);
  let sd = state.startDaysByPid.get(starterPid);
  if (!sd) {
    sd = [];
    state.startDaysByPid.set(starterPid, sd);
  }
  sd.push(day);

  // 投手の日次球数（連投制限・前日球数の判定材料）
  for (const ap of pitcherLog) {
    let m = state.pitchedByDay.get(ap.pid);
    if (!m) {
      m = new Map();
      state.pitchedByDay.set(ap.pid, m);
    }
    m.set(day, (m.get(day) ?? 0) + ap.pitches);
  }

  // 野手の連続出場・先発数（先発した野手は+1、しなかった野手は0へリセット）
  const started = new Set();
  for (const s of lineup) {
    if (s.pos === 'P' || !s.playerId) continue;
    started.add(s.playerId);
    state.startsByPid.set(s.playerId, (state.startsByPid.get(s.playerId) ?? 0) + 1);
    let mp = state.startsAtPos.get(s.playerId);
    if (!mp) {
      mp = new Map();
      state.startsAtPos.set(s.playerId, mp);
    }
    mp.set(s.pos, (mp.get(s.pos) ?? 0) + 1);
  }
  for (const [pid, p] of state.charts.dh.byId) {
    if (p.role !== 'fielder') continue;
    state.consecStarts.set(pid, started.has(pid) ? (state.consecStarts.get(pid) ?? 0) + 1 : 0);
  }

  // 観測成績ベースの見直し（25試合ごと・§S3-2）
  state.games++;
  if (state.games % cfg.tuning.usage.reviewInterval === 0) reviewAssignments(state, getBat, cfg);
}

/**
 * 観測成績ベースの担当見直し（§S3-2）。ポジションごとに混合評価で候補を再ランクし、
 * swapMargin を超えて上回る候補を challenger としてシェアを漸増（share≥1で完全昇格）。
 * 差が縮めばシェアは減衰する（一時の好不調で振り回されない）。真値は見ない。
 */
export function reviewAssignments(state, getBat, cfg) {
  const u = cfg.tuning.usage;
  const chart = state.charts.dh;
  const fielders = [];
  for (const [pid, p] of chart.byId) if (p.role === 'fielder') fielders.push(pid);
  // 直近フォーム窓: 前回見直し以降の観測で評価（窓PAが少なければ累積へフォールバック）
  const getBatWin = (pid) => {
    const cur = getBat(pid);
    const snap = state.lastSnap ? state.lastSnap.get(pid) : null;
    if (!snap) return cur;
    const win = diffBatCounts(cur, snap);
    return win.pa >= u.windowMinPA ? win : cur;
  };
  const bat = new Map(fielders.map((pid) => [pid, blendedWoba(state, pid, getBatWin, cfg)]));

  const used = new Set();
  for (const pos of [...POSITION_DIFFICULTY, 'DH']) {
    const a = state.assign[pos];
    if (!a) continue;
    // 評価 = 混合打撃評価 + ポジション守備のwOBA換算（同一ポジション内の比較・S5較正）
    const ev = new Map(fielders.map((pid) => [pid, bat.get(pid) + defWobaAt(state, pid, pos, cfg)]));
    const pool = (pos === 'DH' ? fielders : chart.positionRank[pos].slice(0, u.candidatesPerPos)).filter(
      (pid) => !used.has(pid),
    );
    if (!pool.length) continue;
    // レギュラーが他ポジションの担当に取られた（or不在）なら評価最良を新担当に
    if (a.regular == null || used.has(a.regular)) {
      a.regular = pool.reduce((b, pid) => (ev.get(pid) > ev.get(b) ? pid : b));
      a.challenger = null;
      a.share = 0;
      used.add(a.regular);
      continue;
    }
    let top = a.regular;
    for (const pid of pool) if (ev.get(pid) > ev.get(top)) top = pid;
    // 入替マージン: 捕手のみ厚め（リード面の継続性＝正捕手の出場を100-135試合へ保つ・S5較正）
    const margin = pos === 'C' ? u.catcherSwapMargin : u.swapMargin;
    if (top === a.regular || ev.get(top) - ev.get(a.regular) <= margin) {
      // 現状維持: 挑戦者のシェアは減衰（差が消えたら挑戦解消）
      a.share = Math.max(0, a.share - u.promoteStep);
      if (a.share === 0) a.challenger = null;
    } else if (a.challenger === top) {
      a.share += u.promoteStep;
      if (a.share >= 1) {
        // 完全昇格: 不振レギュラーはベンチ（次回見直しから挑戦者になりうる）
        a.regular = top;
        a.challenger = null;
        a.share = 0;
      }
    } else {
      a.challenger = top; // 新挑戦者はシェア漸増から（急な全交代をしない）
      a.share = u.promoteStep;
    }
    used.add(a.regular);
  }

  // スナップショットの更新（次回見直しの直近フォーム窓の起点）
  state.lastSnap = new Map(fielders.map((pid) => [pid, copyBatCounts(getBat(pid))]));
}

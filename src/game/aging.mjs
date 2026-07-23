// ============================================================================
// フェーズC2a: 加齢・成長カーブ（§10.1-10.3 / §12.4）
//
//   applyAging(players, cfg, { seed, yearIndex })
//     … オフシーズン遷移で全選手の trueAbility を1年ぶん動かし、age++ する純関数。
//
// 設計原則（phaseC_spec・厳守）:
//   - エンジンを壊さない: 加齢は「オフシーズンに真値を変える」もの。シーズン内シムは不変。
//     applyAging は 2年目以降の開幕前にだけ呼ばれ、1年目のレギュラーシーズン（＝既存50較正）に
//     一切触れない。
//   - 決定論維持: 乱数は makeRng(hashSeed(seed, ...)) のみ。Date.now/Math.random 禁止。
//     各選手の乱数は id 基準で派生＝適用順に依らず同一結果（順序非依存）。
//   - 三層構造: ここが動かすのは layer1（trueAbility・隠し値）。観測/スカウト表現は UI 側の責務。
//
// モデル（能力ごとに「成長→維持→衰え」の3相・cfg.tuning.aging）:
//   growEnd = peakAge + peakShift       … ここまで毎年 +grow（若手は成長係数 gm で幅を持つ）
//   onset   = peakAge + declineOffset   … ここから毎年 −decline×declineRate×(1+accel×経過年)
//   peakShift/declineOffset を能力タイプで振ることで §10.1 の
//     早落ち（走力/守備初動）・遅くまで残る（パワー）・むしろ伸びる（選球眼）・
//     加齢に強い（制球/技巧/ポジIQ/走塁IQ）を「専用ロジックほぼ無し」で構造から出す。
//   declineRate は個体差（§10.2・generate で球速/走力と相関して既に引かれている）＝
//     速球派だけ早く落ち、技巧派・晩成が"稀に"残る（生存バイアスで鉄人が自動レア化・§10.6）。
//
// H4（phaseH_fun_spec・育成方針・キャンプ）: applyAging に { policies, profiles, playerTeamId }
//   を追加で渡すと、方針が付いた選手だけ curveDelta の「成長」summand に軸グループ単位の
//   (1±δ) を掛ける（aging.profiles.grow 自体は一切書き換えない＝恒久シフト禁止・R7の教訓）。
//   引数省略時は完全に無効（既存呼び出し元・テストは byte 同一の挙動を保つ）。
//
// Q1（thyroxin/research/baseball_game_mechanics_research_20260723.md Q1・信頼度）:
//   cfg.game.usageTrust（既定false・GAME_DEFAULT第7例目）が true のとき、applyAging に
//   { usageStats, teamGames } を渡すと、前季（完了シーズン）の観測statlineから導出した
//   起用の安定度（trust.mjs の usageStabilityOf・純関数・乱数非消費）で年次ドリフトSD倍率が
//   streakyDriftMult と完全同型の挿入点で縮む（安定した起用ほどドリフトが小さい＝
//   「起用の安定が選手に返ってくる」）。driftはゼロ平均なのでSD倍率変更でも平均（curveDelta）は
//   不変＝較正の平均帯は不変（streaky と同じ理屈）。usageStats/フラグ省略時は trustDriftMult=1
//   （既存呼び出し元・テストは byte 同一の挙動を保つ）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { clamp, clampRating } from '../model/util.mjs';
import { isTargetAxis, parsePolicy, resolvePlayerTraining } from './training.mjs';
import { usageStabilityOf } from './trust.mjs';

// H4: 軸グループの列挙とその grow 総和(w)計算を agePlayer の実呼び出し順と一致させるための
//   単一の key 配列（ここを変えたら agePlayer 側のループも必ず同じ配列を参照する＝二重管理禁止）。
const COMMON_KEYS = ['speed', 'arm', 'hands', 'reaction', 'power'];
const BATTING_KEYS = ['ev', 'la', 'pull', 'contact', 'eye', 'vsFastball', 'vsBreaking'];
const PITCH_RATING_KEYS = ['control', 'stamina', 'gbRate', 'hold'];
const FIELDING_KEYS = ['positioningIQ', 'framing', 'blocking'];
const BASERUN_KEYS = ['steal', 'baserunIQ'];

/**
 * 全選手にオフシーズンの加齢を適用する（in-place・決定論・順序非依存）。
 * @param {Array} players generateLeague().players（trueAbility/age を持つ選手配列）
 * @param {Object} cfg createConfig()（cfg.tuning.aging を参照）
 * @param {{seed:number, yearIndex:number, playerTeamId?:string, policies?:Array, profiles?:Map,
 *   usageStats?:Map, teamGames?:number}} o
 *   seed=オフシーズン用階層シード / yearIndex=遷移元の年。
 *   H4: policies=当年ぶんに絞り込み済みの人間介入ログ（{playerId,policy,special}[]）、
 *       profiles=teamId→teamEvalProfile()（省略時はAI自動方針を出さない＝無効化）。
 *   Q1: usageStats=playerId→前季(完了シーズン)の観測statline行（省略時はtrust効果無効）、
 *       teamGames=前季のチーム試合数（usageStabilityOf の分母）。cfg.game.usageTrust が false
 *       なら usageStats を渡していても無視する（フラグゲート）。
 * @returns {Array} players（同一参照。呼び出し側の league.players を直接更新する）
 */
export function applyAging(players, cfg, { seed, yearIndex, playerTeamId, policies, profiles, usageStats, teamGames } = {}) {
  const aging = cfg.tuning.aging;
  const veloPerRating = cfg.tuning.maturity.veloPerRating;
  // H3-1（ムラっ気）: drift SD 倍率。personality が無い（旧経路・テスト直呼び）選手は 1（無効果）。
  const streakyMult = cfg.tuning.personality?.streakyDriftMult ?? 1;
  // Q1（信頼度）: フラグOFF or usageStats省略なら trustSpan=0＝どの選手も trustDriftMult=1
  //   （既存呼び出し元・テストと byte 同一。cfg.game 未設定の旧テスト呼び出しも ?. で安全）。
  const usageTrustOn = !!(cfg.game?.usageTrust && usageStats && teamGames);
  const usageTrustSpan = usageTrustOn ? (cfg.game.usageTrustDriftSpan ?? 0) : 0;
  // H4: 当年ぶんの人間介入ログを playerId→entry の Map へ（policies/profiles どちらも無ければ
  //   trainingCtx=null＝既存呼び出し元と完全に同じ経路を通る＝byte 同一）。
  const policyMap = new Map((policies ?? []).map((e) => [e.playerId, e]));
  const trainingCtx = profiles || policyMap.size ? { policyMap, profiles, playerTeamId, cfg } : null;
  for (const p of players) {
    // 選手ごとの乱数は id 基準で派生 → 配列順・呼び出し順に依らず同一（決定論・順序非依存）。
    const prng = makeRng(hashSeed(seed, 'aging', p.id));
    const streakyDriftMult = p.personality === 'streaky' ? streakyMult : 1;
    // Q1: 安定度が高いほど 1.0 未満へ縮む（1.0−stability×span）。乱数は消費しない（決定論）。
    const trustDriftMult = usageTrustSpan > 0
      ? 1 - usageStabilityOf(usageStats.get(p.id), teamGames) * usageTrustSpan
      : 1;
    const driftMult = streakyDriftMult * trustDriftMult;
    agePlayer(p, prng, aging, veloPerRating, driftMult, trainingCtx);
  }
  return players;
}

/**
 * H4: 選手1人の育成方針を「軸グループ tilt」の実行パラメータへ解決する。
 * 対象グループの grow 総和(target)と全軸の grow 総和(total)から、非対象への相殺係数
 * w=target/(total-target) を出す（対象+δ・非対象-δ·w＝個体レベルで期待成長量の総和を保存）。
 * 'rest' は軸グループを持たず、drift/decline/growの一様な倍率だけを返す。
 * 'balanced'・方針無し・不正な policy 文字列は null（tilt 無効）。
 */
function resolveTrainingForPlayer(p, t, aging, trainingCtx) {
  const { policy, special, source } = resolvePlayerTraining(p, trainingCtx, trainingCtx.cfg);
  if (!policy || policy === 'balanced') return null;
  const parsed = parsePolicy(policy);
  if (!parsed) return null; // 防御的（不正文字列はUI/APIで弾いているはずだが無効化して安全側へ）
  const tc = trainingCtx.cfg.tuning.training;
  if (parsed.kind === 'rest') {
    return {
      parsed, tiltMult: 0, w: 0,
      driftMult: tc.restDriftMult, declineMult: tc.restDeclineMult, growMult: tc.restGrowMult,
    };
  }
  const personalityMult = p.personality === 'hardworking' ? trainingCtx.cfg.tuning.personality.hardworkingTrainingMult : 1;
  const specialMult = special ? tc.specialMult : 1;
  // H4: AI球団の自動方針は人間の明示介入より控えめに効かせる（aiEffectMult）。AI方針は
  //   同一チームの全対象選手へ何年も持続的に乗り続けるため、人間の散発的な指定より
  //   多年運用での累積影響が大きくなりやすい（較正ヘッドルームが薄いことへの安全側の配慮）。
  const aiMult = source === 'ai' ? tc.aiEffectMult : 1;
  const tiltMult = tc.tiltStrength * personalityMult * specialMult * aiMult;
  const { total, target } = trainingGrowSums(t, aging, parsed);
  const nonTarget = total - target;
  const w = nonTarget > 0 ? target / nonTarget : 0;
  return { parsed, tiltMult, w, driftMult: 1, declineMult: 1, growMult: 1 };
}

/** profKey の grow（未登録キーは default）。ageRating の prof 解決と同じフォールバック。 */
function growOf(aging, key) {
  return (aging.profiles[key] ?? aging.profiles.default).grow;
}

/**
 * この選手が持つ「全軸」の grow 総和(total)と、方針の対象グループぶんの grow 総和(target)。
 * agePlayer が実際に age させる軸（COMMON_KEYS/BATTING_KEYS/.../positionProf全ポジション/
 * pitches×4サブ軸）と完全に同じ集合を列挙する（w の正規化がここでズレると期待値保存が崩れる）。
 */
function trainingGrowSums(t, aging, parsed) {
  let total = 0;
  let target = 0;
  const add = (section, key, grow, pos = null) => {
    total += grow;
    if (isTargetAxis(parsed, section, key, pos)) target += grow;
  };
  for (const k of COMMON_KEYS) add('common', k, growOf(aging, k));
  for (const k of BATTING_KEYS) add('batting', k, growOf(aging, k));
  add('pitching', 'velocity', aging.velo.grow);
  for (const k of PITCH_RATING_KEYS) add('pitching', k, growOf(aging, k));
  const pitchGrow = growOf(aging, 'pitchStuff');
  for (let i = 0; i < t.pitching.pitches.length; i++) {
    for (let j = 0; j < 4; j++) add('pitching', 'pitchStuff', pitchGrow);
  }
  for (const k of FIELDING_KEYS) add('fielding', k, growOf(aging, k));
  const posGrow = growOf(aging, 'positionProf');
  for (const pos of Object.keys(t.fielding.positionProf)) add('fielding', 'positionProf', posGrow, pos);
  for (const k of BASERUN_KEYS) add('baserunning', k, growOf(aging, k));
  return { total, target };
}

/** 軸(section,key[,pos])の「成長」summandに掛ける倍率（対象グループ+δ／非対象-δ·w、restは一様growMult）。 */
function trainingGrowMult(training, section, key, pos) {
  const inGroup = isTargetAxis(training.parsed, section, key, pos);
  const base = inGroup ? 1 + training.tiltMult : 1 - training.tiltMult * training.w;
  return Math.max(0, base) * training.growMult;
}

/** 1選手を1年ぶん加齢させる（trueAbility を動かし age++）。 */
function agePlayer(p, prng, aging, veloPerRating, driftMult = 1, trainingCtx = null) {
  const t = p.trueAbility;
  const peak = t.career.peakAge;
  const dr = t.career.declineRate;
  const age = p.age;
  const young = age < aging.youngAge;

  // §10.3 成長は「点でなく幅で」: 若手は選手ごとの成長係数 gm を引く（高分散・bust厚め）。
  //   gm<0 まで振れれば真値が退行（TINSTAAPP＝有望株が凡庸に終わる）。ベテランは gm=1（幅なし）。
  let gm = 1;
  if (young) {
    gm = 1 + prng.normal(0, aging.growthVarYoung);
    if (prng.chance(aging.bustProb)) gm -= aging.bustMag; // 伸び悩み（下方の裾を厚く）
    gm = clamp(gm, aging.growthMultMin, aging.growthMultMax);
  }

  // R7（決定1・draft_timeline_evidence）: 高卒新人の「期限付き未成熟負債」の返済。generateRookie が
  //   積んだ負債（career.youthDebt<0）を毎年 youthDebtRepayPerYear ずつ全軸へ均等に足し戻す＝
  //   一時的な弱さが数年で自然に解消する（aging.profiles を動かす方式と違い、初期ロスター生成には
  //   一切影響しない＝1年目較正・多年ドリフト帯を破らない）。
  const debt = t.career.youthDebt ?? 0;
  let flatBonus = 0;
  if (debt < 0) {
    const repay = Math.min(-debt, aging.youthDebtRepayPerYear ?? 0);
    flatBonus = repay;
    t.career.youthDebt = debt + repay;
  }

  // H4（育成方針・キャンプ）: 方針が無ければ training=null＝下の curveDelta は従来と byte 同一。
  const training = trainingCtx ? resolveTrainingForPlayer(p, t, aging, trainingCtx) : null;
  const finalDriftMult = driftMult * (training?.driftMult ?? 1);

  const ctx = { age, peak, dr, gm, young, prng, aging, flatBonus, veloPerRating, driftMult: finalDriftMult, training };

  // 共通素材（§2.2）
  for (const k of COMMON_KEYS) ageRating(t.common, k, k, ctx, { section: 'common', key: k, pos: null });

  // 打撃（§2.3）
  for (const k of BATTING_KEYS) ageRating(t.batting, k, k, ctx, { section: 'batting', key: k, pos: null });

  // 投手（§2.4）: 球速は別枠モデル、それ以外はレーティング機構、球種は技巧扱い。
  ageVelocity(t.pitching, ctx);
  for (const k of PITCH_RATING_KEYS) ageRating(t.pitching, k, k, ctx, { section: 'pitching', key: k, pos: null });
  for (const pitch of t.pitching.pitches) agePitch(pitch, ctx);

  // 野手守備（§2.5）: ポジション習熟は経験で伸び緩やかに落ちる（山本泰寛型）。
  for (const k of FIELDING_KEYS) ageRating(t.fielding, k, k, ctx, { section: 'fielding', key: k, pos: null });
  for (const pos of Object.keys(t.fielding.positionProf)) {
    ageRating(t.fielding.positionProf, pos, 'positionProf', ctx, { section: 'fielding', key: 'positionProf', pos });
  }

  // 走塁（§2.6）
  for (const k of BASERUN_KEYS) ageRating(t.baserunning, k, k, ctx, { section: 'baserunning', key: k, pos: null });

  p.age = age + 1;
}

/**
 * 「成長→維持→衰え」の年次期待デルタ（能力プロファイル × 個体 peakAge/declineRate）。
 * 若手の成長は成長係数 gm で幅を持たせる（§10.3）。
 * H4: axisTag が指す軸が方針の対象グループかどうかで「成長」summand にだけ (1±δ) を掛ける
 *  （衰えsummandは rest の declineMult 以外は不変＝「方針は成長の配分を傾けるだけ」）。
 */
function curveDelta(prof, ctx, axisTag) {
  let d = 0;
  const growEnd = ctx.peak + prof.peakShift;
  const onset = ctx.peak + prof.declineOffset;
  if (ctx.age < growEnd) {
    let g = prof.grow * (ctx.young ? ctx.gm : 1);
    if (ctx.training) g *= trainingGrowMult(ctx.training, axisTag.section, axisTag.key, axisTag.pos);
    d += g;
  }
  if (ctx.age >= onset) {
    const past = ctx.age - onset; // 経過年（大きいほど急落＝§10.1「1オフで急落もありうる」）
    let dec = prof.decline * ctx.dr * (1 + ctx.aging.declineAccel * past);
    if (ctx.training?.declineMult != null) dec *= ctx.training.declineMult;
    d -= dec;
  }
  return d;
}

/** 年次ノイズ（若手ほど大きい＝高分散）。H3-1: ムラっ気は driftMult(既定1) 倍でSDが荒れる（平均は不変）。 */
function drift(ctx) {
  const sd = (ctx.young ? ctx.aging.driftSdYoung : ctx.aging.driftSdOld) * (ctx.driftMult ?? 1);
  return ctx.prng.normal(0, sd);
}

/** 1レーティング(20-80)を加齢で更新（in-place）。profKey 未登録なら default プロファイル。 */
function ageRating(obj, key, profKey, ctx, axisTag) {
  const prof = ctx.aging.profiles[profKey] ?? ctx.aging.profiles.default;
  // R7（決定1）: flatBonus=高卒未成熟負債の当年ぶん返済額（負債が無い選手は0＝既存挙動と bit 同一）。
  obj[key] = clampRating(obj[key] + curveDelta(prof, ctx, axisTag) + drift(ctx) + ctx.flatBonus);
}

/** 球速（km/h 実数）を加齢で更新（in-place）。高球速×高declineRate ほど早く落ちる（§10.2）。 */
function ageVelocity(pitching, ctx) {
  const v = ctx.aging.velo;
  let d = 0;
  const growEnd = ctx.peak + v.peakShift;
  const onset = ctx.peak + v.declineOffset;
  if (ctx.age < growEnd) {
    let g = v.grow * (ctx.young ? ctx.gm : 1);
    if (ctx.training) g *= trainingGrowMult(ctx.training, 'pitching', 'velocity', null);
    d += g;
  }
  if (ctx.age >= onset) {
    let dec = v.decline * ctx.dr * (1 + ctx.aging.declineAccel * (ctx.age - onset));
    if (ctx.training?.declineMult != null) dec *= ctx.training.declineMult;
    d -= dec;
  }
  d += ctx.prng.normal(0, (ctx.young ? v.driftSdYoung : v.driftSdOld) * (ctx.driftMult ?? 1));
  d += ctx.flatBonus * ctx.veloPerRating; // R7: rating単位の返済額を球速換算
  pitching.velocityKmh = clamp(pitching.velocityKmh + d, v.min, v.max);
}

/** 1球種の質（球速でなく技巧側＝出し入れ）を加齢で更新（in-place・pitchStuff プロファイル）。 */
function agePitch(pitch, ctx) {
  const prof = ctx.aging.profiles.pitchStuff;
  const axisTag = { section: 'pitching', key: 'pitchStuff', pos: null };
  for (const k of ['current', 'whiff', 'hrSuppress', 'contactQuality']) {
    pitch[k] = clampRating(pitch[k] + curveDelta(prof, ctx, axisTag) + drift(ctx) + ctx.flatBonus);
  }
}

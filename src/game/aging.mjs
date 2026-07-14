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
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { clamp, clampRating } from '../model/util.mjs';

/**
 * 全選手にオフシーズンの加齢を適用する（in-place・決定論・順序非依存）。
 * @param {Array} players generateLeague().players（trueAbility/age を持つ選手配列）
 * @param {Object} cfg createConfig()（cfg.tuning.aging を参照）
 * @param {{seed:number, yearIndex:number}} o seed=オフシーズン用階層シード / yearIndex=遷移元の年
 * @returns {Array} players（同一参照。呼び出し側の league.players を直接更新する）
 */
export function applyAging(players, cfg, { seed }) {
  const aging = cfg.tuning.aging;
  const veloPerRating = cfg.tuning.maturity.veloPerRating;
  // H3-1（ムラっ気）: drift SD 倍率。personality が無い（旧経路・テスト直呼び）選手は 1（無効果）。
  const streakyMult = cfg.tuning.personality?.streakyDriftMult ?? 1;
  for (const p of players) {
    // 選手ごとの乱数は id 基準で派生 → 配列順・呼び出し順に依らず同一（決定論・順序非依存）。
    const prng = makeRng(hashSeed(seed, 'aging', p.id));
    const driftMult = p.personality === 'streaky' ? streakyMult : 1;
    agePlayer(p, prng, aging, veloPerRating, driftMult);
  }
  return players;
}

/** 1選手を1年ぶん加齢させる（trueAbility を動かし age++）。 */
function agePlayer(p, prng, aging, veloPerRating, driftMult = 1) {
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

  const ctx = { age, peak, dr, gm, young, prng, aging, flatBonus, veloPerRating, driftMult };

  // 共通素材（§2.2）
  ageRating(t.common, 'speed', 'speed', ctx);
  ageRating(t.common, 'arm', 'arm', ctx);
  ageRating(t.common, 'hands', 'hands', ctx);
  ageRating(t.common, 'reaction', 'reaction', ctx);
  ageRating(t.common, 'power', 'power', ctx);

  // 打撃（§2.3）
  ageRating(t.batting, 'ev', 'ev', ctx);
  ageRating(t.batting, 'la', 'la', ctx);
  ageRating(t.batting, 'pull', 'pull', ctx);
  ageRating(t.batting, 'contact', 'contact', ctx);
  ageRating(t.batting, 'eye', 'eye', ctx);
  ageRating(t.batting, 'vsFastball', 'vsFastball', ctx);
  ageRating(t.batting, 'vsBreaking', 'vsBreaking', ctx);

  // 投手（§2.4）: 球速は別枠モデル、それ以外はレーティング機構、球種は技巧扱い。
  ageVelocity(t.pitching, ctx);
  ageRating(t.pitching, 'control', 'control', ctx);
  ageRating(t.pitching, 'stamina', 'stamina', ctx);
  ageRating(t.pitching, 'gbRate', 'gbRate', ctx);
  ageRating(t.pitching, 'hold', 'hold', ctx);
  for (const pitch of t.pitching.pitches) agePitch(pitch, ctx);

  // 野手守備（§2.5）: ポジション習熟は経験で伸び緩やかに落ちる（山本泰寛型）。
  ageRating(t.fielding, 'positioningIQ', 'positioningIQ', ctx);
  ageRating(t.fielding, 'framing', 'framing', ctx);
  ageRating(t.fielding, 'blocking', 'blocking', ctx);
  for (const pos of Object.keys(t.fielding.positionProf)) {
    ageRating(t.fielding.positionProf, pos, 'positionProf', ctx);
  }

  // 走塁（§2.6）
  ageRating(t.baserunning, 'steal', 'steal', ctx);
  ageRating(t.baserunning, 'baserunIQ', 'baserunIQ', ctx);

  p.age = age + 1;
}

/**
 * 「成長→維持→衰え」の年次期待デルタ（能力プロファイル × 個体 peakAge/declineRate）。
 * 若手の成長は成長係数 gm で幅を持たせる（§10.3）。
 */
function curveDelta(prof, ctx) {
  let d = 0;
  const growEnd = ctx.peak + prof.peakShift;
  const onset = ctx.peak + prof.declineOffset;
  if (ctx.age < growEnd) d += prof.grow * (ctx.young ? ctx.gm : 1);
  if (ctx.age >= onset) {
    const past = ctx.age - onset; // 経過年（大きいほど急落＝§10.1「1オフで急落もありうる」）
    d -= prof.decline * ctx.dr * (1 + ctx.aging.declineAccel * past);
  }
  return d;
}

/** 年次ノイズ（若手ほど大きい＝高分散）。H3-1: ムラっ気は driftMult(既定1) 倍でSDが荒れる（平均は不変）。 */
function drift(ctx) {
  const sd = (ctx.young ? ctx.aging.driftSdYoung : ctx.aging.driftSdOld) * (ctx.driftMult ?? 1);
  return ctx.prng.normal(0, sd);
}

/** 1レーティング(20-80)を加齢で更新（in-place）。profKey 未登録なら default プロファイル。 */
function ageRating(obj, key, profKey, ctx) {
  const prof = ctx.aging.profiles[profKey] ?? ctx.aging.profiles.default;
  // R7（決定1）: flatBonus=高卒未成熟負債の当年ぶん返済額（負債が無い選手は0＝既存挙動と bit 同一）。
  obj[key] = clampRating(obj[key] + curveDelta(prof, ctx) + drift(ctx) + ctx.flatBonus);
}

/** 球速（km/h 実数）を加齢で更新（in-place）。高球速×高declineRate ほど早く落ちる（§10.2）。 */
function ageVelocity(pitching, ctx) {
  const v = ctx.aging.velo;
  let d = 0;
  const growEnd = ctx.peak + v.peakShift;
  const onset = ctx.peak + v.declineOffset;
  if (ctx.age < growEnd) d += v.grow * (ctx.young ? ctx.gm : 1);
  if (ctx.age >= onset) d -= v.decline * ctx.dr * (1 + ctx.aging.declineAccel * (ctx.age - onset));
  d += ctx.prng.normal(0, (ctx.young ? v.driftSdYoung : v.driftSdOld) * (ctx.driftMult ?? 1));
  d += ctx.flatBonus * ctx.veloPerRating; // R7: rating単位の返済額を球速換算
  pitching.velocityKmh = clamp(pitching.velocityKmh + d, v.min, v.max);
}

/** 1球種の質（球速でなく技巧側＝出し入れ）を加齢で更新（in-place・pitchStuff プロファイル）。 */
function agePitch(pitch, ctx) {
  const prof = ctx.aging.profiles.pitchStuff;
  for (const k of ['current', 'whiff', 'hrSuppress', 'contactQuality']) {
    pitch[k] = clampRating(pitch[k] + curveDelta(prof, ctx) + drift(ctx) + ctx.flatBonus);
  }
}

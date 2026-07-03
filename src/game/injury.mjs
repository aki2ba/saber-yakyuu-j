// ============================================================================
// フェーズC2b: 故障ハザード（§10.5）
//
//   applyInjuries(players, cfg, { seed, year })
//     … オフシーズン遷移で全選手に「その年に故障したか」を確率事象として判定する純関数。
//        故障したら career.injuryHistory に1件積み、後遺（復帰後の一時的能力減）を真値へ適用する。
//   injuryHazard(player, cfg) … 1選手の故障確率（テスト/UIから再発リスクの可視化に使える）。
//
// 設計原則（phaseC_spec・厳守）:
//   - 予測でなくハザード（§10.5）: 誰が壊れるかは確率事象。合わせるのは集団の分布（§1）。
//   - 決定論・順序非依存: 各選手の乱数は makeRng(hashSeed(seed,'injury',id)) で id 基準に派生。
//     Date.now/Math.random 非使用。配列順・呼び出し順に依らず bit 一致（aging.mjs と同型）。
//   - エンジンを壊さない: 故障判定は2年目以降のオフシーズンにのみ呼ばれる。1年目レギュラー
//     シーズン（＝既存50較正）には一切効かない（trueAbility を動かすのはオフのみ）。
//   - 非対称性（§10.5）: 打者は大怪我から戻れるが、投手の一度の大怪我は将来の故障と能力低下
//     （球速）の始まり。再発（最大リスク）・後遺を持たせる。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { clamp, clampRating } from '../model/util.mjs';

/**
 * 全選手にオフシーズンの故障判定を適用する（in-place・決定論・順序非依存）。
 * @param {Array} players league.players
 * @param {Object} cfg createConfig()（cfg.tuning.injury を参照）
 * @param {{seed:number, year:number}} o seed=故障用階層シード / year=当該シーズンの年（履歴に記録）
 * @returns {Array<{id,year,severity,gamesLost}>} 発生した故障イベント（当該オフ）
 */
export function applyInjuries(players, cfg, { seed, year }) {
  const events = [];
  for (const p of players) {
    const prng = makeRng(hashSeed(seed, 'injury', p.id));
    const ev = rollInjury(p, cfg, prng, year);
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * 1選手の故障ハザード（0..cap）。年齢・ポジション・投手投球負荷・故障歴（再発）で上下する。
 * 故障歴が増える／重症化するほど再発リスクが上がる（§10.5「最大リスク・再発」）。
 * @returns {number} このオフに故障する確率
 */
export function injuryHazard(p, cfg) {
  const inj = cfg.tuning.injury;
  const t = p.trueAbility;
  const hist = t.career.injuryHistory ?? [];
  let h = inj.base;
  h += Math.max(0, p.age - inj.ageRamp) * inj.agePerYear;
  if (p.role === 'pitcher') {
    h += inj.pitcher;
    h += Math.max(0, t.pitching.velocityKmh - inj.veloRef) * inj.veloPerKmh; // 球速＝投球負荷の代理
  }
  if (p.primaryPos === 'C') h += inj.catcher; // 捕手は壊れる
  // 故障歴（再発・最大リスク）: 件数×重症度で将来リスクが上がる。
  let priorMajor = false;
  for (const e of hist) {
    h += e.severity === 'major' ? inj.recurMajor : inj.recurMinor;
    if (e.severity === 'major') priorMajor = true;
  }
  // 投手の大怪我経験は以後の恒常的な将来リスク（非対称・§10.5）。
  if (p.role === 'pitcher' && priorMajor) h += inj.pitcherMajorLegacy;
  return clamp(h, 0, inj.cap);
}

/** 1選手の故障判定。故障したら履歴に積み後遺を適用して event を返す（非故障は null）。 */
function rollInjury(p, cfg, prng, year) {
  const inj = cfg.tuning.injury;
  if (!prng.chance(injuryHazard(p, cfg))) return null;
  const t = p.trueAbility;
  const hist = t.career.injuryHistory ?? (t.career.injuryHistory = []);
  const priorMajor = hist.some((e) => e.severity === 'major');
  // 故障歴があると重症化しやすく、投手の大怪我経験は更に重くなりやすい（再発の悪循環）。
  let majorP = inj.majorGivenInjury;
  if (hist.length) majorP += inj.majorHistBonus;
  if (p.role === 'pitcher' && priorMajor) majorP += inj.majorPitcherLegacy;
  const major = prng.chance(clamp(majorP, 0, 0.95));
  const severity = major ? 'major' : 'minor';
  const gamesLost = major
    ? inj.majorGamesLo + prng.int(inj.majorGamesHi - inj.majorGamesLo + 1)
    : inj.minorGamesLo + prng.int(inj.minorGamesHi - inj.minorGamesLo + 1);
  const ev = { id: p.id, year, severity, gamesLost };
  hist.push({ year, severity, gamesLost });
  applyAftereffect(p, severity, inj);
  return ev;
}

/**
 * 後遺（§10.5）: 復帰後の一時的な能力減を真値へ即時反映する。身体系（走力・初動・パワー）を
 * 中心に落とし、技巧系は残す（＝技巧派の生存に効く）。投手の重症は球速低下の始まり（非対称）。
 * ここで落ちた分は以後の加齢カーブ（成長ドリフト）で部分的に回復しうる（点でなく幅で・§10.3）。
 */
function applyAftereffect(p, severity, inj) {
  const mag = severity === 'major' ? inj.aftMajor : inj.aftMinor;
  const t = p.trueAbility;
  t.common.speed = clampRating(t.common.speed - mag);
  t.common.reaction = clampRating(t.common.reaction - mag);
  t.common.power = clampRating(t.common.power - mag * 0.6);
  t.batting.ev = clampRating(t.batting.ev - mag * 0.6);
  if (p.role === 'pitcher' && severity === 'major') {
    t.pitching.velocityKmh = clamp(t.pitching.velocityKmh - inj.aftVeloMajor, 130, 165);
    t.pitching.control = clampRating(t.pitching.control - mag * 0.5);
  }
}

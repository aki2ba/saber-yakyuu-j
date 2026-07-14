// ============================================================================
// フェーズC2b: ブレイクイベント（§10.4 / §11.1）
//
//   applyBreakouts(players, cfg, { seed, year })
//     … オフシーズンに低確率で能力が「階段状に」跳ねる離散イベントを判定する純関数。
//        上方=球種習得（列が生える千賀型）/覚醒（真値ジャンプ）/EVジャンプ（板山・用具型）、
//        下方=制球崩壊（イップス）/燃え尽き/故障明けの別人化。career.breakEvents に履歴を積む。
//
// 設計原則（phaseC_spec・厳守）:
//   - 同一機構で複数の実在現象を表現（§10.4）: 発火対象パラメータを変えるだけで
//     千賀型（球種列が生える）も板山型（打撃真値ジャンプ）も用具型（EV）も出す。
//   - §11.1: 上方だけだとリーグがインフレするので下方≧上方を既定（バランス上ほぼ必須）。
//   - 決定論・順序非依存: 各選手の乱数は makeRng(hashSeed(seed,'breakout',id))（id基準派生）。
//     Date.now/Math.random 非使用。1年目には効かない（2年目以降のオフのみ）。
//   - 故障との合流（§10.4「故障明けの別人化」）: 直近オフに大怪我があると下方確率が跳ねる。
//     ＝injury.mjs を先に適用してから本モジュールを呼ぶ（index.mjs のオフシーズン順序）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { clamp, clampRating } from '../model/util.mjs';
import { createPitch } from '../model/player.mjs';
import { PITCH_TYPES } from '../model/positions.mjs';

/**
 * 全選手にオフシーズンのブレイクイベントを適用する（in-place・決定論・順序非依存）。
 * @param {Array} players league.players
 * @param {Object} cfg createConfig()（cfg.tuning.breakout を参照）
 * @param {{seed:number, year:number}} o seed=ブレイク用階層シード / year=当該年（履歴・故障合流判定に使用）
 * @returns {Array<{id,year,dir,kind}>} 発生したブレイクイベント（dir='up'|'down'）
 */
export function applyBreakouts(players, cfg, { seed, year }) {
  const events = [];
  for (const p of players) {
    const prng = makeRng(hashSeed(seed, 'breakout', p.id));
    const ev = rollBreakout(p, cfg, prng, year);
    if (ev) events.push(ev);
  }
  return events;
}

/** 1選手のブレイク判定（上方/下方/無し）。下方の裾を厚くしてインフレを抑える（§11.1）。 */
function rollBreakout(p, cfg, prng, year) {
  const bo = cfg.tuning.breakout;
  const hist = p.trueAbility.career.injuryHistory ?? [];
  const recentMajor = hist.some((e) => e.year === year && e.severity === 'major');
  const young = p.age <= bo.youngAge;
  let upP = bo.upBase * (young ? bo.youngUpMult : 1);
  let downP =
    bo.downBase + (recentMajor ? bo.postInjuryDown : 0) + Math.max(0, p.age - bo.burnoutAge) * bo.burnoutPerYear;
  // H3-1（お調子者）: 上方/下方の両確率へ同率で掛ける＝§11.1「下方≧上方」の比を保ったまま
  //   分散だけ増やす（インフレ方向のバイアスを追加しない）。
  if (p.personality === 'showboat') {
    const mult = cfg.tuning.personality?.showboatBreakoutMult ?? 1;
    upP *= mult;
    downP *= mult;
  }
  const r = prng.next(); // 1回の一様乱数で上/下/無しに振る（下方を厚く配置）
  if (r < upP) return applyUpBreak(p, bo, prng, year);
  if (r < upP + downP) return applyDownBreak(p, bo, prng, year, recentMajor);
  return null;
}

/** 上方ブレイク: 投手=球種習得 or 覚醒、野手=覚醒/EVジャンプ。 */
function applyUpBreak(p, bo, prng, year) {
  const t = p.trueAbility;
  let kind;
  if (p.role === 'pitcher') {
    const held = new Set(t.pitching.pitches.map((x) => x.type));
    const avail = PITCH_TYPES.filter((x) => !held.has(x));
    if (avail.length && prng.chance(bo.newPitchShare)) {
      // 球種の「列が一本生える」（千賀のフォーク）: 決め球として whiff を高めに（§4）。
      const type = avail[prng.int(avail.length)];
      t.pitching.pitches.push(
        createPitch(type, {
          current: clampRating(55 + prng.normal(0, 5)),
          whiff: clampRating(58 + prng.normal(0, 6)),
          hrSuppress: clampRating(54 + prng.normal(0, 5)),
          contactQuality: clampRating(54 + prng.normal(0, 5)),
        }),
      );
      kind = 'newPitch';
    } else {
      // 覚醒: 球速＋全球種の質が階段状に上がる。
      t.pitching.velocityKmh = clamp(t.pitching.velocityKmh + bo.veloJump, 130, 165);
      for (const pi of t.pitching.pitches) {
        pi.whiff = clampRating(pi.whiff + bo.jump);
        pi.current = clampRating(pi.current + bo.jump);
      }
      kind = 'awaken';
    }
  } else {
    // 覚醒/EVジャンプ（板山・用具型）: EV・パワー中心にコンタクト/LAも階段状に上がる。
    t.batting.ev = clampRating(t.batting.ev + bo.jump);
    t.common.power = clampRating(t.common.power + bo.jump * 0.6);
    t.batting.contact = clampRating(t.batting.contact + bo.jump * 0.6);
    t.batting.la = clampRating(t.batting.la + bo.jump * 0.4);
    kind = 'awaken';
  }
  pushEvent(t, year, 'up', kind);
  return { id: p.id, year, dir: 'up', kind };
}

/** 下方ブレイク: 投手=制球崩壊（イップス）or 燃え尽き、野手=燃え尽き/別人化。 */
function applyDownBreak(p, bo, prng, year, recentMajor) {
  const t = p.trueAbility;
  let kind;
  if (p.role === 'pitcher' && prng.chance(bo.yipsShare)) {
    // 制球崩壊（イップス）: 制球が階段状に崩れる。
    t.pitching.control = clampRating(t.pitching.control - bo.controlCollapse);
    kind = 'yips';
  } else {
    // 燃え尽き / 故障明けの別人化: 広く低下（別人化は追加で大きく）。
    const mag = recentMajor ? bo.jump + bo.postInjuryMag : bo.jump;
    t.batting.ev = clampRating(t.batting.ev - mag * 0.6);
    t.batting.contact = clampRating(t.batting.contact - mag * 0.6);
    t.common.power = clampRating(t.common.power - mag * 0.5);
    if (p.role === 'pitcher') {
      for (const pi of t.pitching.pitches) pi.whiff = clampRating(pi.whiff - mag * 0.6);
      t.pitching.velocityKmh = clamp(t.pitching.velocityKmh - bo.veloJump * 0.7, 130, 165);
    }
    kind = recentMajor ? 'postInjury' : 'burnout';
  }
  pushEvent(t, year, 'down', kind);
  return { id: p.id, year, dir: 'down', kind };
}

function pushEvent(t, year, dir, kind) {
  (t.career.breakEvents ?? (t.career.breakEvents = [])).push({ year, dir, kind });
}

// ============================================================================
// 球種格子 段階1（2-1/2-2 / §4）
// 1打席ごとに投手の球種を1つ選び、その球種の (whiff/hrSuppress/contactQuality) と
// 打者の (対速球/対変化球) 適性で解決する。これにより:
//   - 対ストレート成績が球種別ログの集計として湧く
//   - フォーク習得で開花（列が一本生える＝新しい優秀な球種の追加）
//   - 球種構成＝投手タイプ / 先発・リリーフ適性
// ============================================================================
import { FASTBALL_TYPES } from '../model/positions.mjs';

/** その打席で投げる球種を1つ選ぶ（速球系を重く重み付け） */
export function selectPitch(pitcher, rng, cfg) {
  const pitches = pitcher.trueAbility.pitching.pitches;
  if (!pitches || pitches.length === 0) return null;
  const fw = cfg.tuning.pa.fastballWeight;
  let total = 0;
  for (const p of pitches) total += FASTBALL_TYPES.has(p.type) ? fw : 1;
  let r = rng.next() * total;
  for (const p of pitches) {
    r -= FASTBALL_TYPES.has(p.type) ? fw : 1;
    if (r <= 0) return p;
  }
  return pitches[pitches.length - 1];
}

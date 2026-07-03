// ============================================================================
// 球種格子 段階1（2-1/2-2 / §4）
// 1打席ごとに投手の球種を1つ選び、その球種の (whiff/hrSuppress/contactQuality) と
// 打者の (対速球/対変化球) 適性で解決する。これにより:
//   - 対ストレート成績が球種別ログの集計として湧く
//   - フォーク習得で開花（列が一本生える＝新しい優秀な球種の追加）
//   - 球種構成＝投手タイプ / 先発・リリーフ適性
// ============================================================================
import { FASTBALL_TYPES } from '../model/positions.mjs';

/** その打席で投げる球種を1つ選ぶ（速球系を重く重み付け・legacy: 打席1回1球種の旧API） */
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

/**
 * 一球ごとの球種選択（B1・§B1-1(a)）: (balls,strikes) 依存の重みで投手の球種構成から1球を選ぶ。
 *   - even/追い込み前 = 速球系を重く（fastballWeight）
 *   - 2ストライク（決め球）= whiff の高い球種ほど重く（putawayWhiffBias×(whiff-50)）
 *   - ビハインド（3ボール, 2-0）= 速球系をさらに重く（制球しやすい球・behindFastballBias）
 * 決定論: rng を1回だけ消費。使い捨てオブジェクトは作らない（重み合計→線形走査）。
 */
export function selectPitchByCount(pitcher, rng, cfg, balls, strikes) {
  const pitches = pitcher.trueAbility.pitching.pitches;
  if (!pitches || pitches.length === 0) return null;
  if (pitches.length === 1) {
    rng.next(); // 乱数消費数をカウント状態に依存させない（決定論の安定化）
    return pitches[0];
  }
  const K = cfg.tuning.pitch;
  const behind = balls === 3 || (balls === 2 && strikes === 0);
  const putaway = strikes === 2;
  let total = 0;
  for (const p of pitches) {
    let w = FASTBALL_TYPES.has(p.type) ? K.fastballWeight : 1;
    if (behind && FASTBALL_TYPES.has(p.type)) w += K.behindFastballBias;
    if (putaway) w += K.putawayWhiffBias * Math.max(0, (p.whiff - 50) / 10); // 決め球=高whiff球種
    total += w;
  }
  let r = rng.next() * total;
  for (const p of pitches) {
    let w = FASTBALL_TYPES.has(p.type) ? K.fastballWeight : 1;
    if (behind && FASTBALL_TYPES.has(p.type)) w += K.behindFastballBias;
    if (putaway) w += K.putawayWhiffBias * Math.max(0, (p.whiff - 50) / 10);
    r -= w;
    if (r <= 0) return p;
  }
  return pitches[pitches.length - 1];
}

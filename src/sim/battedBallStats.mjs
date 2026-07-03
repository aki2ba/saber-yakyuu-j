// ============================================================================
// 追加系指標の打球イベント集計（§B3a / フェーズB B3a）
//
// 「打席/打球/プレーのイベントストリームを読むだけで計算できる」追加集計を、
// シミュレーション本体（打席解決・打球生成・継投）を一切変えずに湧かせる。
// resolveBattedBall が既に計算した期待out率・期待塁打分布(xB1..xHR)と、打球3要素(EV/LA/spray)を
// 打者/投手の生カウントへ積むだけ。ここでは乱数を一切消費しない（＝決定論・較正30指標が完全不変）。
//
// 生の一球ログは永続化しない（§17）。集計カウンタのみ。
// ============================================================================
import { battedType } from './battedBallResult.mjs';

/**
 * Barrel 判定（Statcast定義の近似・§B3a）。EV≥~98mph かつ、EVが上がるほど広がるLA帯に入る打球。
 * @param {number} evKmh 打球速度(km/h)
 * @param {number} laDeg 打球角度(度)
 * @param {Object} m cfg.tuning.metrics（Barrel帯定数）
 */
export function isBarrel(evKmh, laDeg, m) {
  if (evKmh < m.barrelMinKmh) return false;
  const excessMph = (evKmh - m.barrelMinKmh) / 1.60934; // 98mph超過ぶん(mph)
  const lo = Math.max(m.barrelMinLA, m.barrelBaseLo - excessMph * m.barrelLoSlope);
  const hi = Math.min(m.barrelMaxLA, m.barrelBaseHi + excessMph * m.barrelHiSlope);
  return laDeg >= lo && laDeg <= hi;
}

/** 打球種別を該当ラインの被打球分類カウンタへ加算（GB/LD/FB/PU＋総数bbEvents）。 */
function bumpType(line, type) {
  if (type === 'GB') line.bbGB++;
  else if (type === 'LD') line.bbLD++;
  else if (type === 'FB') line.bbFB++;
  else line.bbPU++;
  line.bbEvents++;
}

/**
 * 打球イベント1個ぶんを打者(bat)・投手(pit)の生カウントへ累積する（§B3a）。
 * @param {Object} bat 打者 battingLine
 * @param {Object} pit 投手 pitchingLine
 * @param {Object} bb  打球（evKmh/laDeg/sprayDeg）
 * @param {Object} r   resolveBattedBall の戻り（期待塁打分布 xB1/xB2/xB3/xHR を含む）
 * @param {number} pullSign 打者の引っ張り方向符号（effectiveBats==='L' ? +1 : -1）。
 *   spray がこの符号側なら Pull、逆なら Oppo、|spray|≤centAbsSpray なら Cent。
 * @param {Object} cfg 設定（cfg.tuning.metrics）
 */
export function accumulateBatted(bat, pit, bb, r, pullSign, cfg) {
  const m = cfg.tuning.metrics;
  const type = battedType(bb.laDeg);
  // 被打球分類（打者・投手 双方に対称に計上）
  bumpType(bat, type);
  bumpType(pit, type);
  // 打球方向（打者のみ・Pull/Cent/Oppo）
  const s = bb.sprayDeg;
  if (Math.abs(s) <= m.centAbsSpray) bat.bbCent++;
  else if ((s > 0 ? 1 : -1) === pullSign) bat.bbPull++;
  else bat.bbOppo++;
  // 打球質・速度（打者のみ）
  if (bb.evKmh >= m.hardHitKmh) bat.hardHits++;
  if (bb.laDeg >= m.sweetSpotLoLA && bb.laDeg <= m.sweetSpotHiLA) bat.sweetSpots++;
  if (isBarrel(bb.evKmh, bb.laDeg, m)) bat.barrels++;
  bat.evSum += bb.evKmh;
  if (bb.evKmh > bat.evMax) bat.evMax = bb.evKmh;
  // 期待塁打分布（打者のみ・xBA/xSLG/xwOBA の素）。rng抽選前の期待値をそのまま累積。
  bat.xB1 += r.xB1;
  bat.xB2 += r.xB2;
  bat.xB3 += r.xB3;
  bat.xHR += r.xHR;
}

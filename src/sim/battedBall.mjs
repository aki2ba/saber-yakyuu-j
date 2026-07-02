// ============================================================================
// 打球生成（1-2）— 2段パイプラインの第2段・前半（§3.2）
//
// IN_PLAY になった打席で、接触の瞬間に打球3要素を先に生成する:
//   EV（打球速度 km/h） = 打者EV適性 × 生体power × 投球の質（抑止）＋ノイズ
//   LA（打球角度 度）   = 打者LA適性 × 投手ゴロ率相性 ＋ノイズ
//   方向（spray 度）    = 打者引っ張り/流し（利き手で符号）＋ノイズ
// ここでは結果（安打/アウト）は決めない。落下点・結果は 1-3 が球場ジオメトリで導く。
//
// Phase1簡略（自己レビューF34）: 「投球の質」は集約スカラー、方向は打者傾向のみ
//   （×投球コースは球種格子 段階2まで保留）。球種別は 2-1 で差し替える。
// ============================================================================
import { createBattedBall } from '../model/battedball.mjs';
import { pitchClass } from '../model/positions.mjs';
import { effectiveBats, isSameHand } from '../model/player.mjs';

/** 投手の被コンタクト質抑止（球種contactQualityの平均。高いほど強い打球を許さない） */
function meanContactSuppress(pit) {
  const arr = pit.pitches;
  if (!arr || arr.length === 0) return 50;
  let s = 0;
  for (const p of arr) s += p.contactQuality;
  return s / arr.length;
}

/**
 * 打球3要素を生成して BattedBall を返す（幾何・結果は null のまま）。
 */
export function generateBattedBall(batter, pitcher, cfg, rng, ctx = {}) {
  const bb = cfg.tuning.bb;
  const bat = batter.trueAbility;
  const pit = pitcher.trueAbility.pitching;

  // EV: 打者EV適性＋power − 投手抑止(選択球種) − 被弾抑止(M3) ＋対クラス適性 ＋巡目 ＋ノイズ
  const tto = ctx.tto ?? 0;
  const pitch = ctx.pitch ?? null;
  const contactSup = pitch ? pitch.contactQuality : meanContactSuppress(pit);
  const hrSup = pitch ? pitch.hrSuppress : 50;
  const apt = pitch
    ? pitchClass(pitch.type) === 'fastball'
      ? bat.batting.vsFastball
      : bat.batting.vsBreaking
    : 50;
  // 左右プラトーン（S1・M7解消）: 同利き（スイッチは常に有利側）でEVの中心を下げる
  const pl = cfg.tuning.platoon;
  const platoonEv = pl && isSameHand(batter, pitcher) ? pl.evKmhSame : 0;
  const evMean =
    bb.evBase +
    bb.evPerEV * (bat.batting.ev - 50) +
    bb.evPerPower * (bat.common.power - 50) -
    bb.evPitchSuppress * (contactSup - 50) -
    bb.evHrSuppressW * (hrSup - 50) +
    bb.evAptW * (apt - 50) +
    tto * cfg.tuning.tto.evPerTime +
    platoonEv;
  const evKmh = Math.max(40, rng.normal(evMean, bb.evSd));

  // LA: 打者LA適性で中心シフト、投手ゴロ率で下げる ＋ノイズ
  const laMean = bb.laBase + bb.laPerLA * (bat.batting.la - 50) - bb.laPitchGB * (pit.gbRate - 50);
  const laDeg = rng.normal(laMean, bb.laSd);

  // 方向: pull適性で引っ張り側へ。右打ちは左方向(−)、左打ちは右方向(+)へ引っ張る。
  // スイッチ(S)は実効打席サイド（常に投手と逆＝有利側）で引っ張る（S1でM7の簡易扱いを解消）。
  const pullMag = bb.sprayPull * (bat.batting.pull - 50);
  const pullSign = effectiveBats(batter, pitcher) === 'L' ? +1 : -1;
  const sprayMean = pullSign * pullMag;
  let sprayDeg = rng.normal(sprayMean, bb.spraySd);
  if (sprayDeg < -50) sprayDeg = -50;
  if (sprayDeg > 50) sprayDeg = 50;

  const bb2 = createBattedBall({
    evKmh,
    laDeg,
    sprayDeg,
    pitchType: ctx.pitchType ?? null,
    batterId: batter.id,
    pitcherId: pitcher.id,
    baseState: ctx.baseState ?? 0,
    outs: ctx.outs ?? 0,
  });
  bb2.runnerSpeed = batter.trueAbility.common.speed; // 三塁打の脚力依存に使用（監査B1）
  return bb2;
}

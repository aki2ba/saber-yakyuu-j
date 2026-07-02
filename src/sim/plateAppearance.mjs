// ============================================================================
// 打席解決の規律層（1-1）— 2段パイプラインの第1段（§3.1 / 自己レビュー F29）
//
// ここでは打者能力 vs 投手能力を log5/オッズ比で合成し、打席の分岐だけを決める:
//   { K(三振) / BB(四球) / HBP(死球) / IN_PLAY(インプレー=打球化) }
// 安打/アウト/長打は決めない。IN_PLAY は第2段(1-2/1-3 EV/LA→球場→守備)へ渡す。
// 「結果を先に決めてゾーンを後付け」を避け、決定権をこの1箇所に閉じる。
// ============================================================================
import { logit, expit, ratingDelta } from './rates.mjs';
import { pitchClass } from '../model/positions.mjs';
import { isSameHand } from '../model/player.mjs';

export const PA_OUTCOME = { K: 'K', BB: 'BB', HBP: 'HBP', IN_PLAY: 'inPlay' };

/** 投手の平均空振り資質（球種whiffの平均）。球種未設定なら平均50。 */
function meanWhiff(pit) {
  const arr = pit.pitches;
  if (!arr || arr.length === 0) return 50;
  let s = 0;
  for (const p of arr) s += p.whiff;
  return s / arr.length;
}

/**
 * 打席の分岐確率（pK, pBB, pHBP）を log5 合成で算出。IN_PLAY は残余。
 * @returns {{pK:number, pBB:number, pHBP:number, pInPlay:number}}
 */
export function paProbabilities(batter, pitcher, cfg, tto = 0, pitch = null) {
  const pa = cfg.tuning.pa;
  const b = batter.trueAbility.batting;
  const p = pitcher.trueAbility.pitching;

  // --- 左右プラトーン（S1・M7解消）: 同利き（スイッチは常に有利側=逆打席）で K↑ BB↓ ---
  const pl = cfg.tuning.platoon;
  const same = pl && isSameHand(batter, pitcher);

  // --- K: 打者のK傾向（コンタクト/選球眼＋対該当球種クラス適性）×投手の奪三振資質 ---
  // 球種格子(§4段階1): pitch があればその球種の whiff を使い、打者の対クラス適性で補正。
  const whiffVal = pitch ? pitch.whiff : meanWhiff(p);
  let aptAdj = 0;
  if (pitch) {
    const apt = pitchClass(pitch.type) === 'fastball' ? b.vsFastball : b.vsBreaking;
    aptAdj = pa.whiffAptW * (apt - 50); // 適性高い→Kしにくい
  }
  // 巡目(tto)が進むほど打者はK を回避しやすい（§3.3）。
  const kProne = 50 - pa.kContactW * (b.contact - 50) - pa.kEyeW * (b.eye - 50) - aptAdj;
  const kStuff = whiffVal + pa.kVeloPerKmh * (p.velocityKmh - 146);
  let pK = expit(
    logit(pa.kLeague) +
      ratingDelta(kProne, pa.kSlope) +
      ratingDelta(kStuff, pa.kSlope) -
      tto * cfg.tuning.tto.kPerTime +
      (same ? pl.kLogitSame : 0),
  );

  // --- BB: 打者選球眼（高→増）×投手制球（高→減） ---
  let pBB = expit(
    logit(pa.bbLeague) +
      ratingDelta(b.eye, pa.bbSlope) -
      ratingDelta(p.control, pa.bbSlope) +
      (same ? pl.bbLogitSame : 0),
  );

  // --- HBP: 小。投手制球が低いほどわずかに増 ---
  let pHBP = expit(logit(pa.hbpLeague) - ratingDelta(p.control, pa.hbpSlope));

  // 端の組み合わせで合計が1に近づき過ぎないようガード（IN_PLAY を最低限残す）
  const sum = pK + pBB + pHBP;
  const cap = 0.95;
  if (sum > cap) {
    const s = cap / sum;
    pK *= s;
    pBB *= s;
    pHBP *= s;
  }
  return { pK, pBB, pHBP, pInPlay: 1 - pK - pBB - pHBP };
}

/**
 * 打席の分岐を1回抽選（決定論・rng使用）。
 * @returns {'K'|'BB'|'HBP'|'inPlay'}
 */
export function resolvePADiscipline(batter, pitcher, cfg, rng, tto = 0, pitch = null) {
  const { pK, pBB, pHBP } = paProbabilities(batter, pitcher, cfg, tto, pitch);
  const u = rng.next();
  if (u < pK) return PA_OUTCOME.K;
  if (u < pK + pBB) return PA_OUTCOME.BB;
  if (u < pK + pBB + pHBP) return PA_OUTCOME.HBP;
  return PA_OUTCOME.IN_PLAY;
}

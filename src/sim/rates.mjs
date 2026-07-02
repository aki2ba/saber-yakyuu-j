// 確率合成の基本関数（log5/オッズ比の土台。§3.1）。
// logit/expit と、レーティング(20-80, 50=平均)を logit の増分へ写す変換。

/** ロジット（オッズの対数） */
export function logit(p) {
  return Math.log(p / (1 - p));
}

/** 逆ロジット（シグモイド） */
export function expit(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * レーティング(50=平均)を logit 増分に変換。
 * 例: slope=0.30 なら 80(=+30) で +0.9（オッズ約2.5倍）。
 */
export function ratingDelta(rating, slope) {
  return (slope * (rating - 50)) / 10;
}

/**
 * log5 / オッズ比合成: リーグ基準率に打者側・投手側の logit 増分を足し込む（§3.1）。
 * logit(P) = logit(L) + Δbatter + Δpitcher。両者が平均なら L に戻る。
 */
export function log5(leagueRate, batterDelta, pitcherDelta) {
  return expit(logit(leagueRate) + batterDelta + pitcherDelta);
}

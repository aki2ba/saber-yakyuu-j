// ============================================================================
// 守備の能力→結果 結線（2-7）＋ OAA→UZR run換算（2-8）（§7 / 自己レビュー M1・B-7）
//
// Range（守備範囲）= ポジショニングIQ + 初動(Reaction) + 走力(Speed)（§7.1）を合成し、
// 打球結果解決(resolveBattedBall)に注入して「実効被安打率」を個人スキルで上下させる。
// 期待アウトのベースラインはリーグ平均(ポジション中立)のままなので、
// 実結果 − 期待 の累積(oaaOuts)が個人のレンジ・シグナルになる（MLBAM OAAと同型）。
// ============================================================================

const OUTFIELD = new Set(['LF', 'CF', 'RF']);

/** 野手のRangeレーティング（50=リーグ平均）。§7.1 の Range = ポジIQ+初動+走力 */
export function rangeRating(player, cfg) {
  const f = player.trueAbility.fielding;
  const c = player.trueAbility.common;
  const w = cfg.tuning.field.wRange;
  return w.positioningIQ * f.positioningIQ + w.reaction * c.reaction + w.speed * c.speed;
}

/** 選手シーズンの主守備位置（守備アウト最多）。出場イニング0なら ''（S2: 代打のみの選手が出うる） */
export function mainPosition(fieldingLine) {
  let pos = '';
  let mx = 0;
  for (const k of Object.keys(fieldingLine.positionOuts)) {
    if (fieldingLine.positionOuts[k] > mx) {
      mx = fieldingLine.positionOuts[k];
      pos = k;
    }
  }
  return pos;
}

/** 選手の総守備イニング */
export function totalFieldInnings(fieldingLine) {
  let o = 0;
  for (const k of Object.keys(fieldingLine.positionOuts)) o += fieldingLine.positionOuts[k];
  return o / 3;
}

/**
 * ポジション別に中心化した OAA（アウト単位）。
 * 生の oaaOuts はリーグ中立基準ゆえ「出場している守備者（＝上手い選手ばかり）」が全員プラスに
 * 偏る。正しくは「そのポジションで実際に守る選手の平均」を0とすべき（UZRの定義）。
 * lc.oaaCenterPerInn（主ポジ別のOAA/イニング平均）を差し引いて中心化する。
 */
export function centeredOAAOuts(ps, lc) {
  const raw = ps.fielding.oaaOuts;
  if (!lc || !lc.oaaCenterPerInn) return raw;
  const pos = mainPosition(ps.fielding);
  const inn = totalFieldInnings(ps.fielding);
  return raw - (lc.oaaCenterPerInn[pos] || 0) * inn;
}

/**
 * 失策run成分（ErrR・§7.2 / 監査A3）。OAAは失策"前"の判定で範囲成分のみを表すため、
 * 捕球ミス（Hands）の価値はここで別勘定する（二重計上しない）。
 * ポジション平均の失策率で中心化し、平均より失策が少ない＝プラス。
 */
export function errRunsAboveAvg(ps, cfg, lc) {
  if (!lc || !lc.errCenterPerInn) return 0;
  const pos = mainPosition(ps.fielding);
  const inn = totalFieldInnings(ps.fielding);
  const expE = (lc.errCenterPerInn[pos] || 0) * inn;
  return -((ps.fielding.e || 0) - expE) * cfg.tuning.field.runPerError;
}

/**
 * UZR相当(run単位) = 範囲成分(中心化OAA×run/out) + 失策成分(ErrR) + 捕手フレーミング(framingRuns)。
 * 内野0.75 / 外野0.90（Statcast FRV, §7.2）。捕手は範囲=0で framing が主成分（監査B5）。
 */
export function uzrRuns(ps, cfg, lc) {
  const pos = mainPosition(ps.fielding);
  const rpo = OUTFIELD.has(pos) ? cfg.tuning.field.runPerOutOutfield : cfg.tuning.field.runPerOutInfield;
  return centeredOAAOuts(ps, lc) * rpo + errRunsAboveAvg(ps, cfg, lc) + (ps.fielding.framingRuns || 0);
}

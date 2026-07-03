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

// ============================================================================
// B3b: UZR成分分解（RngR + ErrR + ARM + DPR + rSB + framing・§B3b）
//
// ARM/DPR/rSB は「一球データを要さない」追加集計として game.mjs が乱数非消費で素カウントを
// 積み、ここで対リーグ平均の run に換算する。いずれも WAR用の uzrRuns には加えない
// （＝較正30指標・総WARが完全不変。分解表示でのみ合成する。総UZR不変が理想・§検証）。
// ※フレーミング/ブロッキングの毎球分解は一球データが要る＝B1で実装。ここでは既存の
//   per-inning近似 framingRuns をそのまま維持する（触らない）。
// ============================================================================

/**
 * ARM（外野送球）run。game.mjs が (arm-50)×armRunPerOpp を追加進塁機会ごとに累積した armRuns を、
 * リーグの外野手平均の肩（lgArmRunPerOpp×機会）に対して0中心化する（§B3b・リーグΣ ARM≈0）。
 */
export function armRunsAboveAvg(ps, lc) {
  const f = ps.fielding;
  const raw = f.armRuns || 0;
  const center = lc && lc.lgArmRunPerOpp != null ? lc.lgArmRunPerOpp * (f.armOpp || 0) : 0;
  return raw - center;
}

/** DPR（二遊間の併殺転換）run。対リーグ平均転換率(lgDPRate)より多く転換した分がプラス（§B3b）。 */
export function dprRunsAboveAvg(ps, cfg, lc) {
  const f = ps.fielding;
  const opp = f.dpOpp || 0;
  if (!opp || !lc || lc.lgDPRate == null) return 0;
  return ((f.dpTurned || 0) - lc.lgDPRate * opp) * cfg.tuning.field.runPerDP;
}

/**
 * 捕手 rSB（盗塁阻止run）。既存の盗塁/盗塁死（捕手が許したSB/刺したCS）から、
 * リーグ平均の1企図あたり攻撃価値を基準に、捕手が抑えた分をプラス評価する（FG rSB相当・§B3b）。
 * rSB = lgPerAtt×企図 − (許SB×runSB + 刺CS×runCS)。リーグΣ rSB≈0（Σ許SB=lgSB, Σ刺CS=lgCS）。
 */
export function catcherRsbRuns(ps, cfg, lc) {
  const f = ps.fielding;
  const sb = f.sbAllowed || 0;
  const cs = f.csMade || 0;
  const att = sb + cs;
  if (!att || !lc) return 0;
  const runSB = cfg.tuning.run.runSB;
  const runCS = cfg.tuning.run.runCS;
  const lgAtt = (lc.lgSB || 0) + (lc.lgCS || 0);
  const lgPerAtt = lgAtt ? ((lc.lgSB || 0) * runSB + (lc.lgCS || 0) * runCS) / lgAtt : 0;
  return lgPerAtt * att - (sb * runSB + cs * runCS);
}

/**
 * UZR成分分解（表示用・§B3b）。total = RngR + ErrR + framing + ARM + DPR + rSB。
 * 「classic」= RngR + ErrR + framing は WAR用 uzrRuns と厳密一致する（＝ARM/DPR/rSB は
 * 純粋な内訳の付け足しで、WAR/較正には一切影響しない・self-check可能）。
 */
export function uzrComponents(ps, cfg, lc) {
  const pos = mainPosition(ps.fielding);
  const rpo = OUTFIELD.has(pos) ? cfg.tuning.field.runPerOutOutfield : cfg.tuning.field.runPerOutInfield;
  const rngR = centeredOAAOuts(ps, lc) * rpo;
  const errR = errRunsAboveAvg(ps, cfg, lc);
  const framing = ps.fielding.framingRuns || 0;
  const arm = armRunsAboveAvg(ps, lc);
  const dpr = dprRunsAboveAvg(ps, cfg, lc);
  const rSB = catcherRsbRuns(ps, cfg, lc);
  return { pos, rngR, errR, framing, arm, dpr, rSB, total: rngR + errR + framing + arm + dpr + rSB };
}

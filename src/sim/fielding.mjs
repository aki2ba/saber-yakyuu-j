// ============================================================================
// 守備の能力→結果 結線（2-7）＋ OAA→UZR run換算（2-8）（§7 / 自己レビュー M1・B-7）
//
// Range（守備範囲）= ポジショニングIQ + 初動(Reaction) + 走力(Speed)（§7.1）を合成し、
// 打球結果解決(resolveBattedBall)に注入して「実効被安打率」を個人スキルで上下させる。
// 期待アウトのベースラインはリーグ平均(ポジション中立)のままなので、
// 実結果 − 期待 の累積(oaaOuts)が個人のレンジ・シグナルになる（MLBAM OAAと同型）。
// ============================================================================

import { IS_OUTFIELD } from './fieldingGeometry.mjs';

const OUTFIELD = IS_OUTFIELD;

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
 * 守備run（WARに入る値）。FanGraphs の UZR 定義に従い、ポジションで成分が異なる（正典§1.1）:
 *   外野手 = RngR + ErrR + ARM
 *   内野手 = RngR + ErrR + DPR
 *   捕手   = ErrR + framing + blocking + rSB（UZRは付けない）
 * run換算は MLB.com 公式 FRV glossary の固定定数（内野0.75 / 外野0.90 out・正典§2.4）。
 * uzrComponents(...).total と厳密一致する（表示とWARが食い違わない）。
 */
export function uzrRuns(ps, cfg, lc) {
  return uzrComponents(ps, cfg, lc).total;
}

// ============================================================================
// UZR の成分（FanGraphs 定義・正典§1.1）
//   外野手 UZR = RngR + ErrR + ARM
//   内野手 UZR = RngR + ErrR + DPR
//   捕手     = UZR を付けない → 捕手守備run = ErrR + framing + blocking + throwing(rSB)
//
// すべて生カウント（armOpp/armAdv/armKill, dpOpp/dpTurned, blockOpp/wp/pb, sbAllowed/csMade）
// からリーグ平均基準で創発させる。run換算は MLB.com 公式 FRV glossary の固定定数（正典§2.4）。
// リーグΣ は各成分とも 0 に厳密収束する（＝WARの総量を動かさない）。
// ============================================================================

/**
 * ARM（外野送球）run。実イベント（追加進塁を許した数 / 走塁死に仕留めた数）から創発する。
 *   ARM = lgPerOpp×機会 − (許進塁×runUBR + 刺殺×runCS)
 *   lgPerOpp = (Σ許進塁×runUBR + Σ刺殺×runCS) / Σ機会
 * runCS は負値なので、走者を刺すほど ARM は増える。リーグΣ ARM = 0（厳密）。
 */
export function armRunsAboveAvg(ps, cfg, lc) {
  const f = ps.fielding;
  const opp = f.armOpp || 0;
  if (!opp || !lc || lc.lgArmAdvRate == null) return 0;
  const runAdv = cfg.tuning.run.runUBR; // 走者が1つ余分に進む攻撃側価値
  const runKill = lc.runCS ?? cfg.tuning.run.runCS; // 走塁死の攻撃側価値（負・得点環境依存）
  const lgPerOpp = lc.lgArmAdvRate * runAdv + lc.lgArmKillRate * runKill;
  return lgPerOpp * opp - ((f.armAdv || 0) * runAdv + (f.armKill || 0) * runKill);
}

/**
 * DPR（二遊間の併殺転換）run。対リーグ平均転換率より多く転換した分がプラス。
 * 1件の併殺は 2B・SS が共同で成立させる1イベントで、game.mjs は機会/成立を両者へフル計上する。
 * runPerDP はこの「1イベント」あたりの対称run価値（FRV: Double Plays 1 = .4）なので、
 * 二重帰属を避けるため参加者ぶん (dpShare=0.5) を配分する。
 */
export function dprRunsAboveAvg(ps, cfg, lc) {
  const f = ps.fielding;
  const opp = f.dpOpp || 0;
  if (!opp || !lc || lc.lgDPRate == null) return 0;
  return ((f.dpTurned || 0) - lc.lgDPRate * opp) * cfg.tuning.field.runPerDP * cfg.tuning.field.dpShare;
}

/**
 * 捕手 rSB（盗塁阻止run）。FRV: "Catcher Stealing Runs is a translation of Caught Stealing
 * Above Average to a run value on a .65 runs/CS basis, the difference between a SB (+.2 runs)
 * and a CS (-.45 runs)"（正典§8.4）。
 * .65 を天下りで置かず、この得点環境の runSB − runCS から導出する。
 *   rSB = (刺CS − リーグCS率×企図) × (runSB − runCS)
 * リーグΣ rSB = 0（厳密）。
 */
export function catcherRsbRuns(ps, cfg, lc) {
  const f = ps.fielding;
  const sb = f.sbAllowed || 0;
  const cs = f.csMade || 0;
  const att = sb + cs;
  if (!att || !lc) return 0;
  const lgAtt = (lc.lgSB || 0) + (lc.lgCS || 0);
  if (!lgAtt) return 0;
  const lgCsRate = (lc.lgCS || 0) / lgAtt;
  const runPerCs = cfg.tuning.run.runSB - (lc.runCS ?? cfg.tuning.run.runCS); // FRV の .65 と同型の導出
  return (cs - lgCsRate * att) * runPerCs;
}

/**
 * 捕手ブロッキング run（FRV: "Catcher Blocking 1 = .25 runs"）。
 * ワンバウンド機会あたりの (暴投+捕逸) 率がリーグ平均より低いほどプラス。リーグΣ = 0。
 */
export function catcherBlockRuns(ps, cfg, lc) {
  const f = ps.fielding;
  const opp = f.blockOpp || 0;
  if (!opp || !lc || lc.lgBlockFailRate == null) return 0;
  const fails = (f.wp || 0) + (f.pb || 0);
  return (lc.lgBlockFailRate * opp - fails) * cfg.tuning.field.runPerBlock;
}

/** 捕手守備 run（UZRは付けない・正典§1.1）= ErrR + framing + blocking + rSB */
export function catcherDefenseRuns(ps, cfg, lc) {
  return (
    errRunsAboveAvg(ps, cfg, lc) +
    (ps.fielding.framingRuns || 0) +
    catcherBlockRuns(ps, cfg, lc) +
    catcherRsbRuns(ps, cfg, lc)
  );
}

/**
 * UZR成分分解（表示用）。ポジションに応じて FanGraphs 定義の成分だけを持つ。
 * total は WAR用 uzrRuns と厳密一致する（表示とWARが食い違わない）。
 */
export function uzrComponents(ps, cfg, lc) {
  const pos = mainPosition(ps.fielding);
  if (pos === 'C') {
    const errR = errRunsAboveAvg(ps, cfg, lc);
    const framing = ps.fielding.framingRuns || 0;
    const blocking = catcherBlockRuns(ps, cfg, lc);
    const rSB = catcherRsbRuns(ps, cfg, lc);
    return { pos, rngR: 0, errR, framing, blocking, rSB, arm: 0, dpr: 0, total: errR + framing + blocking + rSB };
  }
  const isOF = OUTFIELD.has(pos);
  const rpo = isOF ? cfg.tuning.field.runPerOutOutfield : cfg.tuning.field.runPerOutInfield;
  const rngR = centeredOAAOuts(ps, lc) * rpo;
  const errR = errRunsAboveAvg(ps, cfg, lc);
  const arm = isOF ? armRunsAboveAvg(ps, cfg, lc) : 0;
  const dpr = isOF ? 0 : dprRunsAboveAvg(ps, cfg, lc);
  return { pos, rngR, errR, framing: 0, blocking: 0, rSB: 0, arm, dpr, total: rngR + errR + arm + dpr };
}

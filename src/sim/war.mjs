// ============================================================================
// WAR算出（2-9 / §9）— 企画の一番の売り「WARまで自然に出る」
//
// 野手WAR = (wRAA + BsR + UZR + posAdj + repl) / RPW
// 投手WAR = (IP/9 × (replFIP − FIP)) / RPW,  replFIP = lgFIP × replFipMult
//
// 各項はここまでの副産物（wRAA=1-7, BsR=2-4/2-6, UZR=2-8, posAdj=位置補正, repl=代替水準）。
// 位置価値は posAdj の一箇所のみで計上（UZR側で二重計上しない・レビューB-5）。
// 試合数依存定数(1350/600)は §18/M3 に従い config・143試合基準を尊重。
// ============================================================================
import { playerBatting, playerPitching, playerBaserunning } from './metrics.mjs';
import { uzrRuns } from './fielding.mjs';
import { POSITION_ADJUST_PER_1350 } from '../model/positions.mjs';

/** 守備位置補正（runs）。各ポジションの守備イニングに比例（§9・BR式 /1350）。 */
export function posAdjRuns(ps) {
  let adj = 0;
  for (const pos of Object.keys(ps.fielding.positionOuts)) {
    const innings = ps.fielding.positionOuts[pos] / 3;
    adj += (POSITION_ADJUST_PER_1350[pos] || 0) * (innings / 1350);
  }
  return adj;
}

/** 野手WAR（構成要素つき） */
export function hitterWAR(ps, cfg, lc) {
  const bat = playerBatting(ps, lc);
  const bsr = playerBaserunning(ps, cfg, lc).bsr;
  const uzr = uzrRuns(ps, cfg, lc);
  const posAdj = posAdjRuns(ps);
  const repl = (ps.batting.pa / 600) * cfg.tuning.replBatterPer600;
  const rpw = lc.rpw || 9.3;
  const raRuns = bat.wraa + bsr + uzr + posAdj + repl;
  return {
    wraa: bat.wraa,
    bsr,
    uzr,
    posAdj,
    repl,
    war: raRuns / rpw,
  };
}

/** 投手WAR */
export function pitcherWAR(ps, cfg, lc) {
  const pit = playerPitching(ps, lc);
  const lgFIP = lc.lgFIP || 3.8;
  const replFIP = lgFIP * cfg.tuning.replFipMult;
  const rpw = lc.rpw || 9.3;
  const war = ((pit.ip / 9) * (replFIP - pit.fip)) / rpw;
  return { ip: pit.ip, fip: pit.fip, replFIP, war };
}

/** 選手のWAR（役割で分岐） */
export function playerWAR(player, ps, cfg, lc) {
  return player.role === 'pitcher' ? pitcherWAR(ps, cfg, lc).war : hitterWAR(ps, cfg, lc).war;
}

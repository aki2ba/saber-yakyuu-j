// ============================================================================
// WAR算出（2-9 / §9）— 企画の一番の売り「WARまで自然に出る」
//
// 野手WAR = (wRAA + BsR + UZR + posAdj + repl) / RPW
// 投手WAR = (lgFIP − FIP)/9 × IP / RPW + (IP/9) × replPer9(役割)
//   役割別代替水準（S3・FanGraphs方式 B-5）: 先発 0.12 / 救援 0.03 wins/9IP を GS/G で按分
//   （旧 replFIP = lgFIP × replFipMult は廃止）
//
// 各項はここまでの副産物（wRAA=1-7, BsR=2-4/2-6, UZR=2-8, posAdj=位置補正, repl=代替水準）。
// 位置価値は posAdj の一箇所のみで計上（UZR側で二重計上しない・レビューB-5）。
// 試合数依存定数(1350/600)は §18/M3 に従い config・143試合基準を尊重。
// ============================================================================
import { playerBatting, playerPitching, playerBaserunning } from './metrics.mjs';
import { uzrRuns } from './fielding.mjs';
import { POSITION_ADJUST_PER_162G, POSITION_ADJUST_INNINGS_FULL } from '../model/positions.mjs';

/**
 * 守備位置補正（runs）。各ポジションの守備イニングに比例する。
 * FanGraphs 式: `posAdj = Σ_pos ( 値[pos] × (そのポジションの守備イニング / 1458) )`
 *   ＝ `((Innings/9) / 162) × 値`。分母は **1458**（162守備試合×9イニング）であり 1350 ではない。
 * 旧実装は FanGraphs の値に Baseball-Reference の分母(1350)を掛けており、補正を 8% 過大に与えていた。
 * 正典: sabermetrics_glossary.md §7.5 / §10.3
 */
export function posAdjRuns(ps) {
  let adj = 0;
  for (const pos of Object.keys(ps.fielding.positionOuts)) {
    const innings = ps.fielding.positionOuts[pos] / 3;
    adj += (POSITION_ADJUST_PER_162G[pos] || 0) * (innings / POSITION_ADJUST_INNINGS_FULL);
  }
  return adj;
}

/**
 * 代替水準（野手）を run 単位で返す（内訳表示の単位を wraa/bsr/uzr/posAdj と揃えるため）。
 * FanGraphs 方式: リーグ全体の代替勝利の総量を固定し、打席比で按分してから rpw を掛けて run へ戻す。
 *   代替wins(選手) = 代替wins(リーグ総量) × PA / lgPA
 *   代替runs(選手) = 代替wins(選手) × rpw
 * → 代替勝利は得点環境にもリーグ総打席にも依存しない（時代が動いても総WARが動かない）。
 * lc が無い（単体呼び出し・テスト）場合のみ、旧来の (PA/600)×replBatterPer600 [run] にフォールバックする。
 */
function replacementRuns(ps, cfg, lc, rpw) {
  if (lc && lc.replHitterWinsTotal && lc.lgPA) {
    return lc.replHitterWinsTotal * (ps.batting.pa / lc.lgPA) * rpw;
  }
  return (ps.batting.pa / 600) * cfg.tuning.replBatterPer600;
}

/** 野手WAR（構成要素つき） */
export function hitterWAR(ps, cfg, lc) {
  const bat = playerBatting(ps, lc);
  const bsr = playerBaserunning(ps, cfg, lc).bsr;
  const uzr = uzrRuns(ps, cfg, lc);
  const posAdj = posAdjRuns(ps);
  const rpw = lc.rpw || 9.3;
  const repl = replacementRuns(ps, cfg, lc, rpw);
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

/** 投手WAR（役割別代替水準・S3）。平均比の価値 + 役割別の代替水準ボーナス。
 *  救援WARのレバレッジ加重（§B2・FG方式・req_1 §8.3「WARの死角」の完成）:
 *    登板時レバレッジ gmLI があるとき、救援ぶんの代替水準対比runに (1+gmLI)/2 を乗じる。
 *    先発は不変（gsShare で加重＝gsShare=1 なら mult=1）。gmLI 未算出（文脈指標オフ＝
 *    gmLiN=0）のときは mult=1 に落ちるため、既存の較正済みWARは完全に不変（30指標を守る）。 */
export function pitcherWAR(ps, cfg, lc) {
  const pit = playerPitching(ps, lc);
  const lgFIP = lc.lgFIP || 3.8;
  const rpw = lc.rpw || 9.3;
  // 役割 = GS/G 比で先発/救援を按分（スイングマンは中間の代替水準になる）
  const gsShare = pit.g ? pit.gs / pit.g : 0;
  const replPer9 = gsShare * cfg.tuning.replStarterPer9 + (1 - gsShare) * cfg.tuning.replRelieverPer9;
  let war = (((lgFIP - pit.fip) / 9) * pit.ip) / rpw + (pit.ip / 9) * replPer9;
  // レバレッジ加重（救援ぶんのみ・gmLI があるとき）
  const gmLiN = ps.pitching.gmLiN || 0;
  const gmLI = gmLiN ? ps.pitching.gmLiSum / gmLiN : null;
  const leverageMult = gmLI != null ? 1 + (1 - gsShare) * ((1 + gmLI) / 2 - 1) : 1;
  war *= leverageMult;
  return { ip: pit.ip, fip: pit.fip, replPer9, gmLI, leverageMult, war };
}

/** 選手のWAR（役割で分岐） */
export function playerWAR(player, ps, cfg, lc) {
  return player.role === 'pitcher' ? pitcherWAR(ps, cfg, lc).war : hitterWAR(ps, cfg, lc).war;
}

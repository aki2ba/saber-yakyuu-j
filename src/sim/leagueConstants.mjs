// ============================================================================
// リーグ定数導出パス（1-6 / 自己レビュー F2・F31・F46）
//
// 2パス構造: pass1 でシーズンを実走・集計 → 本モジュールでシムのラン環境から
// 線形ウェイト・lgwOBA・wOBAscale・FIP定数・RPW を導出 → pass2 で各指標を確定。
// §18 の 13.3/1.216 等は「初期値」であり、ここで 12球団143試合NPB環境へ再導出する。
// ============================================================================
import { leagueBatting, leaguePitching } from './leagueStats.mjs';
import { mainPosition, totalFieldInnings } from './fielding.mjs';

// 各イベントの得点価値（アウト基準=0の線形ウェイト・runs単位）。FanGraphs標準の
// "runs above out" 系（wRAAが正しいラン単位になり、WARの絶対値が文献スケールに乗る・レビューB-2）。
// run-expectancy からの厳密導出は将来（コード自身の予告）。
export const LINEAR_WEIGHTS = {
  bb: 0.55,
  hbp: 0.58,
  b1: 0.7,
  b2: 1.0,
  b3: 1.27,
  hr: 1.65,
};

/** 打撃イベント合計から「アウト基準の得点価値/打席」を出す（wOBAの素） */
export function rawRunValuePerPA(bat, W = LINEAR_WEIGHTS) {
  const denom = bat.ab + bat.bb + bat.hbp + bat.sf;
  if (!denom) return 0;
  const num = W.bb * bat.bb + W.hbp * bat.hbp + W.b1 * bat.b1 + W.b2 * bat.b2 + W.b3 * bat.b3 + W.hr * bat.hr;
  return num / denom;
}

/**
 * シーズン結果からリーグ定数を導出。cfg.leagueConstants に相当する構造を返す。
 * @param {{playerSeasons:Array, standings:Array}} res
 */
export function deriveLeagueConstants(res) {
  const bat = leagueBatting(res.playerSeasons);
  const pit = leaguePitching(res.playerSeasons);

  // --- wOBA 系（lgwOBA を lgOBP スケールへ正規化）---
  const lgRawPerPA = rawRunValuePerPA(bat); // アウト基準の得点価値/打席
  const lgOBP = bat.obp;
  const wobaScale = lgRawPerPA > 0 ? lgOBP / lgRawPerPA : 1; // wOBA = wobaScale × raw で lgwOBA=lgOBP
  const lgwOBA = lgOBP;

  // wRC+ 用: リーグの総得点/打席
  const totalRuns = res.standings.reduce((a, t) => a + t.rs, 0);
  const lgRunsPerPA = bat.pa ? totalRuns / bat.pa : 0;

  // --- FIP 定数（lgFIP を lgERA に一致させる）---
  const ip = pit.outs / 3;
  const fipRawLeague = ip ? (13 * pit.hr + 3 * (pit.bb + pit.hbp) - 2 * pit.so) / ip : 0;
  const lgERA = pit.era;
  const fipConstant = lgERA - fipRawLeague;
  const lgFIP = lgERA; // 定義上一致

  // --- RPW（Runs Per Win, Tango近似 1.5×RG+3。RG=1チーム1試合の得点）---
  const gamesPerTeam = res.standings.reduce((a, t) => a + t.g, 0) / res.standings.length;
  const runsPerGamePerTeam = gamesPerTeam ? totalRuns / res.standings.length / gamesPerTeam : 4.2;
  const rpw = 1.5 * runsPerGamePerTeam + 3;

  // 併殺リーグ率（wGDPの基準・§6）
  let totGDP = 0;
  let totGDPOpp = 0;
  for (const ps of res.playerSeasons) {
    totGDP += ps.batting.gdp;
    totGDPOpp += ps.baserunning.gdpOpp;
  }
  const lgGDPrate = totGDPOpp ? totGDP / totGDPOpp : 0;

  // 追加進塁リーグ率（UBRの基準・§6）
  let totAdv = 0;
  let totAdvOpp = 0;
  for (const ps of res.playerSeasons) {
    totAdv += ps.baserunning.advTaken;
    totAdvOpp += ps.baserunning.advOpp;
  }
  const lgAdvRate = totAdvOpp ? totAdv / totAdvOpp : 0;

  // wSB中心化の基準（監査C1・§6）: リーグの盗塁/盗塁死と、盗塁母数=一塁到達(1B+BB+HBP-IBB)。
  // metrics側で lgwSB = (ΣSB×runSB+ΣCS×runCS)/Σ機会 を作り、走者の機会分だけ基準控除する。
  let lgSB = 0;
  let lgCS = 0;
  let lgSBOpp = 0;
  for (const ps of res.playerSeasons) {
    const b = ps.batting;
    lgSB += b.sb;
    lgCS += b.cs;
    lgSBOpp += b.b1 + b.bb + b.hbp - b.ibb;
  }

  // ポジション別 OAA/イニング・失策/イニング 平均（UZRの範囲成分/失策成分を
  // 「そのポジションで守る選手の平均=0」に中心化するため。§7.2・監査A3）
  const posAgg = {};
  for (const ps of res.playerSeasons) {
    const inn = totalFieldInnings(ps.fielding);
    if (inn < 1) continue;
    const pos = mainPosition(ps.fielding);
    if (!posAgg[pos]) posAgg[pos] = { oaa: 0, inn: 0, err: 0 };
    posAgg[pos].oaa += ps.fielding.oaaOuts;
    posAgg[pos].inn += inn;
    posAgg[pos].err += ps.fielding.e || 0;
  }
  const oaaCenterPerInn = {};
  const errCenterPerInn = {};
  for (const pos of Object.keys(posAgg)) {
    oaaCenterPerInn[pos] = posAgg[pos].oaa / posAgg[pos].inn;
    errCenterPerInn[pos] = posAgg[pos].err / posAgg[pos].inn;
  }

  return {
    lgGDPrate,
    lgAdvRate,
    lgSB,
    lgCS,
    lgSBOpp,
    oaaCenterPerInn,
    errCenterPerInn,
    linearWeights: { ...LINEAR_WEIGHTS },
    lgRawPerPA,
    wobaScale,
    lgwOBA,
    lgOBP,
    lgRunsPerPA,
    lgERA,
    lgFIP,
    fipConstant,
    rpw,
    // WAR 用の位置補正は §9/positions の per-1350 値を使う（143試合再スケールはWAR算出2-9で）
  };
}

/** シーズンを走らせてから cfg.leagueConstants を埋める（2パスの糊） */
export function fillLeagueConstants(cfg, res) {
  cfg.leagueConstants = { ...cfg.leagueConstants, ...deriveLeagueConstants(res) };
  return cfg.leagueConstants;
}

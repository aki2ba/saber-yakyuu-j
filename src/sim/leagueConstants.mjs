// ============================================================================
// リーグ定数導出パス（1-6 / 自己レビュー F2・F31・F46）
//
// 2パス構造: pass1 でシーズンを実走・集計 → 本モジュールでシムのラン環境から
// 線形ウェイト・lgwOBA・wOBAscale・FIP定数・RPW を導出 → pass2 で各指標を確定。
// §18 の 13.3/1.216 等は「初期値」であり、ここで 12球団143試合NPB環境へ再導出する。
// ============================================================================
import { leagueBatting, leaguePitching } from './leagueStats.mjs';
import { mainPosition, totalFieldInnings } from './fielding.mjs';
import { deriveParkFactors } from './parkFactor.mjs';

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

/** 打撃イベント合計から「アウト基準の得点価値/打席」を出す（wOBAの素）。
 *  FG定義準拠（S3）: 分子は uBB=BB−IBB（敬遠は打者の技量でない）、分母 = AB+BB−IBB+SF+HBP。 */
export function rawRunValuePerPA(bat, W = LINEAR_WEIGHTS) {
  const ibb = bat.ibb || 0;
  const denom = bat.ab + bat.bb - ibb + bat.sf + bat.hbp;
  if (!denom) return 0;
  const num =
    W.bb * (bat.bb - ibb) + W.hbp * bat.hbp + W.b1 * bat.b1 + W.b2 * bat.b2 + W.b3 * bat.b3 + W.hr * bat.hr;
  return num / denom;
}

/**
 * シーズン結果からリーグ定数を導出。cfg.leagueConstants に相当する構造を返す。
 * @param {{playerSeasons:Array, standings:Array}} res
 */
export function deriveLeagueConstants(res, cfg = null) {
  const bat = leagueBatting(res.playerSeasons);
  const pit = leaguePitching(res.playerSeasons);

  // パークファクター（D2・§11.2）: 順位表の本拠地/敵地 得点スプリットから球団PFを導出。
  //   metrics 側で wRC+/ERA-/FIP- の park補正版フィールドに接続する（ps.teamId でルックアップ）。
  //   スプリットが無い（古い呼び出し/中立単一park）場合は空Map＝park補正=素の値（後方互換）。
  const hasSplits = (res.standings || []).some((t) => (t.hpG || 0) > 0 && (t.rpG || 0) > 0);
  const pf = hasSplits ? deriveParkFactors(res.standings, cfg) : null;

  // --- wOBA 系（lgwOBA を lgOBP スケールへ正規化）---
  const lgRawPerPA = rawRunValuePerPA(bat); // アウト基準の得点価値/打席
  const lgOBP = bat.obp;
  const wobaScale = lgRawPerPA > 0 ? lgOBP / lgRawPerPA : 1; // wOBA = wobaScale × raw で lgwOBA=lgOBP
  const lgwOBA = lgOBP;

  // wRC+ 用: リーグの総得点/打席
  const totalRuns = res.standings.reduce((a, t) => a + t.rs, 0);
  const lgRunsPerPA = bat.pa ? totalRuns / bat.pa : 0;

  // --- FIP 定数（lgFIP を lgERA に一致させる。FG式＝IBB除外・S3）---
  const ip = pit.outs / 3;
  const fipRawLeague = ip ? (13 * pit.hr + 3 * (pit.bb - (pit.ibb || 0) + pit.hbp) - 2 * pit.so) / ip : 0;
  const lgERA = pit.era;
  const fipConstant = lgERA - fipRawLeague;
  const lgFIP = lgERA; // 定義上一致

  // xFIP用のリーグ HR/FB（§B3a）: リーグ総被HR ÷ リーグ総被フライ。
  // これで Σ(被FB×lgHRFB)=ΣHR となり、リーグ xFIP=リーグ FIP=リーグ ERA が恒等成立する。
  let totFB = 0;
  for (const ps of res.playerSeasons) totFB += ps.pitching.bbFB;
  const lgHRFB = totFB ? pit.hr / totFB : 0;
  const lgSLG = bat.slg; // OPS+ の基準（§B3a）

  // --- RPW（Runs Per Win, Tango近似 1.5×RG+3。RG=1チーム1試合の得点）---
  const gamesPerTeam = res.standings.reduce((a, t) => a + t.g, 0) / res.standings.length;
  const runsPerGamePerTeam = gamesPerTeam ? totalRuns / res.standings.length / gamesPerTeam : 4.2;
  const rpw = 1.5 * runsPerGamePerTeam + 3;

  // 盗塁の得点価値（正典 sabermetrics_glossary.md §6.2・一次: FanGraphs Library wSB）
  //   runSB = +0.2（全シーズン固定）
  //   runCS = −(2 × RunsPerOut + 0.075)  ← 得点環境依存の可変式
  // 旧実装は runCS を固定値 -0.38 にしていたため、時代トレンドで得点環境が動くと原典から乖離した。
  // RunsPerOut = リーグ総得点 / リーグ総アウト数（＝投手の記録した総アウト）。
  let totalOuts = 0;
  for (const ps of res.playerSeasons) totalOuts += ps.pitching.outs;
  const lgRunsPerOut = totalOuts ? totalRuns / totalOuts : 0;
  const runCS = -(2 * lgRunsPerOut + 0.075);

  // 併殺リーグ率（wGDPの基準・§6）
  let totGDP = 0;
  let totGDPOpp = 0;
  for (const ps of res.playerSeasons) {
    totGDP += ps.batting.gdp;
    totGDPOpp += ps.baserunning.gdpOpp;
  }
  const lgGDPrate = totGDPOpp ? totGDP / totGDPOpp : 0;

  // 二遊間 併殺転換率（DPRの基準・§B3b）: 守備側の機会/成立から。lgDPRate= Σ成立/Σ機会。
  // 各機会は 2B・SS の両者に計上されるため分母/分子とも2倍だが比は不変（DPRの対平均は0中心）。
  // ※1件の併殺のrun価値は二遊間で共有する1イベントなので、metrics側(dprRunsAboveAvg)で
  //   dpShare=0.5 を掛けて参加者に配分する（両者へのフル二重帰属を防ぐ・単一計上のチーム値に一致）。
  let totDPturned = 0;
  let totDPopp = 0;
  for (const ps of res.playerSeasons) {
    totDPturned += ps.fielding.dpTurned || 0;
    totDPopp += ps.fielding.dpOpp || 0;
  }
  const lgDPRate = totDPopp ? totDPturned / totDPopp : 0;

  // 外野ARMの基準（実イベント創発）: 追加進塁機会あたりの「進塁を許した率」「刺した率」。
  // fielding.mjs が ARM = lgPerOpp×opp − (adv×runUBR + kill×runCS) で対平均run換算する
  // （リーグΣ ARM = 0 が厳密成立）。
  let totArmOpp = 0;
  let totArmAdv = 0;
  let totArmKill = 0;
  // 捕手ブロッキングの基準: ワンバウンド機会あたりの (暴投+捕逸) 率
  let totBlockOpp = 0;
  let totWpPb = 0;
  for (const ps of res.playerSeasons) {
    const f = ps.fielding;
    totArmOpp += f.armOpp || 0;
    totArmAdv += f.armAdv || 0;
    totArmKill += f.armKill || 0;
    totBlockOpp += f.blockOpp || 0;
    totWpPb += (f.wp || 0) + (f.pb || 0);
  }
  const lgArmAdvRate = totArmOpp ? totArmAdv / totArmOpp : 0;
  const lgArmKillRate = totArmOpp ? totArmKill / totArmOpp : 0;
  const lgBlockFailRate = totBlockOpp ? totWpPb / totBlockOpp : 0;

  // 追加進塁リーグ率（UBRの基準・§6／§req_20260708強化）。
  // 実際のUBR/EqBRR（Fangraphs/Baseball Prospectus）はシナリオ別（単打での二塁走者本塁突入・
  // 二塁打での一塁走者本塁突入・単打での一塁走者三塁進塁・タッグアップ等）にRE24分解して評価する。
  // lgAdvRateは後方互換の全シナリオ合算（XBT%表示用）、各シナリオ別のリーグ率を別途算出する。
  let totAdv = 0;
  let totAdvOpp = 0;
  const scenarioTotals = { adv2h1b: [0, 0], adv1h2b: [0, 0], adv1t3b: [0, 0], tag: [0, 0] };
  for (const ps of res.playerSeasons) {
    const br = ps.baserunning;
    totAdv += br.advTaken;
    totAdvOpp += br.advOpp;
    for (const k of Object.keys(scenarioTotals)) {
      scenarioTotals[k][0] += br[`${k}Taken`] || 0;
      scenarioTotals[k][1] += br[`${k}Opp`] || 0;
    }
  }
  const lgAdvRate = totAdvOpp ? totAdv / totAdvOpp : 0;
  const lgAdvRateByScenario = {};
  for (const k of Object.keys(scenarioTotals)) {
    const [taken, opp] = scenarioTotals[k];
    lgAdvRateByScenario[k] = opp ? taken / opp : 0;
  }

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
    lgDPRate,
    lgArmAdvRate,
    lgArmKillRate,
    lgBlockFailRate,
    lgAdvRate,
    lgAdvRateByScenario,
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
    lgRunsPerOut,
    runCS,
    lgSLG,
    lgHRFB,
    lgERA,
    lgFIP,
    fipConstant,
    rpw,
    // パークファクター（D2・§11.2）: 球団PF。metrics の park補正版フィールドが参照する。
    parkBatByTeam: pf ? pf.pfBatByTeam : null,
    parkPitByTeam: pf ? pf.pfPitByTeam : null,
    parkRunsByTeam: pf ? pf.pfRunsByTeam : null,
    // WAR 用の位置補正は §9/positions の per-1350 値を使う（143試合再スケールはWAR算出2-9で）
  };
}

/** シーズンを走らせてから cfg.leagueConstants を埋める（2パスの糊） */
export function fillLeagueConstants(cfg, res) {
  cfg.leagueConstants = { ...cfg.leagueConstants, ...deriveLeagueConstants(res, cfg) };
  return cfg.leagueConstants;
}

// ============================================================================
// 較正ハーネス（フェーズA S4 / phaseA_spec.md「較正目標」表の全実装）
// config.tuning のノブを上書きして複数リーグ×シーズンを実走し、
// リーグ集計・リーダー値・采配/起用の発現を NPB 目標帯と突合して PASS/FAIL 表示する。
//
// 使い方: OVERRIDES を編集して `node tools/calibrate.mjs` を再実行し、目標帯に寄せる（S5）。
// 判定基準は config.mjs の CALIBRATION_TARGETS（12球団143試合2リーグ制）。
//   - セ・パ得点差は「試合のDH規則単位」= res.runSplit で見る（所属リーグ単位は
//     球団戦力ノイズで符号が反転しうる・S3引き継ぎ）。
//   - WAR下限（200PA野手のmin）は全シードの最悪値で判定（「WAR-6の根絶」保証のため）。
//   - ポストシーズンは較正対象外につき省略（opts.postseason=false で高速化）。
// ============================================================================
import { createConfig, CALIBRATION_TARGETS, inRange, qualifiedPA } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { leagueSummary, leagueSummaryByLeague } from '../src/sim/leagueStats.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { hitterWAR, pitcherWAR } from '../src/sim/war.mjs';
// --- フェーズB B3c 追加系指標の健全性チェック用（既存30には一切影響しない） ---
import { createBattingLine, createPitchingLine, addBattingLine, addPitchingLine } from '../src/model/statline.mjs';
import { playerBatting, playerPitching } from '../src/sim/metrics.mjs';
import { armRunsAboveAvg, mainPosition, totalFieldInnings } from '../src/sim/fielding.mjs';

const OUTFIELD = new Set(['LF', 'CF', 'RF']);

// ---- 調整対象ノブ（ここを編集して収束させる） ----
// 較正結果は src/config.mjs のデフォルトに焼込済。空＝デフォルト構成を検証（回帰チェック）。
const OVERRIDES = {};

const SEEDS = [1,2,3,4,5,6,7,8,9,10,11,12]; // tail指標の安定化のため12シード平均

function runOnce(seed) {
  const cfg = createConfig(OVERRIDES);
  const lg = generateLeague(seed, cfg);
  const res = simulateSeason(lg, cfg, { season: 2026, seed, postseason: false });
  const numTeams = cfg.league.numTeams;
  const summary = leagueSummary(res, numTeams);

  // --- セ・パ得点差（DH規則単位: 得点/チーム/試合 の DH有−DH無） ---
  const rpg = (sp) => (sp.games ? sp.runs / sp.games / 2 : 0);
  const runDiffDh = rpg(res.runSplit.dh) - rpg(res.runSplit.noDh);

  // --- リーグ別（犠打のセパ差・情報表示用の得点環境） ---
  const byLeague = leagueSummaryByLeague(res, lg.teams);
  const dhL = cfg.league.leagues.find((l) => l.dh);
  const noDhL = cfg.league.leagues.find((l) => !l.dh);
  const teamsPerLeague = numTeams / cfg.league.leagues.length;
  const shPerTeamDh = byLeague[dhL.id].batting.sh / teamsPerLeague;
  const shPerTeamNoDh = byLeague[noDhL.id].batting.sh / teamsPerLeague;
  const ibbPerTeam = summary.batting.ibb / numTeams;

  // --- 打撃リーダー（分布の裾。規定打席 = G×3.1 = 443） ---
  const qualPA = qualifiedPA(cfg.league.gamesPerSeason);
  const qual = res.playerSeasons.filter((s) => s.batting.ab > 0 && s.batting.pa >= qualPA);
  const champAvg = Math.max(...qual.map((s) => s.batting.h / s.batting.ab));
  const hrLeader = Math.max(...res.playerSeasons.map((s) => s.batting.hr));
  const rbiLeader = Math.max(...res.playerSeasons.map((s) => s.batting.rbi));
  const sbLeader = Math.max(...res.playerSeasons.map((s) => s.batting.sb));

  // --- 投手リーダー・完投（役割は観測 GS/G 過半で先発/救援に判定） ---
  let ipStarterLeader = 0;
  let reliefGLeader = 0;
  let svLeader = 0;
  let hldLeader = 0;
  let cgLeague = 0;
  for (const s of res.playerSeasons) {
    const p = s.pitching;
    if (!p.g) continue;
    if (p.gs > 0 && p.gs * 2 >= p.g) ipStarterLeader = Math.max(ipStarterLeader, p.outs / 3);
    else reliefGLeader = Math.max(reliefGLeader, p.g);
    svLeader = Math.max(svLeader, p.sv);
    hldLeader = Math.max(hldLeader, p.hld);
    cgLeague += p.cg;
  }

  // --- WAR（総量・比率・リーダー・下限） ---
  const lc = deriveLeagueConstants(res);
  const byId = new Map(lg.players.map((p) => [p.id, p]));
  let warHit = 0;
  let warPit = 0;
  let warHitLeader = -Infinity;
  let warPitLeader = -Infinity;
  let warFloor200 = Infinity; // 200PA以上の野手の最小WAR（「WAR-6の根絶」＝起用AIの機能証明）
  for (const s of res.playerSeasons) {
    const p = byId.get(s.playerId);
    if (p.role === 'pitcher') {
      const w = pitcherWAR(s, cfg, lc).war;
      warPit += w;
      warPitLeader = Math.max(warPitLeader, w);
    } else {
      const w = hitterWAR(s, cfg, lc).war;
      warHit += w;
      warHitLeader = Math.max(warHitLeader, w);
      if (s.batting.pa >= 200) warFloor200 = Math.min(warFloor200, w);
    }
  }

  // --- 起用の発現（規定打席到達者/球団・正捕手の先発出場） ---
  const qualByTeam = new Map(lg.teams.map((t) => [t.id, 0]));
  for (const s of qual) qualByTeam.set(s.teamId, (qualByTeam.get(s.teamId) ?? 0) + 1);
  const qualifiedPerTeam = [...qualByTeam.values()].reduce((a, v) => a + v, 0) / numTeams;
  let catcherSum = 0;
  for (const t of lg.teams) {
    let mx = 0; // 正捕手 = 捕手先発が最多の選手
    for (const [, posMap] of res.usageByTeam.get(t.id).startsAtPos) mx = Math.max(mx, posMap.get('C') ?? 0);
    catcherSum += mx;
  }
  const catcherStarterGames = catcherSum / numTeams;

  // --- フェーズB B3c 追加系指標（非context・§B3）: 既存の生カウントから湧く集計のみ。
  //     lc/summary/WAR には一切触れない＝上の既存30指標の値は完全に不変。 ---
  const lgBat = createBattingLine();
  const lgPit = createPitchingLine();
  for (const s of res.playerSeasons) {
    addBattingLine(lgBat, s.batting);
    addPitchingLine(lgPit, s.pitching);
  }
  const lgBm = playerBatting({ batting: lgBat }, lc); // リーグ集計の wOBA/xwOBA
  const lgPm = playerPitching({ pitching: lgPit }, lc, cfg); // リーグ集計の LOB%
  let armLeader = -Infinity; // 外野ARM上位（規定守備の外野手・対平均run）
  for (const s of res.playerSeasons) {
    if (OUTFIELD.has(mainPosition(s.fielding)) && totalFieldInnings(s.fielding) >= 400) {
      armLeader = Math.max(armLeader, armRunsAboveAvg(s, lc));
    }
  }
  let totQS = 0;
  let totGS = 0;
  // --- B1-3 規律系: 先発投球数/試合・WP+PB/球団・フレーミング上位（一球の副産物）---
  let starterPitches = 0;
  let starterStarts = 0;
  let wpPbTotal = 0;
  let framingLeader = -Infinity;
  for (const s of res.playerSeasons) {
    const p = s.pitching;
    totQS += p.qs;
    totGS += p.gs;
    if (p.gs > 0 && p.gs * 2 >= p.g) { starterPitches += p.pitches; starterStarts += p.gs; }
    wpPbTotal += s.fielding.wp + s.fielding.pb;
    if (mainPosition(s.fielding) === 'C' && totalFieldInnings(s.fielding) >= 400) {
      framingLeader = Math.max(framingLeader, s.fielding.framingRuns);
    }
  }
  // 規律系の率（リーグ集計の生カウントから。打者側=投手側の恒等なので lgBat を使用）---
  const disc = {
    pitchesPerPA: lgBat.pa ? lgBat.pitches / lgBat.pa : 0,
    zonePct: lgBat.pitches ? lgBat.zonePitches / lgBat.pitches : 0,
    oSwingPct: lgBat.oZonePitches ? lgBat.oSwings / lgBat.oZonePitches : 0,
    zSwingPct: lgBat.zonePitches ? lgBat.zSwings / lgBat.zonePitches : 0,
    contactPct: lgBat.swings ? (lgBat.swings - lgBat.whiffs) / lgBat.swings : 0,
    swStrPct: lgBat.pitches ? lgBat.whiffs / lgBat.pitches : 0,
    cswPct: lgBat.pitches ? (lgBat.calledStrikes + lgBat.whiffs) / lgBat.pitches : 0,
    fStrikePct: lgBat.pa ? lgBat.firstPitchStrikes / lgBat.pa : 0,
    starterPitchesPerGame: starterStarts ? starterPitches / starterStarts : 0,
    wpPbPerTeam: wpPbTotal / numTeams,
    framingLeader,
  };

  return {
    summary,
    runDiffDh,
    shPerTeamDh,
    shPerTeamNoDh,
    ibbPerTeam,
    rpgDhLeague: byLeague[dhL.id].runsPerTeamPerGame,
    rpgNoDhLeague: byLeague[noDhL.id].runsPerTeamPerGame,
    champAvg,
    hrLeader,
    rbiLeader,
    sbLeader,
    ipStarterLeader,
    reliefGLeader,
    svLeader,
    hldLeader,
    cgLeague,
    warTotal: warHit + warPit,
    warShare: warHit / (warHit + warPit),
    warHitLeader,
    warPitLeader,
    warFloor200,
    qualifiedPerTeam,
    catcherStarterGames,
    // --- フェーズB B3c 追加系（非context） ---
    woba: lgBm.woba,
    xwoba: lgBm.xwoba,
    xwobaDiff: Math.abs(lgBm.xwoba - lgBm.woba),
    lobPct: lgPm.lobPct,
    armLeader,
    qsRate: totGS ? totQS / totGS : 0,
    disc,
  };
}

/**
 * フェーズB 文脈指標（RE24/WPA/LI/SD/MD・§B2）の健全性を context 有効で確認する。
 * context=true は2パス（導出→再走）だが、pass2 の試合結果は非context単一パスと完全同一
 * （＝上の runOnce/既存30指標には一切影響しない・決定論不変）。少数シードで恒等式を検証する。
 */
function runContext(seed) {
  const cfg = createConfig(OVERRIDES);
  const lg = generateLeague(seed, cfg);
  const res = simulateSeason(lg, cfg, { season: 2026, seed, postseason: false, context: true });
  let re = 0;
  let liB = 0;
  let paB = 0;
  let liP = 0;
  let bf = 0;
  let totSD = 0;
  let totMD = 0;
  let sdLead = 0;
  let mdLead = 0;
  for (const ps of res.playerSeasons) {
    re += ps.batting.re24 + ps.baserunning.re24 + ps.pitching.re24;
    liB += ps.batting.liSum;
    paB += ps.batting.pa;
    liP += ps.pitching.liSum;
    bf += ps.pitching.bf;
    totSD += ps.pitching.sd;
    totMD += ps.pitching.md;
    sdLead = Math.max(sdLead, ps.pitching.sd);
    mdLead = Math.max(mdLead, ps.pitching.md);
  }
  return {
    re24Sum: re,
    wpaMaxErr: res.contextCheck.wpaMaxErr,
    aLI: paB ? liB / paB : 0,
    pLI: bf ? liP / bf : 0,
    totSD,
    totMD,
    sdLead,
    mdLead,
  };
}

// 複数シードの平均（WAR下限のみ最悪値=minで判定）
const runs = SEEDS.map(runOnce);
const sums = runs.map((r) => r.summary);
const avg = (fn) => sums.reduce((a, s) => a + fn(s), 0) / sums.length;
const avgR = (fn) => runs.reduce((a, r) => a + fn(r), 0) / runs.length;
const minR = (fn) => Math.min(...runs.map(fn));

const m = {
  avg: avg((s) => s.batting.avg),
  obp: avg((s) => s.batting.obp),
  slg: avg((s) => s.batting.slg),
  ops: avg((s) => s.batting.ops),
  kPct: avg((s) => s.batting.kPct),
  bbPct: avg((s) => s.batting.bbPct),
  babip: avg((s) => s.batting.babip),
  hrPerTeam: avg((s) => s.hrPerTeam),
  era: avg((s) => s.pitching.era),
  runsPTG: avg((s) => s.runsPerTeamPerGame),
};

const T = CALIBRATION_TARGETS;
let nPass = 0;
let nFail = 0;
const row = (label, val, range, dec = 3) => {
  let ok = '    ';
  if (range) {
    ok = inRange(val, range) ? 'PASS' : 'FAIL';
    if (ok === 'PASS') nPass++;
    else nFail++;
  }
  const rng = range ? `[${range[0]}, ${range[1]}]` : '';
  return `${ok}  ${label.padEnd(16)} ${val.toFixed(dec).padStart(8)}   ${rng}`;
};
// 片側条件（WAR下限: val > min で PASS）
const rowMin = (label, val, min, dec = 1) => {
  const ok = val > min ? 'PASS' : 'FAIL';
  if (ok === 'PASS') nPass++;
  else nFail++;
  return `${ok}  ${label.padEnd(16)} ${val.toFixed(dec).padStart(8)}   [> ${min}]`;
};

console.log('=== 較正ハーネス（seeds=' + SEEDS.join(',') + ' 平均 / フェーズA目標帯） ===');
console.log('overrides:', JSON.stringify(OVERRIDES.tuning));
console.log('');
console.log('--- 得点環境（リーグ合算） ---');
console.log(row('AVG', m.avg, T.batting.avg));
console.log(row('OBP', m.obp, T.batting.obp));
console.log(row('SLG', m.slg, T.batting.slg));
console.log(row('OPS', m.ops, T.batting.ops));
console.log(row('K%', m.kPct, T.batting.kPct));
console.log(row('BB%', m.bbPct, T.batting.bbPct));
console.log(row('BABIP', m.babip, null));
console.log(row('HR/team', m.hrPerTeam, T.batting.hrPerTeam, 1));
console.log(row('ERA', m.era, T.pitching.era, 2));
console.log(row('runs/tm/g', m.runsPTG, T.batting.runsPerTeamPerGame, 2));
console.log('');
console.log('--- セ・パ得点差（DH規則単位: DH有 − DH無 の R/チーム/試合） ---');
console.log(row('セパ得点差', avgR((r) => r.runDiffDh), T.batting.runDiffDhMinusNoDh, 3));
console.log(row('R/G(DH有Lg)', avgR((r) => r.rpgDhLeague), null, 2));
console.log(row('R/G(DH無Lg)', avgR((r) => r.rpgNoDhLeague), null, 2));
console.log('');
console.log('--- 打撃リーダー（分布の裾） ---');
console.log(row('打率王', avgR((r) => r.champAvg), T.leaders.avg));
console.log(row('HR王', avgR((r) => r.hrLeader), T.leaders.hr, 1));
console.log(row('打点王', avgR((r) => r.rbiLeader), T.leaders.rbi, 1));
console.log(row('盗塁王', avgR((r) => r.sbLeader), T.leaders.sb, 1));
console.log('');
console.log('--- 投手リーダー ---');
console.log(row('先発IPリーダー', avgR((r) => r.ipStarterLeader), T.leaders.ipStarter, 1));
console.log(row('登板数王(救援)', avgR((r) => r.reliefGLeader), T.leaders.reliefG, 1));
console.log(row('SV王', avgR((r) => r.svLeader), T.leaders.sv, 1));
console.log(row('HLD王', avgR((r) => r.hldLeader), T.leaders.hld, 1));
console.log('');
console.log('--- 采配の発現（犠打のセパ差・敬遠・完投） ---');
console.log(row('犠打/球団(セ系)', avgR((r) => r.shPerTeamNoDh), T.tactics.shPerTeamNoDh, 1));
console.log(row('犠打/球団(パ系)', avgR((r) => r.shPerTeamDh), T.tactics.shPerTeamDh, 1));
console.log(row('敬遠/球団', avgR((r) => r.ibbPerTeam), T.tactics.ibbPerTeam, 1));
console.log(row('完投(リーグ計)', avgR((r) => r.cgLeague), T.tactics.cgLeague, 1));
console.log('');
console.log('--- WAR（総量・比率・リーダー・下限） ---');
console.log(row('総WAR', avgR((r) => r.warTotal), T.war.totalLeague, 0));
console.log(row('野手WAR比', avgR((r) => r.warShare), T.war.hitterShare));
console.log(row('野手WAR王', avgR((r) => r.warHitLeader), T.war.leaderHitter, 1));
console.log(row('投手WAR王', avgR((r) => r.warPitLeader), T.war.leaderPitcher, 1));
console.log(rowMin('WAR破局(単一最悪)', minR((r) => r.warFloor200), T.war.floorCatastrophe)); // 全シード中の単一最悪
console.log(rowMin('WAR下限(典型平均)', avgR((r) => r.warFloor200), T.war.floorTypical)); // 各シーズン最悪の平均
console.log('');
console.log('--- 起用・休養の発現 ---');
console.log(row('規定到達/球団', avgR((r) => r.qualifiedPerTeam), T.usage.qualifiedPerTeam, 1));
console.log(row('正捕手先発試合', avgR((r) => r.catcherStarterGames), T.usage.catcherStarterGames, 1));
console.log('');
console.log(`=== PASS ${nPass} / FAIL ${nFail}（FAILはS5較正ループで収束させる） ===`);

// ============================================================================
// フェーズB B3c 追加系指標の健全性チェック（新規・上の既存30とは独立の帯）。
// 既存30は runOnce の summary/WAR から算出済みで、ここでの追加集計/context ランは
// それらに一切影響しない（値は完全不変）。ここは新指標の恒等式/妥当域を別集計で検証する。
// ============================================================================
let bPass = 0;
let bFail = 0;
const brow = (label, val, range, dec = 3) => {
  const ok = inRange(val, range) ? 'PASS' : 'FAIL';
  ok === 'PASS' ? bPass++ : bFail++;
  return `${ok}  ${label.padEnd(18)} ${val.toFixed(dec).padStart(9)}   [${range[0]}, ${range[1]}]`;
};
const babs = (label, val, tol) => {
  const ok = Math.abs(val) <= tol ? 'PASS' : 'FAIL';
  ok === 'PASS' ? bPass++ : bFail++;
  return `${ok}  ${label.padEnd(18)} ${val.toExponential(2).padStart(9)}   [|x| <= ${tol}]`;
};

const B = T.phaseB;
const CTX_SEEDS = [1, 2, 3]; // 文脈指標は恒等式検証＝少数シードで十分（context=2パスのため時間節約）
const ctxRuns = CTX_SEEDS.map(runContext);
const avgC = (fn) => ctxRuns.reduce((a, r) => a + fn(r), 0) / ctxRuns.length;

console.log('');
console.log('=== フェーズB 追加系指標の健全性チェック（新規・既存30とは独立） ===');
console.log('--- 規律系（一球シムの副産物・12シード平均・§B1-3） ---');
console.log(brow('投球数/PA', avgR((r) => r.disc.pitchesPerPA), B.pitchesPerPA, 3));
console.log(brow('Zone%', avgR((r) => r.disc.zonePct), B.zonePct, 3));
console.log(brow('O-Swing%', avgR((r) => r.disc.oSwingPct), B.oSwingPct, 3));
console.log(brow('Z-Swing%', avgR((r) => r.disc.zSwingPct), B.zSwingPct, 3));
console.log(brow('Contact%', avgR((r) => r.disc.contactPct), B.contactPct, 3));
console.log(brow('SwStr%', avgR((r) => r.disc.swStrPct), B.swStrPct, 3));
console.log(brow('CSW%', avgR((r) => r.disc.cswPct), B.cswPct, 3));
console.log(brow('F-Strike%', avgR((r) => r.disc.fStrikePct), B.fStrikePct, 3));
console.log(brow('先発投球数/試合', avgR((r) => r.disc.starterPitchesPerGame), B.starterPitchesPerGame, 1));
console.log(brow('WP+PB/球団', avgR((r) => r.disc.wpPbPerTeam), B.wpPbPerTeam, 1));
console.log(brow('フレーミング上位', avgR((r) => r.disc.framingLeader), B.framingLeader, 2));
console.log('');
console.log('--- 期待値/率系（非context・12シード平均） ---');
console.log(`      league wOBA ${avgR((r) => r.woba).toFixed(4)} / xwOBA ${avgR((r) => r.xwoba).toFixed(4)}（モデル=シムの恒等）`);
console.log(brow('|xwOBA−wOBA|', avgR((r) => r.xwobaDiff), [0, B.xwobaVsWoba], 5));
console.log(brow('LOB%', avgR((r) => r.lobPct), B.lobPct, 3));
console.log(brow('QS率', avgR((r) => r.qsRate), B.qsRate, 3));
console.log(brow('ARM上位(外野)', avgR((r) => r.armLeader), B.armLeader, 2));
console.log('');
console.log('--- 文脈指標（context・seeds=' + CTX_SEEDS.join(',') + ' 平均） ---');
console.log(babs('ΣRE24(恒等≈0)', avgC((r) => r.re24Sum), B.re24SumAbs));
console.log(babs('WPAゼロサム誤差', avgC((r) => r.wpaMaxErr), B.wpaZeroSum));
console.log(brow('平均aLI(正規化)', avgC((r) => r.aLI), B.liAvg, 4));
console.log(brow('平均pLI(正規化)', avgC((r) => r.pLI), B.liAvg, 4));
console.log(brow('SD王', avgC((r) => r.sdLead), B.sdLeader, 1));
console.log(`      リーグ総SD ${avgC((r) => r.totSD).toFixed(0)} / 総MD ${avgC((r) => r.totMD).toFixed(0)}（SD>MD で健全）`);
console.log('');
console.log('注: QS率は B1一球化（投球経済の是正）＋継投再較正で NPB帯(45-60%) に収束済み（旧: 上振れ0.63）。');
console.log('');
console.log(`=== フェーズB追加チェック PASS ${bPass} / FAIL ${bFail} ===`);
console.log(`=== 総合: 既存30 [PASS ${nPass}/FAIL ${nFail}]  ＋  フェーズB追加 [PASS ${bPass}/FAIL ${bFail}] ===`);

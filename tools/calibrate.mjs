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

// ---- 調整対象ノブ（ここを編集して収束させる） ----
// 較正結果は src/config.mjs のデフォルトに焼込済。空＝デフォルト構成を検証（回帰チェック）。
const OVERRIDES = {};

const SEEDS = [1, 2, 3, 4, 5]; // 平均を取るリーグ数

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
console.log(rowMin('WAR下限(200PA)', minR((r) => r.warFloor200), T.war.floorMin200PA)); // 全シード最悪値
console.log('');
console.log('--- 起用・休養の発現 ---');
console.log(row('規定到達/球団', avgR((r) => r.qualifiedPerTeam), T.usage.qualifiedPerTeam, 1));
console.log(row('正捕手先発試合', avgR((r) => r.catcherStarterGames), T.usage.catcherStarterGames, 1));
console.log('');
console.log(`=== PASS ${nPass} / FAIL ${nFail}（FAILはS5較正ループで収束させる） ===`);

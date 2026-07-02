// ============================================================================
// 較正ハーネス（1-11の前身 / 予備較正用）
// config.tuning のノブを上書きして複数リーグ×シーズンを実走し、
// リーグ集計を古典寄り目標帯と突合して PASS/FAIL を表示する。
//
// 使い方: OVERRIDES を編集して `node tools/calibrate.mjs` を再実行し、目標帯に寄せる。
// ============================================================================
import { createConfig, CALIBRATION_TARGETS, inRange } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { leagueSummary } from '../src/sim/leagueStats.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { hitterWAR, pitcherWAR } from '../src/sim/war.mjs';

// ---- 調整対象ノブ（ここを編集して収束させる） ----
// 較正結果は src/config.mjs のデフォルトに焼込済。空＝デフォルト構成を検証（回帰チェック）。
const OVERRIDES = {};

const SEEDS = [1, 2, 3, 4, 5]; // 平均を取るリーグ数

function runOnce(seed) {
  const cfg = createConfig(OVERRIDES);
  const lg = generateLeague(seed, cfg);
  const res = simulateSeason(lg, cfg, { season: 2026, seed });
  const summary = leagueSummary(res, cfg.league.numTeams);
  // 分布の裾（M4）: 規定打席到達者のリーダー値
  const qual = res.playerSeasons.filter((s) => s.batting.ab > 0 && s.batting.pa >= 443);
  const champAvg = Math.max(...qual.map((s) => s.batting.h / s.batting.ab));
  const hrLeader = Math.max(...res.playerSeasons.map((s) => s.batting.hr));
  const rbiLeader = Math.max(...res.playerSeasons.map((s) => s.batting.rbi));
  // WAR（2-9）
  const lc = deriveLeagueConstants(res);
  const byId = new Map(lg.players.map((p) => [p.id, p]));
  let warHit = 0, warPit = 0;
  const hW = [], pW = [];
  for (const s of res.playerSeasons) {
    const p = byId.get(s.playerId);
    if (p.role === 'pitcher') { const w = pitcherWAR(s, cfg, lc).war; warPit += w; pW.push(w); }
    else { const w = hitterWAR(s, cfg, lc).war; warHit += w; hW.push(w); }
  }
  hW.sort((a, b) => b - a);
  pW.sort((a, b) => b - a);
  return {
    summary, champAvg, hrLeader, rbiLeader,
    warTotal: warHit + warPit, warShare: warHit / (warHit + warPit), warHitLeader: hW[0], warPitLeader: pW[0],
  };
}

// 複数シードの平均
const runs = SEEDS.map(runOnce);
const sums = runs.map((r) => r.summary);
const avg = (fn) => sums.reduce((a, s) => a + fn(s), 0) / sums.length;
const avgR = (fn) => runs.reduce((a, r) => a + fn(r), 0) / runs.length;

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
const row = (label, val, range, dec = 3) => {
  const ok = range ? (inRange(val, range) ? 'PASS' : 'FAIL') : '    ';
  const rng = range ? `[${range[0]}, ${range[1]}]` : '';
  return `${ok}  ${label.padEnd(16)} ${val.toFixed(dec).padStart(8)}   ${rng}`;
};

console.log('=== 較正ハーネス（seeds=' + SEEDS.join(',') + ' 平均） ===');
console.log('overrides:', JSON.stringify(OVERRIDES.tuning));
console.log('');
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
console.log('--- 分布の裾（M4・リーダー値の目安: 打率.320-.350 / HR40-55 / 打点は満員打線ゆえ構造的に高め） ---');
console.log(row('打率王', avgR((r) => r.champAvg), [0.32, 0.35]));
console.log(row('HR王', avgR((r) => r.hrLeader), [40, 55], 1));
console.log(row('打点王', avgR((r) => r.rbiLeader), [100, 150], 1)); // 控え不在で+15%高め（ベンチ導入で改善予定）
console.log('');
console.log('--- WAR（2-9） ---');
console.log(row('総WAR', avgR((r) => r.warTotal), T.war.totalLeague, 0));
console.log(row('野手WAR比', avgR((r) => r.warShare), T.war.hitterShare));
console.log(row('野手WAR王', avgR((r) => r.warHitLeader), T.war.leaderHitter, 1));
console.log(row('投手WAR王', avgR((r) => r.warPitLeader), T.war.leaderPitcher, 1)); // ~4.2でやや低（後で拡大）

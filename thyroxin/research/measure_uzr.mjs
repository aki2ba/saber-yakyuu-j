import { createConfig } from '/home/thyroxin/workspace/saber-yakyuu-j/src/config.mjs';
import { generateLeague } from '/home/thyroxin/workspace/saber-yakyuu-j/src/generate.mjs';
import { simulateSeason } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/season.mjs';
import { deriveLeagueConstants } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/leagueConstants.mjs';
import { uzrRuns, uzrComponents, mainPosition, totalFieldInnings } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/fielding.mjs';

const cfg = createConfig();
const all = {};
const seeds = [20260701, 20260702, 20260703];
for (const seed of seeds) {
  const lg = generateLeague(seed, cfg);
  const res = simulateSeason(lg, cfg, seed);
  const lc = deriveLeagueConstants(res, cfg);
  for (const ps of res.playerSeasons) {
    const inn = totalFieldInnings(ps.fielding);
    if (inn < 400) continue;
    const pos = mainPosition(ps.fielding);
    if (!pos || pos === 'DH') continue;
    const u = uzrRuns(ps, cfg, lc);
    const c = uzrComponents(ps, cfg, lc);
    (all[pos] ||= []).push({ u, ...c, inn });
  }
}
console.log('pos  n     UZR_max  UZR_min   UZR_sd  |  RngR_max  ErrR_max  ARM_max  DPR_max  frame_max');
const order = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
let globalMax = -99;
let globalMin = 99;
for (const pos of order) {
  const a = all[pos] || [];
  if (!a.length) continue;
  const us = a.map((x) => x.u);
  const mean = us.reduce((s, x) => s + x, 0) / us.length;
  const sd = Math.sqrt(us.reduce((s, x) => s + (x - mean) ** 2, 0) / us.length);
  const mx = Math.max(...us);
  const mn = Math.min(...us);
  globalMax = Math.max(globalMax, mx);
  globalMin = Math.min(globalMin, mn);
  const f = (k) => Math.max(...a.map((x) => x[k])).toFixed(1);
  console.log(
    `${pos.padEnd(4)} ${String(a.length).padEnd(5)} ${mx.toFixed(1).padStart(7)} ${mn.toFixed(1).padStart(8)} ${sd.toFixed(1).padStart(8)}  |  ${f('rngR').padStart(8)} ${f('errR').padStart(9)} ${f('arm').padStart(7)} ${f('dpr').padStart(8)} ${f('framing').padStart(9)}`
  );
}
console.log(`\n全体: UZR最高 ${globalMax.toFixed(1)} / 最低 ${globalMin.toFixed(1)}  (3シーズン, 400イニング以上)`);
console.log('FanGraphs目安: +15=ゴールドグラブ級 / +10=優 / 0=平均 / -15=劣悪');

import { createConfig } from '/home/thyroxin/workspace/saber-yakyuu-j/src/config.mjs';
import { generateLeague } from '/home/thyroxin/workspace/saber-yakyuu-j/src/generate.mjs';
import { simulateSeason } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/season.mjs';

// season.mjs の onBattedBall フックは無いので、resolveBattedBall を直接叩いて分布を作る。
import { generateBattedBall } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/battedBall.mjs';
import { resolveBattedBall } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/battedBallResult.mjs';
import { makeRng } from '/home/thyroxin/workspace/saber-yakyuu-j/src/rng.mjs';
import { NEUTRAL_PARK } from '/home/thyroxin/workspace/saber-yakyuu-j/src/model/battedball.mjs';

const cfg = createConfig();
const lg = generateLeague(20260701, cfg);
const rng = makeRng(12345);

// 適当な打者/投手を拾う（trueAbility.pitching を持つ方が投手）
const players = lg.players;
const batter = players.find((p) => p.role === 'fielder');
const pitcher = players.find((p) => p.role === 'pitcher');

const bins = new Array(10).fill(0);
const byType = {};
let n = 0;
for (let i = 0; i < 200000; i++) {
  const bb = generateBattedBall(batter, pitcher, cfg, rng);
  const r = resolveBattedBall(bb, cfg, rng, NEUTRAL_PARK);
  if (r.result === 'HR') continue;
  const p = r.expOut; // その打球の「期待アウト率」= 実装上の捕球確率相当
  bins[Math.min(9, Math.floor(p * 10))]++;
  (byType[r.type] ||= []).push(p);
  n++;
}
console.log(`インプレー打球 n=${n}\n`);
console.log('現行シムの expOut（=捕球確率相当）の分布:');
for (let i = 0; i < 10; i++) {
  const lo = (i / 10).toFixed(1);
  const hi = ((i + 1) / 10).toFixed(1);
  const pct = (bins[i] / n) * 100;
  console.log(`  ${lo}–${hi}  ${pct.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(pct))}`);
}
const extremes = ((bins[0] + bins[9]) / n) * 100;
const middle = ((bins[3] + bins[4] + bins[5] + bins[6]) / n) * 100;
console.log(`\n  両極 (p<0.1 or p>0.9) : ${extremes.toFixed(1)}%`);
console.log(`  中間 (0.3<=p<0.7)     : ${middle.toFixed(1)}%`);

console.log('\n打球種別ごとの expOut レンジ:');
for (const t of Object.keys(byType)) {
  const a = byType[t];
  const mn = Math.min(...a);
  const mx = Math.max(...a);
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`  ${t}: n=${String(a.length).padStart(6)}  min=${mn.toFixed(3)} mean=${mean.toFixed(3)} max=${mx.toFixed(3)}  幅=${(mx - mn).toFixed(3)}`);
}

// 1シーズン400打球を p=const で処理したときの二項ノイズ
console.log('\n参考: 400打球を expOut=p で処理したときの、OAA の純ノイズ(SD, アウト単位)');
for (const p of [0.5, 0.35, 0.2, 0.1, 0.05]) {
  console.log(`  p=${p.toFixed(2)} → SD = sqrt(400·p(1-p)) = ${Math.sqrt(400 * p * (1 - p)).toFixed(1)} outs → ${(Math.sqrt(400 * p * (1 - p)) * 0.9).toFixed(1)} runs`);
}

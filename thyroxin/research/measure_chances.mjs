// advisor 指摘の検証:
//   「1シーズン400打球」という仮定が正しいか。各ポジションの実際の担当打球数と、
//   その打球群の Σp(1−p) から予測される OAA の二項ノイズ SD を実測する。
import { createConfig } from '/home/thyroxin/workspace/saber-yakyuu-j/src/config.mjs';
import { generateLeague } from '/home/thyroxin/workspace/saber-yakyuu-j/src/generate.mjs';
import { simulateSeason } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/season.mjs';
import { battedType, assignFielder } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/battedBallResult.mjs';

const cfg = createConfig();
const g = cfg.tuning.bb;
const G = 9.8;
const OUTFIELD = new Set(['LF', 'CF', 'RF']);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function hangTimeOf(evKmh, laDeg) {
  if (laDeg <= 0) return 0;
  const v = evKmh / 3.6;
  return (2 * v * Math.sin((laDeg * Math.PI) / 180)) / G;
}
function baseHitProb(type) {
  return type === 'GB' ? g.hitGB : type === 'LD' ? g.hitLD : type === 'FB' ? g.hitFB : g.hitPU;
}
function timeDifficultyAdj(pos, type, distanceM, hangTimeS) {
  if (!(hangTimeS > 0)) return 0;
  const typical = type === 'LD' && g.outfieldLDTypicalDepthM[pos] != null ? g.outfieldLDTypicalDepthM[pos] : g.posTypicalDepthM[pos];
  if (typical == null) return 0;
  return clamp((Math.abs(distanceM - typical) / hangTimeS) * g.timeDifficultyW, 0, g.timeDifficultyCap);
}
// resolveBattedBall と同一の expOut 計算（HRは除外）
function expOutOf(b) {
  const type = battedType(b.laDeg);
  const pos = assignFielder(b, type);
  const hang = hangTimeOf(b.evKmh, b.laDeg);
  let pHit = baseHitProb(type) + (b.evKmh - 140) * g.evHitW;
  if (type === 'FB' && b.distanceM >= g.fbHitBonusM) pHit += 0.15;
  pHit += timeDifficultyAdj(pos, type, b.distanceM, hang);
  pHit = clamp(pHit, 0.01, 0.97);
  return { pos, expOut: 1 - pHit };
}

const agg = {};
const seeds = [20260701, 20260702, 20260703];
for (const seed of seeds) {
  const lg = generateLeague(seed, cfg);
  const res = simulateSeason(lg, cfg, { seed, collectSpray: true, sprayCap: 100000 });
  for (const arr of res.spray.values()) {
    for (const b of arr) {
      if (b.result === 'HR') continue;
      const { pos, expOut } = expOutOf(b);
      const a = (agg[pos] ||= { n: 0, sumVar: 0, sumP: 0 });
      a.n++;
      a.sumVar += expOut * (1 - expOut);
      a.sumP += expOut;
    }
  }
}

const nSeeds = seeds.length;
const TEAMS = 12;
console.log('=== 1チーム・1シーズンあたり、各ポジションが「担当」する打球数と、そこから予測されるOAAノイズ ===');
console.log('（守備側集計。リーグ総打球 ÷ シード数 ÷ 12球団。※そのポジションを1人がフル出場した場合の値）\n');
console.log('pos   担当打球数   平均expOut   予測ノイズSD(outs)   run/out   予測ノイズSD(runs)');
for (const pos of ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']) {
  const a = agg[pos];
  if (!a) continue;
  const nPer = a.n / nSeeds / TEAMS;
  const meanP = a.sumP / a.n;
  const varPer = a.sumVar / nSeeds / TEAMS; // Σp(1-p) をチーム・シーズン単位に
  const sdOuts = Math.sqrt(varPer);
  const rpo = OUTFIELD.has(pos) ? cfg.tuning.field.runPerOutOutfield : cfg.tuning.field.runPerOutInfield;
  console.log(
    `${pos.padEnd(5)} ${nPer.toFixed(0).padStart(9)} ${meanP.toFixed(3).padStart(12)} ${sdOuts.toFixed(1).padStart(18)} ${rpo.toFixed(2).padStart(10)} ${(sdOuts * rpo).toFixed(1).padStart(20)}`
  );
}
console.log('\n※ 予測ノイズSD = sqrt(Σ p(1−p)) — 野手の能力差が一切なくても発生する、構造的な二項ノイズ');
console.log('※ 実測UZR_sd（前回計測・400イニング以上）: C 8.9 / 1B 4.0 / 2B 6.0 / 3B 5.7 / SS 6.9 / LF 6.8 / CF 8.6 / RF 6.1');

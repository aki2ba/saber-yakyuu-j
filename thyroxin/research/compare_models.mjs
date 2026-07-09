// 同一の打球ストリームで、現行モデルと提案モデルの out率を並べて測る（advisor 指摘）
// さらに、実シーズンの BABIP を取って、どちらの数字が現実の較正基準かを確認する。
import { createConfig } from '/home/thyroxin/workspace/saber-yakyuu-j/src/config.mjs';
import { generateLeague } from '/home/thyroxin/workspace/saber-yakyuu-j/src/generate.mjs';
import { simulateSeason } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/season.mjs';
import { generateBattedBall } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/battedBall.mjs';
import { battedType, assignFielder } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/battedBallResult.mjs';
import { makeRng } from '/home/thyroxin/workspace/saber-yakyuu-j/src/rng.mjs';

const G = 9.8;
const cfg = createConfig();
const g = cfg.tuning.bb;
const expit = (x) => 1 / (1 + Math.exp(-x));
const rad = (d) => (d * Math.PI) / 180;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------- 現行モデルの expOut ----------
function currentExpOut(bb, type) {
  const pos = assignFielder(bb, type);
  const hang = bb.laDeg > 0 ? (2 * (bb.evKmh / 3.6) * Math.sin(rad(bb.laDeg))) / G : 0;
  let pHit = (type === 'GB' ? g.hitGB : type === 'LD' ? g.hitLD : type === 'FB' ? g.hitFB : g.hitPU) + (bb.evKmh - 140) * g.evHitW;
  if (type === 'FB' && bb.distanceM >= g.fbHitBonusM) pHit += 0.15;
  if (hang > 0) {
    const typical = type === 'LD' && g.outfieldLDTypicalDepthM[pos] != null ? g.outfieldLDTypicalDepthM[pos] : g.posTypicalDepthM[pos];
    if (typical != null) pHit += clamp((Math.abs(bb.distanceM - typical) / hang) * g.timeDifficultyW, 0, g.timeDifficultyCap);
  }
  return 1 - clamp(pHit, 0.01, 0.97);
}

// ---------- 提案モデル v2 ----------
const P = {
  pos: { '3B': { r: 34, t: -33 }, SS: { r: 44, t: -16 }, '2B': { r: 44, t: 16 }, '1B': { r: 33, t: 35 }, LF: { r: 88, t: -28 }, CF: { r: 98, t: 0 }, RF: { r: 88, t: 28 } },
  smaxBase: 6.9, width: 1.05, reactionS: 0.3, reachM: 1.7, gloveHeightM: 2.1,
  gbSpeedFactor: 0.8, gbMaxDepth: 50, transferS: 0.7, throwSpeed: 32, runnerToFirstS: 4.35, throwWidth: 0.22,
};
const IF = ['3B', 'SS', '2B', '1B'];
const OF = ['LF', 'CF', 'RF'];
const xyOf = (p) => ({ x: p.r * Math.sin(rad(p.t)), y: p.r * Math.cos(rad(p.t)) });
const FPOS = Object.fromEntries(Object.entries(P.pos).map(([k, v]) => [k, xyOf(v)]));
const FIRST = { x: 27.43 / Math.SQRT2, y: 27.43 / Math.SQRT2 };

function pReachAir(f, lx, ly, hang) {
  const d = Math.max(0, Math.hypot(lx - f.x, ly - f.y) - P.reachM);
  const t = hang - P.reactionS;
  return t <= 0 ? 0 : expit((P.smaxBase - d / t) / P.width);
}
function infieldPlay(f, bb) {
  const dx = Math.sin(rad(bb.sprayDeg));
  const dy = Math.cos(rad(bb.sprayDeg));
  const s = f.x * dx + f.y * dy;
  if (s <= 3 || s > P.gbMaxDepth) return 0;
  const v = bb.evKmh / 3.6;
  if (bb.laDeg > 0) {
    const vx = v * Math.cos(rad(bb.laDeg));
    if (s * Math.tan(rad(bb.laDeg)) - (G * s * s) / (2 * vx * vx) > P.gloveHeightM) return 0;
  }
  const fx = s * dx;
  const fy = s * dy;
  const move = Math.max(0, Math.hypot(fx - f.x, fy - f.y) - P.reachM);
  const vG = v * P.gbSpeedFactor;
  const tBall = s / vG;
  const pReach = expit((P.smaxBase - move / Math.max(0.01, tBall - P.reactionS)) / P.width);
  const tField = Math.max(tBall, P.reactionS + move / P.smaxBase);
  const tOut = tField + P.transferS + Math.hypot(FIRST.x - fx, FIRST.y - fy) / P.throwSpeed;
  return pReach * expit((P.runnerToFirstS - tOut) / P.throwWidth);
}
function proposedPOut(bb, type) {
  const v = bb.evKmh / 3.6;
  const hang = bb.laDeg > 0 ? (2 * v * Math.sin(rad(bb.laDeg))) / G : 0;
  const lx = bb.distanceM * Math.sin(rad(bb.sprayDeg));
  const ly = bb.distanceM * Math.cos(rad(bb.sprayDeg));
  let best = 0;
  for (const pos of IF) best = Math.max(best, Math.max(type === 'GB' ? 0 : pReachAir(FPOS[pos], lx, ly, hang), infieldPlay(FPOS[pos], bb)));
  for (const pos of OF) best = Math.max(best, type === 'GB' && bb.laDeg <= 0 ? 0 : pReachAir(FPOS[pos], lx, ly, hang));
  return best;
}

// ---------- 同一ストリームで比較 ----------
const lg = generateLeague(20260701, cfg);
const players = lg.players;
const batters = players.filter((p) => p.role === 'fielder').slice(0, 60);
const pitchers = players.filter((p) => p.role === 'pitcher').slice(0, 30);

for (const label of ['単一打者×単一投手', '60打者×30投手']) {
  const rng = makeRng(999);
  const bs = label.startsWith('単一') ? batters.slice(0, 1) : batters;
  const ps = label.startsWith('単一') ? pitchers.slice(0, 1) : pitchers;
  let n = 0;
  let curSum = 0;
  let propSum = 0;
  const byType = {};
  for (let i = 0; i < 250000; i++) {
    const bb = generateBattedBall(bs[i % bs.length], ps[i % ps.length], cfg, rng);
    const v = bb.evKmh / 3.6;
    if (bb.laDeg <= 0) bb.distanceM = Math.max(0, ((v * v) / G) * 0.15);
    else bb.distanceM = Math.max(0, g.carry * ((v * v) / G) * Math.exp(-Math.pow((bb.laDeg - 26) / 24, 2)));
    const type = battedType(bb.laDeg);
    if (type !== 'GB' && bb.distanceM > 100 && bb.laDeg >= 15 && bb.laDeg <= 48) continue; // HR近似で除外
    const cur = currentExpOut(bb, type);
    const prop = proposedPOut(bb, type);
    n++;
    curSum += cur;
    propSum += prop;
    const t = (byType[type] ||= { n: 0, c: 0, p: 0 });
    t.n++;
    t.c += cur;
    t.p += prop;
  }
  console.log(`\n=== ${label} (n=${n}) ===`);
  console.log(`  現行 out率: ${(curSum / n).toFixed(3)}  → BABIP相当 .${Math.round((1 - curSum / n) * 1000)}`);
  console.log(`  提案 out率: ${(propSum / n).toFixed(3)}  → BABIP相当 .${Math.round((1 - propSum / n) * 1000)}`);
  console.log(`  差: ${((propSum - curSum) / n).toFixed(3)}`);
  console.log('  打球種別 out率 (現行 / 提案):');
  for (const t of ['GB', 'LD', 'FB', 'PU']) {
    if (!byType[t]) continue;
    const b = byType[t];
    console.log(`    ${t}: ${(b.c / b.n).toFixed(3)} / ${(b.p / b.n).toFixed(3)}   (構成比 ${((b.n / n) * 100).toFixed(1)}%)`);
  }
}

// ---------- 実シーズンの BABIP（較正の真の基準） ----------
console.log('\n=== 実シーズンの BABIP（現行エンジンの実測・3シード平均） ===');
let H = 0;
let AB = 0;
let SO = 0;
let HR = 0;
let SF = 0;
for (const seed of [20260701, 20260702, 20260703]) {
  const l = generateLeague(seed, cfg);
  const res = simulateSeason(l, cfg, { seed });
  for (const ps of res.playerSeasons) {
    const b = ps.batting;
    H += b.h;
    AB += b.ab;
    SO += b.so;
    HR += b.hr;
    SF += b.sf || 0;
  }
}
const babip = (H - HR) / (AB - SO - HR + SF);
console.log(`  BABIP = (H−HR)/(AB−SO−HR+SF) = .${Math.round(babip * 1000)}`);
console.log('  NPB の実際の BABIP は概ね .290〜.300');

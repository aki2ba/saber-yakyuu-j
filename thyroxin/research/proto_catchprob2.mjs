// §7.1 設計案プロトタイプ v2
// v1 の欠陥: 内野を「到達確率」だけでモデル化 → ゴロ安打率 0.040（現実 0.19）
// 修正: Statcast infield OAA の4要素をすべて入れる
//   (1) 迎撃点までの距離  (2) 使える時間  (3) 迎撃点から一塁までの距離  (4) 打者走者の足
//   pOut(内野) = P(到達) × P(送球アウト)
// 追加: laDeg>0 のゴロ/低ライナーは内野手の頭上を越えうる → 迎撃点での打球高度を見る
import { createConfig } from '/home/thyroxin/workspace/saber-yakyuu-j/src/config.mjs';
import { generateLeague } from '/home/thyroxin/workspace/saber-yakyuu-j/src/generate.mjs';
import { generateBattedBall } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/battedBall.mjs';
import { battedType } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/battedBallResult.mjs';
import { makeRng } from '/home/thyroxin/workspace/saber-yakyuu-j/src/rng.mjs';

const G = 9.8;
const cfg = createConfig();
const expit = (x) => 1 / (1 + Math.exp(-x));
const rad = (d) => (d * Math.PI) / 180;

const P = {
  pos: {
    '3B': { r: 34, t: -33 },
    SS: { r: 44, t: -16 },
    '2B': { r: 44, t: 16 },
    '1B': { r: 33, t: 35 },
    LF: { r: 88, t: -28 },
    CF: { r: 98, t: 0 },
    RF: { r: 88, t: 28 },
  },
  smaxBase: 6.9, // 実効クロージング速度 m/s
  width: 1.05, // 到達ロジスティックの幅
  reactionS: 0.3,
  reachM: 1.7,
  gloveHeightM: 2.1, // これより高く通過する打球は内野手が捕れない
  gbSpeedFactor: 0.8, // ゴロの実効水平速度 = EV(m/s) × これ
  gbMaxDepth: 50,
  // 送球アウト
  transferS: 0.7, // 捕球→リリース
  throwSpeed: 32, // m/s
  runnerToFirstS: 4.35, // 打者走者の一塁到達（平均）
  throwWidth: 0.22, // 送球アウトのロジスティック幅（秒）
};

const IF = ['3B', 'SS', '2B', '1B'];
const OF = ['LF', 'CF', 'RF'];
const xyOf = (p) => ({ x: p.r * Math.sin(rad(p.t)), y: p.r * Math.cos(rad(p.t)) });
const FPOS = Object.fromEntries(Object.entries(P.pos).map(([k, v]) => [k, xyOf(v)]));
const FIRST = { x: 27.43 / Math.SQRT2, y: 27.43 / Math.SQRT2 };

function pReachAir(fpos, landX, landY, hangS) {
  const d = Math.max(0, Math.hypot(landX - fpos.x, landY - fpos.y) - P.reachM);
  const t = hangS - P.reactionS;
  if (t <= 0) return 0;
  return expit((P.smaxBase - d / t) / P.width);
}

/** ゴロ/低ライナーの内野処理。迎撃点・到達確率・送球アウト確率を返す */
function infieldPlay(fpos, bb) {
  const dx = Math.sin(rad(bb.sprayDeg));
  const dy = Math.cos(rad(bb.sprayDeg));
  const s = fpos.x * dx + fpos.y * dy; // 本塁→迎撃点の弧長
  if (s <= 3 || s > P.gbMaxDepth) return 0;

  // 迎撃点での打球高度（laDeg>0 なら放物線）: 頭上を越えるなら捕れない
  const v = bb.evKmh / 3.6;
  if (bb.laDeg > 0) {
    const vx = v * Math.cos(rad(bb.laDeg));
    const h = s * Math.tan(rad(bb.laDeg)) - (G * s * s) / (2 * vx * vx);
    if (h > P.gloveHeightM) return 0; // 頭上を通過
  }

  const footX = s * dx;
  const footY = s * dy;
  const move = Math.max(0, Math.hypot(footX - fpos.x, footY - fpos.y) - P.reachM);

  const vG = v * P.gbSpeedFactor;
  const tBall = s / vG; // 打球が迎撃点に来る時刻
  const tFielder = P.reactionS + move / P.smaxBase; // 野手が迎撃点に着く時刻
  const pReach = expit((P.smaxBase - move / Math.max(0.01, tBall - P.reactionS)) / P.width);

  // 送球アウト: 捕球時刻 + 持ち替え + 送球飛行 < 打者走者の一塁到達
  const tField = Math.max(tBall, tFielder);
  const throwDist = Math.hypot(FIRST.x - footX, FIRST.y - footY);
  const tOut = tField + P.transferS + throwDist / P.throwSpeed;
  const pThrow = expit((P.runnerToFirstS - tOut) / P.throwWidth);

  return pReach * pThrow;
}

function catchProbs(bb, type) {
  const out = {};
  const v = bb.evKmh / 3.6;
  const hang = bb.laDeg > 0 ? (2 * v * Math.sin(rad(bb.laDeg))) / G : 0;
  const lx = bb.distanceM * Math.sin(rad(bb.sprayDeg));
  const ly = bb.distanceM * Math.cos(rad(bb.sprayDeg));

  for (const pos of IF) {
    // 内野: ライナー/フライを空中で捕るか、ゴロを捕って投げるか、良い方
    const air = type === 'GB' ? 0 : pReachAir(FPOS[pos], lx, ly, hang);
    const ground = infieldPlay(FPOS[pos], bb);
    out[pos] = Math.max(air, ground);
  }
  for (const pos of OF) {
    out[pos] = type === 'GB' && bb.laDeg <= 0 ? 0 : pReachAir(FPOS[pos], lx, ly, hang);
  }
  return out;
}

const lg = generateLeague(20260701, cfg);
const rng = makeRng(999);
const players = lg.players;
const batters = players.filter((p) => p.role === 'fielder').slice(0, 60);
const pitchers = players.filter((p) => p.role === 'pitcher').slice(0, 30);

const bins = new Array(10).fill(0);
const byType = {};
const chances = {};
const varSum = {};
let n = 0;
let outs = 0;
for (let i = 0; i < 300000; i++) {
  const b = batters[i % batters.length];
  const p = pitchers[i % pitchers.length];
  const bb = generateBattedBall(b, p, cfg, rng);
  const v = bb.evKmh / 3.6;
  if (bb.laDeg <= 0) bb.distanceM = Math.max(0, ((v * v) / G) * 0.15);
  else bb.distanceM = Math.max(0, cfg.tuning.bb.carry * ((v * v) / G) * Math.exp(-Math.pow((bb.laDeg - 26) / 24, 2)));
  const type = battedType(bb.laDeg);
  if (type !== 'GB' && bb.distanceM > 100 && bb.laDeg >= 15 && bb.laDeg <= 48) continue;

  const ps = catchProbs(bb, type);
  let best = 0;
  let bestPos = null;
  for (const k of Object.keys(ps)) {
    if (ps[k] > best) {
      best = ps[k];
      bestPos = k;
    }
  }
  n++;
  outs += best;
  bins[Math.min(9, Math.floor(best * 10))]++;
  (byType[type] ||= { n: 0, s: 0 }).n++;
  byType[type].s += best;
  if (bestPos) {
    chances[bestPos] = (chances[bestPos] || 0) + 1;
    varSum[bestPos] = (varSum[bestPos] || 0) + best * (1 - best);
  }
}

console.log(`=== 提案モデル v2: catch/out probability 分布 (n=${n}) ===\n`);
for (let i = 0; i < 10; i++) {
  const pct = (bins[i] / n) * 100;
  console.log(`  ${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}  ${pct.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(pct))}`);
}
console.log(`\n  両極 (p<0.1 or p>0.9) : ${(((bins[0] + bins[9]) / n) * 100).toFixed(1)}%   [現行 17.5%]`);
console.log(`  中間 (0.3<=p<0.7)     : ${(((bins[3] + bins[4] + bins[5] + bins[6]) / n) * 100).toFixed(1)}%   [現行 24.9%]`);
console.log(`\n  リーグ out率: ${(outs / n).toFixed(3)}   [現行 0.716]`);

console.log('\n打球種別ごとの平均 out率（＝創発する hit率の裏返し）:');
for (const t of ['GB', 'LD', 'FB', 'PU']) {
  if (!byType[t]) continue;
  const m = byType[t].s / byType[t].n;
  const cur = { GB: 0.809, LD: 0.35, FB: 0.855, PU: 0.978 }[t];
  console.log(`  ${t}: 提案 ${m.toFixed(3)} / 現行 ${cur.toFixed(3)}    hit率: 提案 ${(1 - m).toFixed(3)} / 現行 ${(1 - cur).toFixed(3)}`);
}

console.log('\n=== 責任野手の担当打球数と構造的二項ノイズ（1チーム・シーズン換算） ===');
const curChances = { '1B': 269, '2B': 736, '3B': 325, SS: 697, LF: 498, CF: 747, RF: 497 };
const curNoise = { '1B': 4.9, '2B': 8.0, '3B': 5.3, SS: 7.8, LF: 8.5, CF: 10.5, RF: 8.5 };
const scale = Object.values(curChances).reduce((a, b) => a + b, 0) / n;
console.log('\npos   担当打球(提案/現行)   ノイズSD runs(提案/現行)');
for (const pos of ['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']) {
  const c = (chances[pos] || 0) * scale;
  const rpo = OF.includes(pos) ? 0.9 : 0.75;
  const sd = Math.sqrt((varSum[pos] || 0) * scale) * rpo;
  console.log(`${pos.padEnd(5)} ${c.toFixed(0).padStart(7)} / ${String(curChances[pos]).padStart(4)}       ${sd.toFixed(1).padStart(5)} / ${curNoise[pos].toFixed(1).padStart(4)}`);
}

console.log('\n=== ユーザー報告事象: EV120km/h の浅いライナー（センター方向） ===');
for (const la of [18, 20, 22]) {
  const v = 120 / 3.6;
  const dist = cfg.tuning.bb.carry * ((v * v) / G) * Math.exp(-Math.pow((la - 26) / 24, 2));
  const bb = { evKmh: 120, laDeg: la, sprayDeg: 0, distanceM: dist };
  const ps = catchProbs(bb, battedType(la));
  const mx = Math.max(...Object.values(ps));
  const who = Object.keys(ps).find((k) => ps[k] === mx);
  console.log(
    `  LA${la}° ${dist.toFixed(1)}m → SS=${ps.SS.toFixed(3)} 2B=${ps['2B'].toFixed(3)} CF=${ps.CF.toFixed(3)}  責任=${who} 落球時の減点 −${mx.toFixed(2)}  [現行: CF に −0.39]`
  );
}
console.log('\n=== 対照: 平凡なフライ / 正面のゴロ ===');
{
  const v = 150 / 3.6;
  const dist = cfg.tuning.bb.carry * ((v * v) / G) * Math.exp(-Math.pow((35 - 26) / 24, 2));
  const bb = { evKmh: 150, laDeg: 35, sprayDeg: 2, distanceM: dist };
  const ps = catchProbs(bb, 'FB');
  console.log(`  EV150 LA35° ${dist.toFixed(1)}m センター正面フライ → CF p=${ps.CF.toFixed(3)}（捕って当然。落とせば −${ps.CF.toFixed(2)}）`);
}
{
  const bb = { evKmh: 130, laDeg: -8, sprayDeg: -16, distanceM: 20 };
  const ps = catchProbs(bb, 'GB');
  console.log(`  EV130 LA−8° 遊撃正面ゴロ → SS p=${ps.SS.toFixed(3)}（捕って当然）`);
}
{
  const bb = { evKmh: 145, laDeg: -4, sprayDeg: -25, distanceM: 25 };
  const ps = catchProbs(bb, 'GB');
  console.log(`  EV145 LA−4° 三遊間の強いゴロ → SS p=${ps.SS.toFixed(3)} 3B p=${ps['3B'].toFixed(3)}（五分五分＝ここで守備力が効く）`);
}

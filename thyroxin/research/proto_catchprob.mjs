// §7.1 設計案のプロトタイプ検証（実装ではない・スクラッチ）
//
// 現行: expOut = 1 − pHit(打球種別) → コイントス帯に密集 → 二項ノイズが支配
// 提案: Statcast Distance-Time モデルで、各野手の catch probability を幾何から出す
//        p_base = expit((Smax_base − reqSpeed) / w)   ← リーグ中立（OAAのベースライン）
//        pOut   = max_i p_base_i、責任野手 = argmax_i
//
// 検証したいこと:
//   (1) p の分布が両極（bimodal）になるか
//   (2) リーグの out率（≈BABIP）が現行と同水準に保てるか
//   (3) 構造的な二項ノイズ sqrt(Σp(1−p)) がどれだけ縮むか
//   (4) ポテンヒットが誰の責任にもならないか
import { createConfig } from '/home/thyroxin/workspace/saber-yakyuu-j/src/config.mjs';
import { generateLeague } from '/home/thyroxin/workspace/saber-yakyuu-j/src/generate.mjs';
import { generateBattedBall } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/battedBall.mjs';
import { battedType } from '/home/thyroxin/workspace/saber-yakyuu-j/src/sim/battedBallResult.mjs';
import { makeRng } from '/home/thyroxin/workspace/saber-yakyuu-j/src/rng.mjs';

const G = 9.8;
const cfg = createConfig();
const expit = (x) => 1 / (1 + Math.exp(-x));
const rad = (d) => (d * Math.PI) / 180;

// --- 提案パラメータ（すべて config 化する想定。ここでは仮値） -------------------
const P = {
  // 守備隊形: 本塁からの距離r(m) と spray角θ(deg)。θ<0=三塁側, θ>0=一塁側
  pos: {
    '3B': { r: 34, t: -33 },
    SS: { r: 44, t: -16 },
    '2B': { r: 44, t: 16 },
    '1B': { r: 33, t: 35 },
    LF: { r: 88, t: -28 },
    CF: { r: 98, t: 0 },
    RF: { r: 88, t: 28 },
  },
  smaxBase: 6.9, // リーグ平均野手の実効クロージング速度 m/s（反応後の平均。全力疾走9m/sより低い）
  width: 1.05, // ロジスティックの幅（m/s）: 小さいほど p が両極化する
  reactionS: 0.30, // 初動までの反応時間 s
  reachM: 1.7, // グラブ+ダイブの到達半径 m
  gbSpeedFactor: 0.52, // ゴロの実効水平速度 = EV(m/s) × これ（バウンド減速込み）
  gbMaxDepth: 52, // 内野手がゴロを処理できる最大の本塁からの距離(m)（これ以遠は外野へ抜ける）
};

const IF = ['3B', 'SS', '2B', '1B'];
const OF = ['LF', 'CF', 'RF'];
const xyOf = (p) => ({ x: p.r * Math.sin(rad(p.t)), y: p.r * Math.cos(rad(p.t)) });
const FPOS = Object.fromEntries(Object.entries(P.pos).map(([k, v]) => [k, xyOf(v)]));

/** 空中球: 落下点へ何m/sで走る必要があるか */
function reqSpeedAir(fpos, landX, landY, hangS) {
  const d = Math.hypot(landX - fpos.x, landY - fpos.y) - P.reachM;
  const t = hangS - P.reactionS;
  if (t <= 0) return Infinity;
  return Math.max(0, d) / t;
}

/** ゴロ: 打球の直線経路への最短到達（Opportunity Distance / Opportunity Time） */
function reqSpeedGround(fpos, sprayDeg, vGround) {
  const dx = Math.sin(rad(sprayDeg));
  const dy = Math.cos(rad(sprayDeg));
  // 野手を打球ベクトルへ射影 → 迎撃点
  const s = fpos.x * dx + fpos.y * dy; // 本塁から迎撃点までの弧長
  if (s <= 0 || s > P.gbMaxDepth) return Infinity; // 背後 / 内野を抜けた
  const footX = s * dx;
  const footY = s * dy;
  const d = Math.hypot(footX - fpos.x, footY - fpos.y) - P.reachM;
  const t = s / vGround - P.reactionS;
  if (t <= 0) return Infinity;
  return Math.max(0, d) / t;
}

/** 打球1つに対する、各野手のリーグ中立 catch probability */
function catchProbs(bb, type) {
  const out = {};
  if (type === 'GB') {
    const vG = (bb.evKmh / 3.6) * P.gbSpeedFactor;
    for (const pos of IF) out[pos] = expit((P.smaxBase - reqSpeedGround(FPOS[pos], bb.sprayDeg, vG)) / P.width);
    for (const pos of OF) out[pos] = 0; // ゴロは外野手のアウト機会にしない（抜けたら安打）
  } else {
    const hang = (2 * (bb.evKmh / 3.6) * Math.sin(rad(bb.laDeg))) / G;
    const lx = bb.distanceM * Math.sin(rad(bb.sprayDeg));
    const ly = bb.distanceM * Math.cos(rad(bb.sprayDeg));
    for (const pos of [...IF, ...OF]) out[pos] = expit((P.smaxBase - reqSpeedAir(FPOS[pos], lx, ly, hang)) / P.width);
  }
  return out;
}

// --- 打球ストリームを流して評価 -------------------------------------------------
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
const N = 300000;
for (let i = 0; i < N; i++) {
  const b = batters[i % batters.length];
  const p = pitchers[i % pitchers.length];
  const bb = generateBattedBall(b, p, cfg, rng);
  // 幾何（resolveBattedBall と同式）
  const v = bb.evKmh / 3.6;
  const laR = rad(bb.laDeg);
  if (bb.laDeg <= 0) bb.distanceM = Math.max(0, ((v * v) / G) * 0.15);
  else bb.distanceM = Math.max(0, cfg.tuning.bb.carry * ((v * v) / G) * Math.exp(-Math.pow((bb.laDeg - 26) / 24, 2)));
  const type = battedType(bb.laDeg);
  // HRっぽい打球は除外（簡易: 適角かつ100m超）
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
  const pOut = best;
  n++;
  outs += pOut;
  bins[Math.min(9, Math.floor(pOut * 10))]++;
  (byType[type] ||= { n: 0, s: 0 }).n++;
  byType[type].s += pOut;
  if (bestPos) {
    chances[bestPos] = (chances[bestPos] || 0) + 1;
    varSum[bestPos] = (varSum[bestPos] || 0) + pOut * (1 - pOut);
  }
}

console.log(`=== 提案モデルの catch probability 分布 (n=${n}) ===\n`);
for (let i = 0; i < 10; i++) {
  const pct = (bins[i] / n) * 100;
  console.log(`  ${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}  ${pct.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(pct))}`);
}
const extremes = ((bins[0] + bins[9]) / n) * 100;
const middle = ((bins[3] + bins[4] + bins[5] + bins[6]) / n) * 100;
console.log(`\n  両極 (p<0.1 or p>0.9) : ${extremes.toFixed(1)}%   [現行 17.5%]`);
console.log(`  中間 (0.3<=p<0.7)     : ${middle.toFixed(1)}%   [現行 24.9%]`);
console.log(`\n  リーグ out率 (=平均pOut): ${(outs / n).toFixed(3)}   [現行 0.716 → BABIP ~.284]`);

console.log('\n打球種別ごとの平均 pOut（＝創発する hit率の裏返し）:');
for (const t of ['GB', 'LD', 'FB', 'PU']) {
  if (!byType[t]) continue;
  const m = byType[t].s / byType[t].n;
  const cur = { GB: 0.809, LD: 0.35, FB: 0.855, PU: 0.978 }[t];
  console.log(`  ${t}: 提案 ${m.toFixed(3)}  / 現行 ${cur.toFixed(3)}   (hit率: 提案 ${(1 - m).toFixed(3)} / 現行 ${(1 - cur).toFixed(3)})`);
}

console.log('\n=== 責任野手(argmax p)の担当打球数と、構造的二項ノイズ ===');
console.log('（1チーム・1シーズン=143試合ぶんに正規化。現行の担当打球数と比較）');
const curChances = { '1B': 269, '2B': 736, '3B': 325, SS: 697, LF: 498, CF: 747, RF: 497 };
const curNoise = { '1B': 4.9, '2B': 8.0, '3B': 5.3, SS: 7.8, LF: 8.5, CF: 10.5, RF: 8.5 };
// 現行の総担当打球数(=1チーム・シーズンのインプレー打球) で正規化
const totalCur = Object.values(curChances).reduce((a, b) => a + b, 0);
const scale = totalCur / n;
console.log('\npos   担当打球数(提案/現行)   ノイズSD runs(提案/現行)');
for (const pos of ['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']) {
  const c = (chances[pos] || 0) * scale;
  const rpo = OF.includes(pos) ? 0.9 : 0.75;
  const sd = Math.sqrt((varSum[pos] || 0) * scale) * rpo;
  console.log(`${pos.padEnd(5)} ${c.toFixed(0).padStart(8)} / ${String(curChances[pos]).padStart(4)}        ${sd.toFixed(1).padStart(5)} / ${curNoise[pos].toFixed(1).padStart(4)}`);
}

// --- ユーザー報告のポテンヒット ---
console.log('\n=== ユーザー報告事象: EV120km/h の浅いライナー ===');
for (const la of [18, 20, 22]) {
  const v = 120 / 3.6;
  const dist = cfg.tuning.bb.carry * ((v * v) / G) * Math.exp(-Math.pow((la - 26) / 24, 2));
  const bb = { evKmh: 120, laDeg: la, sprayDeg: 0, distanceM: dist };
  const ps = catchProbs(bb, battedType(la));
  const shown = ['SS', '2B', 'CF']
    .map((k) => `${k}=${ps[k].toFixed(3)}`)
    .join('  ');
  const mx = Math.max(...Object.values(ps));
  console.log(`  LA${la}° 飛距離${dist.toFixed(1)}m → ${shown}   最大p=${mx.toFixed(3)} → 落球時の減点 −${mx.toFixed(2)}  [現行: CFに −0.39]`);
}

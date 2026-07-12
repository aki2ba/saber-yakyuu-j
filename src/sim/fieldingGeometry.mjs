// ============================================================================
// 守備の幾何（Distance-Time モデル）— Statcast OAA と同型の捕球確率
// 正典: thyroxin/research/fielding_metrics_reference.md §2.1-2.3 / §11.2
//
// 【設計の核】
//   打球ごとに、各野手の「アウト化確率 p」を幾何から導く。
//   p はリーグ中立（野手個人の能力を含まない）＝ Statcast の catch probability と同じ性質。
//   個人の Range 能力は「実効クロージング速度 Smax」に乗り、抽選側にのみ効く。
//
//   空中球(LD/FB/PU) : p = expit((Smax − 必要走速度) / width)
//                      必要走速度 = (落下点までの距離 − reach) / (滞空時間 − 反応時間) / 方向係数
//   ゴロ(GB)         : p = P(到達) × P(送球アウト)
//                      Statcast infield OAA の4要素（迎撃点までの距離・使える時間・
//                      迎撃点から塁までの距離・打者走者の足）をすべて含む。
//                      P(到達) のみだとゴロ安打率が 0.19→0.04 に破綻する（§11.2）。
//
//   方向補正(direction) : 後方への移動は前方/横より遅い（Statcast が2017年に追加）。
//                         これが無いと内野手が頭上のライナーへ走り戻って捕ってしまう。
//
// 【責任野手】 argmax_i p_i（DRS の流儀・§9.2）。同率なら必要走速度が小さい方。
//   アウト → OAA += (1 − p_j) / 安打 → OAA += −p_j。
//   到達不能な打球は全野手 p≈0 ゆえ、誰もほとんど減点されない（＝ポテンヒット問題の解消）。
// ============================================================================
import { expit } from './rates.mjs';

const FG_G = 9.8; // 重力加速度（build.mjs が全モジュールを1スコープへインライン化するため名前衝突を避ける）
const FG_RAD = Math.PI / 180;

export const FG_INFIELD = ['3B', 'SS', '2B', '1B'];
export const FG_OUTFIELD = ['LF', 'CF', 'RF'];
export const FIELD_POS = [...FG_INFIELD, ...FG_OUTFIELD];
export const IS_OUTFIELD = new Set(FG_OUTFIELD);
const IS_INFIELD = new Set(FG_INFIELD);

/** 一塁ベースの座標（本塁原点・y=センター方向・x=一塁側が正） */
const FIRST_BASE = { x: 27.43 / Math.SQRT2, y: 27.43 / Math.SQRT2 };

/** 守備隊形（config の極座標 r[m], t[deg]）→ 直交座標 */
export function fielderPositions(cfg) {
  const out = {};
  const src = cfg.tuning.field.positions;
  for (const pos of FIELD_POS) {
    const p = src[pos];
    out[pos] = { x: p.r * Math.sin(p.t * FG_RAD), y: p.r * Math.cos(p.t * FG_RAD), r: p.r };
  }
  return out;
}

/**
 * 方向係数。野手 → 目標点 の移動が「本塁から見て外向き（＝後方へ下がる）」ほど小さくなる。
 * 係数 = 1 − backPenalty × max(0, 外向き成分の余弦)。前方・横方向では 1。
 */
function directionFactor(fx, fy, tx, ty, backPenalty) {
  const mx = tx - fx;
  const my = ty - fy;
  const m = Math.hypot(mx, my);
  if (m < 1e-6) return 1;
  const fr = Math.hypot(fx, fy);
  if (fr < 1e-6) return 1;
  const cos = (mx * (fx / fr) + my * (fy / fr)) / m; // 外向き単位ベクトルとの余弦
  return 1 - backPenalty * Math.max(0, cos);
}

/** 空中球の必要走速度[m/s]。到達不能なら Infinity */
function reqSpeedAir(f, landX, landY, hangS, g) {
  const t = hangS - g.reactionS;
  if (t <= 0) return Infinity;
  const d = Math.hypot(landX - f.x, landY - f.y) - g.reachM;
  if (d <= 0) return 0;
  const dir = directionFactor(f.x, f.y, landX, landY, g.backPenalty);
  if (dir <= 0.02) return Infinity;
  return d / t / dir;
}

/**
 * ゴロの内野処理。迎撃点は野手を打球ベクトルへ射影した点（Statcast の "intercept point"）。
 * 迎撃点での打球高度が gloveHeightM を超える（頭上を通過）なら処理不能。
 * air=true は「迎撃点が初バウンドより手前」＝ボールがまだ空中にある＝実質ライナー捕球
 * （LA<10°でGB分類だが、現実の記録では『直』＝ラインドライブアウトになるプレー。
 *   realism検証 2026-07-12: GB分類アウトの約19%・1試合1.3件がこれに該当し、旧実装は
 *   すべて「ゴロ」と表示し走者もゴロ意味論（進塁打/併殺）で動かしていた）。
 * @returns {{reqSpeed:number, pThrow:number, air:boolean}|null}
 */
function groundChance(f, bb, g, runnerToFirstS) {
  const dx = Math.sin(bb.sprayDeg * FG_RAD);
  const dy = Math.cos(bb.sprayDeg * FG_RAD);
  const s = f.x * dx + f.y * dy; // 本塁 → 迎撃点
  if (s <= g.gbMinDepth || s > g.gbMaxDepth) return null; // 背後 / 内野を抜けた

  const v = bb.evKmh / 3.6;
  let air = false;
  if (bb.laDeg > 0) {
    const vx = v * Math.cos(bb.laDeg * FG_RAD);
    if (vx > 1e-6) {
      const h = s * Math.tan(bb.laDeg * FG_RAD) - (FG_G * s * s) / (2 * vx * vx);
      if (h > g.gloveHeightM) return null; // 頭上を通過
    }
    // 初バウンドまでの弾道距離（生の放物線）より手前で迎撃＝空中でキャッチ（ライナー捕球）
    const laRad = bb.laDeg * FG_RAD;
    const firstBounceM = (v * v * Math.sin(2 * laRad)) / FG_G;
    air = s < firstBounceM;
  }

  const ix = s * dx;
  const iy = s * dy;
  const move = Math.hypot(ix - f.x, iy - f.y) - g.reachM;
  const vG = v * g.gbSpeedFactor; // ゴロの実効水平速度（バウンド減速込み）
  const tBall = s / vG;
  const tAvail = tBall - g.reactionS;
  if (tAvail <= 0) return null;

  const dir = directionFactor(f.x, f.y, ix, iy, g.backPenalty);
  const reqSpeed = move <= 0 ? 0 : move / tAvail / Math.max(0.02, dir);

  // 送球アウト: 捕球時刻 + 持ち替え + 送球飛行 < 打者走者の一塁到達
  // （air=trueの捕球は本来送球不要の即アウトだが、該当打球は痛烈でpThrow≈1のため補正は省略）
  const tField = Math.max(tBall, g.reactionS + Math.max(0, move) / g.smaxBase);
  const throwDist = Math.hypot(FIRST_BASE.x - ix, FIRST_BASE.y - iy);
  const tOut = tField + g.transferS + throwDist / g.throwSpeed;
  return { reqSpeed, pThrow: expit((runnerToFirstS - tOut) / g.throwWidth), air };
}

/** 打者走者の一塁到達時間[s]。speed 50 = リーグ平均。速い打者ほど内野安打が湧く */
export function runnerToFirst(runnerSpeed, cfg) {
  const g = cfg.tuning.field;
  return g.runnerToFirstS - (runnerSpeed - 50) * g.runnerToFirstPerRating;
}

/**
 * 打球1つに対する各野手の「必要走速度」と「送球アウト確率」。
 * 野手個人の能力を含まない（＝ Statcast catch probability と同じくリーグ中立）。
 * gbAir[pos]=true はGB分類の打球をそのポジションが「初バウンド前に迎撃」＝実質ライナー捕球。
 * @returns {{reqSpeed: Object<string,number>, pThrow: Object<string,number>, gbAir: Object<string,boolean>}}
 */
export function fieldingChances(bb, type, cfg) {
  const g = cfg.tuning.field;
  const F = fielderPositions(cfg);
  const reqSpeed = {};
  const pThrow = {};
  const gbAir = {};

  const v = bb.evKmh / 3.6;
  const hangS = bb.laDeg > 0 ? (2 * v * Math.sin(bb.laDeg * FG_RAD)) / FG_G : 0;
  const landX = bb.distanceM * Math.sin(bb.sprayDeg * FG_RAD);
  const landY = bb.distanceM * Math.cos(bb.sprayDeg * FG_RAD);
  const rtf = runnerToFirst(bb.runnerSpeed ?? 50, cfg);

  for (const pos of FIELD_POS) {
    const f = F[pos];
    let rs = Infinity;
    let pt = 1;
    let air = false;
    if (type === 'GB') {
      // ゴロは内野手のみアウト機会を持つ（外野へ抜けたら安打。外野の処理は ARM の領分）
      if (IS_INFIELD.has(pos)) {
        const gc = groundChance(f, bb, g, rtf);
        if (gc) {
          rs = gc.reqSpeed;
          pt = gc.pThrow;
          air = gc.air;
        }
      }
    } else {
      // 空中球は全野手が落下点を狙える。頭上を越える打球は後方ペナルティで自動的に p≈0 になる
      rs = reqSpeedAir(f, landX, landY, hangS, g);
    }
    reqSpeed[pos] = rs;
    pThrow[pos] = pt;
    gbAir[pos] = air;
  }
  return { reqSpeed, pThrow, gbAir };
}

/**
 * 打球を「拾う」外野手（ARM の主語）。責任野手（OAA の主語）とは別概念であることに注意:
 *   三遊間を抜けたゴロの OAA 責任は SS だが、実際に球を拾って返球するのは LF である。
 * 空中球は落下点に最も近い外野手、ゴロは spray 角のセクタで決める。
 */
export function retrievingOutfielder(bb, cfg) {
  const F = fielderPositions(cfg);
  const landX = bb.distanceM * Math.sin(bb.sprayDeg * FG_RAD);
  const landY = bb.distanceM * Math.cos(bb.sprayDeg * FG_RAD);
  let best = null;
  let bestD = Infinity;
  for (const pos of FG_OUTFIELD) {
    const f = F[pos];
    // ゴロは転がり出しの落下点が浅く落下点距離が使えないので、角度セクタで決める
    const d = bb.laDeg <= 0
      ? Math.abs(bb.sprayDeg - cfg.tuning.field.positions[pos].t)
      : Math.hypot(landX - f.x, landY - f.y);
    if (d < bestD) {
      bestD = d;
      best = pos;
    }
  }
  return best;
}

/** Smax（実効クロージング速度 m/s）。rating 50 = リーグ平均 */
export function smaxOf(rating, cfg) {
  const g = cfg.tuning.field;
  return g.smaxBase + (rating - 50) * g.smaxPerRating;
}

/** 必要走速度 + Smax → アウト化確率 */
export function outProb(reqSpeed, pThrow, smax, cfg) {
  if (!Number.isFinite(reqSpeed)) return 0;
  return expit((smax - reqSpeed) / cfg.tuning.field.width) * pThrow;
}

/**
 * リーグ中立の責任野手とアウト化確率。
 * argmax_i p_i。全員 p≈0（誰にも捕れない打球）のときは、必要走速度が最小の野手＝
 * 「最も惜しかった」野手を責任者とする（減点は −p≈0 なので実害は無い）。
 * @returns {{pos:string, pOut:number, reqSpeed:number, pThrow:number}}
 */
export function neutralResponsible(bb, type, cfg) {
  const { reqSpeed, pThrow } = fieldingChances(bb, type, cfg);
  const smax = cfg.tuning.field.smaxBase;
  let bestPos = null;
  let bestP = -1;
  let bestReq = Infinity;
  for (const pos of FIELD_POS) {
    const p = outProb(reqSpeed[pos], pThrow[pos], smax, cfg);
    const rs = reqSpeed[pos];
    // p が大きい方を優先。同率（典型的には両方 0）なら必要走速度が小さい方
    if (p > bestP + 1e-12 || (Math.abs(p - bestP) <= 1e-12 && rs < bestReq)) {
      bestP = p;
      bestReq = rs;
      bestPos = pos;
    }
  }
  if (bestPos == null) bestPos = type === 'GB' ? 'SS' : 'CF';
  return { pos: bestPos, pOut: Math.max(0, bestP), reqSpeed: reqSpeed[bestPos], pThrow: pThrow[bestPos] };
}

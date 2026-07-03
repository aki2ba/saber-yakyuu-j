// ============================================================================
// 文脈指標（RE24 / WPA / LI / Clutch）— フェーズB B2（§B2 / req_1 §8.3「WARの死角」）
//
// 「打席/打球/プレーのイベントストリームを読むだけで計算できる」文脈指標を、
// シミュレーション本体（打席解決・打球生成・継投）を一切変えずに湧かせる。
//
// 2パス構造（season.mjs で結線・§B2）:
//   pass1(derive)   : シーズンを実走し、24状態(塁×アウト)の得点期待値(RE)・
//                     (イニング,表裏,点差,塁アウト)→勝率(WE)・打席状態のWE変化分散(LI) を
//                     大標本として集計する（乱数は消費しない＝結果は不変）。
//   → deriveTables  : RE行列・WE表(階層平滑化)・LI表(リーグ平均=1.0正規化) を焼き固める。
//   pass2(accumulate): 同一シード＝同一試合を再走し、各プレー確定点で
//                     ΔRE を打者(+)/投手(−)、走塁は走者へ・ΔWE(=WPA) を打者/投手へ加算。
//                     LI を打席加重(aLI)・投手(pLI)・救援登板時(gmLI) に積む。
//
// 恒等式（構造から保証）: リーグ ΣRE24 ≈ 0 / 1試合の ΣWPA = 勝者+0.5・敗者−0.5（ゼロサム）/
//                        リーグ 打席加重平均 LI = 1.0。
//
// 生の一球ログは永続化しない（§17）。派生に用いる liPairs は導出中のみ保持する一時バッファで、
// pass1 完了後は破棄する（集計カウンタと導出用の遷移対のみ・恒久保存しない）。
// ============================================================================

// 終端(試合決着)を表す afterKey のセンチネル（liPairs 用）。
const TERM_HWIN = -1; // ホーム勝ち（weHome=1）
const TERM_HLOSS = -2; // ホーム負け（weHome=0）
const TERM_TIE = -3; // 引分（weHome=0.5）

/** 状態キー = f(イニング, 表裏, 点差クリップ, 塁状態0..7, アウト0..2)。打者側視点の点差。 */
function ctxEncodeKey(innMax, diffClip, inning, isBottom, diff, base, outs) {
  const D = 2 * diffClip + 1;
  const inn = (inning < 1 ? 1 : inning > innMax ? innMax : inning) - 1;
  const d = (diff < -diffClip ? -diffClip : diff > diffClip ? diffClip : diff) + diffClip;
  return (((inn * 2 + (isBottom ? 1 : 0)) * D + d) * 8 + base) * 3 + outs;
}

/** キーから「表裏（bottom=ホーム攻撃）」を復元（LI導出でホーム視点へ変換するのに使う）。 */
function ctxKeyIsBottom(key, diffClip) {
  const D = 2 * diffClip + 1;
  return Math.floor(key / (D * 8 * 3)) % 2 === 1;
}

/** 24状態インデックス（塁 0..7 × アウト 0..2）。RE行列の添字。 */
function ctxReIndex(base, outs) {
  return outs * 8 + base;
}

/**
 * 回終了（3アウト）後の「次ハーフ先頭（無死・走者なし・攻守交代）」の状態キー。
 * 3アウト状態は WE表(アウト0..2)に無いため、勝率は次ハーフ先頭の値へ連続的に引き継ぐ
 * （そうしないと打者/投手側の WPA 配分が偏る）。次の攻撃側から見た点差 = 現守備側得点 − 現攻撃側得点。
 */
function nextHalfKey(innMax, diffClip, inning, curBottom, curBatScore, fldScore) {
  const nextBottom = !curBottom;
  const nextInning = curBottom ? inning + 1 : inning;
  return ctxEncodeKey(innMax, diffClip, nextInning, nextBottom, fldScore - curBatScore, 0, 0);
}

/**
 * このプレー確定後に試合が決着したか（simulateGame の break 条件と整合させる）。
 * @param {boolean} isBottom 攻撃側がホーム（裏）か
 * @param {number} inning
 * @param {number} batScore 攻撃側の得点（このプレー後）
 * @param {number} fldScore 守備側の得点
 * @param {number} outsAfter このプレー後のアウト数
 * @param {number} maxInnings 引分になる回数上限（ポストシーズンは Infinity）
 * @returns {{over:boolean, homeWon?:boolean, tie?:boolean}}
 */
export function gameOverAfter(isBottom, inning, batScore, fldScore, outsAfter, maxInnings) {
  if (inning < 9) return { over: false };
  // サヨナラ: 裏でホーム(=攻撃側)が勝ち越し（アウト数に依らず即決着）
  if (isBottom && batScore > fldScore) return { over: true, homeWon: true };
  if (outsAfter >= 3) {
    if (!isBottom) {
      // 表終了: ホーム(=守備側)がリードなら決着（裏は行われない）
      if (fldScore > batScore) return { over: true, homeWon: true };
      return { over: false }; // ビジターリード or 同点 → 裏へ
    }
    // 裏終了: ホーム(=攻撃側)は勝ち越していれば既にサヨナラ済み。ここでは同点 or ビハインド。
    if (batScore < fldScore) return { over: true, homeWon: false }; // ビジター勝ち
    if (batScore === fldScore && inning >= maxInnings) return { over: true, tie: true };
    return { over: false }; // 同点続行
  }
  return { over: false };
}

// --- 導出コンテキスト（pass1: 集計のみ・乱数非消費） --------------------------

/**
 * pass1 用の集計コンテキストを作る（§B2）。onPlay で各プレーの状態遷移を受け、
 * RE(24状態→残り得点)・WE(状態→勝敗)・LIペア(打席の状態前後キー) を蓄える。
 */
export function makeDeriveContext(cfg) {
  const c = cfg.tuning.context;
  return {
    mode: 'derive',
    innMax: c.innMax,
    diffClip: c.scoreDiffClip,
    maxInnings: 12,
    reSum: new Float64Array(24),
    reCount: new Float64Array(24),
    weWin: new Map(),
    weN: new Map(),
    liPairs: [], // flat [beforeKey, afterKey, ...]（PA のみ・一時バッファ）
    // 実行中の一時状態
    reHalfBuf: [], // flat [reIdx, runsBefore, ...]（当該ハーフ）
    inningRunsSoFar: 0,
    weGameBuf: [], // flat [key, isBottom(0/1), ...]（当該試合）
    startGame() {
      this.reHalfBuf.length = 0;
      this.inningRunsSoFar = 0;
      this.weGameBuf.length = 0;
    },
    onPlay(p) {
      deriveOnPlay(this, p);
    },
  };
}

function deriveOnPlay(gc, p) {
  const batScoreAfter = p.batScoreBefore + p.runsOnPlay;
  const go = gameOverAfter(p.battingIsHome, p.inning, batScoreAfter, p.fldScore, p.outsAfter, gc.maxInnings);
  const inningOver = p.outsAfter >= 3 || go.over;

  // RE: 「この状態から回終わりまでの得点」を回終了時に確定する
  gc.reHalfBuf.push(ctxReIndex(p.baseBefore, p.outsBefore), gc.inningRunsSoFar);
  gc.inningRunsSoFar += p.runsOnPlay;
  if (inningOver) {
    const total = gc.inningRunsSoFar;
    const buf = gc.reHalfBuf;
    for (let i = 0; i < buf.length; i += 2) {
      gc.reSum[buf[i]] += total - buf[i + 1];
      gc.reCount[buf[i]] += 1;
    }
    buf.length = 0;
    gc.inningRunsSoFar = 0;
  }

  // WE: 状態(打者側視点)を試合バッファに積み、決着時に「攻撃側が勝ったか」で確定する
  const beforeKey = ctxEncodeKey(gc.innMax, gc.diffClip, p.inning, p.battingIsHome, p.batScoreBefore - p.fldScore, p.baseBefore, p.outsBefore);
  gc.weGameBuf.push(beforeKey, p.battingIsHome ? 1 : 0);

  // LI: 打席の状態前→状態後（終端は centinel・回終了は次ハーフ先頭）を蓄え、WE表確定後に分散を取る
  if (p.kind === 'pa') {
    const afterKey = go.over
      ? go.tie
        ? TERM_TIE
        : go.homeWon
          ? TERM_HWIN
          : TERM_HLOSS
      : p.outsAfter >= 3
        ? nextHalfKey(gc.innMax, gc.diffClip, p.inning, p.battingIsHome, batScoreAfter, p.fldScore)
        : ctxEncodeKey(gc.innMax, gc.diffClip, p.inning, p.battingIsHome, batScoreAfter - p.fldScore, p.baseAfter, p.outsAfter);
    gc.liPairs.push(beforeKey, afterKey);
  }

  if (go.over) {
    const buf = gc.weGameBuf;
    for (let i = 0; i < buf.length; i += 2) {
      const key = buf[i];
      const isB = buf[i + 1] === 1;
      const battingWon = isB ? go.homeWon : !go.homeWon;
      gc.weN.set(key, (gc.weN.get(key) || 0) + 1);
      gc.weWin.set(key, (gc.weWin.get(key) || 0) + (go.tie ? 0.5 : battingWon ? 1 : 0));
    }
    buf.length = 0;
  }
}

// --- 表の焼き固め（pass1 → tables） ------------------------------------------

/**
 * pass1 の集計から RE行列・WE表(階層平滑化)・LI表(リーグ平均=1.0) を導出する（§B2）。
 * @param {ReturnType<makeDeriveContext>} gc
 * @param {Object} cfg
 * @returns {{re:Float64Array, we:Float64Array, li:Float64Array, innMax:number, diffClip:number,
 *   keyN:number, avgSwing:number, re0:number}}
 */
export function deriveTables(gc, cfg) {
  const c = cfg.tuning.context;
  const innMax = gc.innMax;
  const diffClip = gc.diffClip;
  const D = 2 * diffClip + 1;
  const keyN = innMax * 2 * D * 8 * 3;

  // RE行列（24状態）
  const re = new Float64Array(24);
  for (let i = 0; i < 24; i++) re[i] = gc.reCount[i] ? gc.reSum[i] / gc.reCount[i] : 0;

  // WE表の階層平滑化: fine(状態) ← coarse(イニング/表裏/点差) ← diff周辺 ← 0.5
  const coarseN = new Float64Array(innMax * 2 * D);
  const coarseWin = new Float64Array(innMax * 2 * D);
  const diffN = new Float64Array(D);
  const diffWin = new Float64Array(D);
  for (const [key, n] of gc.weN) {
    const win = gc.weWin.get(key);
    const d = Math.floor(key / (8 * 3)) % D;
    const innB = Math.floor(key / (D * 8 * 3)); // = inn*2 + isBottom（0..innMax*2-1）
    coarseN[innB * D + d] += n;
    coarseWin[innB * D + d] += win;
    diffN[d] += n;
    diffWin[d] += win;
  }
  const diffWE = new Float64Array(D);
  for (let d = 0; d < D; d++) diffWE[d] = (diffWin[d] + c.weDiffK * 0.5) / (diffN[d] + c.weDiffK);
  const coarseWE = new Float64Array(innMax * 2 * D);
  for (let i = 0; i < coarseWE.length; i++) {
    const d = i % D;
    coarseWE[i] = (coarseWin[i] + c.weCoarseK * diffWE[d]) / (coarseN[i] + c.weCoarseK);
  }
  const we = new Float64Array(keyN);
  for (let key = 0; key < keyN; key++) {
    const n = gc.weN.get(key) || 0;
    const win = gc.weWin.get(key) || 0;
    const d = Math.floor(key / (8 * 3)) % D;
    const innB = Math.floor(key / (D * 8 * 3));
    const prior = coarseWE[innB * D + d];
    we[key] = (win + c.weSmoothK * prior) / (n + c.weSmoothK);
  }

  // LI表: 各状態の ΔWE(ホーム視点) の二乗平均平方根(=WE変化のばらつき) を、
  // 打席加重平均で 1.0 に正規化する（リーグ平均LI=1.0）。
  const liSumSq = new Float64Array(keyN);
  const liN = new Float64Array(keyN);
  const P = gc.liPairs;
  const weHomeOfKey = (key) => (ctxKeyIsBottom(key, diffClip) ? we[key] : 1 - we[key]);
  for (let i = 0; i < P.length; i += 2) {
    const b = P[i];
    const a = P[i + 1];
    const weHb = weHomeOfKey(b);
    const weHa = a === TERM_HWIN ? 1 : a === TERM_HLOSS ? 0 : a === TERM_TIE ? 0.5 : weHomeOfKey(a);
    const dw = weHa - weHb;
    liSumSq[b] += dw * dw;
    liN[b] += 1;
  }
  const swing = new Float64Array(keyN);
  let wSum = 0;
  let wN = 0;
  for (let k = 0; k < keyN; k++) {
    if (liN[k]) {
      swing[k] = Math.sqrt(liSumSq[k] / liN[k]);
      wSum += swing[k] * liN[k];
      wN += liN[k];
    }
  }
  const avgSwing = wN ? wSum / wN : 1; // 打席加重平均のスイング＝正規化基準
  const li = new Float64Array(keyN);
  for (let k = 0; k < keyN; k++) li[k] = avgSwing > 0 ? swing[k] / avgSwing : 1;

  return { re, we, li, innMax, diffClip, keyN, avgSwing, re0: re[ctxReIndex(0, 0)] };
}

// --- 加算コンテキスト（pass2: プレーごとに ΔRE/ΔWPA/LI を選手へ付与） ----------

/**
 * pass2 用の加算コンテキストを作る（§B2）。tables を参照し、各プレー確定点で
 * ΔRE を打者(+)/投手(−)・走塁は走者へ、ΔWE(=WPA) を打者/投手・救援登板時LIを積む。
 * gameHomeWpa は当該試合のホーム側WPA累計（= weHome(終端)−0.5 = 勝者±0.5 のゼロサム検査用）。
 */
export function makeAccumulateContext(tables, cfg) {
  return {
    mode: 'accumulate',
    tables,
    innMax: tables.innMax,
    diffClip: tables.diffClip,
    maxInnings: 12,
    weHomePrev: 0.5, // 試合開始の中立勝率（アンカー）
    gameHomeWpa: 0,
    startGame() {
      this.weHomePrev = 0.5;
      this.gameHomeWpa = 0;
    },
    onPlay(p) {
      accumulateOnPlay(this, p);
    },
  };
}

function reGet(t, base, outs) {
  return t.re[ctxReIndex(base, outs)];
}
function weHomeOf(t, inning, isBottom, diff, base, outs) {
  return weHomeAtKey(t, ctxEncodeKey(t.innMax, t.diffClip, inning, isBottom, diff, base, outs));
}
function weHomeAtKey(t, key) {
  const wb = t.we[key]; // P(攻撃側が勝つ)
  return ctxKeyIsBottom(key, t.diffClip) ? wb : 1 - wb; // ホーム視点へ
}
function liGet(t, inning, isBottom, diff, base, outs) {
  const key = ctxEncodeKey(t.innMax, t.diffClip, inning, isBottom, diff, base, outs);
  return t.li[key];
}

function accumulateOnPlay(gc, p) {
  const t = gc.tables;
  const batScoreAfter = p.batScoreBefore + p.runsOnPlay;
  const go = gameOverAfter(p.battingIsHome, p.inning, batScoreAfter, p.fldScore, p.outsAfter, gc.maxInnings);
  const inningOver = p.outsAfter >= 3 || go.over;

  // RE24: ΔRE = RE(状態後) − RE(状態前) + このプレー得点。回終了/決着後は RE=0。
  const reB = reGet(t, p.baseBefore, p.outsBefore);
  const reA = inningOver ? 0 : reGet(t, p.baseAfter, p.outsAfter);
  const dRE = reA - reB + p.runsOnPlay;
  p.batSideStat.re24 += dRE;
  p.pitStat.re24 -= dRE;

  // WPA: ホーム視点の勝率変化を打者(攻撃側)/投手(守備側)へ。ΔWE の総和は telescoping で
  // weHome(終端)−0.5 = 勝者±0.5（ゼロサム）に一致する（weHomePrev をアンカーに逐次更新）。
  // 回終了(3アウト)後は次ハーフ先頭の勝率へ連続的に引き継ぐ（3アウト状態は表に無い）。
  const weNow = go.over
    ? go.tie
      ? 0.5
      : go.homeWon
        ? 1
        : 0
    : p.outsAfter >= 3
      ? weHomeAtKey(t, nextHalfKey(t.innMax, t.diffClip, p.inning, p.battingIsHome, batScoreAfter, p.fldScore))
      : weHomeOf(t, p.inning, p.battingIsHome, batScoreAfter - p.fldScore, p.baseAfter, p.outsAfter);
  const dHome = weNow - gc.weHomePrev;
  const batWPA = p.battingIsHome ? dHome : -dHome; // 攻撃側から見た勝率変化
  p.batSideStat.wpa += batWPA;
  p.pitStat.wpa -= batWPA;
  if (p.pitcherCur) p.pitcherCur.wpa -= batWPA; // 登板ぶんWPA（SD/MD判定用）
  gc.weHomePrev = weNow;
  gc.gameHomeWpa += dHome;

  // LI: 打席の状態前レバレッジを 打者(aLI)/投手(pLI) へ。救援は登板時(初打者)を gmLI へ。
  // WPA/LI（文脈中立）: 各打席の WPA を打席LIで割って累積（Clutch = WPA/pLI − WPA/LI の素）。
  if (p.kind === 'pa') {
    const li = liGet(t, p.inning, p.battingIsHome, p.batScoreBefore - p.fldScore, p.baseBefore, p.outsBefore);
    p.batSideStat.liSum += li;
    p.pitStat.liSum += li;
    if (li > 0) {
      p.batSideStat.wpaLiSum += batWPA / li;
      p.pitStat.wpaLiSum += -batWPA / li;
    }
    if (p.firstBatterOfApp) {
      p.pitStat.gmLiSum += li;
      p.pitStat.gmLiN += 1;
    }
  }
}

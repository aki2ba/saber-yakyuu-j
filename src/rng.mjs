// ============================================================================
// 決定論RNG基盤（§3.1 §17 §19 / 自己レビュー M2・F35・F41）
//
// 設計:
//   - 階層シード: masterSeed → hashSeed(season, game, pa, ...) で打席ごとに独立RNG。
//     「実行順序に依存しない」＝ 任意の試合/打席を単独・任意順で再現できる（並列化・§19突合に必須）。
//   - PRNG: mulberry32（素のLCGでなくカウンタ系。1状態語で高品質・自己完結）。
//   - Box-Muller: 予備値をキャッシュしない（毎回2一様乱数を消費し1つ返す）。
//     → 隠れ状態ゼロで版間・端末間・シリアライズ跨ぎでも完全再現（F41）。
//   - 直列化: 状態は uint32 一語。serializeRng→number / makeRng(number) で復元（セーブ対象）。
// ============================================================================

/** mulberry32 の1ステップ。state.a を進めて float[0,1) を返す。 */
function step(state) {
  const a = (state.a + 0x6d2b79f5) | 0;
  state.a = a;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 素の関数版PRNG（selfCheck等の軽用途） */
export function mulberry32(seed) {
  const state = { a: seed >>> 0 };
  return () => step(state);
}

/**
 * 複数の整数/文字列を 32bit シードへ決定論的に畳み込む（FNV-1a派生）。
 * hashSeed(masterSeed, seasonId, gameId, paIndex) の形で階層シードを作る。
 */
export function hashSeed(...parts) {
  let h = 0x811c9dc5 >>> 0;
  const byte = (b) => {
    h ^= b & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  for (const p of parts) {
    if (typeof p === 'string') {
      for (let i = 0; i < p.length; i++) byte(p.charCodeAt(i));
    } else {
      let n = Math.trunc(p) >>> 0;
      byte(n);
      byte(n >>> 8);
      byte(n >>> 16);
      byte(n >>> 24);
    }
  }
  // 最終ミックス
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * RNGオブジェクト。状態は state.a（uint32）に閉じる＝シリアライズ可能。
 */
export function makeRng(seed) {
  const state = { a: seed >>> 0 };
  const rng = {
    state,
    /** float [0,1) */
    next() {
      return step(state);
    },
    /** 整数 [0,n) */
    int(n) {
      return Math.floor(step(state) * n);
    },
    /** 実数 [lo,hi) */
    range(lo, hi) {
      return lo + step(state) * (hi - lo);
    },
    /** 標準正規（Box-Muller・予備値キャッシュなし＝隠れ状態ゼロ） */
    normal(mean = 0, sd = 1) {
      let u1 = step(state);
      if (u1 < 1e-12) u1 = 1e-12; // log(0) 回避
      const u2 = step(state);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return mean + sd * z;
    },
    /** 確率 p で true */
    chance(p) {
      return step(state) < p;
    },
    /** 子RNGを決定論的に派生（順序非依存） */
    fork(...parts) {
      return makeRng(hashSeed(state.a, ...parts));
    },
  };
  return rng;
}

/**
 * 階層シードから、指定座標(season/game/pa等)の打席用RNGを作る。
 * 実行順序に依存せず、同じ座標は常に同じ列を返す。
 */
export function rngFor(masterSeed, ...coords) {
  return makeRng(hashSeed(masterSeed, ...coords));
}

/** 状態を数値へ（セーブ用） */
export function serializeRng(rng) {
  return rng.state.a >>> 0;
}

/** 数値状態から復元（makeRng(state) はその地点から続きを再現する） */
export function deserializeRng(stateNumber) {
  return makeRng(stateNumber >>> 0);
}

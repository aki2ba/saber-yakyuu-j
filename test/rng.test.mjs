// 決定論RNG基盤（0-5）の単体テスト。順序非依存・シリアライズ・Box-Mullerを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng,
  hashSeed,
  rngFor,
  serializeRng,
  deserializeRng,
} from '../src/rng.mjs';

test('同一シードは同一列（決定論）', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('next() は [0,1)', () => {
  const r = makeRng(7);
  for (let i = 0; i < 5000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1);
  }
});

test('hashSeed は決定論的・入力が違えば概ね違う', () => {
  assert.equal(hashSeed(1, 2, 3), hashSeed(1, 2, 3));
  assert.notEqual(hashSeed(1, 2, 3), hashSeed(1, 2, 4));
  assert.notEqual(hashSeed('a'), hashSeed('b'));
});

test('rngFor は実行順序に依存しない（並列化・§19突合の前提）', () => {
  const master = 12345;
  // 順序A: (game1,pa1) を先に引く
  const a1 = Array.from({ length: 5 }, (_, i) => rngFor(master, 2026, 1, 1).next());
  // 別の打席を大量に引いた後で同じ座標を引く
  for (let g = 1; g <= 50; g++) for (let pa = 1; pa <= 40; pa++) rngFor(master, 2026, g, pa).next();
  const a2 = Array.from({ length: 5 }, (_, i) => rngFor(master, 2026, 1, 1).next());
  assert.deepEqual(a1, a2, '同座標は常に同じ列');
});

test('別座標は別の列を返す', () => {
  const master = 999;
  const x = rngFor(master, 2026, 1, 1).next();
  const y = rngFor(master, 2026, 1, 2).next();
  assert.notEqual(x, y);
});

test('シリアライズ→復元で途中から完全再現（隠れ状態なし）', () => {
  const r = makeRng(2026);
  for (let i = 0; i < 13; i++) r.next(); // 途中まで進める
  const saved = serializeRng(r);
  const contA = Array.from({ length: 10 }, () => r.next());
  const restored = deserializeRng(saved);
  const contB = Array.from({ length: 10 }, () => restored.next());
  assert.deepEqual(contA, contB, '復元後の続きが一致');
});

test('normal は概ね mean=0, sd=1（Box-Muller・キャッシュなし）', () => {
  const r = makeRng(2026);
  const n = 50000;
  let sum = 0;
  let sumsq = 0;
  for (let i = 0; i < n; i++) {
    const z = r.normal();
    sum += z;
    sumsq += z * z;
  }
  const mean = sum / n;
  const variance = sumsq / n - mean * mean;
  assert.ok(Math.abs(mean) < 0.03, `mean ${mean} ~ 0`);
  assert.ok(Math.abs(variance - 1) < 0.05, `var ${variance} ~ 1`);
});

test('normal は決定論的（同一シードで同一列＝キャッシュ由来のズレなし）', () => {
  const a = makeRng(5);
  const b = makeRng(5);
  const seqA = Array.from({ length: 30 }, () => a.normal(10, 2));
  const seqB = Array.from({ length: 30 }, () => b.normal(10, 2));
  assert.deepEqual(seqA, seqB);
});

test('fork は決定論的な子RNGを作る', () => {
  const parent = makeRng(1);
  const c1 = parent.fork('players').next();
  const parent2 = makeRng(1);
  const c2 = parent2.fork('players').next();
  assert.equal(c1, c2);
});

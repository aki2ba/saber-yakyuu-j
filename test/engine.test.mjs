// エンジン核の単体テスト（node:test / 依存ゼロ）。0-2 では決定論性を担保する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfCheck, mulberry32, ENGINE_VERSION } from '../src/engine.mjs';

test('selfCheck は同一シードで決定論的', () => {
  assert.deepEqual(selfCheck(12345), selfCheck(12345));
});

test('selfCheck は異なるシードで異なる列を返す', () => {
  assert.notDeepEqual(selfCheck(12345), selfCheck(54321));
});

test('mulberry32 は [0,1) の値を返す', () => {
  const rnd = mulberry32(1);
  for (let i = 0; i < 1000; i++) {
    const v = rnd();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('ENGINE_VERSION が定義されている', () => {
  assert.equal(typeof ENGINE_VERSION, 'string');
  assert.ok(ENGINE_VERSION.length > 0);
});

// ============================================================================
// エンジン同一性の機械検証（0-2の門番）
//
// Node（src/engine.mjs を直接 import）と、
// ブラウザ相当（dist/pennant.html にインラインされた同一ソースを vm で評価）が、
// 同一シードで同一の selfCheck 出力になることを確認する。
// 不一致なら異常終了する。CI/較正前の回帰チェックに使う（§17 決定論 / §19 突合）。
// ============================================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { selfCheck as nodeSelfCheck, ENGINE_VERSION, POSITIONS as nodePositions } from '../src/engine.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'dist', 'pennant.html'), 'utf8');

// dist の <script> からインラインエンジンを取り出し、ブラウザ相当の環境で評価する。
const m = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(m, 'dist/pennant.html にインラインスクリプトが見つからない（先に npm run build）');

const sandbox = {
  Math,
  JSON,
  document: { getElementById: () => ({ set textContent(_v) {} }) },
};
vm.createContext(sandbox);
vm.runInContext(
  m[1] +
    '\nglobalThis.__selfCheck = selfCheck; globalThis.__ver = ENGINE_VERSION; globalThis.__positions = POSITIONS;',
  sandbox,
);

const seed = 12345;

// vm は別レルムなので配列のプロトタイプが異なる（deepStrictEqual はそこで落ちる）。
// 保証したいのは「シリアライズ出力の同一性」なので内容ベースで比較する。
const nodeJson = JSON.stringify(nodeSelfCheck(seed));
const browserJson = JSON.stringify(sandbox.__selfCheck(seed));
assert.equal(browserJson, nodeJson, 'Node と ブラウザ(dist) の selfCheck が不一致！決定論が壊れている');

// マルチモジュール・バンドラ検証: サブモジュール(positions.mjs)の定数も一致すること。
const posNodeJson = JSON.stringify(nodePositions);
const posBrowserJson = JSON.stringify(sandbox.__positions);
assert.equal(posBrowserJson, posNodeJson, 'POSITIONS が Node と dist で不一致（バンドラ異常）');

assert.equal(sandbox.__ver, ENGINE_VERSION, 'ENGINE_VERSION が Node と dist で不一致');

console.log('identity OK  seed=%d  ENGINE_VERSION=%s', seed, ENGINE_VERSION);
console.log('  selfCheck  Node/Browser :', nodeJson);
console.log('  POSITIONS  Node/Browser :', posNodeJson);

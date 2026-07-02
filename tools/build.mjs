// ============================================================================
// 配布ビルド: src/engine.mjs を起点にローカルESモジュール群を解決し、
// 単一の自己完結HTML（dist/pennant.html）へインライン化する最小バンドラ。
//
// 方針（0-2の設計注記の実装）:
//   - src 配下の相対 import のみ解決（node:組込みは src では使わない＝ブラウザ安全）
//   - 依存順（トポロジカル）に並べ、import 行と export キーワードを剥がして1スコープに連結
//   - default export は使わない規約。名前衝突は避ける（共有ヘルパーは util.mjs に集約）
// エンジンが大規模化したら esbuild へ移行可能（同じ入出力契約）。
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'engine.mjs');

// 単一行・複数行どちらの import 文にもマッチ（lazy に最初の from '...' まで）。
const IMPORT_RE = /import\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]\s*;?/g;

/** モジュールグラフを読み込む（absPath -> {code, deps[]}） */
const modules = new Map();
function load(absPath) {
  if (modules.has(absPath)) return;
  const code = readFileSync(absPath, 'utf8');
  const deps = [];
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // bare/組込みは無視（srcでは未使用）
    const depAbs = resolve(dirname(absPath), spec);
    deps.push(depAbs);
    load(depAbs);
  }
  modules.set(absPath, { code, deps });
}
load(entry);

/** トポロジカルソート（依存を先に） */
const order = [];
const seen = new Set();
function visit(p) {
  if (seen.has(p)) return;
  seen.add(p);
  for (const d of modules.get(p).deps) visit(d);
  order.push(p);
}
visit(entry);

/** import 行と export キーワードを剥がす */
function strip(code) {
  return code
    .replace(IMPORT_RE, '') // 相対/組込みの import 文を除去
    .replace(/^(\s*)export\s+(?=(async\s+function|function|const|let|var|class)\b)/gm, '$1')
    .replace(/^\s*export\s+\{[^}]*\}\s*(?:from\s+['"][^'"]+['"])?;?\s*$/gm, '');
}

const bundled = order
  .map((p) => `// ===== ${relative(root, p)} =====\n${strip(modules.get(p).code)}`)
  .join('\n\n');

// UI（ブラウザ専用）を別スクリプトとしてインライン化。engine.mjs からの import は剥がす
// （エンジンは先行<script>でグローバルに定義済み＝classic scriptの共有レキシカルスコープ参照）。
// エンジンは第1<script>に閉じるので verify-identity.mjs はそのまま機能する。
const uiStripped = strip(readFileSync(join(root, 'src', 'ui.mjs'), 'utf8'));

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>架空選手ペナント</title>
<style>
  :root { --bg:#0f3d2e; --panel:#123d2a; --ink:#f4f1e6; --clay:#c9a06a; --gold:#e8b84b;
          --muted:#9fb8ac; --line:#2f6b4a; --chalk:#e9e4d0; }
  * { box-sizing:border-box; }
  body { font-family: system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;
         background:var(--bg); color:var(--ink); margin:0; padding:16px; line-height:1.5; }
  h2 { font-size:17px; margin:6px 0; }
  .muted { color:var(--muted); font-size:12px; }
  button { font-family:inherit; cursor:pointer; border:1px solid var(--line); background:#0c3122;
           color:var(--ink); border-radius:6px; padding:6px 12px; }
  button.primary { background:var(--clay); color:#20160a; border-color:var(--clay); font-weight:700; }
  button.link { border:none; background:none; color:var(--muted); padding:2px 6px; }
  input { background:#0c3122; color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:5px; }
  .setup .row { display:flex; gap:8px; align-items:center; margin:10px 0; }
  .header { display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid var(--clay); padding-bottom:4px; }
  .tabs { display:flex; gap:6px; margin:10px 0; flex-wrap:wrap; }
  .tab { padding:6px 14px; }
  .tab.active { background:var(--clay); color:#20160a; border-color:var(--clay); font-weight:700; }
  .tablewrap { overflow-x:auto; border:1px solid var(--line); border-radius:8px; }
  table.stat { border-collapse:collapse; width:100%; font-size:13px; white-space:nowrap; }
  table.stat th { position:sticky; top:0; background:#0c3122; color:var(--chalk); padding:6px 8px;
                  text-align:right; cursor:pointer; user-select:none; border-bottom:1px solid var(--line); }
  table.stat th.left, table.stat td.left { text-align:left; }
  table.stat th.sorted { color:var(--gold); }
  table.stat td { padding:5px 8px; text-align:right; border-bottom:1px solid #1c4a34; }
  tr.clickable:hover { background:#174a34; cursor:pointer; }
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:flex-start;
             justify-content:center; padding:20px; overflow:auto; z-index:10; }
  .modal { background:var(--panel); border:1px solid var(--clay); border-radius:10px; padding:16px;
           max-width:560px; width:100%; }
  .modalhead { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .pname { font-size:18px; font-weight:700; }
  .kvgrid { display:grid; grid-template-columns:repeat(5,1fr); gap:6px; }
  .kv { background:#0c3122; border-radius:6px; padding:6px; text-align:center; }
  .kvk { font-size:10px; color:var(--muted); } .kvv { font-size:15px; font-weight:700; }
  .abilities { display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; margin-top:4px; }
  .abtitle { font-size:11px; color:var(--gold); margin:4px 0 2px; }
  .barrow { display:flex; align-items:center; gap:6px; font-size:11px; margin:2px 0; }
  .barlabel { width:64px; color:var(--muted); } .barval { width:22px; text-align:right; }
  .bartrack { flex:1; height:8px; background:#0c3122; border-radius:4px; overflow:hidden; }
  .barfill { display:block; height:100%; }
  .spraywrap { margin-top:10px; text-align:center; }
  svg.spray { width:280px; max-width:100%; background:#0c3122; border-radius:8px; }
  .warlist { display:flex; flex-direction:column; gap:6px; }
  .warcard { display:flex; align-items:center; gap:12px; background:var(--panel);
             border:1px solid var(--line); border-radius:8px; padding:8px 12px; }
  .warcard:hover { background:#174a34; cursor:pointer; }
  .warrank { width:24px; color:var(--muted); text-align:right; font-size:13px; }
  .warval { width:54px; font-size:20px; font-weight:800; color:var(--gold); text-align:right; }
  .warname { flex:1; font-size:14px; } .wn1 { font-weight:700; }
</style>
</head>
<body>
<div id="app"></div>
<script>
${bundled}
</script>
<script>
${uiStripped}
initApp();
</script>
</body>
</html>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'pennant.html'), html);
console.log('built: dist/pennant.html  (%d engine modules + UI inlined)', order.length);

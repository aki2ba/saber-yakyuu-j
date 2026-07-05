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
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'engine.mjs');
// ゲーム層API（フェーズC1・ヘッドレスなゲームループ）をUIから使えるよう、追加ルートとして
// 同一バンドルへ同梱する（engine.mjs の後に並ぶ＝ENGINE_VERSION 等が先に定義される）。
const gameEntry = join(root, 'src', 'game', 'index.mjs');

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
load(gameEntry);

// フェーズA新モジュール（manager/usage/postseason）の同梱確認（S4）:
// engine.mjs の import が誤って剥がされてもビルド自体は黙って通ってしまうため、
// バンドル対象のモジュールグラフに必ず入っていることをここで機械検証する。
const REQUIRED_MODULES = ['sim/manager.mjs', 'sim/usage.mjs', 'sim/postseason.mjs', 'sim/context.mjs', 'sim/metrics.mjs'];
for (const req of REQUIRED_MODULES) {
  const found = [...modules.keys()].some((p) => relative(root, p).split(sep).join('/').endsWith(req));
  if (!found) throw new Error(`bundle missing required module: ${req}（src/engine.mjs の import を確認）`);
}

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
visit(gameEntry); // engine の後にゲーム層（ENGINE_VERSION 定義後に newGame 等が並ぶ）

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
const uiSrc = readFileSync(join(root, 'src', 'ui.mjs'), 'utf8');
// フェーズE: UI分割モジュール（src/ui/*.mjs）を ui.mjs と同じ<script>へ前置 concat する
// （ui.mjs の import 行は strip で剥がれるため、同梱しないと参照エラーになる）。
// 同梱漏れを黙って通さないよう、ui.mjs の ./ui/ import が全て存在することを機械検証する。
const uiDir = join(root, 'src', 'ui');
const uiSubFiles = existsSync(uiDir) ? readdirSync(uiDir).filter((f) => f.endsWith('.mjs')).sort() : [];
for (const m of uiSrc.matchAll(IMPORT_RE)) {
  const spec = m[1];
  if (!spec.startsWith('./ui/')) continue;
  if (!uiSubFiles.includes(spec.slice('./ui/'.length))) {
    throw new Error(`UIバンドルに欠落: ${spec}（src/ui/ 配下に置くこと）`);
  }
}
const uiSubCode = uiSubFiles
  .map((f) => `// ===== src/ui/${f} =====\n${strip(readFileSync(join(uiDir, f), 'utf8'))}`)
  .join('\n\n');
const uiStripped = (uiSubCode ? uiSubCode + '\n\n' : '') + `// ===== src/ui.mjs =====\n${strip(uiSrc)}`;

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
  svg.evla { width:280px; max-width:100%; background:#0c3122; border-radius:8px; }
  .sprayrow { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; align-items:flex-start; margin-top:8px; }
  .modaltabs { display:flex; gap:6px; margin:8px 0 12px; flex-wrap:wrap; border-bottom:1px solid var(--line); padding-bottom:8px; }
  .mtab { padding:4px 12px; font-size:12px; }
  .mtab.active { background:var(--clay); color:#20160a; border-color:var(--clay); font-weight:700; }
  .modalbody { min-height:40px; }
  h4.teamsub { font-size:12px; color:var(--muted); margin:8px 0 3px; font-weight:600; }
  h3.leaguename { font-size:14px; margin:12px 0 4px; color:var(--gold); }
  .pspanel { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-top:12px; background:var(--panel); }
  .psrow { display:flex; gap:8px; font-size:13px; margin:3px 0; flex-wrap:wrap; }
  .pslabel { color:var(--muted); min-width:190px; }
  .pschamp { margin-top:6px; font-weight:700; color:var(--gold); }
  .warlist { display:flex; flex-direction:column; gap:6px; }
  .warcard { display:flex; align-items:center; gap:12px; background:var(--panel);
             border:1px solid var(--line); border-radius:8px; padding:8px 12px; }
  .warcard:hover { background:#174a34; cursor:pointer; }
  .warrank { width:24px; color:var(--muted); text-align:right; font-size:13px; }
  .warval { width:54px; font-size:20px; font-weight:800; color:var(--gold); text-align:right; }
  .warname { flex:1; font-size:14px; } .wn1 { font-weight:700; }
  /* --- フェーズC1b ゲームシェル --- */
  .teamgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; margin-top:10px; }
  .teamcard { text-align:left; padding:10px 12px; }
  .teamcard:hover { background:#174a34; }
  .tcname { font-weight:700; font-size:14px; }
  .progressbar-wrap { border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin:8px 0; }
  .nextcard { border:1px solid var(--clay); border-radius:8px; padding:8px 12px; margin:8px 0; background:var(--panel); }
  .nextmatch { font-size:15px; font-weight:700; }
  .recentlist { display:flex; flex-direction:column; gap:3px; }
  .recentrow { display:flex; gap:10px; align-items:center; font-size:13px; }
  .recentrow .score { margin-left:auto; color:var(--muted); }
  .wl { display:inline-block; width:18px; text-align:center; font-weight:700; border-radius:4px; }
  .wlw { color:#7bc47f; } .wll { color:#e06d6d; } .wlt { color:var(--muted); }
  tr.myteam td { background:#1c4a34; font-weight:700; }
  .teamstate { margin:8px 0; font-size:14px; letter-spacing:1px; }
  .mgrpanel, .savepanel { border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin-top:12px; }
  .tendrow { display:flex; align-items:center; gap:6px; margin:4px 0; }
  .tendlabel { width:96px; color:var(--muted); font-size:13px; }
  .tendbtn { padding:4px 10px; font-size:12px; }
  .tendbtn.active { background:var(--clay); color:#20160a; border-color:var(--clay); font-weight:700; }
  .watchmid { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-start; margin:10px 0; }
  svg.diamond { width:200px; background:#0c3122; border-radius:8px; }
  .benchbox { flex:1; min-width:180px; border:1px solid var(--line); border-radius:8px; padding:8px 12px; }
  .resrow { display:flex; align-items:center; gap:6px; font-size:12px; margin:4px 0; }
  .reslabel { width:60px; color:var(--muted); } .resval { width:40px; text-align:right; }
  .restrack { flex:1; height:8px; background:#0c3122; border-radius:4px; overflow:hidden; }
  .resfill { display:block; height:100%; background:var(--gold); }
  .pbp { border:1px solid var(--line); border-radius:8px; padding:8px 12px; max-height:320px; overflow-y:auto; font-size:13px; }
  .pbpline { padding:2px 0; border-bottom:1px solid #163d2c; }
  .pbpline.ev-hr { color:var(--gold); font-weight:700; }
  .pbpline.ev-run { color:#7bc47f; }
  .pbpline.ev-sub { color:#7fb0e0; }
  .pbpline.ev-start { color:var(--clay); font-weight:600; }
  .finalscore { font-size:16px; font-weight:700; margin-right:auto; }
  table.scoreboard th.rcol, table.scoreboard td.rcol { color:var(--gold); font-weight:700; border-left:1px solid var(--line); }
  .pbtrack { height:14px; background:#0c3122; border:1px solid var(--line); border-radius:8px; overflow:hidden; margin:10px 0; }
  .pbfill { height:100%; background:var(--clay); transition:width .1s; }
  .championbanner { background:var(--panel); border:1px solid var(--gold); border-radius:8px; padding:12px; font-size:18px; font-weight:800; color:var(--gold); text-align:center; margin:12px 0; }
  /* C4 演出: ニュース/表彰/記録/二つ名 */
  .newsfeed { display:flex; flex-direction:column; gap:4px; margin:4px 0 8px; }
  .newsrow { border-left:3px solid var(--line); background:var(--panel); border-radius:4px; padding:5px 10px; font-size:13px; }
  .newsrow.good { border-left-color:var(--gold); }
  .newsrow.bad { border-left-color:#c96a5a; }
  .newsrow.info { border-left-color:#5aa9e6; }
  .awardpanel { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:8px 0; background:var(--panel); }
  .awardlgname { color:var(--gold); font-weight:700; border-bottom:1px solid var(--line); padding-bottom:4px; margin-bottom:6px; }
  .awardtop { display:flex; flex-wrap:wrap; gap:10px; }
  .awardbig { flex:1; min-width:160px; background:#0c3122; border-radius:6px; padding:8px; }
  .awardbigk { display:block; font-size:11px; color:var(--muted); }
  .awardbigv { display:block; font-weight:700; color:var(--gold); }
  .awardlist { display:flex; flex-direction:column; gap:3px; }
  .awardrow { display:flex; gap:8px; align-items:center; background:#0c3122; border-radius:4px; padding:4px 8px; font-size:13px; }
  .awardyear { color:var(--muted); min-width:44px; }
  .awardbadge { color:var(--ink); }
  .nickname { display:flex; gap:8px; align-items:center; margin-top:6px; }
  .nickmark { font-size:10px; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:1px 5px; }
  .nicktext { font-size:18px; font-weight:800; color:var(--gold); }
  svg.growth { width:280px; max-width:100%; background:#0c3122; border-radius:8px; margin-top:6px; }
  /* E1: チームタブ（一軍/二軍サブタブ）・選手名リンク・モーダルヘッダ（二つ名/受賞歴） */
  .subtabs { display:flex; gap:6px; margin:8px 0 4px; flex-wrap:wrap; }
  .subtab { padding:5px 14px; font-size:13px; }
  .subtab.active { background:var(--clay); color:#20160a; border-color:var(--clay); font-weight:700; }
  .plink { color:#8fc7ff; cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px; }
  .plink:hover { color:var(--gold); }
  .headnick { margin-left:8px; font-size:13px; font-weight:700; color:var(--gold); }
  .headawards { font-size:11px; color:var(--muted); margin-top:2px; }
  .reccols { display:flex; flex-wrap:wrap; gap:10px; }
  .reccol { flex:1; min-width:150px; }
  .rechead { color:var(--muted); font-size:12px; border-bottom:1px solid var(--line); margin-bottom:3px; }
  .recrow { display:flex; gap:6px; font-size:13px; padding:2px 0; }
  .recrank { color:var(--muted); min-width:18px; }
  .recname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .recval { color:var(--gold); }
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

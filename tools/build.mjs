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
  .header .row { flex-wrap:wrap; }
  /* G4a: ハブタブバー sticky＋モバイル横スクロール1行。進行フッターは全タブ常設 */
  .tabs { display:flex; gap:6px; position:sticky; top:0; z-index:6; background:var(--bg); padding:6px 0;
          margin:6px 0; flex-wrap:nowrap; overflow-x:auto; }
  .tab { padding:6px 14px; white-space:nowrap; flex:none; }
  .tab.active { background:var(--clay); color:#20160a; border-color:var(--clay); font-weight:700; }
  .hubfooter { position:fixed; left:0; right:0; bottom:0; z-index:8; display:flex; gap:6px;
               background:var(--bg); border-top:1px solid var(--line); padding:8px;
               box-shadow:0 -6px 8px -6px rgba(0,0,0,.5); }
  .hubfooter button { flex:1; min-height:44px; white-space:nowrap; padding:6px 2px; }
  .hubspacer { height:68px; }
  @media (min-width:900px) {
    /* デスクトップでは flex:1 のボタンが幅いっぱいに間延びするのを防ぐ（G1a .watchctrl と同じ配慮） */
    .hubfooter { justify-content:center; }
    .hubfooter button { flex:none; min-width:140px; }
  }
  .tablewrap { overflow-x:auto; border:1px solid var(--line); border-radius:8px; position:relative; }
  /* G5b: 表の右にまだ列がある気配（初期表示時のヒント。スクロール後の追従は保証しない＝仕様） */
  .tablewrap::after { content:''; position:absolute; top:0; right:0; bottom:0; width:14px;
    background:linear-gradient(270deg, rgba(0,0,0,.35), transparent); pointer-events:none;
    border-radius:0 8px 8px 0; }
  .emptybox { text-align:center; padding:24px 8px; color:var(--muted); }
  table.stat { border-collapse:collapse; width:100%; font-size:13px; white-space:nowrap; }
  table.stat th { position:sticky; top:0; background:#0c3122; color:var(--chalk); padding:6px 8px;
                  text-align:right; cursor:pointer; user-select:none; border-bottom:1px solid var(--line); }
  table.stat th.left, table.stat td.left { text-align:left; }
  table.stat th.sorted { color:var(--gold); }
  table.stat td { padding:5px 8px; text-align:right; border-bottom:1px solid #1c4a34; }
  /* F4: 列数の多い成績表（打撃26列等）を横スクロールしても選手名が見えるよう先頭列を固定 */
  table.stat th:first-child { left:0; z-index:2; }
  table.stat td:first-child { position:sticky; left:0; background:var(--sticky-bg, var(--bg)); z-index:1; }
  tr.clickable:hover { background:#174a34; cursor:pointer; }
  /* 上記の先頭列固定より後ろに置き、自チーム強調/hoverが先頭セルだけ効かなくなるのを防ぐ */
  tr.clickable:hover td:first-child { background:#174a34; }
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:flex-start;
             justify-content:center; padding:20px; overflow:auto; z-index:10; }
  /* G9: モーダルは長い成分（打球SVG・経歴等）でも画面内に収まるようスクロール化。ヘッダーは常に見える */
  .modal { background:var(--panel); border:1px solid var(--clay); border-radius:10px; padding:16px;
           max-width:560px; width:100%; --sticky-bg:var(--panel); max-height:92vh; overflow:auto; }
  .modalhead { display:flex; justify-content:space-between; align-items:center;
               position:sticky; top:0; background:var(--panel); z-index:2; padding:4px 0; margin:-4px 0 10px; }
  .modalnavwrap { display:flex; align-items:center; gap:4px; }
  .modalnav { padding:4px 9px; font-size:14px; line-height:1; }
  .modalnav:disabled { opacity:.3; cursor:default; }
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
  /* G9: モーダルのタブ行は折返しせず横スクロール1行に（多タブ選手モーダルの2行化を解消） */
  .modaltabs { display:flex; gap:6px; margin:8px 0 12px; flex-wrap:nowrap; overflow-x:auto;
               border-bottom:1px solid var(--line); padding-bottom:8px; }
  .mtab { padding:4px 12px; font-size:12px; white-space:nowrap; flex:none; }
  .mtab.active { background:var(--clay); color:#20160a; border-color:var(--clay); font-weight:700; }
  .modalbody { min-height:40px; }
  h4.teamsub { font-size:12px; color:var(--muted); margin:8px 0 3px; font-weight:600; }
  h3.leaguename { font-size:14px; margin:12px 0 4px; color:var(--gold); }
  /* G7: 日程タブの月見出しは summary（<details class="schedmonth">内）でも同じ見た目にする */
  summary.leaguename { font-size:14px; margin:12px 0 4px; color:var(--gold); cursor:pointer; }
  .schedmonth { margin:4px 0; }
  .nextjump { margin:6px 0; }
  .schednext { outline:1px solid var(--gold); }
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
  .nextcard { border:1px solid var(--clay); border-radius:8px; padding:8px 12px; margin:8px 0; background:var(--panel); }
  .nextmatch { font-size:15px; font-weight:700; }
  .recentlist { display:flex; flex-direction:column; gap:3px; }
  .recentrow { display:flex; gap:10px; align-items:center; font-size:13px; }
  .recentrow .score { margin-left:auto; color:var(--muted); }
  .wl { display:inline-block; width:18px; text-align:center; font-weight:700; border-radius:4px; }
  .wlw { color:#7bc47f; } .wll { color:#e06d6d; } .wlt { color:var(--muted); }
  table.stat tr.myteam td { background:#1c4a34; font-weight:700; } /* (0,2,3)で先頭列固定の(0,2,2)に順序非依存で勝つ */
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
  .pbpline.ev-run { color:#7bc47f; }
  .pbpline.ev-sub { color:#7fb0e0; }
  .pbpline.ev-start { color:var(--clay); font-weight:600; }
  /* E2改: 結果行の色分け（安打=青系/HR・得点=赤系強調/三振=グレー/四死球=緑系/失策・盗塁死=橙系） */
  .pbpline.ev-hit, .curabresult.ev-hit, .fieldlabel.ev-hit { color:#8fc7ff; }
  .pbpline.ev-bb, .curabresult.ev-bb, .fieldlabel.ev-bb { color:#7bc47f; }
  .pbpline.ev-k, .curabresult.ev-k, .fieldlabel.ev-k { color:var(--muted); }
  .pbpline.ev-err, .curabresult.ev-err, .fieldlabel.ev-err { color:#e8b84b; }
  .pbpline.ev-score, .pbpline.ev-hr, .curabresult.ev-score, .curabresult.ev-hr, .fieldlabel.ev-hr { color:#ff8a76; font-weight:700; }
  /* F4: 得点/HRの瞬間を一目で伝える演出（現在の打席の結果ボックスに一度だけ再生されるパルス。
     再生位置が進んだ描画(justAdvanced)でのみ .fx を付与＝タブ切替等の再描画では再発火しない）。 */
  @keyframes pulseScore { 0% { box-shadow:0 0 0 0 rgba(255,138,118,.55); } 70% { box-shadow:0 0 0 12px rgba(255,138,118,0); } 100% { box-shadow:0 0 0 0 rgba(255,138,118,0); } }
  .curabresult.ev-score.fx, .curabresult.ev-hr.fx { animation: pulseScore .9s ease-out; }
  @keyframes notablePop { 0% { transform:scale(.95); opacity:0; } 100% { transform:scale(1); opacity:1; } }
  .notable.fx { animation: notablePop .35s ease-out; }
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
  /* G8: 表彰パネルをリーグ単位で折りたたみ */
  .awarddetails { margin:8px 0; }
  .awarddetails > summary { cursor:pointer; }
  .awarddetails .awardpanel { margin-top:6px; }
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
  /* G5a: 成績タブの列グループ切替（.subtabsより一段軽い見た目＝タブ切替と列フィルタの階層を区別） */
  .colgroups { display:flex; gap:4px; margin:4px 0 8px; flex-wrap:wrap; }
  .colgroup { padding:3px 10px; font-size:11px; border-radius:999px; border:1px solid var(--line); background:none; color:var(--muted); }
  .colgroup.active { border-color:var(--clay); color:var(--clay); font-weight:700; }
  /* F2-4: 二軍サブタブの育成契約バッジ・二軍順位の折りたたみ */
  .devbadge { margin-left:5px; font-size:10px; color:#20160a; background:var(--gold); border-radius:4px; padding:0 4px; font-weight:700; vertical-align:1px; }
  .farmstandings { margin-top:14px; }
  .plink { color:#8fc7ff; cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px; }
  .plink:hover { color:var(--gold); }
  .headnick { margin-left:8px; font-size:13px; font-weight:700; color:var(--gold); }
  .headawards { font-size:11px; color:var(--muted); margin-top:2px; }
  /* E2: スポナビ風観戦（ラインスコア/フィールド盤面/対戦カード/一球速報/進行切替） */
  .matchup { flex:1; min-width:250px; border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:var(--panel); }
  .bso { display:flex; gap:16px; margin-bottom:8px; flex-wrap:wrap; }
  .bsorow { display:flex; align-items:center; gap:5px; }
  .bsolabel { color:var(--muted); font-size:12px; width:12px; font-weight:700; }
  .lamp { width:11px; height:11px; border-radius:50%; background:#0c3122; border:1px solid var(--line); display:inline-block; }
  .lamp.lb.on { background:#7bc47f; border-color:#7bc47f; }
  .lamp.ls.on { background:var(--gold); border-color:var(--gold); }
  .lamp.lo.on { background:#c96a5a; border-color:#c96a5a; }
  .murow { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; margin:7px 0; font-size:13px; }
  .mulabel { color:var(--muted); font-size:11px; border:1px solid var(--line); border-radius:4px; padding:0 6px; }
  .muname { font-weight:700; font-size:14px; }
  .mutoday { color:var(--chalk); }
  .pbpline.ev-ab { color:var(--chalk); font-weight:600; }
  .pbpline.ev-pitch { color:var(--muted); }
  /* E2改: 「現在の打席」ボックス（正順の投球列＋決着結果の強調）＋履歴チップ＋実況ヘッダ */
  .curab { border:1px solid var(--line); border-radius:8px; padding:8px 12px; background:var(--panel); }
  .curabhead { color:var(--muted); font-size:11px; font-weight:700; letter-spacing:1px; margin-bottom:4px; }
  .curabpitch { font-size:13px; padding:1px 0; color:var(--chalk); }
  .curabresult { margin-top:6px; padding:6px 10px; border-radius:6px; background:#0c3122; font-size:15px; font-weight:700; }
  .reschips { display:inline-flex; gap:3px; flex-wrap:wrap; }
  .reschip { font-size:11px; color:var(--chalk); background:#0c3122; border:1px solid var(--line); border-radius:4px; padding:0 5px; }
  /* §16: 打席ごとの指標変化（「▼ 指標の変化」折りたたみ・既定で開く・結果ボックスの下にぶら下げる） */
  .metricdelta { margin-top:6px; border-top:1px dashed var(--line); padding-top:6px; }
  .metricdelta summary { cursor:pointer; color:var(--muted); font-size:11px; font-weight:700; list-style:none; }
  .metricdelta summary::-webkit-details-marker { display:none; }
  .mdgroup { margin-top:4px; }
  .mdname { font-size:11px; color:var(--muted); margin-right:6px; }
  .mdrow { font-size:12px; padding:1px 0 1px 4px; color:var(--chalk); }
  .mdrow.mdup { color:#7bc47f; }
  .mdrow.mddown { color:#e06d6d; }
  .pbphead { display:flex; align-items:center; gap:10px; margin:8px 0 2px; }
  .lineupbody { display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; align-items:flex-start; }
  .lineupcol { flex:1; min-width:230px; }
  /* E2ゾーニング改の常設パネルは G1a でスコアバー(.scorebar)＋タブ本体に置換済み（下方のG1a追記ブロック参照）。
     .duelcol は watchFieldChart の .fieldcol が併用するため残す（対戦タブでも使用中）。 */
  .duelcol { flex:1; min-width:250px; display:flex; flex-direction:column; gap:10px; }
  .handtag { font-size:10px; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:0 4px; white-space:nowrap; }
  /* F3: 打球フィールド図（対戦パネル右カラム・直近打席1件の実データ・静的画像・スポナビ風） */
  .fieldcol { align-items:center; text-align:center; flex:none; min-width:200px; }
  .duelhead { color:var(--muted); font-size:11px; font-weight:700; letter-spacing:1px; margin-bottom:2px; align-self:flex-start; }
  svg.fieldchart { width:200px; max-width:100%; background:#0c3122; border-radius:8px; }
  .fieldlabel { margin-top:6px; font-size:13px; font-weight:700; }
  .fieldsub { font-size:11px; margin-top:2px; }
  /* 一球判定の統一色（現打席リスト・実況一球行に適用）:
     ボール=白/見逃しS=緑/空振り=赤/ファウル=黄/インプレー=青 */
  .pc-ball, .pbpline.pc-ball, .curabpitch.pc-ball { color:#f4f1e6; fill:#f4f1e6; }
  .pc-called, .pbpline.pc-called, .curabpitch.pc-called { color:#7bc47f; fill:#7bc47f; }
  .pc-whiff, .pbpline.pc-whiff, .curabpitch.pc-whiff { color:#e06d6d; fill:#e06d6d; }
  .pc-foul, .pbpline.pc-foul, .curabpitch.pc-foul { color:#e8b84b; fill:#e8b84b; }
  .pc-inplay, .pbpline.pc-inplay, .curabpitch.pc-inplay { color:#8fc7ff; fill:#8fc7ff; }
  /* E2ゾーニング改: watch内サブタブ（速報/対戦/ボックス/スタメン・G1aで4分割） */
  .wtabs { display:flex; gap:6px; margin:12px 0 4px; flex-wrap:wrap; }
  .wtab { padding:5px 16px; font-size:13px; }
  .wtab.active { background:var(--clay); color:#20160a; border-color:var(--clay); font-weight:700; }
  .reccols { display:flex; flex-wrap:wrap; gap:10px; }
  .reccol { flex:1; min-width:150px; }
  .rechead { color:var(--muted); font-size:12px; border-bottom:1px solid var(--line); margin-bottom:3px; }
  .recrow { display:flex; gap:6px; font-size:13px; padding:2px 0; }
  .recrank { color:var(--muted); min-width:18px; }
  .recname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .recval { color:var(--gold); }
  /* E4: 日程・結果タブ＋簡易ボックススコア */
  .schedfuture td { color:var(--muted); }
  .modal.boxmodal { max-width:760px; }
  /* G1a: 観戦コンパクトスコアボード（常設はこれだけ・sticky） */
  /* wrap(.scorebarwrap)がブロックボックスを生成すると.scorebarのsticky有効範囲(containing block)が
     bar自身の高さとほぼ同一になり貼り付かなくなるため、display:contentsでボックス生成を回避する。 */
  .scorebarwrap { display:contents; }
  .scorebar { position:sticky; top:0; z-index:6; display:flex; align-items:center; justify-content:space-between;
              gap:8px; background:#0d3526; border:1px solid var(--clay); border-radius:10px; padding:6px 10px; margin:8px 0; }
  .sbteam { display:flex; align-items:baseline; gap:8px; min-width:0;
            border-top:3px solid var(--team-accent, transparent); padding-top:2px; }
  .sbname { font-size:13px; font-weight:700; color:var(--chalk); white-space:nowrap; }
  .sbteam.nowmy .sbname { color:var(--gold); }
  .sbscore { font-size:26px; font-weight:800; line-height:1; }
  .sbmid { text-align:center; flex:1; }
  .sbinning { font-size:14px; font-weight:700; color:var(--gold); }
  .sbmid .bso { justify-content:center; gap:8px; margin:2px 0 0; }
  .sbmid .bsorow { gap:3px; } .sbmid .lamp { width:9px; height:9px; }
  .sbbases { display:flex; justify-content:center; gap:10px; margin-top:3px; }
  .sbbase { width:9px; height:9px; transform:rotate(45deg); background:#0c3122; border:1px solid var(--clay); display:inline-block; }
  .sbbase.on { background:var(--gold); border-color:var(--gold); }
  .sblinescore { margin:0 0 8px; }
  .curabvs { font-size:12px; color:var(--chalk); margin-bottom:4px; }
  .dueltab { display:flex; flex-direction:column; gap:10px; align-items:center; margin-top:8px; }
  .dueltab .matchup { width:100%; }
  .dueltab .curab { background:#0d3526; } /* 旧 .duelpanel .curab の背景を引き継ぐ（対戦タブでは curab は使わないが将来の統一のため） */
  /* G1a: 進行バーを下部固定（親指到達域）。文言は変えずCSSだけで1行に収める */
  .watchctrl { position:fixed; left:0; right:0; bottom:0; z-index:8; display:flex; gap:4px; flex-wrap:nowrap;
               background:var(--bg); border-top:1px solid var(--line); padding:8px; margin:0;
               box-shadow:0 -6px 8px -6px rgba(0,0,0,.5); }
  .watchctrl button { flex:1; min-height:44px; min-width:0; padding:6px 1px; font-size:11px; white-space:nowrap; }
  .watchspacer { height:68px; }
  /* G1a: 観戦タブバー(.wtabs)もスコアバー直下にsticky化（ハブの.tabs同様・スクロール中も切替を失わない）。
     top値は.scorebarの実測高さに合わせる。試合進行中はB-S-Oランプ・塁表示分だけ.scorebarが
     高くなり実測67px（v.ended時は塁表示等が無く約46px）。67pxに合わせておけば、どちらの状態でも
     stickyで重なる（wtabsがscorebarの下にめり込む）ことはない。実測値が変わったらここも要再調整。 */
  .wtabs { position:sticky; top:67px; z-index:5; background:var(--bg); padding:4px 0; flex-wrap:nowrap; overflow-x:auto; }
  @media (min-width:900px) {
    /* デスクトップでは対戦タブを2カラム横並びに戻す・進行バー/フッターのボタンを肥大させない */
    .dueltab { flex-direction:row; align-items:flex-start; justify-content:center; }
    .dueltab .matchup { width:auto; flex:1; max-width:520px; }
    .watchctrl { justify-content:center; }
    .watchctrl button { flex:none; min-width:110px; }
  }
  /* E4: 狭幅（スマホ想定）の縦積みレイアウト。表は .tablewrap が横スクロールを受け持つ */
  @media (max-width: 640px) {
    body { padding:8px; }
    .header { flex-direction:column; align-items:flex-start; gap:6px; }
    .kvgrid { grid-template-columns:repeat(3,1fr); }
    .abilities { grid-template-columns:1fr; }
    .lineupbody, .sprayrow, .awardtop { flex-direction:column; }
    /* G1c: column+wrap は交差軸(幅)が内容サイズへ広がるため nowrap にし、列幅を親に合わせる */
    .lineupbody { flex-wrap:nowrap; }
    .lineupcol { min-width:0; width:100%; }
    .benchbox { min-width:0; width:100%; }
    table.scoreboard th, table.scoreboard td { padding:3px 4px; font-size:11px; }
    .reccols { flex-direction:column; }
    .overlay { padding:8px; }
    .modal { padding:12px; }
    .pslabel { min-width:0; }
  }
  /* G10: 用語集モーダル（TIP全項目のdt/dd＋観戦の色凡例） */
  .glossarylist { margin:0; }
  .glossarylist dt { font-weight:700; color:var(--gold); margin-top:8px; font-size:13px; }
  .glossarylist dd { margin:2px 0 0; font-size:12px; color:var(--chalk); }
  .glossarylegend { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
  .legendrow { display:flex; flex-wrap:wrap; gap:6px; }
  /* 既存の pc-*/ev-*/lb・ls・lo は他クラスとの併記が前提の色指定なので、凡例チップは独立した配色を持つ */
  .legendchip { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; border:1px solid var(--line); color:var(--chalk); }
  .legendchip.pc-ball { color:#f4f1e6; border-color:#f4f1e6; }
  .legendchip.pc-called { color:#7bc47f; border-color:#7bc47f; }
  .legendchip.pc-whiff { color:#e06d6d; border-color:#e06d6d; }
  .legendchip.pc-foul { color:#e8b84b; border-color:#e8b84b; }
  .legendchip.pc-inplay { color:#8fc7ff; border-color:#8fc7ff; }
  .legendchip.ev-hit { color:#8fc7ff; border-color:#8fc7ff; }
  .legendchip.ev-hr { color:#ff8a76; border-color:#ff8a76; font-weight:700; }
  .legendchip.ev-k { color:var(--muted); border-color:var(--muted); }
  .legendchip.ev-bb { color:#7bc47f; border-color:#7bc47f; }
  .legendchip.ev-err { color:#e8b84b; border-color:#e8b84b; }
  .legendchip.lamplegend.lb { color:#7bc47f; border-color:#7bc47f; }
  .legendchip.lamplegend.ls { color:var(--gold); border-color:var(--gold); }
  .legendchip.lamplegend.lo { color:#c96a5a; border-color:#c96a5a; }
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

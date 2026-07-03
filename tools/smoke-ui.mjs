// ============================================================================
// UIヘッドレス・スモークテスト
// dist/pennant.html の2スクリプト（engine + UI）を最小DOMスタブ上で実行し、
// 「シミュレート→全タブ描画→選手モーダル（スプレー/能力バー）」まで例外なく通るか検証する。
// ブラウザが無い環境で UI コードの参照エラー・DOM誤用を検出する門番。
// ============================================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'dist', 'pennant.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(scripts.length, 2, '2つの<script>（engine, UI）が必要');

// --- 最小DOMスタブ ---
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this._text = ''; this._onclick = null; }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class || ''; }
  setAttribute(k, v) { this.attrs[k] = v; }
  set innerHTML(v) { this.attrs._html = v; this.children = []; }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text; }
  set onclick(f) { this._onclick = f; }
  get onclick() { return this._onclick; }
  append(...ks) { for (const k of ks) this.children.push(k); }
  remove() { this._removed = true; }
}
const appDiv = new El('div');
appDiv.attrs.id = 'app';
function walk(node, out = []) {
  if (!(node instanceof El)) return out;
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}
function byId(id) {
  for (const n of walk(appDiv)) if (n.attrs.id === id) return n;
  return appDiv.attrs.id === id ? appDiv : new El('stub');
}
const timers = [];
const sandbox = {
  Math, JSON, Number, String, Boolean, Array, Object, isNaN, parseInt, parseFloat, Date: undefined,
  console: { log: () => {}, error: (...a) => console.error(...a) },
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  document: {
    createElement: (t) => new El(t),
    createElementNS: (_ns, t) => new El(t),
    getElementById: (id) => byId(id),
    body: {},
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// engine + UI を同一コンテキストで（classic script のスコープ共有を模倣）。末尾の initApp() は自前で呼ぶ。
vm.runInContext(scripts[0], sandbox, { filename: 'engine.js' });
vm.runInContext(scripts[1].replace(/\n?initApp\(\);\s*$/, ''), sandbox, { filename: 'ui.js' });

// 1) 初期化（セットアップ画面）
vm.runInContext('initApp();', sandbox);
const simBtn = walk(appDiv).find((n) => n.tag === 'button' && n._onclick);
assert.ok(simBtn, 'シミュレートボタンが描画される');

// 2) シミュレート実行（setTimeout をフラッシュ）
simBtn._onclick();
assert.ok(timers.length > 0, 'シーズン処理が予約される');
timers.forEach((fn) => fn());

// 3) 全タブを描画（WAR/順位表/打撃/投手/守備/チーム・B3c）— 例外が出ないこと
// modaltabs は class 'mtab' で 'tab' 始まりでない＝メインタブのみが拾われる。
const tabs = walk(appDiv).filter((n) => (n.className || '').startsWith('tab') && n._onclick);
assert.ok(tabs.length >= 6, `6タブ描画 (found ${tabs.length})`);
let modalsOpened = 0;
for (const tab of tabs) {
  tab._onclick();
  // データ行をクリックして選手モーダルを開く（各タブで例外が出ないこと）
  const row = walk(appDiv).find((n) => n.tag === 'tr' && (n.className || '').includes('clickable') && n._onclick);
  if (row) { row._onclick(); modalsOpened++; }
}
// WARタブ→カード→モーダル（WAR算出パスを通す）
const warTab = tabs.find((t) => (t.children || []).includes('WAR'));
assert.ok(warTab, 'WARタブが存在');
warTab._onclick();
const warCard = walk(appDiv).find((n) => (n.className || '').includes('warcard') && n._onclick);
assert.ok(warCard, 'WARランキングのカードが描画される');
warCard._onclick();
modalsOpened++;
assert.ok(modalsOpened >= 4, `選手モーダルが開ける (opened ${modalsOpened})`);

// --- S4検証: 2リーグ順位表＋交流戦成績＋ポストシーズンパネル -----------------
// El木からテキストを回収（el() は文字列を children に直接 push する）
const textOf = (n) => {
  let s = typeof n._text === 'string' ? n._text : '';
  for (const c of n.children) s += typeof c === 'string' ? c : textOf(c);
  return s;
};

// 5) 順位表タブ: リーグ見出し2つ＋6球団×2テーブル＋交流戦列
const standTab = tabs.find((t) => textOf(t) === '順位表');
assert.ok(standTab, '順位表タブが存在');
standTab._onclick();
let nodes = walk(appDiv);
const leagueHeads = nodes.filter((n) => (n.className || '').includes('leaguename')).map(textOf);
assert.ok(leagueHeads.filter((t) => t.includes('リーグ')).length >= 2, `2リーグの見出しが描画される (${leagueHeads.join('/')})`);
assert.ok(leagueHeads.some((t) => t.includes('DH有')) && leagueHeads.some((t) => t.includes('DH無')), 'DH規則の表記');
const standTables = nodes.filter((n) => n.tag === 'table');
assert.equal(standTables.length, 2, `順位表は2リーグ分割 (found ${standTables.length})`);
for (const tbl of standTables) {
  const dataRows = walk(tbl).filter((n) => n.tag === 'tr' && n.children.some((c) => c.tag === 'td'));
  assert.equal(dataRows.length, 6, `各リーグ6球団 (got ${dataRows.length})`);
}
const standThs = nodes.filter((n) => n.tag === 'th').map(textOf);
assert.ok(standThs.includes('交流戦'), '交流戦成績の列がある');

// 6) ポストシーズンパネル: CS両ステージ・日本シリーズ・日本一
const psPanel = nodes.find((n) => (n.className || '').includes('pspanel'));
assert.ok(psPanel, 'ポストシーズンパネルが描画される');
const psText = textOf(psPanel);
assert.ok(psText.includes('CSファースト'), 'CSファーストの結果が表示される');
assert.ok(psText.includes('CSファイナル'), 'CSファイナルの結果が表示される');
assert.ok(psText.includes('日本シリーズ'), '日本シリーズの結果が表示される');
assert.ok(psText.includes('日本一:'), '日本一チームが表示される');

// 7) 打撃表に SH/IBB/PH 列、投手表に役割（先発/救援）列
const battingTab = tabs.find((t) => textOf(t) === '打撃');
battingTab._onclick();
const batThs = walk(appDiv).filter((n) => n.tag === 'th').map(textOf);
for (const col of ['犠打', '敬遠', '代打']) {
  assert.ok(batThs.some((t) => t.startsWith(col)), `打撃表に${col}列 (${batThs.join(',')})`);
}
const pitchingTab = tabs.find((t) => textOf(t) === '投手');
pitchingTab._onclick();
nodes = walk(appDiv);
const pitThs = nodes.filter((n) => n.tag === 'th').map(textOf);
assert.ok(pitThs.some((t) => t.startsWith('役割')), '投手表に役割列');
const roleCells = nodes.filter((n) => n.tag === 'td').map(textOf);
assert.ok(roleCells.includes('先発') && roleCells.includes('救援'), '役割セルに先発/救援の両方が現れる');

// --- B3c検証: 新指標列（ツールチップ付き）・モーダルのタブ化・チーム集計タブ ----------
// 8) リーダーボードに新指標列＋列ツールチップ（初心者への定義説明・th の title）
battingTab._onclick();
const batThNodes = walk(appDiv).filter((n) => n.tag === 'th');
const batThTexts = batThNodes.map(textOf);
for (const col of ['xwOBA', 'Barrel%', 'HardHit%', 'WPA', 'Clutch']) {
  assert.ok(batThTexts.some((t) => t.startsWith(col)), `打撃表に新指標列 ${col} (${batThTexts.join(',')})`);
}
assert.ok(batThNodes.some((n) => n.attrs.title && n.attrs.title.length > 0), '列見出しに定義ツールチップ(title)がある');
pitchingTab._onclick();
const pitThTexts2 = walk(appDiv).filter((n) => n.tag === 'th').map(textOf);
for (const col of ['xFIP', 'SIERA', 'K-BB%', 'LOB%', 'QS', 'WPA']) {
  assert.ok(pitThTexts2.some((t) => t.startsWith(col)), `投手表に新指標列 ${col} (${pitThTexts2.join(',')})`);
}

// 9) 選手モーダルのタブ化（打者: 基本/打球/スプリット/文脈/守備成分）＋打球タブのSVG
battingTab._onclick();
const batRow = walk(appDiv).find((n) => n.tag === 'tr' && (n.className || '').includes('clickable') && n._onclick);
assert.ok(batRow, '打撃表にクリック可能な選手行がある');
batRow._onclick();
const overlay = walk(appDiv).find((n) => (n.className || '').includes('overlay'));
assert.ok(overlay, '選手モーダルのオーバーレイが開く');
const mtabsOf = () => walk(overlay).filter((n) => n.tag === 'button' && (n.className || '').includes('mtab'));
const batMtabs = mtabsOf().map(textOf);
for (const t of ['基本', '打球', 'スプリット', '文脈', '守備成分']) {
  assert.ok(batMtabs.includes(t), `打者モーダルに「${t}」タブ (${batMtabs.join('/')})`);
}
// 打球タブへ切替→スプレー＋EV/LA散布のSVGが描かれる
mtabsOf().find((n) => textOf(n) === '打球')._onclick();
const svgCount = walk(overlay).filter((n) => n.tag === 'svg' || n.tag === 'circle' || n.tag === 'path' || n.tag === 'rect' || n.tag === 'line').length;
assert.ok(svgCount > 0, `打球タブに打球チャートSVGが生成される (${svgCount})`);
// スプリット/文脈/守備成分タブへ切替（例外なく描画されること）
for (const t of ['スプリット', '文脈', '守備成分', '基本']) {
  const btn = mtabsOf().find((n) => textOf(n) === t);
  assert.ok(btn, `「${t}」タブが再取得できる`);
  btn._onclick();
}
// スプリットタブに状況別行（対左投/得点圏 等）
mtabsOf().find((n) => textOf(n) === 'スプリット')._onclick();
assert.ok(walk(overlay).some((n) => textOf(n).includes('得点圏')), 'スプリットタブに得点圏の行がある');
// 文脈タブにWPA/Clutch
mtabsOf().find((n) => textOf(n) === '文脈')._onclick();
assert.ok(walk(overlay).some((n) => textOf(n) === 'WPA'), '文脈タブにWPA項目がある');

// 10) 投手モーダルのタブ化（基本/投球/文脈）
pitchingTab._onclick();
const pitRow = walk(appDiv).find((n) => n.tag === 'tr' && (n.className || '').includes('clickable') && n._onclick);
pitRow._onclick();
const pOverlay = walk(appDiv).filter((n) => (n.className || '').includes('overlay')).pop();
const pMtabs = walk(pOverlay).filter((n) => n.tag === 'button' && (n.className || '').includes('mtab')).map(textOf);
for (const t of ['基本', '投球', '文脈']) {
  assert.ok(pMtabs.includes(t), `投手モーダルに「${t}」タブ (${pMtabs.join('/')})`);
}
walk(pOverlay).filter((n) => n.tag === 'button' && (n.className || '').includes('mtab')).find((n) => textOf(n) === '投球')._onclick();
assert.ok(walk(pOverlay).some((n) => textOf(n) === 'SIERA'), '投球タブにSIERA項目がある');

// 11) チーム集計タブ（打撃/投手/守備/走塁のリーグ内順位）
const teamsTab = tabs.find((t) => textOf(t) === 'チーム');
assert.ok(teamsTab, 'チームタブが存在');
teamsTab._onclick();
const teamNodes = walk(appDiv);
const teamHeads = teamNodes.filter((n) => (n.className || '').includes('leaguename')).map(textOf);
for (const cat of ['チーム打撃', 'チーム投手', 'チーム守備', 'チーム走塁']) {
  assert.ok(teamHeads.some((t) => t === cat), `チーム集計に「${cat}」がある (${teamHeads.join('/')})`);
}
const teamTables = teamNodes.filter((n) => n.tag === 'table');
assert.ok(teamTables.length >= 8, `チーム表がカテゴリ×リーグ分ある (found ${teamTables.length})`);
// 打撃カテゴリの各リーグブロックは6球団
const battingTeamRows = walk(teamTables[0]).filter((n) => n.tag === 'tr' && n.children.some((c) => c.tag === 'td'));
assert.equal(battingTeamRows.length, 6, `チーム打撃(片リーグ)は6球団 (got ${battingTeamRows.length})`);
const teamThs = teamNodes.filter((n) => n.tag === 'th').map(textOf);
assert.ok(teamThs.includes('得点') && teamThs.includes('防御') && teamThs.includes('ΣUZR'), 'チーム表に打撃/投手/守備の列');

console.log('UI smoke OK: setup→simulate→6タブ描画→モーダル%d回(タブ化)→打球SVG %d要素→2リーグ順位表+PS+SH/IBB/PH+役割列+新指標列(ツールチップ)+モーダルタブ(打球/スプリット/文脈/守備)+チーム集計、例外なし', modalsOpened, svgCount);

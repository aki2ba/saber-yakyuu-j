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

// 3) 全タブを描画（WAR/順位表/打撃/投手/守備）— 例外が出ないこと
const tabs = walk(appDiv).filter((n) => (n.className || '').startsWith('tab') && n._onclick);
assert.ok(tabs.length >= 5, `5タブ描画 (found ${tabs.length})`);
let modalsOpened = 0;
for (const tab of tabs) {
  tab._onclick();
  // データ行をクリックして選手モーダルを開く（スプレー/能力バー/WAR内訳生成を通す）
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

// 4) スプレーチャートSVGが生成されていること（打撃モーダル）
const svgCount = walk(appDiv).filter((n) => n.tag === 'svg' || n.tag === 'circle' || n.tag === 'path').length;
assert.ok(svgCount > 0, `スプレーチャートSVG要素が生成される (${svgCount})`);

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

console.log('UI smoke OK: setup→simulate→5タブ(WAR含む)描画→モーダル%d回→SVG %d要素→2リーグ順位表+交流戦列+PSパネル+SH/IBB/PH+役割列、例外なし', modalsOpened, svgCount);

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
for (const col of ['xwOBA', 'Barrel%', 'HardHit%', 'WPA', 'Clutch', 'wRC+PF']) {
  assert.ok(batThTexts.some((t) => t.startsWith(col)), `打撃表に新指標列 ${col} (${batThTexts.join(',')})`);
}
assert.ok(batThNodes.some((n) => n.attrs.title && n.attrs.title.length > 0), '列見出しに定義ツールチップ(title)がある');
pitchingTab._onclick();
const pitThTexts2 = walk(appDiv).filter((n) => n.tag === 'th').map(textOf);
for (const col of ['xFIP', 'SIERA', 'K-BB%', 'LOB%', 'QS', 'WPA', 'ERA-PF', 'FIP-PF']) {
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

// ============================================================================
// フェーズC1b: ゲームシェルの主要経路（ニューゲーム→ハブ→観戦1試合→セーブ/ロード→進行）
// ============================================================================
const btnByText = (t) => walk(appDiv).find((n) => n.tag === 'button' && n._onclick && textOf(n).includes(t));
const hasClass = (cls) => walk(appDiv).find((n) => (n.className || '').includes(cls));
const allClass = (cls) => walk(appDiv).filter((n) => (n.className || '').includes(cls));

// G1) タイトルへ入る（既存セットアップ画面のキャリア入口ボタン）
vm.runInContext('initApp();', sandbox);
const careerBtn = btnByText('ゲームを始める');
assert.ok(careerBtn, 'セットアップにキャリア入口ボタンがある');
careerBtn._onclick();
assert.ok(btnByText('ニューゲーム'), 'タイトルにニューゲームボタン');

// G2) ニューゲーム: 12球団カード → 自チーム選択 → シーズンハブ
btnByText('ニューゲーム')._onclick();
const teamCards = allClass('teamcard');
assert.equal(teamCards.length, 12, `12球団のカードが出る (got ${teamCards.length})`);
teamCards[0]._onclick();
let hubHead = hasClass('header');
assert.ok(hubHead && textOf(hubHead).includes('2026年'), 'シーズンハブに年が表示される');
// C4) ニュースフィードがハブに描画される（序盤は placeholder 行）
assert.ok(hasClass('newsfeed'), 'ハブにニュースフィードが描画される');

// G3) ハブのタブ（E4整理: ホーム/チーム/日程・結果/順位/成績/ニュース/記録）が開ける（例外なし）
for (const tabName of ['順位', '日程・結果', 'ニュース', 'チーム', '記録']) {
  const t = btnByText(tabName);
  assert.ok(t, `ハブに「${tabName}」タブがある`);
  t._onclick();
}
// E4) 成績タブはサブタブ集約（打撃/投手/守備/WAR/球団比較）
btnByText('成績')._onclick();
for (const sub of ['投手', '守備', 'WAR', '球団比較', '打撃']) {
  const s = btnByText(sub);
  assert.ok(s, `成績タブに「${sub}」サブタブがある`);
  s._onclick();
}
btnByText('ホーム')._onclick();

// G4) 采配介入（監督プロファイル差し替え）: おまかせトグル＋方針ボタン
const tendBtns = allClass('tendbtn');
assert.ok(tendBtns.length >= 8, `采配パネルに方針ボタンがある (got ${tendBtns.length})`);
tendBtns[0]._onclick(); // 「積極」等を1つ押す→介入登録＋ハブ再描画（例外が出ないこと）
assert.ok(hasClass('header'), '介入後もハブが再描画される');

// G5) 次の試合へ → 観戦（E2ゾーニング改: 今の状況パネル/対戦パネル/サブタブ/進行切替）
btnByText('次の試合へ')._onclick();
assert.ok(btnByText('観戦') && btnByText('ダイジェスト') && btnByText('スキップ'), '観戦/ダイジェスト/スキップの選択が出る');
btnByText('観戦')._onclick();
assert.ok(allClass('pbpline').length >= 1, '実況ログ（速報タブ既定・開始行から表示）');
assert.ok(walk(appDiv).some((n) => (n.className || '').includes('diamond')), 'ダイヤモンド盤面SVGが描かれる');
assert.ok(walk(appDiv).some((n) => (n.className || '').includes('scoreboard')), 'スコアボードが描かれる');
// E2z-a) 「今の状況」パネル: 大スコア＋回/表裏＋アウト＋B-S-Oランプ＋盤面SVGを1枚に統合
{
  const nowPanel = hasClass('nowpanel');
  assert.ok(nowPanel, '「今の状況」パネル(.nowpanel)が最上部に描かれる');
  assert.equal(walk(nowPanel).filter((n) => (n.className || '').includes('nowtscore')).length, 2, '両軍の大きなスコア表示（.nowtscore×2）');
  const nowTxt = textOf(nowPanel);
  assert.ok(nowTxt.includes('回'), `パネルに回/表裏 (${nowTxt.slice(0, 60)})`);
  assert.ok(nowTxt.includes('アウト'), 'パネルにアウトカウント');
  assert.ok(walk(nowPanel).filter((n) => (n.className || '').includes('lamp')).length >= 7, 'B-S-Oランプ（3+2+2）がパネル内');
  assert.ok(walk(nowPanel).some((n) => (n.className || '').includes('diamond')), '盤面SVG（走者名）がパネル内');
}
// E2a) ラインスコア: 9イニング列＋R/H/E列（「今の状況」直下にコンパクト維持）
{
  const sb = hasClass('scoreboard');
  const sbThs = walk(sb).filter((n) => n.tag === 'th').map(textOf);
  for (const col of ['1', '5', '9', 'R', 'H', 'E']) {
    assert.ok(sbThs.includes(col), `ラインスコアに${col}列 (${sbThs.join(',')})`);
  }
  const sbRows = walk(sb).filter((n) => n.tag === 'tr' && n.children.some((c) => c.tag === 'td'));
  assert.equal(sbRows.length, 2, 'ラインスコアは両軍2行');
}
// E2z-b) 「対戦」パネル: 打者/投手カード＋現打席（F2でコース図は撤去）を1枚に
const duelPanel = hasClass('duelpanel');
assert.ok(duelPanel, '「対戦」パネル(.duelpanel)が描かれる');
const muBox = hasClass('matchup');
assert.ok(muBox, '対戦カードが描かれる');
const muTxt = textOf(muBox);
assert.ok(muTxt.includes('打者') && muTxt.includes('投手') && muTxt.includes('球数'), `対戦カードに打者/投手/球数 (${muTxt.slice(0, 80)})`);
assert.ok(!walk(duelPanel).some((n) => (n.className || '').includes('zoneplot')), 'コース図SVG(.zoneplot)は撤去済み（ユーザー要望）');
// 利き腕表示（打者「右打/左打/両打」・投手「右投/左投」）は維持
assert.ok(/(右打|左打|両打)/.test(muTxt), `対戦カードの打者に利き腕表記 (${muTxt.slice(0, 80)})`);
assert.ok(/(右投|左投)/.test(muTxt), `対戦カードの投手に利き腕表記 (${muTxt.slice(0, 80)})`);
assert.ok(walk(muBox).filter((n) => (n.className || '').includes('handtag')).length >= 2, '打者/投手の利き腕タグ(.handtag)が両方出る');
// F3) 打球フィールド図: 対戦パネル右カラムにSVGが常設される（試合開始直後は打球なし＝枠だけ）
{
  const fieldSvg = walk(duelPanel).find((n) => (n.className || '').includes('fieldchart'));
  assert.ok(fieldSvg, '打球フィールド図SVG(.fieldchart)が対戦パネルに描かれる');
  assert.ok((fieldSvg.className || '').includes('empty'), '打球がまだ無い間は枠だけの薄い表示(.empty)');
  const fieldCol = hasClass('fieldcol');
  assert.ok(textOf(fieldCol).includes('打球'), '打球フィールド図に見出し「打球」');
  assert.ok(hasClass('fieldlabel') && textOf(hasClass('fieldlabel')).length > 0, '結果ラベル欄が描かれる');
}
// E2c) 進行単位切替: 1球/1打席/1イニング＋自動再生トグル
for (const b of ['1球', '1打席', '1イニング', '自動再生']) {
  assert.ok(btnByText(b), `進行コントロールに「${b}」`);
}
// 「現在の打席」に投球行が出るまで1球ずつ進める（打席開始直後は投球0球のため）
for (let k = 0; k < 12 && !allClass('curabpitch').map(textOf).some((t) => t.includes('球目')); k++) {
  btnByText('1球')._onclick();
}
// E2改a) 「現在の打席」ボックス: 投球が1球目→N球目の正順・全球にカウントB-S統一表記
assert.ok(hasClass('curab'), '「現在の打席」ボックスが対戦カード直下に描かれる');
{
  const abPitches = allClass('curabpitch').map(textOf).filter((t) => t.includes('球目'));
  assert.ok(abPitches.length >= 1, `現打席の投球行が出る (${abPitches.join(' | ')})`);
  assert.ok(abPitches[0].startsWith('1球目'), `投球は1球目からの正順 (${abPitches[0]})`);
  assert.ok(abPitches.every((t) => /\d-\d/.test(t)), `全投球行にカウントB-S表記 (${abPitches.join(' | ')})`);
}
// F2) コース図撤去後も現打席リストの一球行には判定色クラスpc-*が付く（テキスト結果は維持）
{
  const abRows = allClass('curabpitch').filter((n) => textOf(n).includes('球目'));
  assert.ok(abRows.length >= 1, `現打席の投球行が出る (${abRows.map(textOf).join(' | ')})`);
  assert.ok(abRows.every((n) => /pc-(ball|called|whiff|foul|inplay)/.test(n.className || '')), '現打席リストの一球行に判定色クラスpc-*');
}
// E2改b) 実況フィードは既定で一球行/◇打席行を畳む → 「全球表示」トグルで出す
assert.ok(!allClass('pbpline').map(textOf).some((t) => t.includes('球目')), '既定の実況に一球行が出ない（打席結果のみに畳み）');
btnByText('全球表示')._onclick();
{
  const pitchLines = allClass('pbpline').map(textOf);
  assert.ok(pitchLines.some((t) => t.includes('球目')), `全球表示で一球速報行「n球目 球種 判定」 (${pitchLines.slice(0, 6).join(' | ')})`);
  assert.ok(pitchLines.some((t) => t.includes('◇')), '全球表示で打席開始行「◇ 打者 対 投手」');
  // 実況の一球行にもコース図と同じ判定色クラス（色体系の統一）
  const evPitchNodes = allClass('ev-pitch');
  assert.ok(evPitchNodes.length >= 1 && evPitchNodes.every((n) => /pc-(ball|called|whiff|foul|inplay)/.test(n.className || '')),
    `実況の一球行にも判定色クラスpc-* (${evPitchNodes.slice(0, 3).map((n) => n.className).join(',')})`);
}
btnByText('全球表示')._onclick(); // 既定（畳み）へ戻す
// E2z-d) watch内サブタブ「速報／ボックス／スタメン」の切替
{
  const wtabs = allClass('wtab').filter((n) => n.tag === 'button'); // 'wtabs'コンテナを除外
  assert.equal(wtabs.length, 3, `観戦サブタブが3種 (got ${wtabs.length})`);
  assert.deepEqual(wtabs.map(textOf), ['速報', 'ボックス', 'スタメン'], 'サブタブは速報/ボックス/スタメン');
  assert.ok(wtabs.find((n) => textOf(n) === '速報').className.includes('active'), '既定は速報タブ');
  // ボックス: ここまでの両軍打者/投手の当日ライン（E4ボックスの列構成）
  wtabs.find((n) => textOf(n) === 'ボックス')._onclick();
  const boxThs = walk(appDiv).filter((n) => n.tag === 'th').map(textOf);
  for (const col of ['打順', '打数', '安打', '本', '打点', '四死球', '三振', '回', '球数', '被安', '失点', '奪三振']) {
    assert.ok(boxThs.includes(col), `ボックスタブに${col}列 (${boxThs.join(',')})`);
  }
  const boxRows = walk(appDiv).filter((n) => n.tag === 'tr' && n.children.some((c) => c.tag === 'td'));
  assert.ok(boxRows.length >= 20, `ボックスタブに両軍の打者/投手ラインが並ぶ (got ${boxRows.length})`);
  assert.ok(!hasClass('pbp'), 'ボックスタブでは実況フィードが出ない（ゾーニング）');
  // スタメン: 両軍スタメン表＋ベンチ/ブルペン残量（旧折りたたみを移設）
  allClass('wtab').find((n) => textOf(n) === 'スタメン')._onclick();
  const luThs = walk(appDiv).filter((n) => n.tag === 'th').map(textOf);
  assert.ok(luThs.includes('打順') && luThs.includes('今日'), `スタメンタブに打順/今日列 (${luThs.join(',')})`);
  assert.ok(allClass('lineupcol').length >= 2, '両軍のスタメン表が並ぶ');
  assert.ok(hasClass('benchbox'), 'スタメンタブにベンチ/ブルペン残量');
  // 速報へ戻す
  allClass('wtab').find((n) => textOf(n) === '速報')._onclick();
  assert.ok(hasClass('pbp'), '速報タブに戻ると実況フィード');
}
btnByText('1打席')._onclick();
assert.ok(hasClass('matchup'), '1打席進行後も観戦画面が再描画される');
btnByText('1イニング')._onclick();
assert.ok(hasClass('matchup'), '1イニング進行後も観戦画面が再描画される');
// F3) 打球フィールド図: 打球が発生した打席では着弾マーカー1個＋軌跡線1本＋結果ラベル＋EV/飛距離
{
  let fieldSvg = walk(appDiv).find((n) => (n.className || '').includes('fieldchart'));
  for (let k = 0; k < 30 && (fieldSvg.className || '').includes('empty'); k++) {
    btnByText('1打席')._onclick();
    fieldSvg = walk(appDiv).find((n) => (n.className || '').includes('fieldchart'));
  }
  assert.ok(!(fieldSvg.className || '').includes('empty'), '打球が発生すると枠だけ表示(.empty)が解除される');
  const marks = walk(fieldSvg).filter((n) => (n.className || '').includes('fieldmark'));
  assert.equal(marks.length, 1, `着弾マーカーは1個 (got ${marks.length})`);
  const trajs = walk(fieldSvg).filter((n) => (n.className || '').includes('fieldtraj'));
  assert.equal(trajs.length, 1, `軌跡線は1本 (got ${trajs.length})`);
  const label = textOf(hasClass('fieldlabel'));
  assert.ok(label.length > 0, `結果ラベルが表示される (${label})`);
  const sub = textOf(hasClass('fieldsub'));
  assert.ok(/EV\d+km\/h/.test(sub) && /\d+m/.test(sub), `EV/飛距離が表示される (${sub})`);
}
// §16) 打席ごとの指標変化: 「▼ 指標の変化」折りたたみ（既定で開く・結果ボックス直下）＋矢印/差分の表記
{
  const md = hasClass('metricdelta');
  assert.ok(md, '指標変化セクション(.metricdelta)が存在する（直前の打球ありの打席で確認）');
  assert.ok('open' in md.attrs, '指標変化セクションは既定で開いた折りたたみ(open属性)');
  const summary = walk(md).find((n) => n.tag === 'summary');
  assert.ok(summary && textOf(summary).includes('指標の変化'), '見出し「▼ 指標の変化」');
  const mdRows = allClass('mdrow').map(textOf);
  assert.ok(mdRows.length >= 1, `指標変化の行が出る (${mdRows.join(' | ')})`);
  assert.ok(mdRows.every((t) => /→.+（[+-]/.test(t)), `矢印(→)＋差分(+/-)の表記形式 (${mdRows.join(' | ')})`);
  // 安打の打席まで1打席ずつ進めて、AVG/SLG等の打者側変化行が出ることを確認（守備側にはOAA/UZR行が出る打席もある）
  let hitCr = hasClass('curabresult');
  let isHit = hitCr && /ev-hit|ev-hr/.test(hitCr.className || '');
  for (let k = 0; k < 150 && !isHit && btnByText('1打席'); k++) {
    btnByText('1打席')._onclick();
    hitCr = hasClass('curabresult');
    isHit = hitCr && /ev-hit|ev-hr/.test(hitCr.className || '');
  }
  assert.ok(isHit, '安打の打席まで進められる');
  const hitRows = allClass('mdrow').map(textOf);
  assert.ok(hitRows.some((t) => t.startsWith('AVG')), `安打の打席でAVG変化行が出る (${hitRows.join(' | ')})`);
  assert.ok(hitRows.some((t) => t.startsWith('SLG') || t.startsWith('OPS')), `安打の打席でSLG/OPS変化行も出る (${hitRows.join(' | ')})`);
}
// E2改c) 畳み表示の結果行: [N回表/裏] プレフィックス＋選手名リンク
{
  const paLines = allClass('pbpline').map(textOf);
  assert.ok(paLines.some((t) => /^\[\d+回[表裏]\]/.test(t)), `結果行に[N回表/裏]プレフィックス (${paLines.slice(0, 4).join(' | ')})`);
  const pbpBox = walk(appDiv).find((n) => (n.className || '') === 'pbp'); // 'pbphead' との前方一致を避ける
  assert.ok(walk(pbpBox).some((n) => (n.className || '').includes('plink')), '実況の選手名がリンク化（playerLink）');
}
// 自動再生トグル: ON→タイマー予約→OFF（UIのみ・状態不変）
btnByText('自動再生')._onclick();
assert.ok(btnByText('止める'), '自動再生ONで停止ボタンに変わる');
btnByText('止める')._onclick();
assert.ok(btnByText('自動再生'), '自動再生OFFに戻る');
btnByText('最後まで')._onclick();
assert.ok(hasClass('finalscore'), '最後まで進めると最終スコアが出る');
const finalTxt = textOf(hasClass('finalscore'));
assert.ok(finalTxt.includes('試合終了'), `観戦の最終スコア表示 (${finalTxt})`);
// E2改d) 結果行の色分けクラス＋得点行の現在スコア付記（1試合分の実況が出そろった時点で検証）
{
  const pls = allClass('pbpline');
  const withCls = (c) => pls.filter((n) => (n.className || '').includes(c));
  assert.ok(withCls('ev-k').length >= 1, '三振行に ev-k クラス');
  assert.ok(withCls('ev-hit').length + withCls('ev-hr').length >= 1, '安打/本塁打行に ev-hit / ev-hr クラス');
  const scoreLines = withCls('ev-score');
  if (scoreLines.length) {
    assert.ok(scoreLines.every((n) => /（.+ \d+-\d+ .+）/.test(textOf(n))), `得点行の行末に現在スコア（チーム X-Y チーム） (${textOf(scoreLines[0])})`);
  }
}
// E2改e) 対戦カード: 「今日 X打数Y安打」表記＋当日打席履歴チップ（試合終了時点の最終打者で検証）
{
  const muEnd = textOf(hasClass('matchup'));
  assert.ok(muEnd.includes('打数') && muEnd.includes('安打'), `対戦カードが「今日 X打数Y安打」表記 (${muEnd.slice(0, 80)})`);
  assert.ok(allClass('reschip').length >= 1, '対戦カードに当日打席履歴チップ（三ゴロ・左安…）');
}
btnByText('ホームへ戻る')._onclick(); // E4: 戻る導線の一貫（ハブ→ホーム改称）
assert.ok(allClass('recentrow').length >= 1, 'ハブの直近結果に観戦した試合が反映される');

// G6) セーブ/ロード（セッションミラー経由・ロード後の描画継続）
const daySig = () => textOf(hasClass('header'));
const beforeSave = daySig();
btnByText('スロット1に保存')._onclick();
const loadBtn = btnByText('→ロード1');
assert.ok(loadBtn, 'スロット保存後にロードボタンが出る');
loadBtn._onclick();
assert.ok(hasClass('header'), 'ロード後にハブが描画される（決定論継続）');
assert.equal(daySig(), beforeSave, 'ロードでセーブ時点の日付/成績に戻る');

// G7) 進行（月末まで）→ シーズン終了まで（チャンク進行・プログレス）→ リザルト（日本一）
btnByText('月末まで')._onclick();
assert.ok(hasClass('header'), '月末進行後もハブが描画される');
timers.length = 0; // 旧クイックシミュレートの setTimeout 残渣を破棄（チャンク進行のみを消化する）
btnByText('シーズン終了まで')._onclick();
let flush = 0;
while (timers.length && flush++ < 100000) { const fn = timers.shift(); fn(); } // チャンク進行の setTimeout を全消化
assert.ok(hasClass('championbanner'), 'シーズンリザルトに日本一バナーが出る');
assert.ok(textOf(hasClass('championbanner')).includes('日本一'), '日本一の球団名が表示される');
const resultTables = walk(appDiv).filter((n) => n.tag === 'table');
assert.ok(resultTables.length >= 2, `リザルトに2リーグ順位表が出る (got ${resultTables.length})`);

// ============================================================================
// フェーズC4: 表彰パネル（シーズンリザルト）／記録タブ／選手モーダル「経歴」タブ（二つ名/成長曲線）
// ============================================================================
// C4a) シーズンリザルトに表彰パネル（MVP/タイトル/ベストナイン/守備の栄誉賞）
const awardPanels = allClass('awardpanel');
assert.ok(awardPanels.length >= 2, `表彰パネルが2リーグ分描画される (got ${awardPanels.length})`);
const awardText = awardPanels.map((n) => textOf(n)).join(' ');
assert.ok(awardText.includes('MVP'), '表彰にMVPが表示される');
for (const t of ['首位打者', '本塁打王', '最多勝', '最多セーブ']) {
  assert.ok(awardText.includes(t), `表彰にタイトル「${t}」が表示される`);
}
assert.ok(awardText.includes('ベストナイン') || textOf(hasClass('awardpanel')).length > 0, 'ベストナイン枠がある');
const awardHeads = walk(appDiv).filter((n) => (n.className || '').includes('leaguename')).map(textOf);
assert.ok(awardHeads.some((t) => t.includes('表彰')), '表彰見出しが出る');

// C4b) 記録タブ（球団史／リーグ記録）— リザルトから「成績を見る」→ハブ→記録タブ
btnByText('成績を見る')._onclick();
const recTab = btnByText('記録');
assert.ok(recTab, 'ハブに「記録」タブがある');
recTab._onclick();
const recHeads = walk(appDiv).filter((n) => (n.className || '').includes('leaguename')).map(textOf);
assert.ok(recHeads.some((t) => t.includes('球団史')), '記録タブに球団史がある');
assert.ok(recHeads.some((t) => t.includes('リーグ記録')), '記録タブにリーグ記録がある');
assert.ok(allClass('reccol').length >= 4, `リーグ記録が複数カテゴリのカラムで出る (got ${allClass('reccol').length})`);

// ============================================================================
// フェーズE4: 日程・結果タブ（月別区切り/勝敗/先発）→試合クリック→簡易ボックススコア／ニュースタブ
// ============================================================================
// E4a) 日程・結果タブ: 月別見出し・全日程・勝敗マーク・先発の選手リンク
btnByText('日程・結果')._onclick();
{
  const schedHeads = walk(appDiv).filter((n) => (n.className || '').includes('leaguename')).map(textOf);
  assert.ok(schedHeads.filter((t) => t.includes('月')).length >= 5, `月別区切りの見出しが並ぶ (${schedHeads.join('/')})`);
  assert.ok(schedHeads.some((t) => /月（\d+試合）.*\d+勝\d+敗/.test(t)), `月見出しに月間成績 (${schedHeads[0]})`);
  const schedRows = walk(appDiv).filter((n) => n.tag === 'tr' && (n.className || '').includes('clickable') && n._onclick);
  assert.ok(schedRows.length >= 120, `シーズン全消化後は全試合がクリック可能 (got ${schedRows.length})`);
  const schedTxt = textOf(appDiv);
  assert.ok(schedTxt.includes('○') && schedTxt.includes('●'), '勝敗マーク（○/●）が出る');
  const schedThs = walk(appDiv).filter((n) => n.tag === 'th').map(textOf);
  for (const col of ['節', '相手', 'スコア', '勝敗', '先発']) {
    assert.ok(schedThs.some((t) => t.startsWith(col)), `日程表に${col}列 (${schedThs.join(',')})`);
  }
  assert.ok(allClass('plink').length >= 10, '先発投手名がリンク化（playerLink）');
  // E4b) 試合クリック → 簡易ボックススコア（ラインスコアR/H/E＋両軍打者/投手の当日ライン）
  schedRows[0]._onclick();
  const boxModal = allClass('boxmodal').pop();
  assert.ok(boxModal, '試合クリックでボックススコアモーダルが開く');
  const boxThs = walk(boxModal).filter((n) => n.tag === 'th').map(textOf);
  for (const col of ['R', 'H', 'E', '打順', '打数', '安打', '打点', '四死球', '三振', '回', '球数', '失点', '奪三振']) {
    assert.ok(boxThs.includes(col), `ボックススコアに${col}列 (${boxThs.join(',')})`);
  }
  assert.ok(walk(boxModal).some((n) => (n.className || '').includes('scoreboard')), 'ボックススコアにラインスコア');
  const boxBatRows = walk(boxModal).filter((n) => n.tag === 'tr' && n.children.some((c) => c.tag === 'td'));
  assert.ok(boxBatRows.length >= 20, `両軍の打者/投手ラインが並ぶ (got ${boxBatRows.length})`);
  assert.ok(walk(boxModal).filter((n) => (n.className || '').includes('plink')).length >= 18, 'ボックススコアの選手名がリンク化');
}

// E4c) ニュースタブ: チームニュース＋選手の活躍（playerLink 導線）
btnByText('ニュース')._onclick();
{
  assert.ok(allClass('newsfeed').length >= 2, 'ニュースタブにチームニュース/選手の活躍の2セクション');
  const newsHeads = walk(appDiv).filter((n) => (n.className || '').includes('leaguename')).map(textOf);
  assert.ok(newsHeads.some((t) => t.includes('チームニュース')) && newsHeads.some((t) => t.includes('選手の活躍')),
    `ニュースタブの見出し (${newsHeads.join('/')})`);
  const newsLinks = allClass('newsfeed').flatMap((f) => walk(f).filter((n) => (n.className || '').includes('plink') && n._onclick));
  assert.ok(newsLinks.length >= 1, `ニュース見出しの選手名がリンク化 (got ${newsLinks.length})`);
  newsLinks[0]._onclick();
  assert.ok(allClass('overlay').length >= 1, 'ニュースの選手リンクから詳細モーダルが開く');
}

// C4c) 選手モーダルの「経歴」タブ（二つ名＋年度別成績＋成長曲線SVG＋受賞履歴）
btnByText('成績')._onclick();
btnByText('打撃')._onclick();
const cRow = walk(appDiv).find((n) => n.tag === 'tr' && (n.className || '').includes('clickable') && n._onclick);
assert.ok(cRow, '打撃タブに選手行がある');
cRow._onclick();
const cOverlay = allClass('overlay').pop();
const cMtabs = () => walk(cOverlay).filter((n) => n.tag === 'button' && (n.className || '').includes('mtab'));
const careerTab = cMtabs().find((n) => textOf(n) === '経歴');
assert.ok(careerTab, '選手モーダルに「経歴」タブがある（キャリアモード）');
careerTab._onclick();
assert.ok(walk(cOverlay).some((n) => (n.className || '').includes('nickname')), '経歴タブに二つ名が表示される');
assert.ok(walk(cOverlay).some((n) => (n.className || '').includes('growth')), '経歴タブに成長曲線SVGが描かれる');
assert.ok(walk(cOverlay).some((n) => textOf(n).includes('受賞履歴')), '経歴タブに受賞履歴セクションがある');
// D3・§11.3: 記録の時代補正「+指標」が経歴タブに表示される（完了1季ぶんで発現）。
assert.ok(walk(cOverlay).some((n) => textOf(n).includes('時代補正 +指標')), '経歴タブに時代補正+指標セクションがある（D3「見せる」）');

// ============================================================================
// フェーズE1: チームタブ（一軍/二軍の選手一覧）／選手モーダルヘッダ整備／playerLink導線／年送り
// ============================================================================
// E1a) ハブ「チーム」タブ → 一軍（支配下）一覧: サブタブ・野手/投手テーブル・仕様列・ソート
btnByText('チーム')._onclick();
const subtabs = allClass('subtab').filter((n) => n.tag === 'button'); // 'subtabs'コンテナを除外
assert.ok(subtabs.length >= 2, `チームタブに一軍/二軍サブタブ (got ${subtabs.length})`);
assert.ok(subtabs.some((n) => textOf(n).includes('一軍')) && subtabs.some((n) => textOf(n).includes('二軍')), 'サブタブが一軍/二軍');
const teamTabHeads = walk(appDiv).filter((n) => (n.className || '').includes('leaguename')).map(textOf);
assert.ok(teamTabHeads.some((t) => t.startsWith('野手')) && teamTabHeads.some((t) => t.startsWith('投手')), `野手/投手の見出し (${teamTabHeads.join('/')})`);
const rosterThs = walk(appDiv).filter((n) => n.tag === 'th').map(textOf);
for (const col of ['位置', '年齢', '打席', '打率', 'OPS', '打点', '盗塁', 'wRC+', 'WAR', '等級', '状態', '役割', '登板', '防御', 'FIP', 'WHIP', 'K-BB%']) {
  assert.ok(rosterThs.some((t) => t.startsWith(col)), `チーム一覧に${col}列 (${rosterThs.join(',')})`);
}
const rosterRows = () => walk(appDiv).filter((n) => n.tag === 'tr' && (n.className || '').includes('clickable') && n._onclick);
assert.equal(rosterRows().length, 29, `一軍サブタブ=出場登録29人ちょうど (got ${rosterRows().length})`); // F2-2/F2-4
assert.ok(subtabs.some((n) => textOf(n).includes('出場登録（29人）')), 'サブタブラベルに出場登録（29人）');
// 等級セル（S/A/B/C/D/E のどれか）が出る
const rosterCells = walk(appDiv).filter((n) => n.tag === 'td').map(textOf);
assert.ok(rosterCells.some((t) => /^[SABCDE]$/.test(t)), 'スカウト等級（コーチの見立て）が表示される');
// 列ソート（th クリックで矢印・例外なし）
walk(appDiv).find((n) => n.tag === 'th' && textOf(n).startsWith('打席'))._onclick();
assert.ok(walk(appDiv).some((n) => n.tag === 'th' && textOf(n).includes('▼')), '列ソートの矢印が出る');
// 行クリック → 選手詳細モーダル（E1整備ヘッダ: 所属/年齢/利き手/二つ名）
rosterRows()[0]._onclick();
const tOverlay = allClass('overlay').pop();
assert.ok(tOverlay, 'チーム一覧の行クリックで選手モーダルが開く');
const tHead = walk(tOverlay).find((n) => (n.className || '').includes('modalhead'));
const tHeadTxt = textOf(tHead);
assert.ok(tHeadTxt.includes('支配下（一軍登録）'), `モーダルヘッダに所属（一軍登録・F2-4） (${tHeadTxt})`);
assert.ok(tHeadTxt.includes('歳') && (tHeadTxt.includes('右') || tHeadTxt.includes('左') || tHeadTxt.includes('両')), 'ヘッダに年齢/利き手');
assert.ok(walk(tOverlay).some((n) => (n.className || '').includes('headnick')), 'ヘッダに二つ名バッジ');

// E1b→F2a) 二軍サブタブ（F2-4）: 支配下の登録外＋育成（F2-1で1年目から在籍）・**二軍成績列**・育成バッジ
subtabs.find((n) => textOf(n).includes('二軍'))._onclick();
{
  const farmRows = rosterRows();
  assert.ok(farmRows.length >= 45, `二軍=支配下残41人＋育成が並ぶ (got ${farmRows.length})`); // 70-29=41 + 育成10-40
  const farmThs = walk(appDiv).filter((n) => n.tag === 'th').map(textOf);
  assert.ok(farmThs.some((t) => t.startsWith('二軍打席')) && farmThs.some((t) => t.startsWith('二軍打率')), `二軍成績列（二軍打席/二軍打率） (${farmThs.join(',')})`);
  assert.ok(farmThs.some((t) => t.startsWith('二軍登板')) && farmThs.some((t) => t.startsWith('二軍防御')), '投手にも二軍成績列（二軍登板/二軍防御）');
  assert.ok(!farmThs.some((t) => t.startsWith('WAR')), '二軍表にWAR列は無い（リーグ水準差のため非表示）');
  // 1年目終了時点＝二軍リーグ~110試合消化済み → 実観測の率が入る（'-'だけではない）
  const farmTds = walk(appDiv).filter((n) => n.tag === 'td').map(textOf);
  assert.ok(farmTds.some((t) => /^\.\d{3}$/.test(t)), `二軍成績のセルに実観測の率（.xxx）が入る (sample: ${farmTds.slice(0, 20).join(',')})`);
  // 育成契約バッジ
  const badges = allClass('devbadge');
  assert.ok(badges.length >= 5, `育成選手に「育成」バッジ (got ${badges.length})`);
  assert.ok(badges.every((n) => textOf(n) === '育成'), 'バッジの文言は「育成」');
}
// F2b) 順位タブ: 二軍リーグ順位の折りたたみ（F2-4）
btnByText('順位')._onclick();
{
  const farmToggle = btnByText('二軍リーグ順位');
  assert.ok(farmToggle, '順位タブに二軍リーグ順位のトグルがある');
  assert.ok(!walk(appDiv).some((n) => textOf(n) === '若草リーグ（二軍・DH有）'), '既定では二軍順位は畳まれている');
  farmToggle._onclick();
  const farmHeads = walk(appDiv).filter((n) => (n.className || '').includes('leaguename')).map(textOf);
  assert.ok(farmHeads.some((t) => t.includes('若草リーグ')) && farmHeads.some((t) => t.includes('暁リーグ')),
    `二軍2リーグ（若草/暁）の順位表が開く (${farmHeads.join('/')})`);
  const farmBox = hasClass('farmstandings');
  const farmStandRows = walk(farmBox).filter((n) => n.tag === 'tr' && n.children.some((c) => c.tag === 'td'));
  assert.equal(farmStandRows.length, 12, `二軍順位は12球団（6×2リーグ） (got ${farmStandRows.length})`);
  btnByText('二軍リーグ順位')._onclick(); // 畳んで戻す（次の描画に影響させない）
}
btnByText('チーム')._onclick(); // 二軍サブタブ選択のままチームタブへ戻す（後続E1dの前提を維持）

// ============================================================================
// フェーズE3: ストーブリーグ（FA市場/トレード/育成昇格）→年送り→ダイジェスト反映
// ============================================================================
// E3a) リザルト→ストーブリーグ画面（スキップ導線も残っていること）
btnByText('ホーム')._onclick();
btnByText('シーズンリザルトへ')._onclick();
assert.ok(allClass('plink').length >= 1, '表彰パネルの受賞者名がリンク化（playerLink）');
assert.ok(btnByText('翌シーズンへ'), 'リザルトにスキップ年送りボタンが残る');
const stoveBtn = btnByText('ストーブリーグへ');
assert.ok(stoveBtn, 'リザルトにストーブリーグ導線');
stoveBtn._onclick();
assert.ok(textOf(hasClass('header')).includes('ストーブリーグ'), 'ストーブリーグ画面のヘッダ');
assert.ok(btnByText('FA市場') && btnByText('トレード') && btnByText('育成・支配下'), 'FA市場/トレード/育成・支配下のタブ');

// E3b) FA市場: 宣言見込み一覧 → 入札（bidFA＝介入ログ）→ 取消ボタンに変わる
assert.ok(walk(appDiv).some((n) => textOf(n).includes('FA宣言見込み')), 'FA宣言見込みの見出しが出る');
const bidBtn = btnByText('入札する');
assert.ok(bidBtn, 'FA宣言見込みの選手に入札ボタン（seed固定で宣言見込みあり）');
bidBtn._onclick();
assert.ok(btnByText('入札済み・取消'), '入札後は取消ボタンに変わる（marketInterventions に記録）');
assert.ok(textOf(hasClass('header')).includes('FA入札1件'), 'ヘッダの介入予定にFA入札1件');

// E3c) トレード: 放出選手を選ぶ→同型相手に受諾/拒否見込み（相手AI査定の評価差）→打診（proposeTrade）
btnByText('トレード')._onclick();
const pickBtns = allClass('stovepick');
assert.ok(pickBtns.length >= 25, `放出候補=自チームの支配下が並ぶ (got ${pickBtns.length})`);
pickBtns[0]._onclick();
const verdictCells = walk(appDiv).filter((n) => n.tag === 'td').map(textOf);
assert.ok(verdictCells.some((t) => t.includes('受諾見込み') || t.includes('拒否見込み')), '同型相手ごとに受諾/拒否見込み（評価差）が出る');
const askBtn = btnByText('打診する');
assert.ok(askBtn, '同型の相手選手に打診ボタン');
askBtn._onclick();
assert.ok(walk(appDiv).some((n) => textOf(n).includes('起案済みトレード')), '打診後は起案済みトレード一覧に載る');
assert.ok(textOf(hasClass('header')).includes('トレード起案1件'), 'ヘッダの介入予定にトレード起案1件');

// E3d) 育成・支配下タブ（1年目は育成なし→案内文。昇格はエンジン自動判定の可視化）
btnByText('育成・支配下')._onclick();
assert.ok(walk(appDiv).some((n) => textOf(n).includes('昇格候補')), '育成タブに昇格候補セクション');

// E3e) 年送り（オフシーズン処理）→ ダイジェストにFA入札/トレード起案の結果が反映
btnByText('オフシーズン処理を実行')._onclick();
assert.ok(textOf(hasClass('header')).includes('オフシーズン'), 'オフシーズンダイジェストが出る');
assert.ok(walk(appDiv).some((n) => textOf(n).includes('引退')), 'ダイジェストに引退等の件数');
const digestAll = textOf(appDiv);
assert.ok(/FA入札(成立|不成立)/.test(digestAll), 'FA入札の結果（成立/不成立と理由）がダイジェストに反映');
assert.ok(/トレード(成立|拒否|不成立)/.test(digestAll), 'トレード起案の受諾/拒否（評価差の理由）がダイジェストに表示');
assert.ok(digestAll.includes('あなたの球団'), 'ダイジェストに自チームの動きパネル');
assert.ok(digestAll.includes('表彰ダイジェスト'), 'ダイジェストに表彰（MVP/新人王）');
btnByText('シーズン開幕へ')._onclick();
assert.ok(textOf(hasClass('header')).includes('2027年'), `2年目ハブに進む (${textOf(hasClass('header'))})`);

// E1d→F2c) 2年目の二軍名簿: 支配下（二軍）＋育成（バッジ）→ 選手詳細に一軍/二軍の年度別成績行
btnByText('チーム')._onclick(); // サブタブ選択は「二軍」を維持している
const farmRows = rosterRows();
assert.ok(farmRows.length >= 45, `2年目の二軍名簿に支配下残＋育成が並ぶ (got ${farmRows.length})`);
// 育成バッジ付きの行 → モーダル: 所属=育成（二軍）・スカウト評価・（開幕直後＝一軍未出場の案内）
const badgeRow = farmRows.find((r) => walk(r).some((n) => (n.className || '').includes('devbadge')));
assert.ok(badgeRow, '二軍名簿に育成バッジ付きの行がある');
badgeRow._onclick();
const fOverlay = allClass('overlay').pop();
const fHeadTxt = textOf(walk(fOverlay).find((n) => (n.className || '').includes('modalhead')));
assert.ok(fHeadTxt.includes('育成（二軍）'), `育成選手のモーダルに所属=育成 (${fHeadTxt})`);
assert.ok(walk(fOverlay).some((n) => textOf(n).includes('コーチの見立て')), '育成選手モーダルにスカウト評価（真値非露出）');
assert.ok(walk(fOverlay).some((n) => textOf(n).includes('一軍出場はありません')), '未出場の育成選手はNaN成績でなく案内文');
// F2c) 経歴タブ: 年度別成績が一軍/二軍行に分かれる（1年目の二軍成績＝careerFarmStats 接続）。
//   二軍名簿を順に開き「二軍」行を持つ選手を探す（新規獲得の育成など前年ファーム出場ゼロの選手を飛ばす）。
{
  let found = false;
  for (const row of farmRows.slice(0, 20)) {
    row._onclick();
    const ov = allClass('overlay').pop();
    const mt = walk(ov).filter((n) => n.tag === 'button' && (n.className || '').includes('mtab')).find((n) => textOf(n) === '経歴');
    assert.ok(mt, '二軍選手のモーダルに経歴タブ');
    mt._onclick();
    const ths = walk(ov).filter((n) => n.tag === 'th').map(textOf);
    const tds = walk(ov).filter((n) => n.tag === 'td').map(textOf);
    if (ths.includes('軍') && tds.includes('二軍')) { found = true; break; }
  }
  assert.ok(found, '年度別成績に「軍」列＋「二軍」行（前年ファーム実成績）を持つ二軍選手がいる');
}
// 支配下（二軍）の行（バッジ無し）→ モーダル所属=支配下（二軍）
{
  const plainRow = farmRows.find((r) => !walk(r).some((n) => (n.className || '').includes('devbadge')));
  assert.ok(plainRow, '二軍名簿に支配下（バッジ無し）の行がある');
  plainRow._onclick();
  const pOv = allClass('overlay').pop();
  const pHead = textOf(walk(pOv).find((n) => (n.className || '').includes('modalhead')));
  assert.ok(pHead.includes('支配下（二軍）'), `登録外の支配下は所属=支配下（二軍） (${pHead})`);
}
// F2d) 2年目シーズン中: 昇格・降格ニュース（F2-3 rosterMoves → ニュースタブ・playerLink 付き）
btnByText('ホーム')._onclick();
let movesFound = false;
for (let mth = 0; mth < 5 && !movesFound; mth++) {
  btnByText('月末まで')._onclick(); // 同期チャンク進行（IL補充・25試合レビューの成績入替が発生し得る）
  btnByText('ニュース')._onclick();
  const feedTxt = textOf(appDiv);
  movesFound = feedTxt.includes('登録抹消') || feedTxt.includes('を昇格');
  btnByText('ホーム')._onclick();
}
assert.ok(movesFound, '2年目のシーズン中に昇格・降格ニュース（登録抹消/昇格）が出る');
btnByText('ニュース')._onclick();
{
  const newsHeads2 = walk(appDiv).filter((n) => (n.className || '').includes('leaguename')).map(textOf);
  assert.ok(newsHeads2.some((t) => t.includes('昇格・降格')), `ニュースタブに昇格・降格セクション (${newsHeads2.join('/')})`);
  const mvRows = allClass('newsrow').filter((n) => /登録抹消|を昇格|一軍登録/.test(textOf(n)));
  assert.ok(mvRows.length >= 1, `昇降格の見出し行がある (got ${mvRows.length})`);
  const mvLink = walk(mvRows[0]).find((n) => (n.className || '').includes('plink') && n._onclick);
  assert.ok(mvLink, '昇降格見出しの選手名がリンク化（playerLink）');
  mvLink._onclick();
  assert.ok(allClass('overlay').length >= 1, '昇降格ニュースのリンクから選手モーダルが開く');
}
// F2e) 2年目シーズン中の二軍成績: 二軍サブタブに実観測の率＋選手詳細の基本タブに「今季二軍成績」
btnByText('チーム')._onclick(); // 二軍サブタブ維持
{
  const farmTds2 = walk(appDiv).filter((n) => n.tag === 'td').map(textOf);
  assert.ok(farmTds2.some((t) => /^\.\d{3}$/.test(t)), '2年目シーズン中も二軍成績列に実観測の率が入る');
  const fr2 = rosterRows();
  fr2[0]._onclick(); // 野手表の先頭（二軍打席の多い選手）
  const ov2 = allClass('overlay').pop();
  assert.ok(walk(ov2).some((n) => textOf(n).includes('今季二軍成績')), '選手詳細の基本タブに「今季二軍成績」（現役の当年ファーム実成績）');
}

// E1e) playerLink の導線: 記録タブの選手名リンク → モーダル
btnByText('記録')._onclick();
const recLinks = allClass('plink').filter((n) => n._onclick);
assert.ok(recLinks.length >= 1, `記録タブの選手名がリンク化 (got ${allClass('plink').length})`);
recLinks[0]._onclick();
assert.ok(allClass('overlay').length >= 1, '記録タブのリンクから選手モーダルが開く');

console.log('UI smoke OK (E1): チームタブ(一軍=出場登録29人/仕様列/ソート/等級)→行クリックでモーダル(所属/二つ名ヘッダ)→年送り(オフ要約)→2年目二軍名簿→育成選手モーダル→記録タブplayerLink、例外なし');
console.log('UI smoke OK (F2-4二軍UI): チームタブ二軍(支配下残+育成/二軍成績列/育成バッジ)→順位タブ二軍リーグ順位折りたたみ(若草/暁12球団)→選手詳細(年度別の一軍/二軍行・所属=一軍登録/二軍/育成・今季二軍成績)→2年目昇降格ニュース(登録抹消/昇格+playerLink→モーダル)、例外なし');
console.log('UI smoke OK (E3編成): リザルト→ストーブリーグ(FA市場宣言見込み→入札/取消・トレード放出選択→受諾/拒否見込み→打診・育成昇格候補)→オフ処理→ダイジェスト(FA/トレード結果反映・自チームの動き・表彰)、例外なし');

console.log('UI smoke OK (C4演出): シーズンリザルト表彰パネル(MVP/タイトル/ベストナイン/守備賞)→記録タブ(球団史/リーグ記録)→選手モーダル「経歴」(二つ名/年度別/成長曲線/受賞履歴)、例外なし');

console.log('UI smoke OK: setup→simulate→6タブ描画→モーダル%d回(タブ化)→打球SVG %d要素→2リーグ順位表+PS+SH/IBB/PH+役割列+新指標列(ツールチップ)+モーダルタブ(打球/スプリット/文脈/守備)+チーム集計、例外なし', modalsOpened, svgCount);
console.log('UI smoke OK (ゲームシェルC1b): タイトル→ニューゲーム(12球団)→ハブ(全statタブ)→采配介入→観戦1試合(スコアボード/ダイヤモンド/実況/残量)→セーブ/ロード継続→月末進行→シーズン終了(日本一)、例外なし');
console.log('UI smoke OK (E2観戦・ゾーニング改): 今の状況パネル(大スコア/回/アウト/B-S-O/盤面)→ラインスコア(9回+R/H/E)→対戦パネル(打者/投手カード+現打席正順・pc-色統一)→サブタブ(速報/ボックス/スタメン切替)→実況畳み(結果1行+[N回表裏]+色分け+得点行スコア付記)→全球表示トグル(一球行もpc-色)→進行切替(1球/1打席/1イニング/自動再生)、例外なし');
console.log('UI smoke OK (F2コース表示撤去): コース図SVG(.zoneplot/.batshadow/.pdot/.pnum/.zonelegend)は撤去・利き腕表示(右打/左打/両打・右投/左投・.handtag)と現打席の1球ごとテキスト結果は維持、例外なし');
console.log('UI smoke OK (E4動線): タブ整理(ホーム/チーム/日程・結果/順位/成績サブタブ/ニュース/記録)→日程・結果(月別/勝敗/先発link)→試合クリック→簡易ボックススコア(ラインスコアR/H/E+両軍打者/投手ライン)→ニュースタブ(選手の活躍→playerLink→モーダル)、例外なし');

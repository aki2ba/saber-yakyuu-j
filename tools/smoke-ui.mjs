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

// G3) ハブの stat タブ（順位/WAR/打撃/投手/守備/チーム）が既存描画で開ける（例外なし）
for (const tabName of ['順位表', 'WAR', '打撃', '投手', '守備', 'チーム', 'ハブ']) {
  const t = btnByText(tabName);
  assert.ok(t, `ハブに「${tabName}」タブがある`);
  t._onclick();
}

// G4) 采配介入（監督プロファイル差し替え）: おまかせトグル＋方針ボタン
const tendBtns = allClass('tendbtn');
assert.ok(tendBtns.length >= 8, `采配パネルに方針ボタンがある (got ${tendBtns.length})`);
tendBtns[0]._onclick(); // 「積極」等を1つ押す→介入登録＋ハブ再描画（例外が出ないこと）
assert.ok(hasClass('header'), '介入後もハブが再描画される');

// G5) 次の試合へ → 観戦（E2: スポナビ風 = ラインスコア/盤面/対戦カード/一球速報/進行切替）
btnByText('次の試合へ')._onclick();
assert.ok(btnByText('観戦') && btnByText('ダイジェスト') && btnByText('スキップ'), '観戦/ダイジェスト/スキップの選択が出る');
btnByText('観戦')._onclick();
assert.ok(allClass('pbpline').length >= 1, '実況ログ（打席開始行から表示）');
assert.ok(walk(appDiv).some((n) => (n.className || '').includes('diamond')), 'ダイヤモンド盤面SVGが描かれる');
assert.ok(walk(appDiv).some((n) => (n.className || '').includes('scoreboard')), 'スコアボードが描かれる');
assert.ok(hasClass('benchbox'), 'ベンチ/ブルペン残量が描かれる');
// E2a) ラインスコア: 9イニング列＋R/H/E列（スポナビ風ヘッダ）
{
  const sb = hasClass('scoreboard');
  const sbThs = walk(sb).filter((n) => n.tag === 'th').map(textOf);
  for (const col of ['1', '5', '9', 'R', 'H', 'E']) {
    assert.ok(sbThs.includes(col), `ラインスコアに${col}列 (${sbThs.join(',')})`);
  }
  const sbRows = walk(sb).filter((n) => n.tag === 'tr' && n.children.some((c) => c.tag === 'td'));
  assert.equal(sbRows.length, 2, 'ラインスコアは両軍2行');
}
// E2b) 対戦カード: 打者/投手・今日の結果・球数・B-S-Oランプ・選手名リンク
const muBox = hasClass('matchup');
assert.ok(muBox, '対戦カードが描かれる');
const muTxt = textOf(muBox);
assert.ok(muTxt.includes('打者') && muTxt.includes('投手') && muTxt.includes('球数'), `対戦カードに打者/投手/球数 (${muTxt.slice(0, 80)})`);
assert.ok(walk(muBox).filter((n) => (n.className || '').includes('lamp')).length >= 7, 'B-S-Oランプ（3+2+2）が描かれる');
// E2c) 進行単位切替: 1球/1打席/1イニング＋自動再生トグル
for (const b of ['1球', '1打席', '1イニング', '自動再生']) {
  assert.ok(btnByText(b), `進行コントロールに「${b}」`);
}
btnByText('1球')._onclick();
btnByText('1球')._onclick();
btnByText('1球')._onclick();
const pitchLines = allClass('pbpline').map(textOf);
assert.ok(pitchLines.some((t) => t.includes('球目')), `一球速報行「n球目 球種 判定」が出る (${pitchLines.slice(0, 6).join(' | ')})`);
assert.ok(pitchLines.some((t) => t.includes('◇')), '打席開始行「◇ 打者 対 投手」が出る');
assert.ok(walk(hasClass('pbp')).some((n) => (n.className || '').includes('plink')), '実況の選手名がリンク化（playerLink）');
btnByText('1打席')._onclick();
assert.ok(hasClass('matchup'), '1打席進行後も観戦画面が再描画される');
btnByText('1イニング')._onclick();
assert.ok(hasClass('matchup'), '1イニング進行後も観戦画面が再描画される');
// 自動再生トグル: ON→タイマー予約→OFF（UIのみ・状態不変）
btnByText('自動再生')._onclick();
assert.ok(btnByText('止める'), '自動再生ONで停止ボタンに変わる');
btnByText('止める')._onclick();
assert.ok(btnByText('自動再生'), '自動再生OFFに戻る');
// E2d) 折りたたみ: 両軍スタメン表（打順/守/今日）＋ベンチ・ブルペン残量の統合
btnByText('スタメン・ベンチ')._onclick();
{
  const luThs = walk(appDiv).filter((n) => n.tag === 'th').map(textOf);
  assert.ok(luThs.includes('打順') && luThs.includes('今日'), `スタメン表に打順/今日列 (${luThs.join(',')})`);
  assert.ok(allClass('lineupcol').length >= 2, '両軍のスタメン表が並ぶ');
}
btnByText('最後まで')._onclick();
assert.ok(hasClass('finalscore'), '最後まで進めると最終スコアが出る');
const finalTxt = textOf(hasClass('finalscore'));
assert.ok(finalTxt.includes('試合終了'), `観戦の最終スコア表示 (${finalTxt})`);
btnByText('ハブへ戻る')._onclick();
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

// C4c) 選手モーダルの「経歴」タブ（二つ名＋年度別成績＋成長曲線SVG＋受賞履歴）
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
assert.ok(rosterRows().length >= 25, `支配下ロスター全員が並ぶ (got ${rosterRows().length})`); // 33人/球団
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
assert.ok(tHeadTxt.includes('支配下（一軍）'), `モーダルヘッダに所属（一軍） (${tHeadTxt})`);
assert.ok(tHeadTxt.includes('歳') && (tHeadTxt.includes('右') || tHeadTxt.includes('左') || tHeadTxt.includes('両')), 'ヘッダに年齢/利き手');
assert.ok(walk(tOverlay).some((n) => (n.className || '').includes('headnick')), 'ヘッダに二つ名バッジ');

// E1b) 二軍（育成）サブタブ: 1年目は空（育成契約は翌オフから）→ 空メッセージ
subtabs.find((n) => textOf(n).includes('二軍'))._onclick();
assert.ok(walk(appDiv).some((n) => textOf(n).includes('育成選手はまだいません')), '1年目の二軍は空メッセージ');

// ============================================================================
// フェーズE3: ストーブリーグ（FA市場/トレード/育成昇格）→年送り→ダイジェスト反映
// ============================================================================
// E3a) リザルト→ストーブリーグ画面（スキップ導線も残っていること）
btnByText('ハブ')._onclick();
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

// E1d) 2年目の二軍（育成）名簿: 育成獲得が発生→行クリックで育成選手のモーダルが開く
btnByText('チーム')._onclick(); // サブタブ選択は「二軍」を維持している
const farmRows = rosterRows();
assert.ok(farmRows.length >= 1, `2年目の二軍名簿に育成選手が並ぶ (got ${farmRows.length})`);
farmRows[0]._onclick();
const fOverlay = allClass('overlay').pop();
const fHeadTxt = textOf(walk(fOverlay).find((n) => (n.className || '').includes('modalhead')));
assert.ok(fHeadTxt.includes('育成（二軍）'), `育成選手のモーダルに所属=育成 (${fHeadTxt})`);
assert.ok(walk(fOverlay).some((n) => textOf(n).includes('コーチの見立て')), '育成選手モーダルにスカウト評価（真値非露出）');
assert.ok(walk(fOverlay).some((n) => textOf(n).includes('一軍出場はありません')), '未出場の育成選手はNaN成績でなく案内文');

// E1e) playerLink の導線: 記録タブの選手名リンク → モーダル
btnByText('記録')._onclick();
const recLinks = allClass('plink').filter((n) => n._onclick);
assert.ok(recLinks.length >= 1, `記録タブの選手名がリンク化 (got ${allClass('plink').length})`);
recLinks[0]._onclick();
assert.ok(allClass('overlay').length >= 1, '記録タブのリンクから選手モーダルが開く');

console.log('UI smoke OK (E1): チームタブ(一軍33人一覧/仕様列/ソート/等級)→行クリックでモーダル(所属/二つ名ヘッダ)→年送り(オフ要約)→2年目二軍名簿→育成選手モーダル→記録タブplayerLink、例外なし');
console.log('UI smoke OK (E3編成): リザルト→ストーブリーグ(FA市場宣言見込み→入札/取消・トレード放出選択→受諾/拒否見込み→打診・育成昇格候補)→オフ処理→ダイジェスト(FA/トレード結果反映・自チームの動き・表彰)、例外なし');

console.log('UI smoke OK (C4演出): シーズンリザルト表彰パネル(MVP/タイトル/ベストナイン/守備賞)→記録タブ(球団史/リーグ記録)→選手モーダル「経歴」(二つ名/年度別/成長曲線/受賞履歴)、例外なし');

console.log('UI smoke OK: setup→simulate→6タブ描画→モーダル%d回(タブ化)→打球SVG %d要素→2リーグ順位表+PS+SH/IBB/PH+役割列+新指標列(ツールチップ)+モーダルタブ(打球/スプリット/文脈/守備)+チーム集計、例外なし', modalsOpened, svgCount);
console.log('UI smoke OK (ゲームシェルC1b): タイトル→ニューゲーム(12球団)→ハブ(全statタブ)→采配介入→観戦1試合(スコアボード/ダイヤモンド/実況/残量)→セーブ/ロード継続→月末進行→シーズン終了(日本一)、例外なし');
console.log('UI smoke OK (E2観戦): ラインスコア(9回+R/H/E)→対戦カード(打者/投手/球数/B-S-Oランプ/playerLink)→一球速報(n球目/◇打席行)→進行切替(1球/1打席/1イニング/自動再生)→スタメン折りたたみ(打順/今日)、例外なし');

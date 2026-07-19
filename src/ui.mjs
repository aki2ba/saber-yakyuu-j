// ============================================================================
// 結果表示UI（1-10 / §16 Lv1+Lv2 / §18）— ブラウザ専用（document使用）
//
// エンジン(engine.mjs)は build.mjs が先行<script>で読み込み済み。本ファイルは
// その関数群（createConfig/generateLeague/simulateSeason/deriveLeagueConstants/
// playerBatting/playerPitching/winPct 等）をグローバルスコープから参照する。
// 開発時のNode解決用に import も書くが、配布バンドルでは build.mjs が剥がす。
// ============================================================================
import {
  createConfig, generateLeague, simulateSeason, deriveLeagueConstants,
  playerBatting, playerPitching, playerBaserunning, battingSplits, playerFielding, winPct, gamesBehind, pythag,
  hitterWAR, pitcherWAR, uzrRuns, centeredOAAOuts,
  leagueBatting, leaguePitching, makeRng, hashSeed, TEAM_COLORS, TEAM_ABBR,
  createPlayerSeason, // E1: 育成/未出場選手のモーダル用の空観測ライン
  PERSONALITY_LABELS, // H3-1: 性格タグの日本語表示
} from './engine.mjs';
// フェーズC1 ゲーム層API（配布バンドルではグローバル・開発時Node解決用に import も書く）。
// バンドルでは import 行が剥がれ、これらは先行スクリプト（game/index.mjs 由来）のグローバルを参照する。
import {
  newGame, advanceDay, advanceTo, advanceYear, save, load, allPlayersById,
  setManagerProfile, clearManagerProfile,
  // C4 演出: 表彰/記録/二つ名/ニュース（バンドルではグローバル・開発時Node解決用に import）。
  computeSeasonAwards, playerAwardHistory, nicknameFor, evalSeason,
  leagueRecords, teamRecords, championCounts, milestones, careerBatting, careerPitching,
  careerEraPlus, // D3・§11.3: 記録の時代補正「+指標」（打高/投高時代を跨いで同価値化）
  DEF_AWARD_NAME, TITLE_LABELS, detectGameNotables, notableHeadline, streakOf, weeklyDigest,
  rosterMoveHeadline, // F2-4: 昇降格ニュース（フォールバック文面）
  // H1: ストーリーライン（連続ニュース・ライバル・引退ロード・phaseH_fun_spec H1）。
  weeklyStorylineDigest, rivalryGameHeadlines, rivalriesOf, retirementRoadCandidates,
  // H3-2: 評判ラベル「メディア評」（phaseH_fun_spec H3・観測集計のみから導出）。
  mediaReputation,
  // H5-B: オーナー目標・信任・解任（phaseH_fun_spec H5-B）。
  resolveOwnerDecision,
} from './game/index.mjs';
// フェーズE1: チームタブ（一軍/二軍の選手一覧）。src/ui/ 配下の分割モジュール
// （build.mjs が同一<script>へ前置concat＝バンドルでは import が剥がれ同一スコープ参照）。
import { renderTeamTab } from './ui/team.mjs';
// フェーズE2: スポナビ風観戦画面（ラインスコア/フィールド盤面/対戦カード/一球速報/進行切替）。
import { renderWatchScreen } from './ui/watch.mjs';
// フェーズE3: ストーブリーグ（FA市場/トレード/育成昇格）＋オフシーズンダイジェスト。
import { renderStoveScreen, renderOffseasonDigestScreen } from './ui/stove.mjs';
// フェーズE4: 日程・結果タブ（月別日程＋簡易ボックススコア）＋選手の活躍ニュース見出し。
import { renderScheduleTab, schedPlayerHeadlines } from './ui/schedule.mjs';
// H2: プレイヤー参加型ドラフト会議室（phaseH_fun_spec H2）。
import { renderDraftRoomScreen } from './ui/draft.mjs';

const state = {
  league: null,
  res: null,
  lc: null,
  cfg: null,
  byId: new Map(), // playerId -> player
  teamName: new Map(), // teamId -> name
  tab: 'war',
  sort: { key: 'wrcPlus', dir: -1 },
};

const el = (tag, attrs = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const k of Object.keys(attrs)) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'onclick') e.onclick = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  for (const kid of [].concat(kids)) e.append(kid);
  return e;
};
const fmt3 = (v) => (v < 1 ? '.' + Math.round(v * 1000).toString().padStart(3, '0') : v.toFixed(3));
const f2 = (v) => v.toFixed(2);
const pct = (v) => (v * 100).toFixed(1);
const signed = (v) => (v > 0 ? '+' : '') + (v ?? 0).toFixed(2);
const cl = (v, a, b) => (v < a ? a : v > b ? b : v);
// 列見出しに出る「±」書式の指標（run/win系。0中心・符号が意味を持つ）。
const PLUSMINUS = new Set(['oaa', 'uzr', 'bsr', 'wpa', 'clutch', 'arm', 'dpr', 'rSB', 'rngR', 'errR', 'framing', 're24']);

// リーダーボード/チーム表の列ツールチップ（初心者への定義説明・§B3 UI）。th の title に出す。
const TIP = {
  war: 'WAR: 打撃/走塁/守備/位置を得点換算した総合貢献度。控え級=0が基準、5で主力、8で球界代表級。',
  woba: 'wOBA: 出塁の質を得点価値で重み付けした打撃総合レート（リーグ平均≈.320）。',
  xwoba: 'xwOBA: 打球の速度と角度から期待されるwOBA。運を除いた実力寄りの指標。',
  wrcPlus: 'wRC+: 得点創出力を100=リーグ平均で指数化。150で平均比5割増、100が平均、70で3割減。',
  wrcPlusPF: 'wRC+PF: wRC+を本拠地の球場補正（パークファクター）で調整。打高球場の選手は割り引かれ、実力がリーグ100基準で公平に並ぶ（§11.2 文脈で正しく評価）。',
  opsPlus: 'OPS+: OPSをリーグ平均100で指数化した指標（球場補正はフェーズD）。',
  iso: 'ISO: 長打率−打率。純粋な長打力（本塁打・長打の多さ）。',
  barrelPct: 'Barrel%: 最も安打/長打になりやすいEV×角度帯に入った打球の割合。強打者ほど高い。',
  hardHitPct: 'HardHit%: 打球速度152km/h(約95mph)以上の割合＝強い打球を打つ頻度。',
  bsr: 'BsR: 走塁の総合得点貢献（盗塁wSB＋進塁UBR＋併殺回避wGDP）。0が平均。',
  wpa: 'WPA: 各打席で動いた勝利確率の累計。勝負所での貢献が大きく効く文脈指標。',
  clutch: 'Clutch: 場面の重み(LI)を除いた勝負強さ。プラスで大事な局面に強い。',
  bbPct: 'BB%: 四球÷打席。選球眼の指標。',
  kPct: 'K%: 三振÷打席。低いほど三振が少ない。',
  era: 'ERA: 防御率。9回あたりの自責点。',
  fip: 'FIP: 三振/四球/被本塁打だけで評価する守備非依存の防御指標（ERAスケール）。',
  eraMinusPF: 'ERA-PF: ERA-を本拠地の球場補正で調整（100=リーグ平均・低いほど良い）。打高球場の投手は優遇され、球場個性を除いた実力で並ぶ（§11.2）。',
  fipMinusPF: 'FIP-PF: FIP-を本拠地の球場補正で調整（100=リーグ平均・低いほど良い）。被本塁打が出やすい球場の投手を公平に評価（§11.2）。',
  xfip: 'xFIP: FIPの被本塁打をリーグ平均HR/FBで補正。長期の実力寄りで運に強い。',
  siera: 'SIERA: 三振/四球/ゴロ率から推定する技術ベースの防御指標（ERAスケール）。',
  kwera: 'kwERA: K%−BB% のみから算出する簡易防御指標（ERAスケール）。',
  kbbPct: 'K-BB%: 奪三振率−与四球率。投手の支配力の核。高いほど良い。',
  lobPct: 'LOB%: 残塁率。出した走者を還さなかった割合（リーグ≈72%）。',
  qs: 'QS: クオリティスタート。先発が6回以上を自責3以下で投げた試合数。',
  whip: 'WHIP: 1回あたりの(被安打＋四球)。走者を出さない指標。',
  kPer9: 'K/9: 9回あたりの奪三振。',
  rs: '得点: チームの総得点。', ra: '失点: チームの総失点。',
  uzrTeam: 'ΣUZR: チーム守備の対平均得点（範囲＋失策＋フレーミング）。',
};

// --- テーマ切替（明色既定・ダーク切替。表示レイヤーのみ＝エンジン/セーブに不干渉） ---
// localStorage/documentElement はヘッドレス環境（smoke）に無いので try/catch で握る（決定論に影響なし）。
const THEME_KEY = 'saber_theme';
function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
function applyTheme(t) {
  try { document.documentElement.setAttribute('data-theme', t); } catch { /* smoke: documentElement無し */ }
  try { localStorage.setItem(THEME_KEY, t); } catch { /* smoke/プライベートモード: 保存不可 */ }
}
function themeToggleBtn() {
  return el('button', { class: 'link', title: '明色/ダークの切替', onclick: () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark') }, '◐ 配色');
}

export function initApp() {
  applyTheme(currentTheme()); // 起動時に保存済みテーマを適用（既定=明色）
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';
  root.append(renderSetup());
}

function renderSetup() {
  const seedInput = el('input', { type: 'number', value: '2026', id: 'seedInput', style: 'width:90px' });
  const btn = el('button', { class: 'primary', onclick: () => runLeague(Number(seedInput.value) || 2026) }, 'リーグ生成＆シミュレート');
  // フェーズC1: ゲームシェル（キャリアを"プレイ"する）への入口。既存のクイックシミュレートは
  // そのまま残す（sim ボタンが先頭＝既存スモーク経路を壊さない）。
  const playBtn = el('button', { class: 'primary', onclick: () => renderTitle() }, '🎮 ゲームを始める（キャリア）');
  return el('div', { class: 'setup' }, [
    el('div', { class: 'header' }, [
      el('h2', {}, '架空選手ペナント（12球団 / 143試合・2リーグ制）'),
      el('div', { class: 'row' }, [themeToggleBtn()]),
    ]),
    el('p', { class: 'muted' }, 'リーグシードごとに架空選手840人（12球団×支配下70人・ほかに育成選手）が生成されます。生成後は「▶ 再シミュレート」で、同じ選手のまま毎回ちがう乱数で別のシーズンを回せます。'),
    el('div', { class: 'row' }, [el('label', {}, 'リーグシード: '), seedInput, btn]),
    el('div', { id: 'status', class: 'muted' }, ''),
    el('hr', { style: 'border:none;border-top:1px solid var(--line);margin:14px 0' }),
    el('p', { class: 'muted' }, 'または、1球団の監督としてキャリアをプレイ（観戦・采配・セーブ）:'),
    el('div', { class: 'row' }, [playBtn]),
  ]);
}

/** リーグ（選手）を生成し、最初のシーズンを回す */
function runLeague(leagueSeed) {
  const status = document.getElementById('status');
  if (status) status.textContent = 'リーグ生成中…';
  setTimeout(() => {
    const cfg = createConfig();
    const league = generateLeague(leagueSeed, cfg);
    state.cfg = cfg;
    state.league = league;
    state.leagueSeed = leagueSeed;
    state.seasonN = 0;
    state.byId = new Map(league.players.map((p) => [p.id, p]));
    state.teamName = new Map(league.teams.map((t) => [t.id, t.name]));
    simulateNextSeason();
  }, 20);
}

/** 同じリーグ（選手）で、別の乱数で1シーズン回す（押すたびに結果が変わる） */
function simulateNextSeason() {
  state.seasonN += 1;
  const seed = state.leagueSeed * 100000 + state.seasonN; // シーズンごとに別シード（決定論は保つ）
  // context:true で文脈指標（RE24/WPA/LI/Clutch・§B2）を2パスで算出（選手モーダル「文脈」タブ／
  // リーダーボードのWPA・Clutch列に必要）。pass2の試合結果は単一パスと完全同一＝決定論は不変。
  const res = simulateSeason(state.league, state.cfg, { season: 2024 + state.seasonN, seed, collectSpray: true, context: true });
  state.res = res;
  state.lc = deriveLeagueConstants(res);
  renderMain();
}

function renderMain() {
  const root = document.getElementById('app');
  root.innerHTML = '';
  const tabs = [
    ['war', 'WAR'],
    ['standings', '順位表'],
    ['batting', '打撃'],
    ['pitching', '投手'],
    ['fielding', '守備'],
    ['teams', 'チーム'],
  ];
  const bar = el('div', { class: 'tabs' }, tabs.map(([k, label]) =>
    el('button', { class: 'tab' + (state.tab === k ? ' active' : ''), onclick: () => { state.tab = k; renderMain(); } }, label),
  ));
  const resim = el('button', { class: 'primary', onclick: () => simulateNextSeason() }, '▶ 再シミュレート');
  const back = el('button', { class: 'link', onclick: () => initApp() }, '↺ 新しいリーグ');
  const content = el('div', { id: 'content' });
  root.append(
    el('div', { class: 'header' }, [
      el('h2', {}, `シーズン${state.seasonN}（リーグseed ${state.leagueSeed}）`),
      el('div', { class: 'row' }, [resim, back, themeToggleBtn()]),
    ]),
    bar,
    content,
  );
  if (state.tab === 'war') renderWAR(content);
  else if (state.tab === 'standings') renderStandings(content);
  else if (state.tab === 'batting') renderBatting(content);
  else if (state.tab === 'pitching') renderPitching(content);
  else if (state.tab === 'teams') renderTeams(content);
  else renderFielding(content);
}

// --- WARランキング（カード型・§16 Lv2）------------------------------------
function renderWAR(c) {
  const rows = state.res.playerSeasons
    .map((s) => {
      const p = state.byId.get(s.playerId);
      if (p.role === 'pitcher') {
        const w = pitcherWAR(s, state.cfg, state.lc);
        return { id: s.playerId, name: p.name, team: state.teamName.get(s.teamId) || s.teamId, role: '投', war: w.war, detail: `FIP ${w.fip.toFixed(2)} / ${w.ip.toFixed(0)}回` };
      }
      const w = hitterWAR(s, state.cfg, state.lc);
      return { id: s.playerId, name: p.name, team: state.teamName.get(s.teamId) || s.teamId, role: primaryPos(p), war: w.war, detail: `打${w.wraa.toFixed(0)} 走${w.bsr.toFixed(0)} 守${w.uzr.toFixed(0)} 位${w.posAdj.toFixed(0)}` };
    })
    .sort((a, b) => b.war - a.war)
    .slice(0, 50);
  c.append(el('div', { class: 'muted', style: 'margin:4px 0' }, 'WAR = 打撃(wRAA)＋走塁(BsR)＋守備(UZR)＋位置補正 の総合。行タップで詳細。'));
  const navIds = rows.map((r) => r.id); // G9: モーダルの前後ナビ用
  c.append(el('div', { class: 'warlist' }, rows.map((r, i) =>
    el('div', { class: 'warcard clickable', onclick: () => openModal(r.id, navIds) }, [
      el('span', { class: 'warrank' }, String(i + 1)),
      el('span', { class: 'warval' }, r.war.toFixed(1)),
      el('span', { class: 'warname' }, [
        el('div', { class: 'wn1' }, r.name),
        el('div', { class: 'muted' }, `${r.team} / ${r.role}　${r.detail}`),
      ]),
    ]),
  )));
}

// G5b: 順位表の詳細列トグル（UIローカル状態・null=未初期化）。
//   キャリアモードは既定OFF（基本列のみ）・クイックシミュレート（game.gs===null＝分析用途）は既定ON。
//   一軍・二軍の順位表で共有する（トグルは1つ）。G5aの列グループ既定と同じ判定基準。
let standingsDetail = null;
function renderStandings(c) {
  if (standingsDetail === null) standingsDetail = !game.gs;
  const leagues = state.cfg.league.leagues ?? [];
  const byLg = state.res.standingsByLeague ?? {};
  const blocks = leagues.length
    ? leagues.map((l) => ({ title: `${l.name}（DH${l.dh ? '有' : '無'}）`, rows: byLg[l.id] ?? [] }))
    : [{ title: '総合', rows: state.res.standings }];
  const toggle = el('button', {
    class: 'link',
    onclick: () => { standingsDetail = !standingsDetail; c.innerHTML = ''; renderStandings(c); },
  }, standingsDetail ? '▼ 詳細列（得失点・期待勝率・運・交流戦）を閉じる' : '▶ 詳細列（得失点・期待勝率・運・交流戦）');
  c.append(toggle);
  for (const blk of blocks) {
    const leader = blk.rows[0];
    const rows = blk.rows.map((t, i) => {
      const py = pythag(t); // ピタゴラス期待勝率＋幸運度（得失点から見た実力勝率と実勝率の差）
      const luck = Math.round(py.luck);
      // ゲーム差（NPB慣例の「差」＝首位との勝敗差の平均。首位行は0=表記「-」）
      const gb = gamesBehind(leader, t);
      const cells = [
        td(i + 1),
        el('td', { class: 'left', style: `border-left:3px solid ${teamColor(t.teamId)}` }, t.name),
        td(t.w), td(t.l), td(t.t),
        td(fmt3(winPct(t))), td(gbText(i, gb)),
      ];
      if (standingsDetail) {
        cells.push(
          td(t.rs), td(t.ra), td((t.rs - t.ra > 0 ? '+' : '') + (t.rs - t.ra)),
          td(fmt3(py.expWinPct)), td((luck > 0 ? '+' : '') + luck),
          td(t.il ? `${t.il.w}-${t.il.l}-${t.il.t}` : '-'),
        );
      }
      // キャリアモードでは自チーム行を強調（二軍順位・ホームのミニ順位と同じ流儀）
      const my = game.gs && t.teamId === game.gs.playerTeamId;
      return el('tr', { class: my ? 'myteam' : '' }, cells);
    });
    c.append(el('h3', { class: 'leaguename' }, blk.title));
    // 期待勝率=得失点からのピタゴラス実力勝率 / 運=実勝率−期待勝率を勝数換算（+は接戦強い/幸運）
    const head = ['順', '球団', '勝', '敗', '分', '勝率', '差'];
    if (standingsDetail) head.push('得点', '失点', '得失点差', '期待勝率', '運', '交流戦');
    c.append(table(head, rows));
  }
  renderPostseasonPanel(c);
  renderFarmStandings(c); // F2-4: 二軍リーグ順位（キャリアモードのみ・折りたたみ）
}

// --- 二軍リーグ順位（F2-4・キャリアモードのみ） ------------------------------
// rt.farm.standings（進行途中も可）を farm 2リーグ（若草/暁）に分割して表示する。
// 見出しボタンで折りたたみ（UIローカル状態・ゲーム状態は一切変えない）。
let farmStandingsOpen = false;
function renderFarmStandings(c) {
  const rt = game.gs ? game.gs.rt : null;
  if (!rt || !rt.farm) return; // クイックシミュレート/farm不成立構成では出さない
  const box = el('div', { class: 'farmstandings' });
  const body = el('div');
  const draw = () => {
    body.innerHTML = '';
    if (!farmStandingsOpen) return;
    // 現在順位（finalizeStandings と同じ並び: 勝率→得失点差）を farm リーグ別に分割
    const rows = [...rt.farm.standings.values()].sort((a, b) => winPct(b) - winPct(a) || (b.rs - b.ra) - (a.rs - a.ra));
    for (const l of state.cfg.league.farm?.leagues ?? []) {
      const lgRows = rows.filter((r) => r.league === l.id);
      if (!lgRows.length) continue;
      body.append(el('h3', { class: 'leaguename' }, `${l.name}（二軍・DH${l.dh ? '有' : '無'}）`));
      const leader = lgRows[0];
      // G5b: 一軍と同じ standingsDetail トグルを二軍にも適用（得点/失点/得失点差の3列）
      const head = ['順', '球団', '勝', '敗', '分', '勝率', '差'];
      if (standingsDetail) head.push('得点', '失点', '得失点差');
      body.append(table(head, lgRows.map((t, i) => {
        const gb = gamesBehind(leader, t);
        const cells = [
          td(i + 1), td(t.name, 'left'), td(t.w), td(t.l), td(t.t),
          td(fmt3(winPct(t))), td(gbText(i, gb)),
        ];
        if (standingsDetail) cells.push(td(t.rs), td(t.ra), td((t.rs - t.ra > 0 ? '+' : '') + (t.rs - t.ra)));
        return el('tr', { class: t.teamId === game.gs.playerTeamId ? 'myteam' : '' }, cells);
      })));
    }
    body.append(el('div', { class: 'muted' }, '二軍は出場登録外の支配下＋育成選手によるファームリーグ（優勝争いは一軍と独立）。'));
  };
  const toggle = el('button', { class: 'link', onclick: () => { farmStandingsOpen = !farmStandingsOpen; toggle.textContent = farmLabel(); draw(); } }, '');
  const farmLabel = () => (farmStandingsOpen ? '▼ 二軍リーグ順位（ファーム）を閉じる' : '▶ 二軍リーグ順位（ファーム）を開く');
  toggle.textContent = farmLabel();
  box.append(toggle, body);
  draw();
  c.append(box);
}

// --- ポストシーズン結果パネル（S4: CS/日本シリーズの勝敗） -------------------
function renderPostseasonPanel(c) {
  const ps = state.res.postseason;
  if (!ps) return;
  const name = (tid) => state.teamName.get(tid) || tid;
  // シリーズ1行: 「ラベル  A w-l B（アド込み）→ 勝者」
  const seriesRow = (label, s) => {
    if (!s) return null;
    const [a, b] = s.teams;
    const adv = s.advantage ? `（${name(s.advantage)}のアド1勝込み）` : '';
    return el('div', { class: 'psrow' }, [
      el('span', { class: 'pslabel' }, label),
      el('span', {}, `${name(a)} ${s.wins[a]} - ${s.wins[b]} ${name(b)}${adv} → ${name(s.winner)}`),
    ]);
  };
  const box = el('div', { class: 'pspanel' });
  box.append(el('h3', { class: 'leaguename' }, 'ポストシーズン'));
  for (const l of state.cfg.league.leagues ?? []) {
    const first = seriesRow(`${l.name} CSファースト`, ps.csFirst[l.id]);
    const fin = seriesRow(`${l.name} CSファイナル`, ps.csFinal[l.id]);
    if (first) box.append(first);
    if (fin) box.append(fin);
  }
  if (ps.japanSeries) {
    box.append(seriesRow('日本シリーズ', ps.japanSeries));
    // G8: 戦績の長文1行を表形式に（戦/ホーム/スコア/ビジター/延長）
    const jsRows = ps.japanSeries.games.map((g, i) => el('tr', {}, [
      td(`第${i + 1}戦`), td(name(g.home)), td(`${g.homeScore}-${g.awayScore}`, 'right'), td(name(g.away)),
      td(g.innings > 9 ? `延長${g.innings}回` : ''),
    ]));
    box.append(table(['戦', 'ホーム', 'スコア', 'ビジター', '延長'], jsRows));
  }
  if (ps.champion) box.append(el('div', { class: 'pschamp' }, `日本一: ${name(ps.champion)}`));
  c.append(box);
}

// --- 打撃 -----------------------------------------------------------------
const BAT_COLS = [
  ['name', '選手', 'left'], ['team', 'ﾁｰﾑ', 'left'], ['pos', '守', 'left'],
  ['war', 'WAR'], ['pa', '打席'], ['avg', '打率'], ['hr', '本'], ['rbi', '点'], ['sb', '盗'],
  ['obp', '出塁'], ['slg', '長打'], ['ops', 'OPS'], ['woba', 'wOBA'], ['xwoba', 'xwOBA'],
  ['wrcPlus', 'wRC+'], ['wrcPlusPF', 'wRC+PF'], ['opsPlus', 'OPS+'], ['iso', 'ISO'],
  ['barrelPct', 'Barrel%'], ['hardHitPct', 'HardHit%'],
  ['bsr', 'BsR'], ['wpa', 'WPA'], ['clutch', 'Clutch'], ['bbPct', 'BB%'], ['kPct', 'K%'],
  ['sh', '犠打'], ['ibb', '敬遠'], ['ph', '代打'], // S4: 采配の発現（SH/IBB/PH）
];
// G3: 規定ライン（NPB: 打席=試合数×3.1 / 投球回=試合数×1.0）。シーズン途中は消化試合に比例させ、
// 通年（g=143）では従来の固定フィルタ（打者100PA/投手20IP）と同値に収める＝通年の表示は従来と不変。
function qualifyPa(teamId) {
  const st = state.res.standings.find((t) => t.teamId === teamId);
  const g = st ? st.w + st.l + st.t : 0;
  return Math.min(100, Math.max(1, Math.ceil(g * 3.1)));
}
function qualifyIp(teamId) {
  const st = state.res.standings.find((t) => t.teamId === teamId);
  const g = st ? st.w + st.l + st.t : 0;
  return Math.min(20, Math.max(1, Math.ceil(g * 1.0)));
}
const QUALIFY_EMPTY_MSG = '規定到達者がまだいません（規定打席=消化試合×3.1・規定投球回=消化試合×1.0）。試合を進めると表示されます。';
// G5a: 列グループ（モバイルで多数列を一度に出さない）。キーは BAT_COLS/PIT_COLS のサブセット。
// 配列の並び順=表示順（cols側の元の並びではない）。
const BAT_COL_GROUPS = [
  ['basic', '基本', ['name', 'team', 'pos', 'war', 'pa', 'avg', 'hr', 'rbi', 'sb', 'obp', 'slg', 'ops']],
  ['saber', 'セイバー', ['name', 'team', 'woba', 'xwoba', 'wrcPlus', 'wrcPlusPF', 'opsPlus', 'iso', 'bsr', 'war']],
  ['batted', '打球', ['name', 'team', 'barrelPct', 'hardHitPct', 'bbPct', 'kPct']],
  ['ctx', '文脈', ['name', 'team', 'wpa', 'clutch', 'sh', 'ibb', 'ph']],
  ['all', '全列', null], // null=BAT_COLS全体をそのまま使う
];
const PIT_COL_GROUPS = [
  ['basic', '基本', ['name', 'team', 'role', 'war', 'w', 'l', 'sv', 'hld', 'ip', 'era', 'so', 'whip']],
  ['saber', 'セイバー', ['name', 'team', 'fip', 'eraMinusPF', 'fipMinusPF', 'xfip', 'siera', 'kwera', 'kPer9', 'kbbPct', 'bbPct', 'lobPct']],
  ['ctx', '文脈', ['name', 'team', 'qs', 'wpa', 'clutch']],
  ['all', '全列', null],
];
// UIローカル状態: null は「未初期化」の意味で使い、初回描画時に既定値をセットする
//   （キャリアモードは'basic'・クイックシミュレートは'all'＝分析用途では全指標を即座に見たい）。
let batColGroup = null;
let pitColGroup = null;
function renderBatting(c) {
  if (batColGroup === null) batColGroup = game.gs ? 'basic' : 'all';
  const data = state.res.playerSeasons
    .filter((s) => s.batting.pa >= qualifyPa(s.teamId))
    .map((s) => {
      const m = playerBatting(s, state.lc);
      const p = state.byId.get(s.playerId);
      const war = p.role === 'fielder' ? hitterWAR(s, state.cfg, state.lc).war : 0;
      const bsr = playerBaserunning(s, state.cfg, state.lc).bsr;
      const b = s.batting;
      return { id: s.playerId, name: p ? p.name : s.playerId, team: state.teamName.get(s.teamId) || s.teamId, teamId: s.teamId, pos: primaryPos(p), war, bsr, sh: b.sh, ibb: b.ibb, ph: b.ph, ...m };
    });
  c.append(statTable(data, BAT_COLS, ['avg', 'obp', 'slg', 'ops', 'woba', 'xwoba', 'iso'], ['bbPct', 'kPct', 'barrelPct', 'hardHitPct'], 'war', 1, {
    emptyMsg: QUALIFY_EMPTY_MSG, groups: BAT_COL_GROUPS, getGroup: () => batColGroup, setGroup: (k) => { batColGroup = k; },
  }));
}

// --- 投手 -----------------------------------------------------------------
const PIT_COLS = [
  ['name', '選手', 'left'], ['team', 'ﾁｰﾑ', 'left'], ['role', '役割', 'left'], ['war', 'WAR'],
  ['w', '勝'], ['l', '敗'], ['sv', 'S'], ['hld', 'H'], ['ip', '回'], ['era', '防御'], ['fip', 'FIP'],
  ['eraMinusPF', 'ERA-PF'], ['fipMinusPF', 'FIP-PF'],
  ['xfip', 'xFIP'], ['siera', 'SIERA'], ['kwera', 'kwERA'],
  ['so', '奪三'], ['kPer9', 'K/9'], ['whip', 'WHIP'], ['bbPct', 'BB%'], ['kbbPct', 'K-BB%'], ['lobPct', 'LOB%'],
  ['qs', 'QS'], ['wpa', 'WPA'], ['clutch', 'Clutch'],
];
function renderPitching(c) {
  if (pitColGroup === null) pitColGroup = game.gs ? 'basic' : 'all';
  const data = state.res.playerSeasons
    .filter((s) => s.pitching.outs / 3 >= qualifyIp(s.teamId))
    .map((s) => {
      const m = playerPitching(s, state.lc, state.cfg);
      const p = state.byId.get(s.playerId);
      // 役割は観測値（GS/G過半）で判定（S4。真値のローテ表は見ない＝statlineから湧く原則）
      const role = m.g && m.gs * 2 >= m.g ? '先発' : '救援';
      return { id: s.playerId, name: p ? p.name : s.playerId, team: state.teamName.get(s.teamId) || s.teamId, teamId: s.teamId, role, war: pitcherWAR(s, state.cfg, state.lc).war, ...m };
    });
  c.append(statTable(data, PIT_COLS, ['era', 'fip', 'whip', 'xfip', 'siera', 'kwera'], ['bbPct', 'kbbPct', 'lobPct'], 'war', 1, {
    emptyMsg: QUALIFY_EMPTY_MSG, groups: PIT_COL_GROUPS, getGroup: () => pitColGroup, setGroup: (k) => { pitColGroup = k; },
  }));
}

// --- 守備 -----------------------------------------------------------------
function renderFielding(c) {
  const data = state.res.playerSeasons
    .map((s) => {
      let outs = 0;
      let mainPos = '';
      let mx = -1;
      for (const k of Object.keys(s.fielding.positionOuts)) {
        outs += s.fielding.positionOuts[k];
        if (s.fielding.positionOuts[k] > mx) { mx = s.fielding.positionOuts[k]; mainPos = k; }
      }
      const p = state.byId.get(s.playerId);
      return { id: s.playerId, name: p ? p.name : s.playerId, team: state.teamName.get(s.teamId) || s.teamId, teamId: s.teamId, pos: mainPos, inn: outs / 3, oaa: centeredOAAOuts(s, state.lc), uzr: uzrRuns(s, state.cfg, state.lc), e: s.fielding.e };
    })
    .filter((d) => d.inn >= 100 && d.pos !== 'DH'); // DHは守備表から除外（守備位置補正はWAR表に反映）
  const cols = [['name', '選手', 'left'], ['team', 'ﾁｰﾑ', 'left'], ['pos', '守', 'left'], ['inn', '守備回'], ['oaa', 'OAA'], ['uzr', 'UZR'], ['e', '失策']];
  c.append(statTable(data, cols, [], [], 'uzr', 1));
}

// --- 汎用ソート可能テーブル ------------------------------------------------
function statTable(data, cols, fmtDec3, fmtPct, defaultSort, dec = 0, opts = {}) {
  const { emptyMsg, groups, getGroup, setGroup } = opts;
  const wrap = el('div', { class: 'tablewrap' });
  // G5a: groups があるとき、getGroup() が指すグループ定義（第3要素=列キー配列）の並び順で
  //   cols から該当列を1つずつ拾って表示列を決める（cols側の元の並びではなくグループ配列側の並びを使う。
  //   例: saber 群は war を末尾に置きたいのでグループ配列の記載順をそのまま使う）。
  const displayCols = () => {
    if (!groups) return cols;
    const g = groups.find(([k]) => k === getGroup());
    const list = g ? g[2] : null;
    return list ? list.map((k) => cols.find(([ck]) => ck === k)).filter(Boolean) : cols; // 第3要素null='全列'
  };
  const render = () => {
    wrap.innerHTML = '';
    if (!data.length) { wrap.append(el('div', { class: 'emptybox' }, emptyMsg || '対象データがありません。')); return; }
    const curCols = displayCols();
    // 現在の表示列に無いキーでソート中なら既定ソートへフォールバック（グループ切替直後の不整合防止）。
    if (!curCols.some(([k]) => k === state.sort.key)) state.sort = { key: defaultSort, dir: defaultSort === 'era' || defaultSort === 'fip' ? 1 : -1 };
    const { key, dir } = state.sort;
    const sorted = [...data].sort((a, b) => {
      const av = a[key]; const bv = b[key];
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * ((av ?? 0) - (bv ?? 0));
    }).slice(0, 100);
    const head = el('tr', {}, curCols.map(([k, label, align]) =>
      el('th', { class: (align || '') + (state.sort.key === k ? ' sorted' : ''), title: TIP[k] || '', onclick: () => { state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 }; render(); } }, label + (state.sort.key === k ? (dir < 0 ? ' ▼' : ' ▲') : '')),
    ));
    // G9: 表示中テーブルのソート済みID配列をモーダルの前後ナビに渡す。
    const navIds = sorted.map((d) => d.id);
    const rows = sorted.map((d) => el('tr', { class: 'clickable', onclick: () => openModal(d.id, navIds) }, curCols.map(([k, , align]) => {
      if (k === 'team') return teamCell(d, align); // G5a: 略称チップ（teamIdが無ければ文字列フォールバック）
      let v = d[k];
      if (typeof v === 'number') {
        if (fmtDec3.includes(k)) v = fmt3(v);
        else if (fmtPct.includes(k)) v = pct(v);
        else if (k === 'ip' || k === 'inn') v = v.toFixed(1);
        else if (k === 'war') v = v.toFixed(1);
        else if (PLUSMINUS.has(k)) v = (v > 0 ? '+' : '') + v.toFixed(1);
        else if (!Number.isInteger(v)) v = v.toFixed(dec);
      }
      return td(v, align);
    })));
    wrap.append(el('table', { class: 'stat' }, [el('thead', {}, head), el('tbody', {}, rows)]));
  };
  state.sort = { key: defaultSort, dir: defaultSort === 'era' || defaultSort === 'fip' ? 1 : -1 };
  render();
  if (!groups) return wrap;
  // G5a: 列グループ切替バー（wrap の外側）。render() 単体を再実行するだけでよくソート状態は保持される。
  const barWrap = el('div', { class: 'colgroups' });
  const renderBar = () => {
    barWrap.innerHTML = '';
    barWrap.append(...groups.map(([k, label]) => el('button', {
      class: 'colgroup' + (getGroup() === k ? ' active' : ''),
      onclick: () => { setGroup(k); render(); renderBar(); },
    }, label)));
  };
  renderBar();
  return el('div', {}, [barWrap, wrap]);
}

// G5a: team列のセル。d.teamId があれば tabbr() 略称＋球団カラーのチップ（順位表の球団名セルと同じ流儀）、
//   無ければ従来どおり d.team の文字列 td にフォールバック（守備タブ等 teamId 未設定でも壊れない）。
function teamCell(d, align) {
  if (d.teamId == null) return td(d.team, align);
  return el('td', { class: align || '', style: `border-left:3px solid ${teamColor(d.teamId)}` }, tabbr(d.teamId));
}

// --- 選手モーダル（タブ化・§B3 UI）----------------------------------------
// 打者: 基本 / 打球(スプレー+EV/LA+Barrel%) / スプリット(対左右/RISP/home-away) / 文脈(WPA/RE24/Clutch/LI) / 守備成分
// 投手: 基本 / 投球(xFIP/SIERA/被打球) / 文脈(WPA/pLI/gmLI/SD/MD)
// G9: navIds は「表示中テーブルのソート済みID配列」（省略可）。渡されたときだけ modalhead に
//   前後ナビ（◀/▶）が出る。ナビ時は overlay を作り直さず一旦 remove() して openModal を呼び直す
//   （最も単純な再構築＝タブ選択状態はナビをまたいで保持しない仕様）。
function openModal(playerId, navIds = null) {
  const p = state.byId.get(playerId);
  if (!p) return;
  const isPitcher = p.role === 'pitcher';
  // E1: 育成（二軍）・当年未出場の選手も開けるように、観測ラインが無ければ空ラインで代替する。
  //   観測が空のときは指標タブを出さない（0除算のNaN表示を避け、基本＋経歴のみ）。
  let s = state.res && state.res.statsById ? state.res.statsById.get(playerId) : null;
  const hasStats = !!s && (isPitcher ? (s.pitching.g > 0 || s.pitching.outs > 0) : s.batting.pa > 0);
  if (!s) s = createPlayerSeason(playerId, state.res ? state.res.season : 0);
  const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const box = el('div', { class: 'modal' });
  box.append(modalHeader(p, isPitcher, overlay, playerId, navIds));
  const modalTabs = !hasStats
    ? [['basic', '基本']]
    : isPitcher
      ? [['basic', '基本'], ['pitch', '投球'], ['context', '文脈']]
      : [['basic', '基本'], ['batted', '打球'], ['splits', 'スプリット'], ['context', '文脈'], ['field', '守備成分']];
  // キャリアモード（game.gs）では「経歴」タブ（二つ名/年度別成績/受賞履歴/成長曲線）を足す。
  if (game.gs) modalTabs.push(['career', '経歴']);
  let cur = 'basic';
  const rest = el('div');
  box.append(rest);
  const render = () => {
    rest.innerHTML = '';
    const bar = el('div', { class: 'modaltabs' }, modalTabs.map(([k, label]) =>
      el('button', { class: 'mtab' + (cur === k ? ' active' : ''), onclick: () => { cur = k; render(); } }, label)));
    const body = el('div', { class: 'modalbody' });
    rest.append(bar, body);
    if (cur === 'basic') renderModalBasic(body, p, s, isPitcher);
    else if (cur === 'batted') renderModalBatted(body, s, playerId);
    else if (cur === 'splits') renderModalSplits(body, s);
    else if (cur === 'context') renderModalContext(body, s, isPitcher);
    else if (cur === 'field') renderModalField(body, s);
    else if (cur === 'pitch') renderModalPitch(body, s);
    else if (cur === 'career') renderModalCareer(body, p, isPitcher);
  };
  render();
  overlay.append(box);
  document.getElementById('app').append(overlay);
}

/**
 * モーダルヘッダ（E1整備）: 名前＋二つ名（キャリア時）／所属（一軍支配下・育成二軍）・位置・
 * 年齢・利き手／受賞歴（キャリア時・直近3件＋件数）。三層構造: 二つ名も受賞も観測ベース。
 * G9: navIds が渡されたときは◀/▶の前後ナビボタンを右側（✕の隣）に足す（端は disabled）。
 */
function modalHeader(p, isPitcher, overlay, playerId, navIds) {
  const gs = game.gs;
  const left = el('div', {});
  const nameRow = el('div', {}, [el('span', { class: 'pname' }, p.name)]);
  if (gs) nameRow.append(el('span', { class: 'headnick' }, `「${nicknameFor(p, gs.careerStats, gs.cfg)}」`));
  left.append(nameRow);
  // 所属: キャリアモードのみ明示（E1→F2-4: 支配下は出場登録の有無で一軍登録/二軍を区別）。
  const registered = gs && gs.rt && gs.rt.registeredByTeam ? !!gs.rt.registeredByTeam.get(p.teamId)?.has(p.id) : true;
  const belong = gs ? (p.rosterStatus === 'minor' ? '育成（二軍）' : registered ? '支配下（一軍登録）' : '支配下（二軍）') + ' / ' : '';
  left.append(el('div', { class: 'muted' },
    `${state.teamName.get(p.teamId) || ''} / ${belong}${isPitcher ? '投手' : posJP(primaryPos(p))} / ${p.age}歳 / ${handLabel(p.throws)}投${handLabel(p.bats)}打`));
  // H3: 性格タグ（常時・真値ではない表示用の個性）＋メディア評（キャリアモードのみ・観測から導出）。
  if (p.personality || gs) {
    const tags = [];
    if (p.personality) tags.push(el('span', { class: 'persontag' }, PERSONALITY_LABELS[p.personality] ?? p.personality));
    if (gs) {
      for (const t of mediaReputation(p, gs.careerStats, gs.injuryLog, gs.cfg)) {
        tags.push(el('span', { class: 'reptag' }, t.label));
      }
    }
    if (tags.length) left.append(el('div', { class: 'reptags' }, tags));
  }
  if (gs) {
    const hist = playerAwardHistory(p.id, { careerStats: gs.careerStats, teamHistory: gs.teamHistory, playersById: allPlayersById(gs), cfg: gs.cfg });
    if (hist.length) {
      const recent = hist.slice(-3).map((a) => `${a.year} ${a.label}${a.pos ? `（${posJP(a.pos)}）` : ''}`).join('・');
      left.append(el('div', { class: 'headawards' }, `🏅 ${recent}${hist.length > 3 ? ` 他${hist.length - 3}件` : ''}`));
    }
    // H1-3: 引退ロード候補（年齢閾値＋通算マイルストーン）バッジ。引退判定そのものには非干渉。
    if (p.rosterStatus === 'active' && retirementRoadCandidates(gs).some((c) => c.playerId === p.id)) {
      left.append(el('div', { class: 'headawards' }, '🎬 今季が集大成のシーズンになるか'));
    }
  }
  const right = el('div', { class: 'modalnavwrap' });
  if (navIds && navIds.length > 1) {
    const idx = navIds.indexOf(playerId);
    const prevId = idx > 0 ? navIds[idx - 1] : null;
    const nextId = idx >= 0 && idx < navIds.length - 1 ? navIds[idx + 1] : null;
    const navBtn = (label, id) => {
      const attrs = { class: 'link modalnav' };
      if (id == null) attrs.disabled = true;
      else attrs.onclick = () => { overlay.remove(); openModal(id, navIds); };
      return el('button', attrs, label);
    };
    right.append(navBtn('◀', prevId), navBtn('▶', nextId));
  }
  right.append(el('button', { class: 'link', onclick: () => overlay.remove() }, '✕'));
  return el('div', { class: 'modalhead' }, [left, right]);
}

// 基本タブ: 成績サマリ＋（打者）WAR内訳/対球種 ＋能力バー
function renderModalBasic(box, p, s, isPitcher) {
  const hasStats = isPitcher ? (s.pitching.g > 0 || s.pitching.outs > 0) : s.batting.pa > 0;
  if (!hasStats) {
    // E1: 育成（二軍）・当年未出場。観測成績はまだ無い＝見立てのみ表示（NaN指標を出さない）。
    box.append(el('div', { class: 'muted' },
      `今季の一軍出場はありません${p.rosterStatus === 'minor' ? '（育成契約・二軍所属）' : ''}。`));
  } else if (isPitcher) {
    const m = playerPitching(s, state.lc, state.cfg);
    const pw = pitcherWAR(s, state.cfg, state.lc);
    box.append(kv([['WAR', pw.war.toFixed(1)], ['登板', m.g], ['勝', m.w], ['敗', m.l], ['S', m.sv], ['投球回', m.ip.toFixed(1)], ['防御率', f2(m.era)], ['FIP', f2(m.fip)], ['奪三', m.so], ['K/9', f2(m.kPer9)]]));
  } else {
    const m = playerBatting(s, state.lc);
    box.append(kv([['打席', m.pa], ['打率', fmt3(m.avg)], ['本塁打', m.hr], ['打点', m.rbi], ['盗塁', m.sb], ['出塁', fmt3(m.obp)], ['長打', fmt3(m.slg)], ['OPS', fmt3(m.ops)], ['wOBA', fmt3(m.woba)], ['wRC+', m.wrcPlus.toFixed(0)], ['wRC+PF', m.wrcPlusPF.toFixed(0)]]));
    const w = hitterWAR(s, state.cfg, state.lc);
    box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, `WAR ${w.war.toFixed(1)} 内訳`));
    box.append(kv([['打wRAA', w.wraa.toFixed(1)], ['走BsR', w.bsr.toFixed(1)], ['守UZR', w.uzr.toFixed(1)], ['位置', w.posAdj.toFixed(1)], ['OAA', centeredOAAOuts(s, state.lc).toFixed(1)]]));
    const vf = s.batting.vsFastball;
    const vb = s.batting.vsBreaking;
    const avgOf = (x) => (x.ab ? fmt3(x.h / x.ab) : '-');
    box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, '対球種成績（打率 / 本）'));
    box.append(kv([['対速球', `${avgOf(vf)} / ${vf.hr}`], ['対変化球', `${avgOf(vb)} / ${vb.hr}`]]));
  }
  // F2-4: 今季の二軍成績（現役・キャリアモード）。二軍集計 rt.farm.stats から観測値のみ表示。
  renderCurrentFarmLine(box, p, isPitcher);
  // 三層構造の禁則（phaseC_spec 禁則・§1）: キャリアモードでは trueAbility（layer1・隠し値）を
  // 直接出さない。プレイヤーが見るのは観測成績＋スカウト評価＝「コーチの見立て」（scoutSeed 由来の
  // 決定論ノイズを乗せた粗い等級・layer3）。分析ダッシュボード（クイックシミュレート＝game.gs 無し）は
  // 開発/分析用途として真値表示を許容する。
  if (game.gs) {
    box.append(el('div', { class: 'muted', style: 'margin-top:10px' }, 'コーチの見立て（スカウト評価・等級）'));
    box.append(scoutBars(p));
  } else {
    box.append(el('div', { class: 'muted', style: 'margin-top:10px' }, '能力（真の実力）'));
    box.append(abilityBars(p.trueAbility, p.role));
  }
}

/**
 * F2-4: 基本タブの「今季二軍成績」（キャリアモードのみ）。二軍集計（rt.farm.stats）から
 * 数え上げ系＋率系のみ表示（WAR/wRC+は二軍リーグ水準が異なるため出さない・観測値のみ＝三層構造）。
 * 二軍出場が無い選手（登録に居続けた主力等）は何も出さない。
 */
function renderCurrentFarmLine(box, p, isPitcher) {
  const gs = game.gs;
  const rt = gs ? gs.rt : null;
  if (!rt || !rt.farm) return;
  const s = rt.farm.stats.stats.get(p.id);
  const has = !!s && (isPitcher ? (s.pitching.g > 0 || s.pitching.outs > 0) : s.batting.pa > 0);
  if (!has) return;
  box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, '今季二軍成績（ファーム）'));
  if (isPitcher) {
    // 率系は生カウントから直接（リーグ定数非依存＝水準の取り違えが起きない）。
    const t = s.pitching;
    const ip = t.outs / 3;
    const era = t.outs > 0 ? (t.er * 27) / t.outs : null;
    const whip = t.outs > 0 ? (t.h + t.bb) / ip : null;
    box.append(kv([
      ['登板', t.g], ['勝', t.w], ['敗', t.l], ['S', t.sv], ['投球回', ip.toFixed(1)],
      ['防御率', era != null && Number.isFinite(era) ? f2(era) : '-'],
      ['WHIP', whip != null && Number.isFinite(whip) ? f2(whip) : '-'], ['奪三', t.so],
    ]));
  } else {
    const b = s.batting;
    const ab = b.ab;
    const obpDen = ab + b.bb + b.hbp + b.sf; // 標準OBP分母（playerBatting と同定義）
    const avg = ab > 0 ? b.h / ab : null;
    const obp = obpDen > 0 ? (b.h + b.bb + b.hbp) / obpDen : null;
    const slg = ab > 0 ? (b.h + b.b2 + 2 * b.b3 + 3 * b.hr) / ab : null;
    box.append(kv([
      ['打席', b.pa], ['打率', avg != null ? fmt3(avg) : '-'], ['本塁打', b.hr], ['打点', b.rbi], ['盗塁', b.sb],
      ['出塁', obp != null ? fmt3(obp) : '-'], ['長打', slg != null ? fmt3(slg) : '-'],
      ['OPS', obp != null && slg != null ? fmt3(obp + slg) : '-'],
    ]));
  }
}

// 打球タブ: 打球質(Barrel/HardHit/SweetSpot・EV)・打球タイプ/方向・スプレー＋EV/LA散布図
function renderModalBatted(box, s, playerId) {
  const m = playerBatting(s, state.lc);
  box.append(el('div', { class: 'muted' }, '打球の質（インプレー打球ベース）'));
  box.append(kv([
    ['Barrel%', pct(m.barrelPct)], ['HardHit%', pct(m.hardHitPct)], ['SwSpot%', pct(m.sweetSpotPct)],
    ['平均EV', m.evAvg ? m.evAvg.toFixed(0) : '-'], ['最大EV', m.evMax ? m.evMax.toFixed(0) : '-'],
  ]));
  box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, '打球タイプ / 方向（対 全打球）'));
  box.append(kv([
    ['GB%', pct(m.gbPct)], ['LD%', pct(m.ldPct)], ['FB%', pct(m.fbPct)], ['PU%', pct(m.puPct)],
    ['引張%', pct(m.pullPct)], ['中%', pct(m.centPct)], ['流し%', pct(m.oppoPct)],
  ]));
  const arr = state.res.spray && state.res.spray.get(playerId);
  if (arr && arr.length) {
    box.append(el('div', { class: 'sprayrow' }, [
      el('div', { class: 'spraywrap' }, [el('div', { class: 'muted' }, `スプレー（${arr.length}打球）`), sprayChart(arr)]),
      el('div', { class: 'spraywrap' }, [el('div', { class: 'muted' }, 'EV / LA 分布（横=角度 縦=球速）'), evLaChart(arr)]),
    ]));
  } else {
    box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, '打球データなし'));
  }
}

// スプリットタブ: 対左/対右・得点圏(RISP)・ホーム/ビジター
function renderModalSplits(box, s) {
  const sp = battingSplits(s);
  const rows = [['対左投', sp.vsL], ['対右投', sp.vsR], ['得点圏', sp.risp], ['ホーム', sp.home], ['ビジター', sp.away]]
    .map(([label, x]) => el('tr', {}, [td(label, 'left'), td(x.pa), td(fmt3(x.avg)), td(fmt3(x.obp)), td(fmt3(x.slg)), td(fmt3(x.ops)), td(x.hr)]));
  box.append(el('div', { class: 'muted' }, '状況別成績（スプリット）'));
  box.append(table(['状況', '打席', '打率', '出塁', '長打', 'OPS', '本'], rows));
}

// 文脈タブ: WPA/RE24/Clutch/LI（§B2。context有効シーズンで非0）
function renderModalContext(box, s, isPitcher) {
  const m = isPitcher ? playerPitching(s, state.lc, state.cfg) : playerBatting(s, state.lc);
  box.append(el('div', { class: 'muted' }, '文脈指標（勝利確率ベース）'));
  if (isPitcher) {
    box.append(kv([
      ['WPA', signed(m.wpa)], ['RE24', signed(m.re24)], ['Clutch', signed(m.clutch)],
      ['pLI', m.pLI.toFixed(2)], ['gmLI', m.gmLI.toFixed(2)], ['WPA/LI', signed(m.wpaLI)],
      ['SD', m.sd], ['MD', m.md],
    ]));
  } else {
    box.append(kv([
      ['WPA', signed(m.wpa)], ['RE24', signed(m.re24)], ['Clutch', signed(m.clutch)],
      ['aLI', m.aLI.toFixed(2)], ['WPA/LI', signed(m.wpaLI)],
    ]));
  }
  box.append(el('div', { class: 'muted', style: 'margin-top:6px' },
    'WPA=勝利確率の増減の累計 / RE24=得点期待値ベースの貢献 / LI=場面の重要度(平均1.0) / Clutch=場面の重みを除いた勝負強さ'));
}

// 守備成分タブ: UZR分解 RngR/ErrR/ARM/DPR/rSB/framing ＋素データ（§B3b）
function renderModalField(box, s) {
  const pf = playerFielding(s, state.cfg, state.lc);
  box.append(el('div', { class: 'muted' }, `守備成分（主位置 ${pf.pos || '-'}・UZR分解）`));
  box.append(kv([
    ['RngR', signed(pf.rngR)], ['ErrR', signed(pf.errR)], ['ARM', signed(pf.arm)], ['DPR', signed(pf.dpr)],
    ['rSB', signed(pf.rSB)], ['Frame', signed(pf.framing)], ['合計', signed(pf.total)],
  ]));
  box.append(el('div', { class: 'muted', style: 'margin-top:6px' }, '素データ'));
  box.append(kv([
    ['送球機会', pf.armOpp], ['併殺機会', pf.dpOpp], ['併殺成立', pf.dpTurned], ['許盗塁', pf.sbAllowed], ['刺盗', pf.csMade],
  ]));
  box.append(el('div', { class: 'muted', style: 'margin-top:6px' },
    'RngR=範囲 / ErrR=失策 / ARM=外野送球 / DPR=併殺 / rSB=捕手盗塁阻止 / Frame=捕手フレーミング（対リーグ平均run）'));
}

// 投球タブ（投手）: 守備非依存・技術ベースの指標＋被打球
function renderModalPitch(box, s) {
  const m = playerPitching(s, state.lc, state.cfg);
  box.append(el('div', { class: 'muted' }, '投球指標（守備非依存・技術ベース）'));
  box.append(kv([
    ['FIP', f2(m.fip)], ['xFIP', f2(m.xfip)], ['SIERA', f2(m.siera)], ['kwERA', f2(m.kwera)],
    ['K-BB%', pct(m.kbbPct)], ['WHIP', f2(m.whip)], ['LOB%', pct(m.lobPct)], ['QS', m.qs],
  ]));
  // パーク補正版 ERA-/FIP-（D2・§11.2）: 100=リーグ平均・低いほど良い。球場個性を除いた実力。
  box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, '球場補正（100=平均・低いほど良い）'));
  box.append(kv([
    ['ERA-', m.eraMinus.toFixed(0)], ['ERA-PF', m.eraMinusPF.toFixed(0)],
    ['FIP-', m.fipMinus.toFixed(0)], ['FIP-PF', m.fipMinusPF.toFixed(0)],
  ]));
  box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, '被打球（インプレー割合）・被本塁打'));
  box.append(kv([
    ['GB%', pct(m.gbPct)], ['LD%', pct(m.ldPct)], ['FB%', pct(m.fbPct)], ['PU%', pct(m.puPct)], ['HR/FB', pct(m.hrFbPct)],
  ]));
}

// 経歴タブ（C4・キャリアモード専用）: 二つ名＋年度別成績表＋受賞履歴＋成長曲線SVG。
//   すべて "観測成績/受賞（=観測ベース選定）" から組む（trueAbility 非露出＝三層構造）。
function renderModalCareer(box, p, isPitcher) {
  const gs = game.gs;
  const cs = gs.careerStats.filter((s) => s.playerId === p.id).slice().sort((a, b) => a.season - b.season);
  const nick = nicknameFor(p, gs.careerStats, gs.cfg);
  box.append(el('div', { class: 'nickname' }, [el('span', { class: 'nickmark' }, '二つ名'), el('span', { class: 'nicktext' }, `「${nick}」`)]));
  // 年度別成績表（当年は rt からも見えるが、careerStats は完了年ぶん＝確定値）。
  //   WAR は「その年のリーグ全体」から導いた定数で評価する（単一選手からの導出は歪むため）。
  const lcCache = new Map();
  const lcForYear = (year) => {
    if (lcCache.has(year)) return lcCache.get(year);
    const ps = gs.careerStats.filter((s) => s.season === year);
    const hist = gs.teamHistory.find((h) => h.year === year);
    const standings = hist ? hist.standings : [{ teamId: p.teamId, rs: 1, g: 1 }];
    const lc = deriveLeagueConstants({ playerSeasons: ps, standings });
    lcCache.set(year, lc);
    return lc;
  };
  const yearRows = cs.map((s) => yearStatRow(s, p, isPitcher, lcForYear(s.season)));
  // F2-4: 二軍（ファーム）の年度別成績行（careerFarmStats・一軍と分離永続）。同年は一軍行→二軍行の順。
  const farmRows = gs.careerFarmStats
    .filter((s) => s.playerId === p.id)
    .slice()
    .sort((a, b) => a.season - b.season)
    .map((s) => yearStatRow(s, p, isPitcher, lcForYear(s.season), '二軍'));
  const allRows = [...yearRows, ...farmRows].sort((a, b) => a.season - b.season || (a.mil === '一軍' ? -1 : 1) - (b.mil === '一軍' ? -1 : 1));
  if (allRows.length) {
    box.append(el('div', { class: 'muted', style: 'margin-top:10px' }, '年度別成績（一軍/二軍）'));
    const head = isPitcher
      ? ['年', '球団', '軍', '登板', '勝', '敗', 'S', '防御率', 'WAR']
      : ['年', '球団', '軍', '打席', '打率', '本', '点', '盗', 'WAR'];
    box.append(table(head, allRows.map((r) => el('tr', {}, r.cells.map((c, i) => td(c, i === 1 ? 'left' : ''))))));
    // 成長曲線は一軍WARのみ（二軍はリーグ水準が異なりWAR非表示・混ぜると曲線が歪む）。
    if (yearRows.length) box.append(growthCurveSVG(yearRows));
  } else {
    box.append(el('div', { class: 'muted', style: 'margin-top:10px' }, '完了シーズンの成績はまだありません（今季進行中）。'));
  }
  // 時代補正「+指標」（D3・§11.3「記録の文脈」）: 各年の記録をその年のリーグ環境で正規化し
  //   PA/IP 加重で通算平均。打高時代の.320と投高時代の.290が同価値に揃う（生成績の時代インフレ補正）。
  const eraAdj = careerEraPlus(p.id, { careerStats: gs.careerStats, teamHistory: gs.teamHistory, playersById: allPlayersById(gs), cfg: gs.cfg });
  if (eraAdj.seasons > 0) {
    box.append(el('div', { class: 'muted', style: 'margin-top:10px' }, `時代補正 +指標（通算${eraAdj.seasons}季・PA/IP加重・100=各年リーグ平均）`));
    box.append(kv(isPitcher
      ? [['通算ERA-', eraAdj.eraMinus != null ? eraAdj.eraMinus.toFixed(0) : '-'], ['通算FIP-', eraAdj.fipMinus != null ? eraAdj.fipMinus.toFixed(0) : '-']]
      : [['通算wRC+', eraAdj.wrcPlus != null ? eraAdj.wrcPlus.toFixed(0) : '-']]));
    box.append(el('div', { class: 'muted', style: 'margin-top:4px' },
      isPitcher ? '低いほど良い。打高/投高時代を跨いで防御の実力を同じ物差しで比較できる。'
        : '100=平均。打高時代の記録は割り引かれ、時代を跨いだ打撃実力を公平に比較できる。'));
  }
  // 受賞履歴（全年の表彰を再計算して収集）。全時代byId＝引退した真の受賞者を過去年の再計算から
  // 落とさない（現役のみだと過去年の表彰が現役選手へ誤帰属する・C4検証修正）。
  const hist = playerAwardHistory(p.id, { careerStats: gs.careerStats, teamHistory: gs.teamHistory, playersById: allPlayersById(gs), cfg: gs.cfg });
  box.append(el('div', { class: 'muted', style: 'margin-top:10px' }, '受賞履歴'));
  if (hist.length) {
    box.append(el('div', { class: 'awardlist' }, hist.map((a) => el('div', { class: 'awardrow' }, [
      el('span', { class: 'awardyear' }, `${a.year}`),
      el('span', { class: 'awardbadge' }, a.label + (a.pos ? `（${posJP(a.pos)}）` : '')),
    ]))));
  } else {
    box.append(el('div', { class: 'muted' }, 'まだ受賞はありません。'));
  }
  // H1-2: ライバル・因縁（トレード相手/FA・戦力外の旧所属/同年同round指名の同期）。
  const rivals = rivalriesOf(gs, p.id);
  box.append(el('div', { class: 'muted', style: 'margin-top:10px' }, 'ライバル・因縁'));
  box.append(rivals.length
    ? el('div', { class: 'awardlist' }, rivals.map((r) => el('div', { class: 'awardrow' }, rivalryParts(r))))
    : el('div', { class: 'muted' }, '記録された因縁関係はありません。'));
}

/** H1-2: 1件の因縁関係をモーダル用の要素列へ（playerLink付き）。 */
function rivalryParts(r) {
  if (r.type === 'trade') {
    return [`${r.year}年トレード: `, playerLink(r.otherPlayerId), ` と交換で ${tname(r.oldTeamId)} → ${tname(r.newTeamId)}`];
  }
  if (r.type === 'faOld') return [`${r.year}年FA移籍: ${tname(r.oldTeamId)} → ${tname(r.newTeamId)}（古巣は${tname(r.oldTeamId)}）`];
  if (r.type === 'pickupOld') return [`${r.year}年戦力外→拾い上げ: ${tname(r.oldTeamId)} → ${tname(r.newTeamId)}`];
  if (r.type === 'draftmate') return [`${r.year}年ドラフト${r.round}巡目の同期: `, playerLink(r.otherPlayerId), `（${tname(r.matchTeamId)}）`];
  return [];
}

/**
 * 年度別成績1行（表示セル＋WAR数値）を作る。lc は各年のリーグ全体の観測から導出済みを渡す。
 * F2-4: mil='二軍' の行は careerFarmStats 由来＝WARは非表示（二軍リーグは水準が異なるため。
 * 率系（防御率/打率）は lc 非依存＝そのまま正しい）。
 */
function yearStatRow(s, p, isPitcher, lc, mil = '一軍') {
  const ev = evalSeason(s, p, game.gs.cfg, lc);
  const team = state.teamName.get(s.teamId) || s.teamId;
  const warCell = mil === '一軍' && Number.isFinite(ev.war) ? ev.war.toFixed(1) : '-';
  const cells = isPitcher
    ? [String(s.season), team, mil, ev.g, ev.w, ev.l, ev.sv, Number.isFinite(ev.era) ? f2(ev.era) : '-', warCell]
    : [String(s.season), team, mil, ev.pa, Number.isFinite(ev.avg) ? fmt3(ev.avg) : '-', ev.hr, ev.rbi, ev.sb, warCell];
  return { cells, war: ev.war, season: s.season, mil };
}

/** 成長曲線（年度別WARの折れ線・SVG）。0基準線＋WAR点を結ぶ。 */
function growthCurveSVG(yearRows) {
  const W = 280, H = 90, pad = 18;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'growth' });
  const wars = yearRows.map((r) => r.war);
  const maxW = Math.max(3, ...wars);
  const minW = Math.min(0, ...wars);
  const span = maxW - minW || 1;
  const x = (i) => pad + (yearRows.length <= 1 ? (W - 2 * pad) / 2 : (i / (yearRows.length - 1)) * (W - 2 * pad));
  const y = (v) => H - pad - ((v - minW) / span) * (H - 2 * pad);
  const zeroY = y(0);
  svg.append(svgEl('line', { x1: pad, y1: zeroY, x2: W - pad, y2: zeroY, stroke: '#2f6b4a', 'stroke-dasharray': '3 3' }));
  if (yearRows.length > 1) {
    const pts = yearRows.map((r, i) => `${x(i).toFixed(1)},${y(r.war).toFixed(1)}`).join(' ');
    svg.append(svgEl('polyline', { points: pts, fill: 'none', stroke: '#e8b84b', 'stroke-width': '2' }));
  }
  yearRows.forEach((r, i) => svg.append(svgEl('circle', { cx: x(i), cy: y(r.war), r: 3, fill: r.war >= 0 ? '#7bc47f' : '#c96a5a' })));
  svg.append(svgText({ x: pad, y: 12, fill: '#9fb8ac', 'font-size': '10' }, '成長曲線（年度別WAR）'));
  return svg;
}

function kv(pairs) {
  return el('div', { class: 'kvgrid' }, pairs.map(([k, v]) => el('div', { class: 'kv' }, [el('div', { class: 'kvk' }, k), el('div', { class: 'kvv' }, String(v))])));
}

function abilityBars(t, role) {
  const groups = [];
  const bar = (label, val) => el('div', { class: 'barrow' }, [
    el('span', { class: 'barlabel' }, label),
    el('span', { class: 'bartrack' }, [el('span', { class: 'barfill', style: `width:${((val - 20) / 60) * 100}%;background:${barColor(val)}` })]),
    el('span', { class: 'barval' }, String(Math.round(val))),
  ]);
  const c = t.common;
  groups.push(section('共通', [bar('走力', c.speed), bar('肩', c.arm), bar('確実', c.hands), bar('反応', c.reaction), bar('パワー', c.power)]));
  if (role === 'pitcher') {
    const p = t.pitching;
    groups.push(section('投手', [bar('球速km/h', p.velocityKmh), bar('制球', p.control), bar('スタミナ', p.stamina), bar('ゴロ率', p.gbRate), bar('クイック', p.hold)]));
    groups.push(section('球種', p.pitches.map((pi) => bar(pitchName(pi.type), pi.current))));
  } else {
    const b = t.batting;
    groups.push(section('打撃', [bar('EV適性', b.ev), bar('LA適性', b.la), bar('引張', b.pull), bar('コンタクト', b.contact), bar('選球眼', b.eye)]));
    groups.push(section('走塁', [bar('盗塁技術', t.baserunning.steal), bar('走塁IQ', t.baserunning.baserunIQ)]));
    groups.push(section('守備', [bar('ポジIQ', t.fielding.positioningIQ), bar('捕手F', t.fielding.framing)]));
  }
  return el('div', { class: 'abilities' }, groups);
}
function section(title, bars) { return el('div', { class: 'abgroup' }, [el('div', { class: 'abtitle' }, title), ...bars]); }
function barColor(v) { return v >= 70 ? '#e8b84b' : v >= 55 ? '#7bc47f' : v >= 45 ? '#cfc8b0' : '#9a8f78'; }

// --- コーチの見立て（キャリアモード・三層構造 layer3）------------------------------
// trueAbility（隠し値）を直接は出さず、scoutSeed 由来の決定論ノイズを乗せた「観測推定」を
// 粗い等級（S/A/B/C/D/E）で示す。ノイズは軸ごと固定シード＝同じ選手を何度開いても同じ見立て。
// 真値そのものは表示しない（バー幅も推定値ベース）。§1「合わせるのは分布」/ phaseC_spec 禁則。
const SCOUT_GRADES = [[70, 'S'], [63, 'A'], [56, 'B'], [48, 'C'], [40, 'D']];
function scoutGrade(v) { for (const [th, g] of SCOUT_GRADES) if (v >= th) return g; return 'E'; }
function scoutBars(p) {
  const t = p.trueAbility;
  const role = p.role;
  const cl20 = (x) => Math.max(20, Math.min(80, x));
  const sd = (state.cfg?.tuning?.mgr?.scoutSd ?? 5) * 1.4; // 見立ては真値より粗い（観測誤差）
  const seed = p.scoutSeed ?? hashSeed(p.id, 'scout');
  // 軸ごとに固定シードで一度だけ誤差を引く（決定論・開くたびに同じ等級）。
  const obs = (key, v) => cl20(v + makeRng(hashSeed(seed, 'coachView', key)).normal(0, sd));
  const bar = (label, key, val) => {
    const v = obs(key, val);
    const g = scoutGrade(v);
    return el('div', { class: 'barrow' }, [
      el('span', { class: 'barlabel' }, label),
      el('span', { class: 'bartrack' }, [el('span', { class: 'barfill', style: `width:${((v - 20) / 60) * 100}%;background:${barColor(v)}` })]),
      el('span', { class: 'barval' }, g),
    ]);
  };
  const c = t.common;
  const groups = [section('共通', [bar('走力', 'speed', c.speed), bar('肩', 'arm', c.arm), bar('確実', 'hands', c.hands), bar('反応', 'reaction', c.reaction), bar('パワー', 'power', c.power)])];
  if (role === 'pitcher') {
    const pi = t.pitching;
    const veloR = cl20(50 + (pi.velocityKmh - 146) * 2); // 球速は等級用にrating換算（実km/hは伏せる）
    groups.push(section('投手', [bar('球速', 'velo', veloR), bar('制球', 'control', pi.control), bar('スタミナ', 'stamina', pi.stamina), bar('ゴロ率', 'gbRate', pi.gbRate), bar('クイック', 'hold', pi.hold)]));
    groups.push(section('球種', pi.pitches.map((x, i) => bar(pitchName(x.type), 'pitch' + i, x.current))));
  } else {
    const b = t.batting;
    groups.push(section('打撃', [bar('EV適性', 'ev', b.ev), bar('LA適性', 'la', b.la), bar('引張', 'pull', b.pull), bar('コンタクト', 'contact', b.contact), bar('選球眼', 'eye', b.eye)]));
    groups.push(section('走塁', [bar('盗塁技術', 'steal', t.baserunning.steal), bar('走塁IQ', 'brIQ', t.baserunning.baserunIQ)]));
    groups.push(section('守備', [bar('ポジIQ', 'posIQ', t.fielding.positioningIQ), bar('捕手F', 'framing', t.fielding.framing)]));
  }
  return el('div', { class: 'abilities' }, groups);
}

// --- スプレーチャート SVG（1-8, Lv2）--------------------------------------
function sprayChart(balls) {
  const W = 320; const H = 300; const hx = W / 2; const hy = H - 24; const scale = (H - 40) / 135;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spray' });
  // 内野・外野の目安円 + フェンス弧
  const pt = (deg, dist) => {
    const r = (deg * Math.PI) / 180;
    return [hx + dist * scale * Math.sin(r), hy - dist * scale * Math.cos(r)];
  };
  // フェア地帯（ファウルライン ±45°）
  const [lx, ly] = pt(-45, 125); const [rx, ry] = pt(45, 125);
  svg.append(svgEl('path', { d: `M ${hx} ${hy} L ${lx} ${ly} A ${125 * scale} ${125 * scale} 0 0 1 ${rx} ${ry} Z`, fill: '#123d2a', stroke: '#2f6b4a' }));
  // 内野ダイヤ目安
  const [b2x, b2y] = pt(0, 38);
  svg.append(svgEl('circle', { cx: b2x, cy: b2y, r: 3, fill: '#c9a06a' }));
  // 打球ドット
  for (const b of balls) {
    const [x, y] = pt(b.sprayDeg, Math.min(b.distanceM, 130));
    svg.append(svgEl('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: b.result === 'HR' ? 3.2 : 2.2, fill: ballColor(b.result), opacity: 0.85 }));
  }
  svg.append(svgEl('circle', { cx: hx, cy: hy, r: 3, fill: '#fff' }));
  return svg;
}
function ballColor(res) { return res === 'HR' ? '#e8b84b' : res === '2B' || res === '3B' ? '#5aa9e6' : res === '1B' ? '#f4f1e6' : '#6d7f74'; }

// --- EV/LA 散布図 SVG（打球速度×角度・§B3 打球タブ）------------------------
// 横=打球角度(LA -20〜60°) 縦=打球速度(EV 80〜200km/h)。Barrel帯の目安として Sweet-Spot(8-32°)・
// HardHit(152km/h) のガイドを薄く描く。色は打球結果（HR=金/長打=青/単打=白/アウト=灰）。
function evLaChart(balls) {
  const W = 300; const H = 220; const padL = 30; const padB = 22; const top = 8; const right = 8;
  const laMin = -20; const laMax = 60; const evMin = 80; const evMax = 200;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'evla' });
  const plotW = W - padL - right; const plotH = H - top - padB;
  const xOf = (la) => padL + ((cl(la, laMin, laMax) - laMin) / (laMax - laMin)) * plotW;
  const yOf = (ev) => top + (1 - (cl(ev, evMin, evMax) - evMin) / (evMax - evMin)) * plotH;
  svg.append(svgEl('rect', { x: padL, y: top, width: plotW, height: plotH, fill: '#0c3122', stroke: '#2f6b4a' }));
  // Sweet-Spot 角度帯 8-32°（縦帯）
  svg.append(svgEl('rect', { x: xOf(8).toFixed(1), y: top, width: (xOf(32) - xOf(8)).toFixed(1), height: plotH, fill: '#1c4a34', opacity: 0.6 }));
  // HardHit 閾値 152km/h（横ガイド）
  svg.append(svgEl('line', { x1: padL, y1: yOf(152).toFixed(1), x2: (padL + plotW).toFixed(1), y2: yOf(152).toFixed(1), stroke: '#c9a06a', 'stroke-dasharray': '3 3', opacity: 0.6 }));
  for (const b of balls) {
    svg.append(svgEl('circle', { cx: xOf(b.laDeg).toFixed(1), cy: yOf(b.evKmh).toFixed(1), r: b.result === 'HR' ? 2.8 : 2, fill: ballColor(b.result), opacity: 0.8 }));
  }
  return svg;
}

// --- チーム集計タブ（打撃/投手/守備/走塁のリーグ内順位・§B3 UI）---------------
function teamAggregates() {
  const teamPS = new Map();
  for (const s of state.res.playerSeasons) {
    if (!teamPS.has(s.teamId)) teamPS.set(s.teamId, []);
    teamPS.get(s.teamId).push(s);
  }
  const standRow = new Map(state.res.standings.map((t) => [t.teamId, t]));
  const out = [];
  for (const [tid, list] of teamPS) {
    const bat = leagueBatting(list);
    const pit = leaguePitching(list);
    const ip = pit.ip;
    const fipRaw = ip ? (13 * pit.hr + 3 * (pit.bb - (pit.ibb || 0) + pit.hbp) - 2 * pit.so) / ip : 0;
    const fip = ip ? fipRaw + (state.lc.fipConstant || 0) : 0;
    let uzr = 0; let bsr = 0; let e = 0; let sb = 0; let cs = 0;
    for (const s of list) {
      uzr += uzrRuns(s, state.cfg, state.lc);
      bsr += playerBaserunning(s, state.cfg, state.lc).bsr;
      e += s.fielding.e || 0;
      sb += s.batting.sb || 0;
      cs += s.batting.cs || 0;
    }
    const st = standRow.get(tid);
    out.push({
      id: tid, name: state.teamName.get(tid) || tid, league: st ? st.league : null,
      rs: st ? st.rs : 0, ra: st ? st.ra : 0,
      avg: bat.avg, obp: bat.obp, slg: bat.slg, ops: bat.ops, hr: bat.hr, sb, cs,
      era: pit.era, fip, whip: pit.whip, kPer9: ip ? (pit.so * 9) / ip : 0, so: pit.so,
      uzr, e, bsr,
    });
  }
  return out;
}

const TEAM_CATS = [
  { title: '打撃', sort: 'rs', asc: false, dec3: ['avg', 'obp', 'slg', 'ops'],
    cols: [['name', '球団', 'left'], ['rs', '得点'], ['avg', '打率'], ['obp', '出塁'], ['slg', '長打'], ['ops', 'OPS'], ['hr', '本'], ['sb', '盗塁']] },
  { title: '投手', sort: 'era', asc: true, dec3: [],
    cols: [['name', '球団', 'left'], ['ra', '失点'], ['era', '防御'], ['fip', 'FIP'], ['whip', 'WHIP'], ['kPer9', 'K/9'], ['so', '奪三']] },
  { title: '守備', sort: 'uzr', asc: false, dec3: [],
    cols: [['name', '球団', 'left'], ['uzr', 'ΣUZR'], ['e', '失策']] },
  { title: '走塁', sort: 'bsr', asc: false, dec3: [],
    cols: [['name', '球団', 'left'], ['bsr', 'ΣBsR'], ['sb', '盗塁'], ['cs', '盗塁死']] },
];

function renderTeams(c) {
  const rows = teamAggregates();
  const byLg = new Map();
  for (const r of rows) { const k = r.league ?? 'ALL'; if (!byLg.has(k)) byLg.set(k, []); byLg.get(k).push(r); }
  const leagues = (state.cfg.league.leagues ?? []).length ? state.cfg.league.leagues : [{ id: 'ALL', name: '総合' }];
  c.append(el('div', { class: 'muted', style: 'margin:4px 0' }, 'チーム集計（各リーグ内順位）。数値の意味は列見出しにカーソルで表示。'));
  const teamCell = (k, v, dec3) => {
    if (typeof v !== 'number') return v;
    if (dec3.includes(k)) return fmt3(v);
    if (k === 'era' || k === 'fip' || k === 'whip' || k === 'kPer9') return v.toFixed(2);
    if (k === 'uzr' || k === 'bsr') return (v > 0 ? '+' : '') + v.toFixed(1);
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(1);
  };
  for (const cat of TEAM_CATS) {
    c.append(el('h3', { class: 'leaguename' }, `チーム${cat.title}`));
    for (const l of leagues) {
      const list = (byLg.get(l.id) || []).slice().sort((a, b) => (cat.asc ? a[cat.sort] - b[cat.sort] : b[cat.sort] - a[cat.sort]));
      if (!list.length) continue;
      const headers = ['順', ...cat.cols.map(([, label]) => label)];
      const trs = list.map((r, i) => el('tr', {}, [
        td(i + 1),
        ...cat.cols.map(([k, , align]) => td(teamCell(k, r[k], cat.dec3), align)),
      ]));
      c.append(el('h4', { class: 'teamsub' }, l.name));
      c.append(teamTable(headers, cat.cols, trs));
    }
  }
}

// チーム表（ヘッダにツールチップ・§B3 初心者配慮）。cols は [key,label,align]。
function teamTable(headers, cols, rows) {
  const head = el('tr', {}, [el('th', {}, headers[0]), ...cols.map(([k, label, align]) =>
    el('th', { class: align || '', title: TIP[k === 'uzr' ? 'uzrTeam' : k] || '' }, label))]);
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [el('thead', {}, head), el('tbody', {}, rows)])]);
}

// --- 小物 -----------------------------------------------------------------
function td(v, align) { return el('td', { class: align || '' }, String(v)); }
function table(headers, rows) {
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows),
  ])]);
}
function svgEl(tag, attrs) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
  return e;
}
function primaryPos(p) {
  if (!p || p.role === 'pitcher') return 'P';
  let mp = ''; let mx = -1;
  const pp = p.trueAbility.fielding.positionProf;
  for (const k of Object.keys(pp)) if (pp[k] > mx) { mx = pp[k]; mp = k; }
  return mp;
}
function pitchName(t) {
  return { fastball: '直球', slider: 'スラ', curve: 'カーブ', changeup: 'チェンジ', fork: 'フォーク', sinker: 'シンカー', cutter: 'カット' }[t] || t;
}
/** 利き手の表示（S4: 選手モーダルの「右投左打」等。S=両打/両投） */
function handLabel(h) {
  return { R: '右', L: '左', S: '両' }[h] || h || '?';
}

/**
 * 選手名リンク（E1・導線の全画面化）: クリックで選手詳細モーダルを開く共通ヘルパー。
 * byId に居ない選手（引退者など・モーダルを組めない）は素のテキストで返す。
 * 行クリックと入れ子になる場所でも使えるよう stopPropagation する。
 */
function playerLink(id, label) {
  const nm = label ?? pname(id);
  if (!state.byId.get(id)) return el('span', {}, String(nm));
  return el('span', {
    class: 'plink',
    onclick: (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); openModal(id); },
  }, String(nm));
}

// ============================================================================
// フェーズC1b: ゲームシェル（タイトル→ニューゲーム→シーズンハブ→観戦→リザルト）
//
// 設計原則（phaseC_spec）:
//   - エンジンとUIの分離: 進行/セーブは src/game/ のヘッドレスAPI（newGame/advanceDay/
//     advanceTo/save/load/setManagerProfile）に委譲し、本UIは「その状態を描く」ことに徹する。
//   - 三層構造: プレイヤーに真値は出さない（観測成績＋順位のみ）。育成/スカウトはC2。
//   - 決定論: 人間の采配は setManagerProfile が interventions ログに積み、save/load 再現される。
//   - 自己完結: SVG/CSSのみ・外部依存なし。観戦実況は onEvent（乱数非消費）の構造化イベントを言語化。
// ============================================================================

const game = {
  gs: null, // GameState（newGame/load の返値）
  watch: null, // 観戦中の { rec, events, idx, progressive, unit, auto, showBench }（E2: 進行単位/自動再生/折りたたみ）
  slots: {}, // セッション内セーブミラー（同期ロード用。永続は IndexedDB）
  bg: null, // 「シーズン終了まで」バックグラウンド進行の状態
};

// --- 小物（ゲーム層） -------------------------------------------------------
const pname = (id) => (state.byId.get(id) ? state.byId.get(id).name : id);
const tname = (id) => state.teamName.get(id) || id;
const posJP = (p) => (p === 'DH' ? 'DH' : p === 'P' ? '投' : p);

/** H1: storylines.mjs の見出し関数へ渡す名前解決束（pname/tname/leagueNameOfの共通ラップ）。 */
function storyNames() {
  return { pnameOf: pname, tnameOf: tname, leagueNameOf: (lid) => leagueNameOf(game.gs.cfg, lid) };
}

// 球団アクセントカラー（UI表示専用）は generate.mjs の TEAM_NAMES とペアで定義され、
// engine.mjs 経由で import 済み（TEAM_COLORS）。ここでは参照ヘルパーのみ。
const teamColor = (id) => TEAM_COLORS[tname(id)] || 'var(--clay)';
// G1a: 球団略称（スコアボード/狭幅テーブル用）。TEAM_ABBR は generate.mjs で TEAM_NAMES とペア定義済み。
const tabbr = (id) => TEAM_ABBR[tname(id)] || tname(id);
// ゲーム差の表記（首位行のみ「-」。同率2位の0.0や負のゲーム差はそのまま数値表示＝首位と区別する）
const gbText = (i, gb) => (i === 0 ? '-' : gb.toFixed(1));

/** ゲーム層の共有コンテキスト（stat 描画が参照する state.* をゲーム状態から張る）。 */
function bindGameContext(gs) {
  state.cfg = gs.cfg;
  state.league = gs.league;
  // E1: 育成（league.farm）も byId に含める＝二軍一覧・playerLink から名前解決/モーダルを開ける。
  state.byId = new Map([...gs.league.players, ...(gs.league.farm ?? [])].map((p) => [p.id, p]));
  state.teamName = new Map(gs.league.teams.map((t) => [t.id, t.name]));
}

/** 現在の順位表スナップショット（シーズン途中でも算出。finalizeStandings と同ロジック）。 */
function currentStandings(rt) {
  const rows = [...rt.standings.values()];
  return rows.slice().sort((a, b) => winPct(b) - winPct(a) || b.rs - b.ra - (a.rs - a.ra));
}

/** rt → 既存 stat 描画が食える res 形（§B2文脈は途中では未算出＝WPA/Clutch列は0で妥当）。 */
function resFromRt(rt) {
  const rows = currentStandings(rt);
  const byLg = {};
  for (const r of rows) {
    const k = r.league ?? 'ALL';
    (byLg[k] = byLg[k] || []).push(r);
  }
  return {
    season: rt.season,
    standings: rows,
    standingsByLeague: byLg,
    playerSeasons: [...rt.stats.stats.values()],
    statsById: rt.stats.stats,
    postseason: rt.finished ? rt.postseason : null,
    spray: new Map(),
    runSplit: rt.runSplit,
  };
}

/** stat タブ用に state.res/state.lc を張り直す（少データでも deriveLeagueConstants は動く）。 */
function refreshRes() {
  state.res = resFromRt(game.gs.rt);
  state.lc = deriveLeagueConstants(state.res);
}

// --- タイトル / ニューゲーム -------------------------------------------------
function renderTitle() {
  const root = document.getElementById('app');
  root.innerHTML = '';
  const keys = Object.keys(game.slots);
  const loadBtns = keys.map((k) =>
    el('button', { class: 'link', onclick: () => loadFromSlot(k) }, `ロード: ${slotLabel(k)}`),
  );
  root.append(
    el('div', { class: 'setup' }, [
      el('h2', {}, '⚾ 架空選手ペナント — キャリアモード'),
      el('p', { class: 'muted' }, '1球団の監督として、143試合＋ポストシーズンを戦います。観戦・采配・セーブに対応。'),
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', onclick: () => renderNewGame() }, '＋ ニューゲーム'),
        el('button', { class: 'link', onclick: () => initApp() }, '↺ クイックシミュレートに戻る'),
      ]),
      keys.length ? el('div', { class: 'row', style: 'flex-wrap:wrap' }, loadBtns) : el('div', { class: 'muted' }, '（このセッションのセーブはまだありません）'),
    ]),
  );
  // 別セッションのオートセーブが IndexedDB にあれば拾って「つづきから」を出す（非同期・任意）。
  idbList().then((recs) => {
    if (!recs.length) return;
    const bar = el('div', { class: 'row', style: 'flex-wrap:wrap' },
      recs.map((r) => el('button', { class: 'link', onclick: () => loadFromBlob(r.blob) }, `保存済み: ${slotLabel(r.key)}`)));
    document.getElementById('app').append(el('div', {}, [el('div', { class: 'muted', style: 'margin-top:10px' }, 'IndexedDB のセーブ:'), bar]));
  }).catch(() => {});
}

function renderNewGame() {
  const root = document.getElementById('app');
  root.innerHTML = '';
  const seedInput = el('input', { type: 'number', value: '20260701', id: 'gseed', style: 'width:120px' });
  // シード確定でリーグを一旦生成し、12球団から自チームを選ばせる
  const cfg = createConfig();
  let previewSeed = 20260701;
  let league = generateLeague(previewSeed, cfg);
  const grid = el('div', { class: 'teamgrid' });
  const drawTeams = () => {
    grid.innerHTML = '';
    for (const t of league.teams) {
      grid.append(el('button', { class: 'teamcard', onclick: () => startNewGame(previewSeed, t.id) }, [
        el('div', { class: 'tcname' }, t.name),
        el('div', { class: 'muted' }, `${leagueNameOf(cfg, t.league)}`),
      ]));
    }
  };
  drawTeams();
  const regen = el('button', {
    onclick: () => { previewSeed = Number(seedInput.value) || 20260701; league = generateLeague(previewSeed, cfg); drawTeams(); },
  }, 'このシードで球団を見る');
  root.append(
    el('div', { class: 'setup' }, [
      el('h2', {}, 'ニューゲーム — 自チームを選ぶ'),
      el('div', { class: 'row' }, [el('label', {}, 'シード: '), seedInput, regen, el('button', { class: 'link', onclick: () => renderTitle() }, '戻る')]),
      el('p', { class: 'muted' }, '球団カードをタップすると、その球団の監督としてキャリアを開始します。'),
      grid,
    ]),
  );
}

function leagueNameOf(cfg, lid) {
  const l = (cfg.league.leagues ?? []).find((x) => x.id === lid);
  return l ? `${l.name}（DH${l.dh ? '有' : '無'}）` : lid || '';
}

/**
 * H2: UIが作る/読み込む GameState は常に対話型ドラフト（config既定はfalse＝headless/既存テストは
 *   全自動不変・phaseH_fun_spec H2「cfg.game.interactiveDraft…ui.mjs の startNewGame だけが
 *   オーバーライドで true を渡す」）。startNewGame と loadFromBlob の両方がこれを使う
 *   （loadFromBlob が素の createConfig() を使うと、ドラフト中断中のセーブを読み込んだ際に
 *   interactiveDraft:false のまま driveOffseasonDraft が再駆動され、蓄積済みの指名ログが
 *   握りつぶされて全球団AI自動で完了してしまう＝中断状態が silently 失われるバグになる。
 *   src/game/index.mjs driveOffseasonDraft 側にも offseasonStage 起点の防御を入れてあるが、
 *   将来年度のドラフトも対話継続させるにはロード時点の cfg 自体を対話化しておく必要がある）。
 * SABER_CFG_OVERRIDES（smoke/デバッグ用の注入点。通常は空＝既定の config）の game.* が優先されるよう、
 *   トップレベルはオーバーライドを丸ごと展開しつつ game だけ手動で深くマージする
 *   （object spread は同名キーを丸ごと上書きするため、素朴な {...overrides} だと
 *   overrides.game が interactiveDraft:true を消してしまう）。
 */
function uiConfig() {
  const ov = globalThis.SABER_CFG_OVERRIDES ?? {};
  return createConfig({
    ...ov,
    game: { interactiveDraft: true, allowFiring: true, dynamicLineup: true, ...(ov.game ?? {}) },
    // H5-C: ファン関心→予算の連動は実プレイのみON（headless既定OFF＝多年較正の保護。config.mjs参照）
    tuning: { economy: { fan: { budgetFloorMult: 0.75, budgetSpanMult: 0.5 } }, ...(ov.tuning ?? {}) },
  });
}

function startNewGame(seed, teamId) {
  const cfg = uiConfig();
  const burnIn = cfg.game.burnInYears ?? 0;
  const root = typeof document !== 'undefined' ? document.getElementById('app') : null;
  // ローディング表示は実ブラウザでのみ（ヘッドレスの簡易DOMには replaceChildren が無い）。
  if (burnIn > 0 && typeof setTimeout === 'function' && root && typeof root.replaceChildren === 'function') {
    // ★R5 前史（burn-in）: 20年ぶんのシーズンを先に回すため十数秒かかる。同期実行だと画面が
    //   固まったまま無反応に見えるので、先にローディングを描いてから次のタスクで実行する。
    root.replaceChildren(
      el('section', { class: 'card' }, [
        el('h2', {}, 'リーグの歴史を生成しています'),
        el('p', { class: 'muted' }, `${burnIn}年ぶんのドラフト・成長・故障・引退のサイクルを回しています…`),
        el('p', { class: 'muted' }, '（この世界には通算記録・引退者・ドラフト史・故障歴が既に存在します）'),
      ]),
    );
    setTimeout(() => finishNewGame(seed, teamId, cfg, burnIn), 0);
    return;
  }
  finishNewGame(seed, teamId, cfg, burnIn);
}

function finishNewGame(seed, teamId, cfg, burnIn) {
  game.gs = newGame(seed >>> 0, teamId, { cfg, burnInYears: burnIn });
  bindGameContext(game.gs);
  // G5a: 成績タブの列グループ既定を「キャリアモード='basic'」に戻す（クイックシミュレート等で
  //   既に'all'へ初期化されていた場合の巻き戻り対策。次回 renderBatting/Pitching で再初期化される）。
  batColGroup = null;
  pitColGroup = null;
  // G5b: 順位表の詳細トグルも同様にキャリアモード既定(OFF)へ巻き戻す。
  standingsDetail = null;
  autoSave();
  renderHub();
}

// --- シーズンハブ -----------------------------------------------------------
// E4: タブ整理（phaseE_spec E4）: ホーム / チーム(E1) / 日程・結果 / 順位 / 成績（打・投・守・
// WAR・球団比較のサブタブ） / ニュース / 記録。現在地はタブの active 表示で常に分かる。
const HUB_TABS = [
  ['hub', 'ホーム'], ['team', 'チーム'], ['schedule', '日程・結果'], ['standings', '順位'],
  ['stats', '成績'], ['news', 'ニュース'], ['records', '記録'],
];
// 成績タブのサブタブ（E4: 打・投・守・WAR＋球団比較を1タブへ集約）。ビュー状態はUIローカル。
const HUB_STAT_SUBTABS = [
  ['batting', '打撃'], ['pitching', '投手'], ['fielding', '守備'], ['war', 'WAR'], ['teams', '球団比較'],
];
let hubStatsSub = 'batting';

function renderHub(tab = 'hub') {
  const gs = game.gs;
  const rt = gs.rt;
  const root = document.getElementById('app');
  root.innerHTML = '';
  const myName = tname(gs.playerTeamId);
  const myRow = rt.standings.get(gs.playerTeamId);
  const header = el('div', { class: 'header' }, [
    el('h2', {}, [
      // 自チーム色のチップ（チームカラーをUIの軸に＝スポナビのチームページ流）
      el('span', { style: `display:inline-block;width:6px;height:16px;border-radius:2px;background:${teamColor(gs.playerTeamId)};box-shadow:inset 0 0 0 1px rgba(0,0,0,.18);margin-right:7px;vertical-align:-2px` }),
      `${myName}　`, el('span', { class: 'muted' }, `${gs.year}年 / 第${pendingDayOf(rt)}節　${myRow.w}勝${myRow.l}敗${myRow.t}分`)]),
    el('div', { class: 'row' }, [
      // G4b: セーブ/ロードはヘッダー導線→overlayモーダル（ホームからは削除）
      el('button', { class: 'link', onclick: () => openSaveModal() }, '💾 セーブ'),
      el('button', { class: 'link', onclick: () => renderTitle() }, '≡ タイトル'),
      themeToggleBtn(),
    ]),
  ]);
  const bar = el('div', { class: 'tabs' }, HUB_TABS.map(([k, label]) =>
    el('button', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => renderHub(k) }, label)));
  const content = el('div', { id: 'content' });
  root.append(header, bar, content);
  if (tab === 'hub') renderHubHome(content);
  else if (tab === 'records') renderRecords(content);
  else if (tab === 'team') { refreshRes(); renderTeamTab(content, teamTabDeps()); } // E1: 自チーム選手一覧
  else if (tab === 'schedule') { refreshRes(); renderScheduleTab(content, scheduleDeps()); } // E4: 日程・結果
  else if (tab === 'news') { refreshRes(); renderNewsTab(content); } // E4: ニュース
  else if (tab === 'standings') { refreshRes(); renderStandings(content); }
  else if (tab === 'stats') { refreshRes(); renderStatsTab(content); } // E4: 成績（サブタブ集約）
  // G4a: 全タブ共通の進行フッター（固定下部・観戦画面の.watchctrlと同位置）。ラップdivで包まず root へ直接append
  //（G1aのposition:stickyのcontaining block問題の再発防止＝position:fixedも祖先のtransform等で無効化され得るため同様に注意）。
  const footerBtns = rt.finished
    ? [el('button', { class: 'primary', onclick: () => renderSeasonResult() }, 'シーズンリザルトへ')]
    : [
        el('button', { class: 'primary', onclick: () => showNextGameChoices() }, '▶ 次の試合へ'),
        el('button', { onclick: () => runAdvanceWithProgress('weekEnd') }, '1週間'),
        el('button', { onclick: () => runAdvanceWithProgress('monthEnd') }, '月末まで'),
        el('button', { onclick: () => runToSeasonEnd() }, 'シーズン終了まで'),
      ];
  root.append(el('div', { class: 'hubfooter' }, footerBtns));
  root.append(el('div', { class: 'hubspacer' }));
}

/** E4: 成績タブ（打・投・守・WAR・球団比較のサブタブ。既存の描画関数を再利用）。 */
function renderStatsTab(c) {
  c.append(el('div', { class: 'subtabs' }, [
    ...HUB_STAT_SUBTABS.map(([k, label]) =>
      el('button', {
        class: 'subtab' + (hubStatsSub === k ? ' active' : ''),
        onclick: () => { hubStatsSub = k; renderHub('stats'); },
      }, label)),
    // G10: 成績タブには現行「説明行」が無いため subtabs 行末尾に用語集導線を同居させる
    el('button', { class: 'link', onclick: () => renderGlossary() }, '📖 用語集'),
  ]));
  const body = el('div');
  c.append(body);
  if (hubStatsSub === 'war') renderWAR(body);
  else if (hubStatsSub === 'pitching') renderPitching(body);
  else if (hubStatsSub === 'fielding') renderFielding(body);
  else if (hubStatsSub === 'teams') renderTeams(body);
  else renderBatting(body);
}

/**
 * E4: src/ui/schedule.mjs（日程・結果タブ）へ渡すUI共有ヘルパー束（他の deps と同じ流儀）。
 */
function scheduleDeps() {
  return {
    el, td, state, game, tname, pname, playerLink, posJP, fmt3, pendingDayOf,
    renderHub: () => renderHub('schedule'),
  };
}

/**
 * E1: src/ui/team.mjs（チームタブ）へ渡すUI共有ヘルパー束。分割モジュールは ui.mjs の
 * ヘルパー/状態を import せず（バンドルの同一スコープで名前衝突・Node循環importを避ける）、
 * この deps オブジェクト経由で参照する。
 */
function teamTabDeps() {
  return {
    el, td, state, game, openModal, playerLink, posJP, primaryPos, scoutGrade,
    fmt3, pct, pendingDayOf,
    rerender: () => renderHub('team'),
    renderManagerPanel, // G4b: 采配パネルをチームタブの采配サブタブへ移設（呼び出し側で rerender を差し替える）
    gotoNews: () => renderHub('news'), // G4b: 離脱者サマリ「→ニュース」導線
  };
}

/** 進行が「次に処理する節」（1始まり表示）。 */
function pendingDayOf(rt) {
  const gi = rt.cursor;
  const d = gi < rt.schedule.length ? rt.schedule[gi].day : rt.finalDay + 1;
  return d + 1;
}

function renderHubHome(c) {
  const gs = game.gs;
  const rt = gs.rt;
  if (rt.finished) {
    c.append(el('div', { class: 'pspanel' }, [
      el('div', { class: 'pschamp' }, 'レギュラーシーズン終了'),
      el('button', { class: 'primary', onclick: () => renderSeasonResult() }, 'シーズンリザルトへ'),
    ]));
    return;
  }
  // G4a: 進行ボタンは全タブ共通の .hubfooter（renderHub 末尾）へ一本化。ここでは出さない。

  // 次戦カード（対戦カード化: 両チームの色チップ＋今季成績＝スポナビの試合カード流）
  const nextCard = nextPlayerCard(rt);
  if (nextCard) {
    const oppRow = rt.standings.get(nextCard.oppId);
    const myRow2 = rt.standings.get(gs.playerTeamId);
    const chip = (id) => el('span', {
      // 白系のチームカラー（白鷺等）が白面に沈まないよう薄い縁取りを足す
      style: `display:inline-block;width:10px;height:10px;border-radius:2px;background:${teamColor(id)};box-shadow:inset 0 0 0 1px rgba(0,0,0,.18);margin-right:6px;vertical-align:baseline`,
    });
    const rec = (r) => (r ? `${r.w}勝${r.l}敗${r.t}分` : '');
    c.append(el('div', { class: 'nextcard' }, [
      el('div', { class: 'muted' }, `次戦（第${nextCard.day + 1}節）${nextCard.isHome ? '　ホーム' : '　ビジター'}`),
      el('div', { class: 'nextmatch' }, [
        chip(gs.playerTeamId), `${tname(gs.playerTeamId)} `,
        el('span', { class: 'muted', style: 'font-size:12px' }, rec(myRow2)),
        el('span', { style: 'margin:0 8px;font-weight:400' }, nextCard.isHome ? 'vs' : '@'),
        chip(nextCard.oppId), `${tname(nextCard.oppId)} `,
        el('span', { class: 'muted', style: 'font-size:12px' }, rec(oppRow)),
      ]),
    ]));
  }

  // H5-B: フロントより（今季のオーナー目標＋信任メーター）。yearIndex>=1 のみ（1年目は目標なし）。
  if (gs.ownerGoals?.yearIndex === gs.yearIndex && gs.ownerGoals.goals.length) {
    const trust = gs.ownerTrust;
    const col = trust < 30 ? '#e0574a' : trust < 55 ? '#e8c93a' : '#5fd694';
    c.append(el('div', { class: 'card' }, [
      el('div', { class: 'muted' }, '📜 フロントより — 今季の目標'),
      ...gs.ownerGoals.goals.map((g) =>
        el('div', {}, `${g.priority === 'high' ? '【最重要】' : '【目標】'}${g.label}`)),
      el('div', { class: 'muted', style: 'margin-top:4px' }, [
        `オーナー信任 ${trust}/100 `,
        el('span', { style: `display:inline-block;width:80px;height:8px;background:var(--inset);border:1px solid var(--line);vertical-align:middle` }, [
          el('span', { style: `display:block;width:${Math.round(trust * 0.8)}px;height:8px;background:${col}` }),
        ]),
      ]),
    ]));
  }

  // ニュースフィード（C4・§54）: 自チームの直近成績から見出しをテンプレ生成（実データ差し込み）。
  renderNewsFeed(c);

  // G4b: 故障者リストはホームから削除（ニュースタブ・チームタブ冒頭の離脱者サマリに一本化＝三重表示の解消）。

  // 直近結果（自チーム直近5試合）
  const recent = rt.playerGameLog.slice(-5).reverse();
  if (recent.length) {
    c.append(el('h3', { class: 'leaguename' }, '直近の結果'));
    c.append(el('div', { class: 'recentlist' }, recent.map((g) => {
      const isHome = g.home === gs.playerTeamId;
      const my = isHome ? g.homeScore : g.awayScore;
      const opp = isHome ? g.awayScore : g.homeScore;
      const oppId = isHome ? g.away : g.home;
      const wl = g.tie ? '△' : my > opp ? '○' : '●';
      return el('div', { class: 'recentrow' }, [
        el('span', { class: 'wl wl' + (g.tie ? 't' : my > opp ? 'w' : 'l') }, wl),
        el('span', {}, `${isHome ? 'vs' : '@'} ${tname(oppId)}`),
        el('span', { class: 'score' }, `${my}-${opp}`),
      ]);
    })));
  }

  // ミニ順位表（自チームのリーグ）
  const rows = currentStandings(rt);
  const myLg = rt.standings.get(gs.playerTeamId).league;
  const lgRows = rows.filter((r) => r.league === myLg);
  const lgLeader = lgRows[0];
  c.append(el('h3', { class: 'leaguename' }, `${leagueNameOf(gs.cfg, myLg)} 順位`));
  c.append(table(['順', '球団', '勝', '敗', '分', '勝率', '差'], lgRows.map((t, i) => {
    // ゲーム差（NPB慣例の「差」＝首位との勝敗差の平均。以前は誤って得失点差を表示していた）
    const gb = gamesBehind(lgLeader, t);
    return el('tr', { class: t.teamId === gs.playerTeamId ? 'myteam' : '' }, [
      td(i + 1),
      el('td', { class: 'left', style: `border-left:3px solid ${teamColor(t.teamId)}` }, t.name),
      td(t.w), td(t.l), td(t.t), td(fmt3(winPct(t))), td(gbText(i, gb)),
    ]);
  })));

  // チーム状態（調子＝直近10試合の勝敗・疲労＝ブルペン可用の目安は省略しC2で拡張）
  const form = teamForm(rt, gs.playerTeamId);
  c.append(el('div', { class: 'teamstate' }, [
    el('span', { class: 'muted' }, '調子（直近10試合）: '),
    el('span', {}, form || '—'),
  ]));

  // G4b: 采配（チームタブの采配サブタブへ移設）・セーブ/ロード（ヘッダーの💾セーブ導線へ移設）は
  //   ここでは描かない。
}

// --- ニュースフィード（C4） --------------------------------------------------
function renderNewsFeed(c) {
  const gs = game.gs;
  const rt = gs.rt;
  const heads = weeklyDigest({
    gameLog: rt.playerGameLog,
    standings: currentStandings(rt),
    teamId: gs.playerTeamId,
    nameOf: (id) => tname(id),
  });
  // 今季のチーム注目選手（自チーム最高WAR・観測ベース）。序盤で試合が薄いと出ない。
  const star = teamSeasonStar(rt, gs.playerTeamId);
  // E1: 選手名は playerLink でモーダルへ（見出しは parts=要素列 or text=文字列のどちらでも描ける）。
  if (star) heads.unshift({ parts: [`${tname(gs.playerTeamId)}の今季の顔は `, playerLink(star.id), `（WAR ${star.war.toFixed(1)}・「${star.nick}」）`], cls: 'info' });
  // F2-4: 自チームの直近の昇格・降格（出場登録の入替・F2-3）を最大2件（playerLink 付き）。
  for (const m of (rt.rosterMoves ?? []).filter((x) => x.teamId === gs.playerTeamId).slice(-2).reverse()) {
    heads.push({ parts: rosterMoveParts(m), cls: 'info' });
  }
  // E4: 選手の活躍見出し（直近のボックススコア集計から・playerLink 付き）を上位2件だけホームにも出す。
  heads.push(...schedPlayerHeadlines(rt, scheduleDeps(), 2));
  // H1-2: 因縁の一戦（古巣に牙をむく等）は一番目を引くので1件だけホームにも出す。
  heads.push(...rivalryGameHeadlines(gs, storyNames(), 1).map((h) => ({ text: h.text, cls: h.cls })));
  c.append(el('h3', { class: 'leaguename' }, ['📰 ニュース　', el('button', { class: 'link', onclick: () => renderHub('news') }, '一覧へ →')]));
  if (!heads.length) {
    c.append(el('div', { class: 'newsfeed' }, [el('div', { class: 'newsrow info' }, 'シーズン序盤。見出しはこれから生まれます。')]));
    return;
  }
  // G4b: ホームは3件に絞る（全件は「一覧へ →」＝ニュースタブ）
  c.append(el('div', { class: 'newsfeed' }, heads.slice(0, 3).map((h) => el('div', { class: 'newsrow ' + (h.cls || 'info') }, h.parts || h.text))));
}

/**
 * E4: ニュースタブ本体。チームの週次ダイジェスト＋選手の活躍（直近試合のボックススコア集計）。
 * 見出しの選手名はすべて playerLink（→選手詳細モーダル）＝「ニュースから該当選手へ」の導線。
 */
function renderNewsTab(c) {
  const gs = game.gs;
  const rt = gs.rt;
  // チームニュース（週次ダイジェスト＋今季の顔）
  const heads = weeklyDigest({
    gameLog: rt.playerGameLog,
    standings: currentStandings(rt),
    teamId: gs.playerTeamId,
    nameOf: (id) => tname(id),
  });
  const star = teamSeasonStar(rt, gs.playerTeamId);
  if (star) heads.unshift({ parts: [`${tname(gs.playerTeamId)}の今季の顔は `, playerLink(star.id), `（WAR ${star.war.toFixed(1)}・「${star.nick}」）`], cls: 'info' });
  c.append(el('h3', { class: 'leaguename' }, '📰 チームニュース'));
  c.append(el('div', { class: 'newsfeed' }, heads.length
    ? heads.map((h) => el('div', { class: 'newsrow ' + (h.cls || 'info') }, h.parts || h.text))
    : [el('div', { class: 'newsrow info' }, 'シーズン序盤。見出しはこれから生まれます。')]));
  // H1-1: 今週の見どころ（タイトル争い・新人王レース・記録ペース・引退ロード候補）。
  const storylines = weeklyStorylineDigest(gs, storyNames());
  c.append(el('h3', { class: 'leaguename' }, '🏆 今週の見どころ'));
  c.append(el('div', { class: 'newsfeed' }, storylines.length
    ? storylines.map((h) => el('div', { class: 'newsrow ' + (h.cls || 'info') }, h.text))
    : [el('div', { class: 'newsrow info' }, '目立った争い・ペースはまだありません。')]));
  // 選手の活躍（直近試合の当日ライン＝rec.box 集計から。選手名クリックで詳細モーダル）
  const perf = schedPlayerHeadlines(rt, scheduleDeps(), 10);
  c.append(el('h3', { class: 'leaguename' }, '⚾ 選手の活躍（直近の試合から）'));
  c.append(el('div', { class: 'newsfeed' }, perf.length
    ? perf.map((h) => el('div', { class: 'newsrow ' + (h.cls || 'good') }, h.parts || h.text))
    : [el('div', { class: 'newsrow info' }, '直近の試合に目立った活躍はまだありません。')]));
  // H1-2: 因縁の一戦（古巣に牙をむく・トレード相手・同期指名との対戦で活躍した回）。
  const rivalryHeads = rivalryGameHeadlines(gs, storyNames(), 8);
  if (rivalryHeads.length) {
    c.append(el('h3', { class: 'leaguename' }, '🔥 因縁の一戦'));
    c.append(el('div', { class: 'newsfeed' }, rivalryHeads.map((h) => el('div', { class: 'newsrow ' + (h.cls || 'good') }, h.text))));
  }
  // F2-4: 昇格・降格（出場登録の入替・F2-3 rosterMoves）。自チーム優先＋リーグ全体の直近。
  //   選手名は playerLink（→詳細モーダル）。育成→支配下の昇格はオフシーズンダイジェストに出る
  //   （market.runMarket の判定＝シーズン中の入替はない・§12.1）。
  const allMoves = rt.rosterMoves ?? [];
  const myMoves = allMoves.filter((m) => m.teamId === gs.playerTeamId).slice(-6).reverse();
  const otherMoves = allMoves.filter((m) => m.teamId !== gs.playerTeamId).slice(-6).reverse();
  c.append(el('h3', { class: 'leaguename' }, '🔁 昇格・降格（出場登録の入替）'));
  const mvRows = [...myMoves, ...otherMoves].map((m) =>
    el('div', { class: 'newsrow ' + (m.teamId === gs.playerTeamId ? 'good' : 'info') },
      [`第${m.day + 1}節: `, ...rosterMoveParts(m)]));
  c.append(el('div', { class: 'newsfeed' }, mvRows.length ? mvRows
    : [el('div', { class: 'newsrow info' }, '出場登録の入替はまだありません（故障補充・25試合レビューの成績入替は2年目以降のシーズン中に発生します）。')]));
  // 故障者情報もニュースとして再掲（ホームと同じ判定・playerLink 付き）
  const curDay = pendingDayOf(rt) - 1;
  const injured = (rt.seasonInjuries ?? [])
    .filter((e) => e.teamId === gs.playerTeamId && e.gamesLost > curDay)
    .sort((a, b) => b.gamesLost - a.gamesLost);
  if (injured.length) {
    c.append(el('h3', { class: 'leaguename' }, '🏥 故障者情報'));
    c.append(el('div', { class: 'newsfeed' }, injured.map((e) => el('div', { class: 'newsrow bad' },
      [playerLink(e.id), `（${e.role === 'pitcher' ? '投' : posJP(e.primaryPos)}）が離脱中 — 復帰まで約${e.gamesLost - curDay}試合`]))));
  }
}

/**
 * F2-4: 昇降格ニュース1件の見出しパーツ（news.mjs rosterMoveHeadline と同文面＋playerLink 導線）。
 * mv = rt.rosterMoves / step.rosterMoves の1件（F2-3 logMove の形）。
 */
function rosterMoveParts(mv) {
  const t = tname(mv.teamId);
  if (mv.type === 'ilReplace') {
    return [`${t}、`, playerLink(mv.downId, mv.downName), `（${posJP(mv.downPos)}）が故障で登録抹消 — 二軍から`, playerLink(mv.upId, mv.upName), 'を昇格'];
  }
  if (mv.type === 'ilReturn') {
    return [`${t}、`, playerLink(mv.upId, mv.upName), `（${posJP(mv.upPos)}）が離脱から復帰し一軍登録（`, playerLink(mv.downId, mv.downName), 'は登録抹消）'];
  }
  if (mv.type === 'perfSwap') {
    return [`${t}、不振の`, playerLink(mv.downId, mv.downName), `（${posJP(mv.downPos)}）を登録抹消 — 二軍で好調の`, playerLink(mv.upId, mv.upName), 'を昇格'];
  }
  return [rosterMoveHeadline(mv, tname)]; // 未知タイプはエンジンの文面へフォールバック
}

/** 自チームの今季最高WAR選手（観測ベース）と二つ名。データが薄い序盤は null。 */
function teamSeasonStar(rt, teamId) {
  refreshRes();
  const gs = game.gs;
  let best = null;
  for (const s of rt.stats.stats.values()) {
    if (s.teamId !== teamId) continue;
    const p = state.byId.get(s.playerId);
    if (!p) continue;
    const ev = evalSeason(s, p, gs.cfg, state.lc);
    const played = p.role === 'pitcher' ? ev.ip >= 20 : ev.pa >= 80;
    if (!played) continue;
    if (!best || ev.war > best.war) best = { id: s.playerId, war: ev.war };
  }
  if (!best) return null;
  return { ...best, nick: nicknameFor(state.byId.get(best.id), gs.careerStats, gs.cfg) };
}

// --- 記録タブ（C4・球団史／リーグ記録／マイルストーン） -----------------------------
function renderRecords(c) {
  const gs = game.gs;
  // 全時代byId（現役＋引退者サマリ）: 引退選手を通算記録/マイルストーンから落とさない（C4検証修正）
  const byId = allPlayersById(gs);
  // 球団史（自チームの年度別順位・日本一）
  c.append(el('h3', { class: 'leaguename' }, `球団史 — ${tname(gs.playerTeamId)}`));
  const th = teamRecords(gs.teamHistory, gs.playerTeamId);
  if (th.length) {
    c.append(table(['年', '順位', '勝', '敗', '分', '日本一'], th.map((r) => el('tr', { class: r.champion ? 'myteam' : '' }, [
      td(r.year), td(r.rank + '位'), td(r.w), td(r.l), td(r.t), td(r.champion ? '🏆' : ''),
    ]))));
    const champs = championCounts(gs.teamHistory);
    const mine = champs.get(gs.playerTeamId) || 0;
    c.append(el('div', { class: 'muted', style: 'margin-top:4px' }, `通算日本一: ${mine}回`));
  } else {
    c.append(el('div', { class: 'muted' }, 'まだ完了したシーズンがありません（今季終了後に記録が刻まれます）。'));
  }
  // マイルストーン（当年に通算で跨いだ達成）: 直近完了年ぶんを表示。
  const lastYear = gs.teamHistory.length ? gs.teamHistory[gs.teamHistory.length - 1].year : null;
  if (lastYear != null) {
    const miles = milestones({ careerStats: gs.careerStats, playersById: byId, cfg: gs.cfg, year: lastYear });
    if (miles.length) {
      c.append(el('h3', { class: 'leaguename' }, `${lastYear}年 達成マイルストーン`));
      c.append(el('div', { class: 'awardlist' }, miles.map((m) => el('div', { class: 'awardrow' }, [
        el('span', { class: 'awardbadge' }, [playerLink(m.playerId, m.name), `　${m.category} ${m.threshold}${m.unit}到達（通算${m.total}）`]), // E1: 選手名→詳細
      ]))));
    }
  }
  // リーグ記録（シーズン/通算トップN）
  if (gs.careerStats.length) {
    const rec = leagueRecords({ careerStats: gs.careerStats, playersById: byId, cfg: gs.cfg });
    c.append(el('h3', { class: 'leaguename' }, 'リーグ記録（シーズン）'));
    c.append(recordColumns([
      ['本塁打', rec.seasonHR, (r) => `${r.value}（${r.year}）`],
      ['安打', rec.seasonH, (r) => `${r.value}（${r.year}）`],
      ['勝利', rec.seasonW, (r) => `${r.value}（${r.year}）`],
      ['奪三振', rec.seasonSO, (r) => `${r.value}（${r.year}）`],
    ]));
    c.append(el('h3', { class: 'leaguename' }, 'リーグ記録（通算）'));
    c.append(recordColumns([
      ['通算本塁打', rec.careerHR, (r) => `${r.value}`],
      ['通算安打', rec.careerH, (r) => `${r.value}`],
      ['通算勝利', rec.careerW, (r) => `${r.value}`],
      ['通算セーブ', rec.careerSV, (r) => `${r.value}`],
    ]));
  }
}

/** 記録のトップNを複数カラムで並べる（各カテゴリ縦リスト）。 */
function recordColumns(cats) {
  return el('div', { class: 'reccols' }, cats.map(([title, rows, fmt]) => el('div', { class: 'reccol' }, [
    el('div', { class: 'rechead' }, title),
    ...rows.slice(0, 10).map((r, i) => el('div', { class: 'recrow' }, [
      el('span', { class: 'recrank' }, `${i + 1}`),
      el('span', { class: 'recname' }, [playerLink(r.playerId, r.name)]), // E1: 選手名→詳細（引退者は素のテキスト）
      el('span', { class: 'recval' }, fmt(r)),
    ])),
    rows.length ? el('span', {}, '') : el('div', { class: 'muted' }, '—'),
  ])));
}

/** 自チームの次戦カードを探す（未消化 schedule から最初の自チーム試合）。 */
function nextPlayerCard(rt) {
  for (let gi = rt.cursor; gi < rt.schedule.length; gi++) {
    const g = rt.schedule[gi];
    if (g.home === game.gs.playerTeamId || g.away === game.gs.playerTeamId) {
      const isHome = g.home === game.gs.playerTeamId;
      const oppId = isHome ? g.away : g.home;
      return { day: g.day, isHome, oppId, text: `${isHome ? 'HOME vs' : 'AWAY @'} ${tname(oppId)}` };
    }
  }
  return null;
}

/** 直近10試合の勝敗を ○●△ で。 */
function teamForm(rt, teamId) {
  return rt.playerGameLog.slice(-10).map((g) => {
    const isHome = g.home === teamId;
    const my = isHome ? g.homeScore : g.awayScore;
    const opp = isHome ? g.awayScore : g.homeScore;
    return g.tie ? '△' : my > opp ? '○' : '●';
  }).join('');
}

// --- 采配介入パネル（監督プロファイル差し替え・§フェーズAフック） -----------------
const TEND_LEVELS = [['積極', 65], ['標準', 50], ['慎重', 35]];
const TEND_FIELDS = [['buntTend', 'バント'], ['stealTend', '盗塁'], ['ibbTend', '敬遠'], ['quickHook', '継投の早さ']];

// G4b: rerender は「このパネルを内包する画面をどう再描画するか」の再描画コールバック引数化
// （既定=renderHub()＝旧来のホーム呼び出しのまま）。チームタブの采配サブタブから呼ぶ場合は
// () => renderHub('team') 相当（teamTabDeps().rerender）を渡し、方針変更後もそのタブに留まらせる。
function renderManagerPanel(rerender = () => renderHub()) {
  const gs = game.gs;
  const box = el('div', { class: 'mgrpanel' });
  box.append(el('h3', { class: 'leaguename' }, '采配（監督方針・自チーム）'));
  const auto = gs.settings.autoManage;
  box.append(el('div', { class: 'row' }, [
    el('span', { class: 'muted' }, 'おまかせ（AI委任）: '),
    el('button', { class: auto ? 'primary' : '', onclick: () => { clearManagerProfile(gs); autoSave(); rerender(); } }, auto ? 'ON' : 'OFFにする→'),
    !auto ? el('span', { class: 'muted' }, '（人間が方針を上書き中）') : el('span', {}, ''),
  ]));
  // 現在有効な監督値（rt に反映済みの値）
  const cur = gs.rt.teamById.get(gs.playerTeamId).manager;
  for (const [field, label] of TEND_FIELDS) {
    const v = cur[field];
    box.append(el('div', { class: 'tendrow' }, [
      el('span', { class: 'tendlabel' }, label),
      ...TEND_LEVELS.map(([lvl, val]) => el('button', {
        class: 'tendbtn' + (Math.abs(v - val) <= 7 ? ' active' : ''),
        onclick: () => { setManagerProfile(gs, { [field]: val }); autoSave(); rerender(); },
      }, lvl)),
    ]));
  }
  box.append(el('div', { class: 'muted', style: 'margin-top:4px' }, '方針は次節以降の試合に反映され、セーブに介入ログとして残ります（再現可能）。'));
  return box;
}

// --- セーブ/ロード（IndexedDB＋セッションミラー） ------------------------------
// G4b: rerender は「保存後にこのパネルをどう再描画するか」の再描画コールバック引数化
// （既定=renderHub()。ヘッダーのセーブモーダルからは rebuildModalBody を渡し、
//  保存直後もモーダルを閉じずに「→ロードN」ボタンへ進めるようにする）。
function renderSavePanel(rerender = () => renderHub()) {
  const box = el('div', { class: 'savepanel' });
  box.append(el('h3', { class: 'leaguename' }, 'セーブ / ロード'));
  const row = el('div', { class: 'row', style: 'flex-wrap:wrap' });
  for (let n = 1; n <= 3; n++) {
    const key = 'slot' + n;
    row.append(el('button', { onclick: () => { saveToSlot(key); rerender(); } }, `スロット${n}に保存`));
    if (game.slots[key]) row.append(el('button', { class: 'link', onclick: () => loadFromSlot(key) }, `→ロード${n}`));
  }
  box.append(row);
  box.append(el('div', { class: 'muted' }, 'オートセーブは日次で IndexedDB に保存されます（localStorage不使用）。'));
  return box;
}

/**
 * G4b: ハブヘッダーの「💾 セーブ」→ overlayモーダルにセーブ/ロードパネルを表示する。
 * modalhead＋✕は選手モーダルと同じ流儀。rebuildModalBody は overlay を作り直さず
 * box の中身だけ再構築する＝renderHub() を呼ばないため、保存直後もモーダルが開いたままになり
 * 「→ロードN」ボタンへ進める（renderSavePanel の rerender 引数として渡す）。
 */
function openSaveModal() {
  const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const box = el('div', { class: 'modal' });
  box.append(el('div', { class: 'modalhead' }, [el('span', { class: 'pname' }, 'セーブ / ロード'), el('button', { class: 'link', onclick: () => overlay.remove() }, '✕')]));
  const body = el('div');
  box.append(body);
  const rebuildModalBody = () => {
    body.innerHTML = '';
    body.append(renderSavePanel(rebuildModalBody));
  };
  rebuildModalBody();
  overlay.append(box);
  document.getElementById('app').append(overlay);
}

/**
 * G10: 共通の用語集モーダル（TIP全項目のdt/dd列挙＋観戦の色凡例）。
 * タッチ端末では th の title 属性（ツールチップ）が出せないため、いつでも定義に到達できる導線として設ける。
 * overlay/modal は選手モーダル（openModal）・セーブモーダル（openSaveModal）と同じ流儀。
 */
function renderGlossary() {
  const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const box = el('div', { class: 'modal' });
  box.append(el('div', { class: 'modalhead' }, [el('span', { class: 'pname' }, '用語集・凡例'), el('button', { class: 'link', onclick: () => overlay.remove() }, '✕')]));
  const dl = el('dl', { class: 'glossarylist' });
  for (const k of Object.keys(TIP)) {
    // TIP の値は "指標名: 説明文" 形式（例: 'WAR: 打撃/走塁/守備/位置を...'）。
    // 内部キー(kbbPct等のcamelCase)をそのまま見出しに出さず、先頭の指標名を dt に、残りを dd に振り分ける。
    const sep = TIP[k].indexOf(': ');
    const label = sep >= 0 ? TIP[k].slice(0, sep) : k;
    const desc = sep >= 0 ? TIP[k].slice(sep + 2) : TIP[k];
    dl.append(el('dt', {}, label), el('dd', {}, desc));
  }
  box.append(dl);
  box.append(el('h4', { class: 'teamsub' }, '観戦の色凡例'));
  box.append(el('div', { class: 'glossarylegend' }, [
    el('div', { class: 'glossarysec' }, [
      el('div', { class: 'muted' }, '球判定'),
      el('div', { class: 'legendrow' }, [
        el('span', { class: 'legendchip pc-ball' }, 'ボール'),
        el('span', { class: 'legendchip pc-called' }, '見逃し'),
        el('span', { class: 'legendchip pc-whiff' }, '空振り'),
        el('span', { class: 'legendchip pc-foul' }, 'ファウル'),
        el('span', { class: 'legendchip pc-inplay' }, 'インプレー'),
      ]),
    ]),
    el('div', { class: 'glossarysec' }, [
      el('div', { class: 'muted' }, '結果'),
      el('div', { class: 'legendrow' }, [
        el('span', { class: 'legendchip ev-hit' }, '安打'),
        el('span', { class: 'legendchip ev-hr' }, 'HR・得点'),
        el('span', { class: 'legendchip ev-k' }, '三振'),
        el('span', { class: 'legendchip ev-bb' }, '四死球'),
        el('span', { class: 'legendchip ev-err' }, '失策'),
      ]),
    ]),
    el('div', { class: 'glossarysec' }, [
      el('div', { class: 'muted' }, 'ランプ（カウント）'),
      el('div', { class: 'legendrow' }, [
        el('span', { class: 'legendchip lamplegend lb' }, 'B（ボール）'),
        el('span', { class: 'legendchip lamplegend ls' }, 'S（ストライク）'),
        el('span', { class: 'legendchip lamplegend lo' }, 'O（アウト）'),
      ]),
    ]),
  ]));
  overlay.append(box);
  document.getElementById('app').append(overlay);
}

function slotLabel(key) {
  const rec = game.slots[key];
  if (key === 'auto') return 'オートセーブ';
  const n = key.replace('slot', '');
  return `スロット${n}` + (rec ? `（${rec.year}年 第${rec.day}節）` : '');
}

function saveToSlot(key) {
  const blob = save(game.gs);
  game.slots[key] = { blob, year: blob.year, day: (blob.seasonState ? blob.seasonState.cursor : 0) };
  idbPut(key, blob); // IndexedDB へ永続（非同期・失敗は無視）
}
function autoSave() { saveToSlot('auto'); }

function loadFromSlot(key) {
  const rec = game.slots[key];
  if (rec) loadFromBlob(rec.blob);
}
function loadFromBlob(blob) {
  game.gs = load(blob, { cfg: uiConfig() });
  bindGameContext(game.gs);
  // H2: ドラフト中断中のセーブは load() が driveOffseasonDraft を再駆動して同じ中断点
  //   （state.awaitingDraft）を再構築済み。rt.finished も true のままだが、advanceYear は
  //   awaitingDraft が立っている間は再度呼べない（throw）ため renderSeasonResult より先に判定する。
  if (game.gs.ownerPending) renderOwnerDecisionScreen(); // H5-B: 裁定待ちセーブの復元
  else if (game.gs.awaitingDraft) renderDraftRoomScreen(draftDeps());
  else if (game.gs.rt.finished) renderSeasonResult();
  else renderHub();
}

// IndexedDB 薄ラッパ（自己完結・indexedDB 不在環境（ヘッドレス）では no-op に落ちる）。
const IDB_NAME = 'saber_yakyuu';
const IDB_STORE = 'saves';
function idbDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no-indexeddb'));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(key, blob) {
  return idbDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })).catch(() => {});
}
function idbList() {
  return idbDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const out = [];
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { out.push({ key: cur.key, blob: cur.value }); cur.continue(); }
      else resolve(out);
    };
    req.onerror = () => reject(req.error);
  })).catch(() => []);
}

// --- 進行（観戦/ダイジェスト/スキップ） --------------------------------------
function showNextGameChoices() {
  const c = document.getElementById('content');
  // 既存ハブの上に選択オーバーレイを出す
  const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const box = el('div', { class: 'modal' });
  box.append(el('div', { class: 'modalhead' }, [el('span', { class: 'pname' }, '次の自チーム試合'), el('button', { class: 'link', onclick: () => overlay.remove() }, '✕')]));
  box.append(el('p', { class: 'muted' }, '観戦=1プレーずつ実況 / ダイジェスト=一括表示 / スキップ=結果のみ'));
  box.append(el('div', { class: 'row', style: 'flex-wrap:wrap' }, [
    el('button', { class: 'primary', onclick: () => { overlay.remove(); playNextPlayerGame('watch'); } }, '観戦'),
    el('button', { onclick: () => { overlay.remove(); playNextPlayerGame('digest'); } }, 'ダイジェスト'),
    el('button', { onclick: () => { overlay.remove(); playNextPlayerGame('skip'); } }, 'スキップ'),
  ]));
  overlay.append(box);
  document.getElementById('app').append(overlay);
}

function playNextPlayerGame(mode) {
  const gs = game.gs;
  const collect = mode !== 'skip';
  const steps = advanceTo(gs, 'nextPlayerGame', { collectPlayerEvents: collect });
  autoSave();
  if (gs.rt.finished && !steps.some((s) => s.playerGames.length)) { renderSeasonResult(); return; }
  const last = steps[steps.length - 1];
  const rec = last.playerGames.length ? last.playerGames[last.playerGames.length - 1] : null;
  if (rec && collect && last.playerEvents) {
    // E2: 観戦は最初の打席開始（atbat）から一球ずつ。ダイジェストは全消化（結果行のみ表示）。
    game.watch = {
      rec,
      events: last.playerEvents,
      idx: mode === 'watch' ? indexOfFirstAtbat(last.playerEvents) : last.playerEvents.length,
      progressive: mode === 'watch',
      unit: 'pitch', // 進行単位: 'pitch'|'pa'|'inning'
      auto: false, // 自動再生トグル（UIのみ・状態不変）
      showBench: false, // スタメン/ベンチ・ブルペン残量の折りたたみ
      justAdvanced: true, // 初回描画で決着済みイベントがあれば1回だけ光る
    };
    renderWatch();
  } else {
    renderHub();
  }
}

function indexOfFirstAtbat(events) {
  const i = events.findIndex((e) => e.type === 'atbat' || e.type === 'pa');
  return i < 0 ? events.length : i + 1;
}

// G2: 週/月の進行を日次分割で実行（runToSeasonEnd と同じチャンク進行パターン・決定論は advanceDay の逐次で不変）。
// until: 'weekEnd' | 'monthEnd'。advanceTo（src/game/index.mjs）と同じ境界計算で停止条件を span 単位に再現する
// （エンジン非改変＝計算式そのものを advanceTo からコピーしているだけで、エンジンのロジックには触れない）。
function runAdvanceWithProgress(until) {
  const gs = game.gs;
  const span = until === 'weekEnd' ? gs.cfg.game.daysPerWeek : gs.cfg.game.daysPerMonth;
  const startDay = pendingDayOf(gs.rt) - 1; // 0始まりの現在day
  const targetDay = Math.floor(startDay / span) * span + span; // 次の span 境界（advanceTo と同義）
  const heading = until === 'weekEnd' ? '1週間を進行中…' : '月末まで進行中…';
  // G6: 進行後の差分ダイジェスト用スナップショット（開始時点の日付・自リーグ順位を控える）。
  // digestTitle は heading とは独立に持つ（文字列のreplace合成だと「1週間を結果」のように助詞が崩れるため）。
  const digestTitle = until === 'weekEnd' ? '1週間の結果' : '月末までの結果';
  const digestSnap = { startDay, digestTitle, rank: leagueRankOf(gs.rt, gs.playerTeamId) };
  const overlay = el('div', { class: 'overlay' });
  const barFill = el('div', { class: 'pbfill', style: 'width:0%' });
  const barText = el('div', { class: 'muted' }, '0%');
  overlay.append(el('div', { class: 'modal' }, [
    el('h2', {}, heading),
    el('div', { class: 'pbtrack' }, [barFill]),
    barText,
  ]));
  document.getElementById('app').append(overlay);
  const step = () => {
    advanceDay(gs);
    const cur = pendingDayOf(gs.rt) - 1;
    const pct = Math.min(100, Math.round(((cur - startDay) / (targetDay - startDay)) * 100));
    barFill.setAttribute('style', `width:${pct}%`);
    barText.textContent = pct + '%';
    if (gs.rt.finished || cur >= targetDay) {
      autoSave();
      overlay.remove();
      // G6: rt.finished は G2 の分岐をそのまま維持（ダイジェストを挟まずリザルトへ直行）。
      //   それ以外のときだけ差分ダイジェストモーダルを表示してから hub へ戻る。
      if (gs.rt.finished) renderSeasonResult(); else showAdvanceDigest(gs, digestSnap);
    } else {
      setTimeout(step, 0);
    }
  };
  step();
}

/** G6: 自リーグ内の順位（1始まり）とリーグ球団数。renderHubHome のミニ順位表と同じ算出方法。 */
function leagueRankOf(rt, teamId) {
  const rows = currentStandings(rt);
  const myLg = rt.standings.get(teamId).league;
  const lgRows = rows.filter((r) => r.league === myLg);
  return { rank: lgRows.findIndex((r) => r.teamId === teamId) + 1, total: lgRows.length };
}

/**
 * G6: 週/月進行後の差分ダイジェスト（runAdvanceWithProgress 完了後・rt.finished でないときのみ表示）。
 * 期間戦績（進行開始日以降のW-L-T）・順位変動（開始時→完了時）・見出し（週次ダイジェスト＋選手活躍）・
 * 昇降格（期間分・自チームのみ）を overlay モーダルで示してから「閉じる」で renderHub() へ戻る。
 * スキップ設定は持たない（「次の試合へ」経由の playNextPlayerGame では呼ばない＝仕様どおり）。
 */
function showAdvanceDigest(gs, snap) {
  const rt = gs.rt;
  const myId = gs.playerTeamId;
  // 期間戦績: rt.playerGameLog のうち進行開始日以降
  const games = rt.playerGameLog.filter((g) => g.day >= snap.startDay);
  let w = 0, l = 0, t = 0;
  for (const g of games) {
    const isHome = g.home === myId;
    const my = isHome ? g.homeScore : g.awayScore;
    const opp = isHome ? g.awayScore : g.homeScore;
    if (g.tie) t++; else if (my > opp) w++; else l++;
  }
  // 順位変動: 開始時スナップショット → 現在
  const after = leagueRankOf(rt, myId);
  // 見出し: 週次ダイジェスト上位3件＋選手活躍3件
  const heads = weeklyDigest({
    gameLog: rt.playerGameLog,
    standings: currentStandings(rt),
    teamId: myId,
    nameOf: (id) => tname(id),
  }).slice(0, 3);
  heads.push(...schedPlayerHeadlines(rt, scheduleDeps(), 3));
  // 昇降格: 期間分・自チームのみ
  const moves = (rt.rosterMoves ?? []).filter((m) => m.teamId === myId && m.day >= snap.startDay);

  const close = () => { overlay.remove(); renderHub(); };
  const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const box = el('div', { class: 'modal' });
  box.append(el('div', { class: 'modalhead' }, [
    el('span', { class: 'pname' }, snap.digestTitle),
    el('button', { class: 'link', onclick: close }, '✕'),
  ]));
  box.append(el('div', {}, `期間戦績: ${w}勝${l}敗${t}分`));
  if (snap.rank.rank && after.rank) {
    box.append(el('div', {}, `順位: ${snap.rank.rank}位 → ${after.rank}位（${after.total}球団中）`));
  }
  box.append(el('h3', { class: 'leaguename' }, '📰 見出し'));
  box.append(el('div', { class: 'newsfeed' }, heads.length
    ? heads.map((h) => el('div', { class: 'newsrow ' + (h.cls || 'info') }, h.parts || h.text))
    : [el('div', { class: 'newsrow info' }, '目立った見出しはありません。')]));
  if (moves.length) {
    box.append(el('h3', { class: 'leaguename' }, '🔁 昇格・降格'));
    box.append(el('div', { class: 'newsfeed' }, moves.map((m) =>
      el('div', { class: 'newsrow info' }, [`第${m.day + 1}節: `, ...rosterMoveParts(m)]))));
  }
  box.append(el('div', { class: 'row', style: 'margin-top:10px' }, [
    el('button', { class: 'primary', onclick: close }, '閉じる'),
  ]));
  overlay.append(box);
  document.getElementById('app').append(overlay);
}

// 「シーズン終了まで」: UIを凍らせないチャンク進行（節を小分けに消化＋プログレスバー）。
// 階層シードで分割実行しても結果不変（advanceDay は決定論）。true な Web Worker（Blob）はC2で検討。
function runToSeasonEnd() {
  const gs = game.gs;
  const total = gs.rt.schedule.length;
  const root = document.getElementById('app');
  root.innerHTML = '';
  const barFill = el('div', { class: 'pbfill', id: 'pbfill', style: 'width:0%' });
  root.append(el('div', { class: 'setup' }, [
    el('h2', {}, 'シーズンを進行中…'),
    el('div', { class: 'pbtrack' }, [barFill]),
    el('div', { class: 'muted', id: 'pbtext' }, '0%'),
  ]));
  const step = () => {
    let n = 0;
    while (!gs.rt.finished && n < 24) { advanceDay(gs); n++; }
    const pct = Math.min(100, Math.round((gs.rt.cursor / total) * 100));
    const f = document.getElementById('pbfill');
    const t = document.getElementById('pbtext');
    if (f) f.setAttribute('style', `width:${pct}%`);
    if (t) t.textContent = pct + '%';
    if (gs.rt.finished) { autoSave(); renderSeasonResult(); }
    else setTimeout(step, 0);
  };
  step();
}

// --- 試合観戦UI（E2: スポナビ風。実装は src/ui/watch.mjs・ここは deps 供給のみ） ---------
function renderWatch() {
  renderWatchScreen(watchDeps());
}

/**
 * E2: src/ui/watch.mjs（観戦画面）へ渡すUI共有ヘルパー束（E1 teamTabDeps と同じ流儀:
 * 分割モジュールは ui.mjs のヘルパー/状態を import せず deps 経由で参照する）。
 */
function watchDeps() {
  return {
    el, td, state, game, tname, pname, posJP, playerLink, teamColor, tabbr,
    svgEl, svgText, fmt3, f2, refreshRes, renderHub,
    renderGlossary, // G10: 観戦ヘッダーの「?」用語集リンク
  };
}

/** SVG <text> 要素（既存 svgEl は子を持たないため専用ヘルパで textContent を設定）。 */
function svgText(attrs, text) {
  const e = svgEl('text', attrs);
  e.textContent = text;
  return e;
}

// --- シーズンリザルト --------------------------------------------------------
function renderSeasonResult() {
  const gs = game.gs;
  const rt = gs.rt;
  const root = document.getElementById('app');
  root.innerHTML = '';
  refreshRes();
  root.append(el('div', { class: 'header' }, [
    el('h2', {}, `${gs.year}年 シーズンリザルト`),
    // G8: 4ボタンを2行構成に（1行目=進行系・primary/2行目=閲覧系）。ボタン文言は変更しない。
    el('div', {}, [
      el('div', { class: 'row' }, [
        // E3: リザルト→年送りの間に「ストーブリーグ」ステップ（FA入札/トレード起案）。スキップも可。
        el('button', { class: 'primary', onclick: () => renderStoveScreen(stoveDeps()) }, '▶ ストーブリーグへ（FA・トレード）'),
        el('button', { onclick: () => advanceToNextYearUI() }, '翌シーズンへ（スキップ）'),
      ]),
      el('div', { class: 'row' }, [
        el('button', { onclick: () => renderHub('standings') }, '成績を見る'),
        el('button', { class: 'link', onclick: () => renderTitle() }, 'タイトルへ'),
      ]),
    ]),
  ]));
  const ps = rt.postseason;
  if (ps && ps.champion) {
    root.append(el('div', { class: 'championbanner' }, `🏆 日本一: ${tname(ps.champion)}${ps.champion === gs.playerTeamId ? '（あなたの球団！）' : ''}`));
  }
  const content = el('div', { id: 'content' });
  root.append(content);
  renderAwardsPanel(content); // 表彰（MVP/新人王/ベストナイン/守備の栄誉賞/タイトル・C4）
  renderStandings(content); // 2リーグ順位表＋ポストシーズンパネル（既存描画を再利用）
}

// --- 年送り（E3: ストーブリーグ→オフシーズン処理→ダイジェスト） -----------------
// 市場介入（bidFA/proposeTrade）はストーブリーグ画面（src/ui/stove.mjs）が advanceYear の前に
// marketInterventions へ積む。ここではエンジン既存の advanceYear（決定論・セーブは careerStats/
// 介入ログから replay 再現）を実行し、オフシーズン要約ダイジェストを表示するのみ
// ＝UI都合の新たな乱数消費・状態変更はない。
// H2: cfg.game.interactiveDraft=true（既定・startNewGame参照）かつ自チームの指名番になると
//   advanceYear は null を返して中断する（state.awaitingDraft が立つ）。その場合はドラフト会議室
//   （src/ui/draft.mjs）へ遷移し、全ラウンド解決後に finishOffseasonUI へ合流する。
//   interactiveDraft=false（旧セーブ/デバッグ）なら off は常に非nullで従来どおり即ダイジェストへ。
function advanceToNextYearUI() {
  const off = advanceYear(game.gs);
  if (off === null) {
    // H5-B: 解任イベント（ownerPending）はドラフト中断より先に発生する（advanceYear冒頭で評価）。
    if (game.gs.ownerPending) { renderOwnerDecisionScreen(); return; }
    renderDraftRoomScreen(draftDeps());
    return;
  }
  finishOffseasonUI(off);
}

/** H5-B: 解任イベントの裁定画面（移籍オファー受諾 or 留任嘆願）。裁定後はオフ処理へ合流。 */
function renderOwnerDecisionScreen() {
  const gs = game.gs;
  const pend = gs.ownerPending;
  const rep = gs.lastOwnerReport;
  const c = el('div', { class: 'card' }, [
    el('div', { class: 'header' }, '⚠ オーナーからの通告'),
    el('div', {}, `信任が地に落ちた（${rep ? rep.trustAfter : gs.ownerTrust}/100）。球団はあなたの解任を決定した。`),
    el('div', { class: 'muted', style: 'margin:6px 0' },
      (rep?.results ?? []).map((r) => `【${r.goal.priority === 'high' ? '最重要' : '目標'}】${r.goal.label} → ${r.achieved ? '達成' : '未達'}（${r.actual}）`).join('　')),
    el('div', { style: 'margin-top:8px' }, [
      el('button', { class: 'primary', onclick: () => { const off = resolveOwnerDecision(gs, 'transfer'); afterOwnerDecision(off); } },
        `${tname(pend.toTeam)} からのオファーを受ける（移籍）`),
      pend.canPlea
        ? el('button', { style: 'margin-left:6px', onclick: () => { const off = resolveOwnerDecision(gs, 'plea'); afterOwnerDecision(off); } },
            '留任を嘆願する（キャリアで1回だけ）')
        : el('span', { class: 'muted', style: 'margin-left:6px' }, '（留任嘆願は使用済み）'),
    ]),
  ]);
  const root = document.getElementById('app');
  root.innerHTML = '';
  root.append(c);
}
function afterOwnerDecision(off) {
  autoSave();
  if (off === null) { renderDraftRoomScreen(draftDeps()); return; } // 続けてドラフト中断
  finishOffseasonUI(off);
}

/** オフシーズン確定後の共通の締め（advanceToNextYearUI と draft.mjs の完了ハンドラで共有）。 */
function finishOffseasonUI(off) {
  bindGameContext(game.gs); // 引退/新人/育成獲得で players/farm が変わる＝byId を張り直す
  autoSave();
  renderOffseasonDigestScreen(off, stoveDeps()); // E3: 1画面ダイジェスト（実装は src/ui/stove.mjs）
}

/**
 * H2: src/ui/draft.mjs（ドラフト会議室）へ渡すUI共有ヘルパー束
 * （teamTabDeps/watchDeps/stoveDeps と同じ流儀: 分割モジュールは deps 経由で ui.mjs を参照する）。
 */
function draftDeps() {
  return {
    el, game, tname, posJP, autoSave,
    PERSONALITY_LABELS, // H3-1: スカウトレポートの性格タグ表示
    renderHub: () => renderHub(),
    onDraftComplete: (off) => finishOffseasonUI(off),
  };
}

/**
 * E3: src/ui/stove.mjs（ストーブリーグ/オフダイジェスト）へ渡すUI共有ヘルパー束
 * （teamTabDeps/watchDeps と同じ流儀: 分割モジュールは deps 経由で ui.mjs を参照する）。
 */
function stoveDeps() {
  return {
    el, td, state, game, kv, playerLink, posJP, scoutGrade, tname, pname,
    fmt3, refreshRes, autoSave, leagueNameOf,
    renderHub: () => renderHub(),
    renderSeasonResult: () => renderSeasonResult(),
    advanceToNextYearUI: () => advanceToNextYearUI(),
  };
}

// --- 表彰パネル（C4・シーズンリザルト） --------------------------------------
function renderAwardsPanel(c) {
  const gs = game.gs;
  const aw = computeSeasonAwards({
    playerSeasons: state.res.playerSeasons,
    standings: state.res.standings,
    playersById: state.byId,
    cfg: gs.cfg,
    allCareerStats: gs.careerStats,
    year: gs.year,
  });
  c.append(el('h3', { class: 'leaguename' }, `🏅 ${gs.year}年 表彰`));
  // E1: 受賞者名は playerLink でモーダルへ（導線の全画面化）。引退者は素のテキストに落ちる。
  const linkOf = (id) => (id ? playerLink(id) : '—');
  // G8: リーグごとに<details>で折りたたみ、自チームのリーグだけ既定open
  const myLg = gs.rt.standings.get(gs.playerTeamId).league;
  for (const lg of aw.leagues) {
    const box = el('div', { class: 'awardpanel' });
    // MVP・新人王
    const bigVal = (a) => [playerLink(a.playerId), `（WAR ${a.war.toFixed(1)}）`];
    const top = [['MVP', lg.mvp ? bigVal(lg.mvp) : '—']];
    if (lg.roty) top.push(['新人王', bigVal(lg.roty)]);
    box.append(el('div', { class: 'awardtop' }, top.map(([k, v]) => el('div', { class: 'awardbig' }, [el('span', { class: 'awardbigk' }, k), el('span', { class: 'awardbigv' }, v)]))));
    // タイトル9種
    const tvals = (t) => (t ? linkOf(t.playerId) : '—');
    const titleGrid = Object.keys(TITLE_LABELS).map((k) => el('div', { class: 'kv' }, [
      el('div', { class: 'kvk' }, TITLE_LABELS[k]), el('div', { class: 'kvv' }, tvals(lg.titles[k])),
    ]));
    box.append(el('div', { class: 'muted', style: 'margin-top:6px' }, 'タイトル'));
    box.append(el('div', { class: 'kvgrid' }, titleGrid));
    // ベストナイン
    box.append(el('div', { class: 'muted', style: 'margin-top:6px' }, 'ベストナイン'));
    box.append(el('div', { class: 'kvgrid' }, lg.bestNine.map((b) => el('div', { class: 'kv' }, [
      el('div', { class: 'kvk' }, posJP(b.pos)), el('div', { class: 'kvv' }, linkOf(b.playerId)),
    ]))));
    // 守備の栄誉賞（UZR+OAA・架空名）
    box.append(el('div', { class: 'muted', style: 'margin-top:6px' }, `${DEF_AWARD_NAME}（UZR+OAA）`));
    box.append(el('div', { class: 'kvgrid' }, lg.gloves.map((g) => el('div', { class: 'kv' }, [
      el('div', { class: 'kvk' }, posJP(g.pos)), el('div', { class: 'kvv' }, g.playerId ? [playerLink(g.playerId), `（${signed(g.defScore)}）`] : '—'),
    ]))));
    const detailsAttrs = { class: 'awarddetails' };
    if (lg.leagueId === myLg) detailsAttrs.open = '';
    c.append(el('details', detailsAttrs, [
      el('summary', { class: 'leaguename' }, leagueNameOf(gs.cfg, lg.leagueId)),
      box,
    ]));
  }
}

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
  playerBatting, playerPitching, playerBaserunning, battingSplits, playerFielding, winPct,
  hitterWAR, pitcherWAR, uzrRuns, centeredOAAOuts,
  leagueBatting, leaguePitching,
} from './engine.mjs';
// フェーズC1 ゲーム層API（配布バンドルではグローバル・開発時Node解決用に import も書く）。
// バンドルでは import 行が剥がれ、これらは先行スクリプト（game/index.mjs 由来）のグローバルを参照する。
import {
  newGame, advanceDay, advanceTo, save, load,
  setManagerProfile, clearManagerProfile,
} from './game/index.mjs';

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

export function initApp() {
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
    el('h2', {}, '架空選手ペナント（12球団 / 143試合・2リーグ制）'),
    el('p', { class: 'muted' }, 'リーグシードごとに架空選手396人（12球団×33人）が生成されます。生成後は「▶ 再シミュレート」で、同じ選手のまま毎回ちがう乱数で別のシーズンを回せます。'),
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
      el('div', { class: 'row' }, [resim, back]),
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
  c.append(el('div', { class: 'warlist' }, rows.map((r, i) =>
    el('div', { class: 'warcard clickable', onclick: () => openModal(r.id) }, [
      el('span', { class: 'warrank' }, String(i + 1)),
      el('span', { class: 'warval' }, r.war.toFixed(1)),
      el('span', { class: 'warname' }, [
        el('div', { class: 'wn1' }, r.name),
        el('div', { class: 'muted' }, `${r.team} / ${r.role}　${r.detail}`),
      ]),
    ]),
  )));
}

// --- 順位表（S4: 2リーグ分割＋交流戦成績＋ポストシーズンパネル） -------------
function renderStandings(c) {
  const leagues = state.cfg.league.leagues ?? [];
  const byLg = state.res.standingsByLeague ?? {};
  const blocks = leagues.length
    ? leagues.map((l) => ({ title: `${l.name}（DH${l.dh ? '有' : '無'}）`, rows: byLg[l.id] ?? [] }))
    : [{ title: '総合', rows: state.res.standings }];
  for (const blk of blocks) {
    const rows = blk.rows.map((t, i) => el('tr', {}, [
      td(i + 1), td(t.name, 'left'), td(t.w), td(t.l), td(t.t),
      td(fmt3(winPct(t))), td(t.rs), td(t.ra), td((t.rs - t.ra > 0 ? '+' : '') + (t.rs - t.ra)),
      td(t.il ? `${t.il.w}-${t.il.l}-${t.il.t}` : '-'),
    ]));
    c.append(el('h3', { class: 'leaguename' }, blk.title));
    c.append(table(['順', '球団', '勝', '敗', '分', '勝率', '得点', '失点', '差', '交流戦'], rows));
  }
  renderPostseasonPanel(c);
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
    const scores = ps.japanSeries.games.map((g, i) =>
      `第${i + 1}戦 ${name(g.home)} ${g.homeScore}-${g.awayScore} ${name(g.away)}${g.innings > 9 ? `（延長${g.innings}回）` : ''}`);
    box.append(el('div', { class: 'muted' }, scores.join(' ／ ')));
  }
  if (ps.champion) box.append(el('div', { class: 'pschamp' }, `日本一: ${name(ps.champion)}`));
  c.append(box);
}

// --- 打撃 -----------------------------------------------------------------
const BAT_COLS = [
  ['name', '選手', 'left'], ['team', 'ﾁｰﾑ', 'left'], ['pos', '守', 'left'],
  ['war', 'WAR'], ['pa', '打席'], ['avg', '打率'], ['hr', '本'], ['rbi', '点'], ['sb', '盗'],
  ['obp', '出塁'], ['slg', '長打'], ['ops', 'OPS'], ['woba', 'wOBA'], ['xwoba', 'xwOBA'],
  ['wrcPlus', 'wRC+'], ['opsPlus', 'OPS+'], ['iso', 'ISO'],
  ['barrelPct', 'Barrel%'], ['hardHitPct', 'HardHit%'],
  ['bsr', 'BsR'], ['wpa', 'WPA'], ['clutch', 'Clutch'], ['bbPct', 'BB%'], ['kPct', 'K%'],
  ['sh', '犠打'], ['ibb', '敬遠'], ['ph', '代打'], // S4: 采配の発現（SH/IBB/PH）
];
function renderBatting(c) {
  const data = state.res.playerSeasons
    .filter((s) => s.batting.pa >= 100)
    .map((s) => {
      const m = playerBatting(s, state.lc);
      const p = state.byId.get(s.playerId);
      const war = p.role === 'fielder' ? hitterWAR(s, state.cfg, state.lc).war : 0;
      const bsr = playerBaserunning(s, state.cfg, state.lc).bsr;
      const b = s.batting;
      return { id: s.playerId, name: p ? p.name : s.playerId, team: state.teamName.get(s.teamId) || s.teamId, pos: primaryPos(p), war, bsr, sh: b.sh, ibb: b.ibb, ph: b.ph, ...m };
    });
  c.append(statTable(data, BAT_COLS, ['avg', 'obp', 'slg', 'ops', 'woba', 'xwoba', 'iso'], ['bbPct', 'kPct', 'barrelPct', 'hardHitPct'], 'war', 1));
}

// --- 投手 -----------------------------------------------------------------
const PIT_COLS = [
  ['name', '選手', 'left'], ['team', 'ﾁｰﾑ', 'left'], ['role', '役割', 'left'], ['war', 'WAR'],
  ['w', '勝'], ['l', '敗'], ['sv', 'S'], ['hld', 'H'], ['ip', '回'], ['era', '防御'], ['fip', 'FIP'],
  ['xfip', 'xFIP'], ['siera', 'SIERA'], ['kwera', 'kwERA'],
  ['so', '奪三'], ['kPer9', 'K/9'], ['whip', 'WHIP'], ['bbPct', 'BB%'], ['kbbPct', 'K-BB%'], ['lobPct', 'LOB%'],
  ['qs', 'QS'], ['wpa', 'WPA'], ['clutch', 'Clutch'],
];
function renderPitching(c) {
  const data = state.res.playerSeasons
    .filter((s) => s.pitching.outs / 3 >= 20)
    .map((s) => {
      const m = playerPitching(s, state.lc, state.cfg);
      const p = state.byId.get(s.playerId);
      // 役割は観測値（GS/G過半）で判定（S4。真値のローテ表は見ない＝statlineから湧く原則）
      const role = m.g && m.gs * 2 >= m.g ? '先発' : '救援';
      return { id: s.playerId, name: p ? p.name : s.playerId, team: state.teamName.get(s.teamId) || s.teamId, role, war: pitcherWAR(s, state.cfg, state.lc).war, ...m };
    });
  c.append(statTable(data, PIT_COLS, ['era', 'fip', 'whip', 'xfip', 'siera', 'kwera'], ['bbPct', 'kbbPct', 'lobPct'], 'war', 1));
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
      return { id: s.playerId, name: p ? p.name : s.playerId, team: state.teamName.get(s.teamId) || s.teamId, pos: mainPos, inn: outs / 3, oaa: centeredOAAOuts(s, state.lc), uzr: uzrRuns(s, state.cfg, state.lc), e: s.fielding.e };
    })
    .filter((d) => d.inn >= 100 && d.pos !== 'DH'); // DHは守備表から除外（守備位置補正はWAR表に反映）
  const cols = [['name', '選手', 'left'], ['team', 'ﾁｰﾑ', 'left'], ['pos', '守', 'left'], ['inn', '守備回'], ['oaa', 'OAA'], ['uzr', 'UZR'], ['e', '失策']];
  c.append(statTable(data, cols, [], [], 'uzr', 1));
}

// --- 汎用ソート可能テーブル ------------------------------------------------
function statTable(data, cols, fmtDec3, fmtPct, defaultSort, dec = 0) {
  const wrap = el('div', { class: 'tablewrap' });
  const render = () => {
    wrap.innerHTML = '';
    const { key, dir } = state.sort;
    const sorted = [...data].sort((a, b) => {
      const av = a[key]; const bv = b[key];
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * ((av ?? 0) - (bv ?? 0));
    }).slice(0, 100);
    const head = el('tr', {}, cols.map(([k, label, align]) =>
      el('th', { class: (align || '') + (state.sort.key === k ? ' sorted' : ''), title: TIP[k] || '', onclick: () => { state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 }; render(); } }, label + (state.sort.key === k ? (dir < 0 ? ' ▼' : ' ▲') : '')),
    ));
    const rows = sorted.map((d) => el('tr', { class: 'clickable', onclick: () => openModal(d.id) }, cols.map(([k, , align]) => {
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
  return wrap;
}

// --- 選手モーダル（タブ化・§B3 UI）----------------------------------------
// 打者: 基本 / 打球(スプレー+EV/LA+Barrel%) / スプリット(対左右/RISP/home-away) / 文脈(WPA/RE24/Clutch/LI) / 守備成分
// 投手: 基本 / 投球(xFIP/SIERA/被打球) / 文脈(WPA/pLI/gmLI/SD/MD)
function openModal(playerId) {
  const p = state.byId.get(playerId);
  const s = state.res.statsById.get(playerId);
  if (!p || !s) return;
  const isPitcher = p.role === 'pitcher';
  const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const box = el('div', { class: 'modal' });
  box.append(el('div', { class: 'modalhead' }, [
    el('div', {}, [el('span', { class: 'pname' }, p.name), el('span', { class: 'muted' }, `  ${state.teamName.get(p.teamId) || ''} / ${isPitcher ? '投手' : primaryPos(p)} / ${p.age}歳 / ${handLabel(p.throws)}投${handLabel(p.bats)}打`)]),
    el('button', { class: 'link', onclick: () => overlay.remove() }, '✕'),
  ]));
  const modalTabs = isPitcher
    ? [['basic', '基本'], ['pitch', '投球'], ['context', '文脈']]
    : [['basic', '基本'], ['batted', '打球'], ['splits', 'スプリット'], ['context', '文脈'], ['field', '守備成分']];
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
  };
  render();
  overlay.append(box);
  document.getElementById('app').append(overlay);
}

// 基本タブ: 成績サマリ＋（打者）WAR内訳/対球種 ＋能力バー
function renderModalBasic(box, p, s, isPitcher) {
  if (isPitcher) {
    const m = playerPitching(s, state.lc, state.cfg);
    const pw = pitcherWAR(s, state.cfg, state.lc);
    box.append(kv([['WAR', pw.war.toFixed(1)], ['登板', m.g], ['勝', m.w], ['敗', m.l], ['S', m.sv], ['投球回', m.ip.toFixed(1)], ['防御率', f2(m.era)], ['FIP', f2(m.fip)], ['奪三', m.so], ['K/9', f2(m.kPer9)]]));
  } else {
    const m = playerBatting(s, state.lc);
    box.append(kv([['打席', m.pa], ['打率', fmt3(m.avg)], ['本塁打', m.hr], ['打点', m.rbi], ['盗塁', m.sb], ['出塁', fmt3(m.obp)], ['長打', fmt3(m.slg)], ['OPS', fmt3(m.ops)], ['wOBA', fmt3(m.woba)], ['wRC+', m.wrcPlus.toFixed(0)]]));
    const w = hitterWAR(s, state.cfg, state.lc);
    box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, `WAR ${w.war.toFixed(1)} 内訳`));
    box.append(kv([['打wRAA', w.wraa.toFixed(1)], ['走BsR', w.bsr.toFixed(1)], ['守UZR', w.uzr.toFixed(1)], ['位置', w.posAdj.toFixed(1)], ['OAA', centeredOAAOuts(s, state.lc).toFixed(1)]]));
    const vf = s.batting.vsFastball;
    const vb = s.batting.vsBreaking;
    const avgOf = (x) => (x.ab ? fmt3(x.h / x.ab) : '-');
    box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, '対球種成績（打率 / 本）'));
    box.append(kv([['対速球', `${avgOf(vf)} / ${vf.hr}`], ['対変化球', `${avgOf(vb)} / ${vb.hr}`]]));
  }
  box.append(el('div', { class: 'muted', style: 'margin-top:10px' }, '能力（真の実力）'));
  box.append(abilityBars(p.trueAbility, p.role));
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
  box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, '被打球（インプレー割合）・被本塁打'));
  box.append(kv([
    ['GB%', pct(m.gbPct)], ['LD%', pct(m.ldPct)], ['FB%', pct(m.fbPct)], ['PU%', pct(m.puPct)], ['HR/FB', pct(m.hrFbPct)],
  ]));
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
  watch: null, // 観戦中の { rec, events, idx, progressive }
  slots: {}, // セッション内セーブミラー（同期ロード用。永続は IndexedDB）
  bg: null, // 「シーズン終了まで」バックグラウンド進行の状態
};

// --- 小物（ゲーム層） -------------------------------------------------------
const pname = (id) => (state.byId.get(id) ? state.byId.get(id).name : id);
const tname = (id) => state.teamName.get(id) || id;
const BATTED_JP = { GB: 'ゴロ', LD: 'ライナー', FB: 'フライ', PU: 'ポップフライ' };
const posJP = (p) => (p === 'DH' ? 'DH' : p === 'P' ? '投' : p);

/** 打球方向（スプレー角→左/中/右）。sprayChart と同じ符号系（負=左, 正=右）。 */
function sprayDir(deg) {
  return deg < -12 ? '左' : deg > 12 ? '右' : '中';
}

/** ゲーム層の共有コンテキスト（stat 描画が参照する state.* をゲーム状態から張る）。 */
function bindGameContext(gs) {
  state.cfg = gs.cfg;
  state.league = gs.league;
  state.byId = new Map(gs.league.players.map((p) => [p.id, p]));
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

function startNewGame(seed, teamId) {
  const cfg = createConfig();
  game.gs = newGame(seed >>> 0, teamId, { cfg });
  bindGameContext(game.gs);
  autoSave();
  renderHub();
}

// --- シーズンハブ -----------------------------------------------------------
const HUB_TABS = [
  ['hub', 'ハブ'], ['standings', '順位表'], ['war', 'WAR'],
  ['batting', '打撃'], ['pitching', '投手'], ['fielding', '守備'], ['teams', 'チーム'],
];

function renderHub(tab = 'hub') {
  const gs = game.gs;
  const rt = gs.rt;
  const root = document.getElementById('app');
  root.innerHTML = '';
  const myName = tname(gs.playerTeamId);
  const myRow = rt.standings.get(gs.playerTeamId);
  const header = el('div', { class: 'header' }, [
    el('h2', {}, [`${myName}　`, el('span', { class: 'muted' }, `${gs.year}年 / 第${pendingDayOf(rt)}節　${myRow.w}勝${myRow.l}敗${myRow.t}分`)]),
    el('div', { class: 'row' }, [
      el('button', { class: 'link', onclick: () => renderTitle() }, '≡ タイトル'),
    ]),
  ]);
  const bar = el('div', { class: 'tabs' }, HUB_TABS.map(([k, label]) =>
    el('button', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => renderHub(k) }, label)));
  const content = el('div', { id: 'content' });
  root.append(header, bar, content);
  if (tab === 'hub') renderHubHome(content);
  else {
    refreshRes();
    if (tab === 'standings') renderStandings(content);
    else if (tab === 'war') renderWAR(content);
    else if (tab === 'batting') renderBatting(content);
    else if (tab === 'pitching') renderPitching(content);
    else if (tab === 'fielding') renderFielding(content);
    else if (tab === 'teams') renderTeams(content);
  }
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
  // 進行ボタン
  c.append(el('div', { class: 'progressbar-wrap' }, [
    el('div', { class: 'muted' }, '進行'),
    el('div', { class: 'row', style: 'flex-wrap:wrap' }, [
      el('button', { class: 'primary', onclick: () => showNextGameChoices() }, '▶ 次の試合へ'),
      el('button', { onclick: () => { advanceChunk('weekEnd'); renderHub(); } }, '1週間'),
      el('button', { onclick: () => { advanceChunk('monthEnd'); renderHub(); } }, '月末まで'),
      el('button', { onclick: () => runToSeasonEnd() }, 'シーズン終了まで'),
    ]),
  ]));

  // 次戦カード
  const nextCard = nextPlayerCard(rt);
  if (nextCard) {
    c.append(el('div', { class: 'nextcard' }, [
      el('div', { class: 'muted' }, `次戦（第${nextCard.day + 1}節）`),
      el('div', { class: 'nextmatch' }, nextCard.text),
    ]));
  }

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
  c.append(el('h3', { class: 'leaguename' }, `${leagueNameOf(gs.cfg, myLg)} 順位`));
  c.append(table(['順', '球団', '勝', '敗', '分', '勝率', '差'], lgRows.map((t, i) => el('tr', { class: t.teamId === gs.playerTeamId ? 'myteam' : '' }, [
    td(i + 1), td(t.name, 'left'), td(t.w), td(t.l), td(t.t), td(fmt3(winPct(t))), td((t.rs - t.ra > 0 ? '+' : '') + (t.rs - t.ra)),
  ]))));

  // チーム状態（調子＝直近10試合の勝敗・疲労＝ブルペン可用の目安は省略しC2で拡張）
  const form = teamForm(rt, gs.playerTeamId);
  c.append(el('div', { class: 'teamstate' }, [
    el('span', { class: 'muted' }, '調子（直近10試合）: '),
    el('span', {}, form || '—'),
  ]));

  // 采配（監督プロファイル介入・自チームのみ）
  c.append(renderManagerPanel());
  // セーブ/ロード
  c.append(renderSavePanel());
}

/** 自チームの次戦カードを探す（未消化 schedule から最初の自チーム試合）。 */
function nextPlayerCard(rt) {
  for (let gi = rt.cursor; gi < rt.schedule.length; gi++) {
    const g = rt.schedule[gi];
    if (g.home === game.gs.playerTeamId || g.away === game.gs.playerTeamId) {
      const isHome = g.home === game.gs.playerTeamId;
      const oppId = isHome ? g.away : g.home;
      return { day: g.day, text: `${isHome ? 'HOME vs' : 'AWAY @'} ${tname(oppId)}` };
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

function renderManagerPanel() {
  const gs = game.gs;
  const box = el('div', { class: 'mgrpanel' });
  box.append(el('h3', { class: 'leaguename' }, '采配（監督方針・自チーム）'));
  const auto = gs.settings.autoManage;
  box.append(el('div', { class: 'row' }, [
    el('span', { class: 'muted' }, 'おまかせ（AI委任）: '),
    el('button', { class: auto ? 'primary' : '', onclick: () => { clearManagerProfile(gs); autoSave(); renderHub(); } }, auto ? 'ON' : 'OFFにする→'),
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
        onclick: () => { setManagerProfile(gs, { [field]: val }); autoSave(); renderHub(); },
      }, lvl)),
    ]));
  }
  box.append(el('div', { class: 'muted', style: 'margin-top:4px' }, '方針は次節以降の試合に反映され、セーブに介入ログとして残ります（再現可能）。'));
  return box;
}

// --- セーブ/ロード（IndexedDB＋セッションミラー） ------------------------------
function renderSavePanel() {
  const box = el('div', { class: 'savepanel' });
  box.append(el('h3', { class: 'leaguename' }, 'セーブ / ロード'));
  const row = el('div', { class: 'row', style: 'flex-wrap:wrap' });
  for (let n = 1; n <= 3; n++) {
    const key = 'slot' + n;
    row.append(el('button', { onclick: () => { saveToSlot(key); renderHub(); } }, `スロット${n}に保存`));
    if (game.slots[key]) row.append(el('button', { class: 'link', onclick: () => loadFromSlot(key) }, `→ロード${n}`));
  }
  box.append(row);
  box.append(el('div', { class: 'muted' }, 'オートセーブは日次で IndexedDB に保存されます（localStorage不使用）。'));
  return box;
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
  game.gs = load(blob, { cfg: createConfig() });
  bindGameContext(game.gs);
  if (game.gs.rt.finished) renderSeasonResult();
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
    game.watch = { rec, events: last.playerEvents, idx: mode === 'watch' ? indexOfFirstPa(last.playerEvents) : last.playerEvents.length, progressive: mode === 'watch' };
    renderWatch();
  } else {
    renderHub();
  }
}

function indexOfFirstPa(events) {
  const i = events.findIndex((e) => e.type === 'pa');
  return i < 0 ? events.length : i + 1;
}

function advanceChunk(until) {
  advanceTo(game.gs, until);
  autoSave();
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

// --- 試合観戦UI（スコアボード＋ダイヤモンド＋実況＋ベンチ/ブルペン残量） -----------
function renderWatch() {
  const w = game.watch;
  const root = document.getElementById('app');
  root.innerHTML = '';
  const view = reconstruct(w.events, w.idx);
  const done = w.idx >= w.events.length;
  root.append(el('div', { class: 'header' }, [
    el('h2', {}, [`観戦　`, el('span', { class: 'muted' }, `${tname(view.home)} vs ${tname(view.away)}`)]),
    el('div', { class: 'row' }, [el('button', { class: 'link', onclick: () => { game.watch = null; renderHub(); } }, 'ハブへ戻る')]),
  ]));
  root.append(scoreboard(view));
  root.append(el('div', { class: 'watchmid' }, [diamondSVG(view), benchBox(view)]));
  // 実況ログ
  root.append(el('div', { class: 'pbp' }, view.lines.map((ln) => el('div', { class: 'pbpline ' + (ln.cls || '') }, ln.text))));
  // コントロール
  const ctrl = el('div', { class: 'row', style: 'flex-wrap:wrap;margin-top:8px' });
  if (!done) {
    ctrl.append(el('button', { class: 'primary', onclick: () => { w.idx = nextPaIdx(w.events, w.idx); renderWatch(); } }, '▶ 次のプレー'));
    ctrl.append(el('button', { onclick: () => { w.idx = w.events.length; renderWatch(); } }, '最後まで'));
  } else {
    ctrl.append(el('div', { class: 'finalscore' }, `試合終了　${tname(view.home)} ${view.scoreH} - ${view.scoreA} ${tname(view.away)}`));
    ctrl.append(el('button', { class: 'primary', onclick: () => { game.watch = null; renderHub(); } }, 'ハブへ戻る'));
  }
  root.append(ctrl);
}

/** 次の pa まで idx を進める（実況の「打席前ポーズ」相当）。 */
function nextPaIdx(events, idx) {
  let i = idx;
  while (i < events.length && events[i].type !== 'pa') i++;
  return i < events.length ? i + 1 : events.length;
}

/** events[0..idx) を再生して観戦ビュー（スコア/塁/アウト/実況/残量）を組む。 */
function reconstruct(events, idx) {
  const v = {
    home: null, away: null, scoreH: 0, scoreA: 0,
    inning: 1, half: 'top', bases: 0, outs: 0,
    line: [], lines: [],
    myBull: 0, myBench: 0, myBullMax: 0, myBenchMax: 0,
  };
  const my = game.gs.playerTeamId;
  const addLine = (inning, half, r) => {
    let cell = v.line.find((x) => x.inning === inning);
    if (!cell) { cell = { inning, top: 0, bottom: 0 }; v.line.push(cell); }
    cell[half] += r;
  };
  for (let i = 0; i < idx && i < events.length; i++) {
    const e = events[i];
    if (e.type === 'start') {
      v.home = e.home; v.away = e.away;
      const meHome = e.home === my;
      v.myBull = v.myBullMax = (meHome ? e.homeBullpen : e.awayBullpen).length;
      v.myBench = v.myBenchMax = (meHome ? e.homeBench : e.awayBench).length;
      v.lines.push({ text: `プレイボール: ${tname(e.away)}（先攻） vs ${tname(e.home)}（後攻）`, cls: 'ev-start' });
    } else if (e.type === 'pa') {
      v.inning = e.inning; v.half = e.half; v.bases = e.basesAfter; v.outs = e.outsAfter;
      if (e.batTeam === v.home) { v.scoreH = e.batScore; v.scoreA = e.fldScore; }
      else { v.scoreA = e.batScore; v.scoreH = e.fldScore; }
      if (e.runsOnPlay) addLine(e.inning, e.half === 'bottom' ? 'bottom' : 'top', e.runsOnPlay);
      v.lines.push({ text: paNarration(e), cls: e.result === 'HR' ? 'ev-hr' : e.runsOnPlay ? 'ev-run' : '' });
    } else if (e.type === 'steal') {
      v.lines.push({ text: `　${pname(e.runnerId)} が盗塁${e.success ? '成功' : '失敗（盗塁死）'}`, cls: e.success ? 'ev-run' : '' });
    } else if (e.type === 'sub') {
      const mine = e.team === my;
      if (e.kind === 'RP') { if (mine) v.myBull = Math.max(0, v.myBull - 1); v.lines.push({ text: `　[${tname(e.team)}] 投手交代 → ${pname(e.inPid)}`, cls: 'ev-sub' }); }
      else if (e.kind === 'PH') { if (mine) v.myBench = Math.max(0, v.myBench - 1); v.lines.push({ text: `　[${tname(e.team)}] 代打 ${pname(e.inPid)}（← ${pname(e.outPid)}）`, cls: 'ev-sub' }); }
    } else if (e.type === 'end') {
      v.scoreH = e.homeScore; v.scoreA = e.awayScore;
      v.lines.push({ text: `試合終了: ${tname(v.home)} ${e.homeScore} - ${e.awayScore} ${tname(v.away)}${e.innings > 9 ? `（延長${e.innings}回）` : ''}`, cls: 'ev-start' });
    }
  }
  return v;
}

/** 打席結果の言語化（セイバー感: EV/LA/落下点）。 */
function paNarration(e) {
  const half = e.half === 'bottom' ? '裏' : '表';
  const head = `${e.inning}回${half} ${pname(e.batterId)}`;
  let body;
  if (e.outcome === 'K') body = '空振り三振';
  else if (e.outcome === 'BB') body = e.isIBB ? '申告敬遠' : '四球';
  else if (e.outcome === 'HBP') body = '死球';
  else if (e.result === 'E') body = '失策で出塁';
  else if (e.bb) {
    const ev = Math.round(e.bb.evKmh);
    const la = Math.round(e.bb.laDeg);
    const dist = Math.round(e.bb.distanceM);
    const dir = sprayDir(e.bb.sprayDeg);
    const q = `[EV${ev} LA${la}° ${dir}方向${dist}m]`;
    if (e.result === 'HR') body = `本塁打！ ${q}`;
    else if (e.result === '3B') body = `三塁打 ${q}`;
    else if (e.result === '2B') body = `二塁打 ${q}`;
    else if (e.result === '1B') body = `ヒット ${q}`;
    else body = `${BATTED_JP[e.battedType] || '打球'}アウト ${q}`;
  } else body = '凡退';
  const rbi = e.runsOnPlay ? `　${e.runsOnPlay}点!` : '';
  return `${head}: ${body}${rbi}`;
}

/** スコアボード（イニング別＋合計）。 */
function scoreboard(v) {
  const maxInn = Math.max(9, v.line.length, v.inning);
  const head = el('tr', {}, [el('th', { class: 'left' }, ''), ...Array.from({ length: maxInn }, (_, i) => el('th', {}, String(i + 1))), el('th', { class: 'rcol' }, 'R')]);
  const cell = (teamIsHome, inn) => {
    const c = v.line.find((x) => x.inning === inn + 1);
    if (!c) return '';
    const r = teamIsHome ? c.bottom : c.top;
    // 後攻がサヨナラ等で打っていない回は空欄
    return r || (inn + 1 <= v.inning ? '0' : '');
  };
  const rowFor = (teamId, isHome, total) => el('tr', { class: teamId === game.gs.playerTeamId ? 'myteam' : '' }, [
    el('td', { class: 'left' }, tname(teamId)),
    ...Array.from({ length: maxInn }, (_, i) => td(cell(isHome, i))),
    el('td', { class: 'rcol' }, String(total)),
  ]);
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat scoreboard' }, [
    el('thead', {}, head),
    el('tbody', {}, [rowFor(v.away, false, v.scoreA), rowFor(v.home, true, v.scoreH)]),
  ])]);
}

/** SVG <text> 要素（既存 svgEl は子を持たないため専用ヘルパで textContent を設定）。 */
function svgText(attrs, text) {
  const e = svgEl('text', attrs);
  e.textContent = text;
  return e;
}

/** ダイヤモンド盤面（SVG・占有塁＋アウトカウント）。 */
function diamondSVG(v) {
  const W = 200, H = 190;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'diamond' });
  const cx = W / 2, cy = 128, s = 46; // ホーム基準
  const home = [cx, cy], first = [cx + s, cy - s], second = [cx, cy - 2 * s], third = [cx - s, cy - s];
  svg.append(svgEl('polygon', { points: `${home} ${first} ${second} ${third}`, fill: '#123d2a', stroke: '#2f6b4a' }));
  const baseAt = (pt, occ) => svgEl('rect', { x: pt[0] - 8, y: pt[1] - 8, width: 16, height: 16, transform: `rotate(45 ${pt[0]} ${pt[1]})`, fill: occ ? '#e8b84b' : '#0c3122', stroke: '#c9a06a' });
  svg.append(baseAt(first, v.bases & 1));
  svg.append(baseAt(second, v.bases & 2));
  svg.append(baseAt(third, v.bases & 4));
  svg.append(svgEl('rect', { x: home[0] - 7, y: home[1] - 7, width: 14, height: 14, transform: `rotate(45 ${home[0]} ${home[1]})`, fill: '#f4f1e6' }));
  // アウトカウント
  for (let i = 0; i < 3; i++) svg.append(svgEl('circle', { cx: 24 + i * 16, cy: 172, r: 5, fill: i < v.outs ? '#e8b84b' : '#0c3122', stroke: '#c9a06a' }));
  svg.append(svgText({ x: 62, y: 176, fill: '#9fb8ac', 'font-size': '11' }, `${v.outs} OUT`));
  svg.append(svgText({ x: cx, y: 18, fill: '#e9e4d0', 'font-size': '12', 'text-anchor': 'middle' }, `${v.inning}回${v.half === 'bottom' ? '裏' : '表'}`));
  return svg;
}

/** ベンチ/ブルペン残量（自チーム）。 */
function benchBox(v) {
  const bar = (label, cur, max) => el('div', { class: 'resrow' }, [
    el('span', { class: 'reslabel' }, label),
    el('span', { class: 'restrack' }, [el('span', { class: 'resfill', style: `width:${max ? (cur / max) * 100 : 0}%` })]),
    el('span', { class: 'resval' }, `${cur}/${max}`),
  ]);
  return el('div', { class: 'benchbox' }, [
    el('div', { class: 'muted' }, `自チーム残量`),
    bar('ブルペン', v.myBull, v.myBullMax),
    bar('ベンチ', v.myBench, v.myBenchMax),
  ]);
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
    el('div', { class: 'row' }, [
      el('button', { onclick: () => renderHub('standings') }, '成績を見る'),
      el('button', { class: 'link', onclick: () => renderTitle() }, 'タイトルへ'),
    ]),
  ]));
  const ps = rt.postseason;
  if (ps && ps.champion) {
    root.append(el('div', { class: 'championbanner' }, `🏆 日本一: ${tname(ps.champion)}${ps.champion === gs.playerTeamId ? '（あなたの球団！）' : ''}`));
  }
  const content = el('div', { id: 'content' });
  root.append(content);
  renderStandings(content); // 2リーグ順位表＋ポストシーズンパネル（既存描画を再利用）
  root.append(el('div', { class: 'muted', style: 'margin-top:10px' }, '表彰（MVP/新人王/ベストナイン/タイトル）と複数年キャリアは後続フェーズ（C2/C4）で追加されます。'));
}

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
  return el('div', { class: 'setup' }, [
    el('h2', {}, '架空選手ペナント（12球団 / 143試合・2リーグ制）'),
    el('p', { class: 'muted' }, 'リーグシードごとに架空選手396人（12球団×33人）が生成されます。生成後は「▶ 再シミュレート」で、同じ選手のまま毎回ちがう乱数で別のシーズンを回せます。'),
    el('div', { class: 'row' }, [el('label', {}, 'リーグシード: '), seedInput, btn]),
    el('div', { id: 'status', class: 'muted' }, ''),
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

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
  playerBatting, playerPitching, playerBaserunning, winPct,
  hitterWAR, pitcherWAR, uzrRuns, centeredOAAOuts,
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
    el('h2', {}, '架空選手ペナント（6球団 / 140試合）'),
    el('p', { class: 'muted' }, 'リーグシードごとに架空選手198人が生成されます。生成後は「▶ 再シミュレート」で、同じ選手のまま毎回ちがう乱数で別のシーズンを回せます。'),
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
  const res = simulateSeason(state.league, state.cfg, { season: 2024 + state.seasonN, seed, collectSpray: true });
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

// --- 順位表 ---------------------------------------------------------------
function renderStandings(c) {
  const rows = state.res.standings.map((t, i) => el('tr', {}, [
    td(i + 1), td(t.name, 'left'), td(t.w), td(t.l), td(t.t),
    td(fmt3(winPct(t))), td(t.rs), td(t.ra), td((t.rs - t.ra > 0 ? '+' : '') + (t.rs - t.ra)),
  ]));
  c.append(table(['順', '球団', '勝', '敗', '分', '勝率', '得点', '失点', '差'], rows));
}

// --- 打撃 -----------------------------------------------------------------
const BAT_COLS = [
  ['name', '選手', 'left'], ['team', 'ﾁｰﾑ', 'left'], ['pos', '守', 'left'],
  ['war', 'WAR'], ['pa', '打席'], ['avg', '打率'], ['hr', '本'], ['rbi', '点'], ['sb', '盗'],
  ['obp', '出塁'], ['slg', '長打'], ['ops', 'OPS'], ['woba', 'wOBA'], ['wrcPlus', 'wRC+'],
  ['bsr', 'BsR'], ['bbPct', 'BB%'], ['kPct', 'K%'],
];
function renderBatting(c) {
  const data = state.res.playerSeasons
    .filter((s) => s.batting.pa >= 100)
    .map((s) => {
      const m = playerBatting(s, state.lc);
      const p = state.byId.get(s.playerId);
      const war = p.role === 'fielder' ? hitterWAR(s, state.cfg, state.lc).war : 0;
      const bsr = playerBaserunning(s, state.cfg, state.lc).bsr;
      return { id: s.playerId, name: p ? p.name : s.playerId, team: state.teamName.get(s.teamId) || s.teamId, pos: primaryPos(p), war, bsr, ...m };
    });
  c.append(statTable(data, BAT_COLS, ['avg', 'obp', 'slg', 'ops', 'woba'], ['bbPct', 'kPct'], 'war', 1));
}

// --- 投手 -----------------------------------------------------------------
const PIT_COLS = [
  ['name', '選手', 'left'], ['team', 'ﾁｰﾑ', 'left'], ['war', 'WAR'],
  ['w', '勝'], ['l', '敗'], ['sv', 'S'], ['ip', '回'], ['era', '防御'], ['fip', 'FIP'],
  ['so', '奪三'], ['kPer9', 'K/9'], ['whip', 'WHIP'], ['bbPct', 'BB%'],
];
function renderPitching(c) {
  const data = state.res.playerSeasons
    .filter((s) => s.pitching.outs / 3 >= 20)
    .map((s) => {
      const m = playerPitching(s, state.lc);
      const p = state.byId.get(s.playerId);
      return { id: s.playerId, name: p ? p.name : s.playerId, team: state.teamName.get(s.teamId) || s.teamId, war: pitcherWAR(s, state.cfg, state.lc).war, ...m };
    });
  c.append(statTable(data, PIT_COLS, ['era', 'fip', 'whip'], ['bbPct'], 'war', 1));
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
      el('th', { class: (align || '') + (state.sort.key === k ? ' sorted' : ''), onclick: () => { state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 }; render(); } }, label + (state.sort.key === k ? (dir < 0 ? ' ▼' : ' ▲') : '')),
    ));
    const rows = sorted.map((d) => el('tr', { class: 'clickable', onclick: () => openModal(d.id) }, cols.map(([k, , align]) => {
      let v = d[k];
      if (typeof v === 'number') {
        if (fmtDec3.includes(k)) v = fmt3(v);
        else if (fmtPct.includes(k)) v = pct(v);
        else if (k === 'ip' || k === 'inn') v = v.toFixed(1);
        else if (k === 'war') v = v.toFixed(1);
        else if (k === 'oaa' || k === 'uzr' || k === 'bsr') v = (v > 0 ? '+' : '') + v.toFixed(1);
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

// --- 選手モーダル（能力バー＋スプレーチャート） ----------------------------
function openModal(playerId) {
  const p = state.byId.get(playerId);
  const s = state.res.statsById.get(playerId);
  if (!p || !s) return;
  const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const box = el('div', { class: 'modal' });
  box.append(el('div', { class: 'modalhead' }, [
    el('div', {}, [el('span', { class: 'pname' }, p.name), el('span', { class: 'muted' }, `  ${state.teamName.get(p.teamId) || ''} / ${p.role === 'pitcher' ? '投手' : primaryPos(p)} / ${p.age}歳 / ${p.bats}打${p.throws}投`)]),
    el('button', { class: 'link', onclick: () => overlay.remove() }, '✕'),
  ]));

  // 成績サマリ
  if (p.role === 'pitcher') {
    const m = playerPitching(s, state.lc);
    const pw = pitcherWAR(s, state.cfg, state.lc);
    box.append(kv([['WAR', pw.war.toFixed(1)], ['登板', m.g], ['勝', m.w], ['敗', m.l], ['S', m.sv], ['投球回', m.ip.toFixed(1)], ['防御率', f2(m.era)], ['FIP', f2(m.fip)], ['奪三', m.so], ['K/9', f2(m.kPer9)]]));
  } else {
    const m = playerBatting(s, state.lc);
    box.append(kv([['打席', m.pa], ['打率', fmt3(m.avg)], ['本塁打', m.hr], ['打点', m.rbi], ['盗塁', m.sb], ['出塁', fmt3(m.obp)], ['長打', fmt3(m.slg)], ['OPS', fmt3(m.ops)], ['wOBA', fmt3(m.woba)], ['wRC+', m.wrcPlus.toFixed(0)]]));
    // WAR内訳（打/走/守/位）
    const w = hitterWAR(s, state.cfg, state.lc);
    box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, `WAR ${w.war.toFixed(1)} 内訳`));
    box.append(kv([['打wRAA', w.wraa.toFixed(1)], ['走BsR', w.bsr.toFixed(1)], ['守UZR', w.uzr.toFixed(1)], ['位置', w.posAdj.toFixed(1)], ['OAA', centeredOAAOuts(s, state.lc).toFixed(1)]]));
    // 対球種成績（§4段階1）
    const vf = s.batting.vsFastball;
    const vb = s.batting.vsBreaking;
    const avgOf = (x) => (x.ab ? fmt3(x.h / x.ab) : '-');
    box.append(el('div', { class: 'muted', style: 'margin-top:8px' }, '対球種成績（打率 / 本）'));
    box.append(kv([['対速球', `${avgOf(vf)} / ${vf.hr}`], ['対変化球', `${avgOf(vb)} / ${vb.hr}`]]));
    // スプレーチャート
    const arr = state.res.spray && state.res.spray.get(playerId);
    if (arr && arr.length) box.append(el('div', { class: 'spraywrap' }, [el('div', { class: 'muted' }, `スプレーチャート（${arr.length}打球）`), sprayChart(arr)]));
  }

  // 能力バー
  box.append(el('div', { class: 'muted', style: 'margin-top:10px' }, '能力（真の実力）'));
  box.append(abilityBars(p.trueAbility, p.role));
  overlay.append(box);
  document.getElementById('app').append(overlay);
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
  const color = (res) => res === 'HR' ? '#e8b84b' : res === '2B' || res === '3B' ? '#5aa9e6' : res === '1B' ? '#f4f1e6' : '#6d7f74';
  for (const b of balls) {
    const [x, y] = pt(b.sprayDeg, Math.min(b.distanceM, 130));
    svg.append(svgEl('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: b.result === 'HR' ? 3.2 : 2.2, fill: color(b.result), opacity: 0.85 }));
  }
  svg.append(svgEl('circle', { cx: hx, cy: hy, r: 3, fill: '#fff' }));
  return svg;
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

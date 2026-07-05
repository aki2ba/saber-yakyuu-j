// ============================================================================
// フェーズE1: ハブ「チーム」タブ — 自チーム選手一覧（一軍=支配下 / 二軍=育成）
//
// ユーザーフィードバック（phaseE_spec）「自チームの選手一覧がない・二軍が見えない」への対応。
// 設計原則:
//   - 三層構造: 表に出すのは当年の観測成績＋WAR（観測から算出）と「コーチの見立て」等級
//     （scoutSeed 由来の決定論ノイズ・ui.mjs の scoutBars と同じ座標系）。真値は出さない。
//   - 表示のみ: 本モジュールは gs/rt を読むだけで一切書かない（決定論に無関係）。
//   - バンドル: build.mjs が src/ui/*.mjs を ui.mjs と同じ<script>へ前置 concat する。
//     import 行は剥がれてエンジンのグローバルを参照する（開発時 Node 解決用に import も書く）。
//     ui.mjs のヘルパー（el/td/openModal/state/game 等）は名前衝突とNode循環importを避けるため
//     引数 u（deps オブジェクト・ui.mjs の teamTabDeps()）で受け取る。
// ============================================================================
import { playerBatting, playerPitching, hitterWAR, pitcherWAR, makeRng, hashSeed } from '../engine.mjs';

// タブ内ビュー状態（UIローカル。セーブ非対象＝ゲーム状態を一切変えない）。
const teamTabView = {
  sub: 'active', // 'active'=一軍(支配下) | 'farm'=二軍(育成)
  batSort: { key: 'war', dir: -1 },
  pitSort: { key: 'war', dir: -1 },
};

// 列定義 [key, label, align]（phaseE_spec E1 の列構成）。
const TEAM_BAT_COLS = [
  ['name', '選手', 'left'], ['pos', '位置', 'left'], ['age', '年齢'], ['pa', '打席'],
  ['avg', '打率'], ['obp', '出塁'], ['slg', '長打'], ['ops', 'OPS'], ['hr', '本'], ['rbi', '打点'], ['sb', '盗塁'],
  ['wrcPlus', 'wRC+'], ['war', 'WAR'], ['grade', '等級'], ['status', '状態', 'left'],
];
const TEAM_PIT_COLS = [
  ['name', '選手', 'left'], ['prole', '役割', 'left'], ['age', '年齢'], ['g', '登板'], ['ip', '回'],
  ['era', '防御'], ['fip', 'FIP'], ['whip', 'WHIP'], ['kbbPct', 'K-BB%'], ['sv', 'S'], ['hld', 'H'],
  ['war', 'WAR'], ['grade', '等級'], ['status', '状態', 'left'],
];
// セル書式（キー別）。無観測（null）は '-'。
const TEAM_COL_FMT3 = new Set(['avg', 'obp', 'slg', 'ops']);
const TEAM_COL_F2 = new Set(['era', 'fip', 'whip']);
const TEAM_COL_PCT = new Set(['kbbPct']);
const TEAM_COL_ASC = new Set(['era', 'fip', 'whip', 'age']); // クリック時に昇順が自然な列

/**
 * ハブ「チーム」タブ本体。c=コンテンツ要素、u=ui.mjs の共有ヘルパー束（teamTabDeps()）。
 * 呼び出し前に refreshRes() 済み（state.res/state.lc が当年観測を指す）であること。
 */
export function renderTeamTab(c, u) {
  const { el, state, game } = u;
  const gs = game.gs;
  const myId = gs.playerTeamId;
  const actives = gs.league.players.filter((p) => p.teamId === myId);
  const farm = (gs.league.farm ?? []).filter((p) => p.teamId === myId);
  const sub = teamTabView.sub;
  // サブタブ: 一軍(支配下) / 二軍(育成)
  c.append(el('div', { class: 'subtabs' }, [
    el('button', { class: 'subtab' + (sub === 'active' ? ' active' : ''), onclick: () => { teamTabView.sub = 'active'; u.rerender(); } }, `一軍・支配下（${actives.length}人）`),
    el('button', { class: 'subtab' + (sub === 'farm' ? ' active' : ''), onclick: () => { teamTabView.sub = 'farm'; u.rerender(); } }, `二軍・育成（${farm.length}人）`),
  ]));
  const players = sub === 'active' ? actives : farm;
  if (!players.length) {
    c.append(el('div', { class: 'muted', style: 'margin:8px 0' },
      sub === 'farm'
        ? '育成選手はまだいません。育成契約（ドラフト外）は翌年以降のオフシーズンで発生します。'
        : '選手がいません。'));
    return;
  }
  c.append(el('div', { class: 'muted', style: 'margin:4px 0' },
    (sub === 'farm' ? '育成選手は一軍公式戦に出場しないため観測成績は「-」。' : '成績は今季の観測値。')
    + '等級=コーチの見立て（スカウト評価の総合・真の実力ではない）。列見出しでソート、行クリックで選手詳細。'));
  const rows = buildTeamRosterRows(players, u);
  c.append(el('h3', { class: 'leaguename' }, `野手（${rows.bat.length}人）`));
  if (rows.bat.length) c.append(teamRosterTable(rows.bat, TEAM_BAT_COLS, teamTabView.batSort, u));
  else c.append(el('div', { class: 'muted' }, '—'));
  c.append(el('h3', { class: 'leaguename' }, `投手（${rows.pit.length}人）`));
  if (rows.pit.length) c.append(teamRosterTable(rows.pit, TEAM_PIT_COLS, teamTabView.pitSort, u));
  else c.append(el('div', { class: 'muted' }, '—'));
}

/** 有限数のみ返す（0除算由来の NaN/Infinity は無観測扱い＝'-'）。 */
function finiteOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

/** 選手配列 → 野手/投手の行データ（当年観測＋WAR＋等級＋故障状態）。 */
function buildTeamRosterRows(players, u) {
  const { state, game } = u;
  const gs = game.gs;
  const rt = gs.rt;
  // 現在離脱中（開幕ILの残り）: ハブの故障者リストと同じ判定（renderHubHome と同ロジック）。
  const curDay = u.pendingDayOf(rt) - 1;
  const injured = new Map();
  for (const e of rt.seasonInjuries ?? []) {
    if (e.gamesLost > curDay) injured.set(e.id, e);
  }
  const bat = [];
  const pit = [];
  for (const p of players) {
    const s = state.res && state.res.statsById ? state.res.statsById.get(p.id) : null;
    const inj = injured.get(p.id);
    const status = inj ? `離脱中(残${inj.gamesLost - curDay})` : '';
    const grade = teamScoutGrade(p, state.cfg, u);
    if (p.role === 'pitcher') {
      const has = !!s && (s.pitching.g > 0 || s.pitching.outs > 0);
      const m = has ? playerPitching(s, state.lc, state.cfg) : null;
      pit.push({
        id: p.id, name: p.name, age: p.age,
        prole: m ? (m.gs * 2 >= m.g ? '先発' : '救援') : '-',
        g: m ? m.g : null, ip: m ? finiteOrNull(m.ip) : null,
        era: m ? finiteOrNull(m.era) : null, fip: m ? finiteOrNull(m.fip) : null,
        whip: m ? finiteOrNull(m.whip) : null, kbbPct: m ? finiteOrNull(m.kbbPct) : null,
        sv: m ? m.sv : null, hld: m ? m.hld : null,
        war: has ? finiteOrNull(pitcherWAR(s, state.cfg, state.lc).war) : null,
        grade, status,
      });
    } else {
      const has = !!s && s.batting.pa > 0;
      const m = has ? playerBatting(s, state.lc) : null;
      bat.push({
        id: p.id, name: p.name, age: p.age, pos: u.posJP(u.primaryPos(p)),
        pa: m ? m.pa : null, avg: m ? finiteOrNull(m.avg) : null, obp: m ? finiteOrNull(m.obp) : null,
        slg: m ? finiteOrNull(m.slg) : null, ops: m ? finiteOrNull(m.ops) : null,
        hr: m ? m.hr : null, rbi: m ? m.rbi : null, sb: m ? m.sb : null,
        wrcPlus: m ? finiteOrNull(m.wrcPlus) : null,
        war: has ? finiteOrNull(hitterWAR(s, state.cfg, state.lc).war) : null,
        grade, status,
      });
    }
  }
  return { bat, pit };
}

/**
 * コーチの見立て・総合等級（S/A/B/C/D/E）。ui.mjs の scoutBars と同じ観測座標
 * (scoutSeed,'coachView',軸キー) で軸ごとに決定論ノイズを乗せ、主要軸の平均を等級化する。
 * 何度描画しても同じ等級（決定論）・真値そのものは出さない（三層構造 layer3）。
 * E3: ストーブリーグ画面（stove.mjs）も同じ見立てを使うため export する。
 */
export function teamScoutGrade(p, cfg, u) {
  const t = p.trueAbility;
  const cl20 = (x) => Math.max(20, Math.min(80, x));
  const sd = (cfg?.tuning?.mgr?.scoutSd ?? 5) * 1.4;
  const seed = p.scoutSeed ?? hashSeed(p.id, 'scout');
  const obs = (key, v) => cl20(v + makeRng(hashSeed(seed, 'coachView', key)).normal(0, sd));
  let axes;
  if (p.role === 'pitcher') {
    const pi = t.pitching;
    const veloR = cl20(50 + (pi.velocityKmh - 146) * 2);
    axes = [obs('velo', veloR), obs('control', pi.control), obs('stamina', pi.stamina)];
    if (pi.pitches.length) {
      let sum = 0;
      pi.pitches.forEach((x, i) => { sum += obs('pitch' + i, x.current); });
      axes.push(sum / pi.pitches.length);
    }
  } else {
    const b = t.batting;
    axes = [obs('ev', b.ev), obs('la', b.la), obs('contact', b.contact), obs('eye', b.eye), obs('speed', t.common.speed)];
  }
  const v = axes.reduce((a, x) => a + x, 0) / axes.length;
  return u.scoutGrade(v);
}

/** セル書式（列キー別・null='-'）。 */
function teamRosterCell(k, v, u) {
  if (v == null || v === '') return v === '' ? '' : '-';
  if (typeof v !== 'number') return v;
  if (TEAM_COL_FMT3.has(k)) return u.fmt3(v);
  if (TEAM_COL_F2.has(k)) return v.toFixed(2);
  if (TEAM_COL_PCT.has(k)) return u.pct(v);
  if (k === 'ip') return v.toFixed(1);
  if (k === 'war') return v.toFixed(1);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** ソート可能な選手一覧テーブル（statTable の流儀・独立ソート状態・null は常に末尾）。 */
function teamRosterTable(data, cols, sort, u) {
  const { el, td } = u;
  const wrap = el('div', { class: 'tablewrap' });
  const render = () => {
    wrap.innerHTML = '';
    const { key, dir } = sort;
    const sorted = [...data].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // 無観測は昇降に依らず末尾
      if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return dir * String(av).localeCompare(String(bv));
      return dir * (av - bv);
    });
    const head = el('tr', {}, cols.map(([k, label, align]) => el('th', {
      class: (align || '') + (key === k ? ' sorted' : ''),
      onclick: () => {
        if (sort.key === k) sort.dir = -sort.dir;
        else { sort.key = k; sort.dir = TEAM_COL_ASC.has(k) ? 1 : -1; }
        render();
      },
    }, label + (key === k ? (dir < 0 ? ' ▼' : ' ▲') : ''))));
    const rows = sorted.map((d) => el('tr', { class: 'clickable', onclick: () => u.openModal(d.id) },
      cols.map(([k, , align]) => td(teamRosterCell(k, d[k], u), align))));
    wrap.append(el('table', { class: 'stat' }, [el('thead', {}, head), el('tbody', {}, rows)]));
  };
  render();
  return wrap;
}

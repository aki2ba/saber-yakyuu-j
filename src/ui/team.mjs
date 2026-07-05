// ============================================================================
// フェーズE1→F2-4: ハブ「チーム」タブ — 自チーム選手一覧
//   一軍サブタブ = 出場登録29人（rt.registeredByTeam・一軍成績列）
//   二軍サブタブ = 支配下の登録外＋育成（rt.farm.rosterByTeam・**二軍成績列**＋育成バッジ）
//
// ユーザーフィードバック（phaseE_spec→phaseF_spec F2-4）「二軍の実成績が見たい」への対応。
// 設計原則:
//   - 三層構造: 表に出すのは当年の観測成績（一軍=rt.stats／二軍=rt.farm.stats）＋WAR（観測から算出）
//     と「コーチの見立て」等級（scoutSeed 由来の決定論ノイズ・ui.mjs の scoutBars と同じ座標系）。
//     真値は出さない。二軍のWAR/wRC+は出さない（二軍リーグは水準が異なり一軍WARと混同するため）。
//   - 表示のみ: 本モジュールは gs/rt を読むだけで一切書かない（決定論に無関係）。
//   - バンドル: build.mjs が src/ui/*.mjs を ui.mjs と同じ<script>へ前置 concat する。
//     import 行は剥がれてエンジンのグローバルを参照する（開発時 Node 解決用に import も書く）。
//     ui.mjs のヘルパー（el/td/openModal/state/game 等）は名前衝突とNode循環importを避けるため
//     引数 u（deps オブジェクト・ui.mjs の teamTabDeps()）で受け取る。
// ============================================================================
import { playerBatting, playerPitching, hitterWAR, pitcherWAR, makeRng, hashSeed, deriveLeagueConstants } from '../engine.mjs';

// タブ内ビュー状態（UIローカル。セーブ非対象＝ゲーム状態を一切変えない）。
const teamTabView = {
  sub: 'active', // 'active'=一軍(出場登録29) | 'farm'=二軍(支配下残+育成)
  batSort: { key: 'war', dir: -1 },
  pitSort: { key: 'war', dir: -1 },
  farmBatSort: { key: 'pa', dir: -1 }, // 二軍はWAR列が無いため打席/回を既定ソートに
  farmPitSort: { key: 'ip', dir: -1 },
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
// F2-4: 二軍サブタブの列＝**二軍成績列**（farmStats観測値）。WAR/wRC+はリーグ水準差のため非表示。
const FARM_BAT_COLS = [
  ['name', '選手', 'left'], ['pos', '位置', 'left'], ['age', '年齢'], ['pa', '二軍打席'],
  ['avg', '二軍打率'], ['obp', '出塁'], ['slg', '長打'], ['ops', 'OPS'], ['hr', '本'], ['rbi', '打点'], ['sb', '盗塁'],
  ['grade', '等級'], ['status', '状態', 'left'],
];
const FARM_PIT_COLS = [
  ['name', '選手', 'left'], ['prole', '役割', 'left'], ['age', '年齢'], ['g', '二軍登板'], ['ip', '回'],
  ['era', '二軍防御'], ['whip', 'WHIP'], ['kbbPct', 'K-BB%'], ['so', '奪三'], ['sv', 'S'],
  ['grade', '等級'], ['status', '状態', 'left'],
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
  const rt = gs.rt;
  const myId = gs.playerTeamId;
  const teamPlayers = gs.league.players.filter((p) => p.teamId === myId);
  // 一軍＝出場登録（F2-2: rt.registeredByTeam。旧セーブ/ミニ構成で無ければ支配下全員＝旧挙動）。
  const reg = rt.registeredByTeam ? rt.registeredByTeam.get(myId) : null;
  const actives = reg ? teamPlayers.filter((p) => reg.has(p.id)) : teamPlayers;
  // 二軍＝支配下の登録外＋育成。farm ランタイム成立時はそのロスター（昇降格が即時反映される）。
  const farmRoster = rt.farm
    ? (rt.farm.rosterByTeam.get(myId) ?? [])
    : teamPlayers.filter((p) => !reg || !reg.has(p.id)).concat((gs.league.farm ?? []).filter((p) => p.teamId === myId));
  const sub = teamTabView.sub;
  const nMinor = farmRoster.filter((p) => p.rosterStatus === 'minor').length;
  // サブタブ: 一軍(出場登録) / 二軍(支配下残+育成)
  c.append(el('div', { class: 'subtabs' }, [
    el('button', { class: 'subtab' + (sub === 'active' ? ' active' : ''), onclick: () => { teamTabView.sub = 'active'; u.rerender(); } }, `一軍・出場登録（${actives.length}人）`),
    el('button', { class: 'subtab' + (sub === 'farm' ? ' active' : ''), onclick: () => { teamTabView.sub = 'farm'; u.rerender(); } }, `二軍・支配下＋育成（${farmRoster.length}人）`),
  ]));
  const players = sub === 'active' ? actives : farmRoster;
  if (!players.length) {
    c.append(el('div', { class: 'muted', style: 'margin:8px 0' }, '選手がいません。'));
    return;
  }
  const isFarm = sub === 'farm';
  c.append(el('div', { class: 'muted', style: 'margin:4px 0' },
    (isFarm
      ? `成績は今季の二軍戦（ファーム）観測値。「育成」バッジ=育成契約（支配下70人枠の外・${nMinor}人）。`
      : '成績は今季の一軍観測値。')
    + '等級=コーチの見立て（スカウト評価の総合・真の実力ではない）。列見出しでソート、行クリックで選手詳細。'));
  const rows = isFarm ? buildFarmRosterRows(players, u) : buildTeamRosterRows(players, u);
  const batCols = isFarm ? FARM_BAT_COLS : TEAM_BAT_COLS;
  const pitCols = isFarm ? FARM_PIT_COLS : TEAM_PIT_COLS;
  const batSort = isFarm ? teamTabView.farmBatSort : teamTabView.batSort;
  const pitSort = isFarm ? teamTabView.farmPitSort : teamTabView.pitSort;
  c.append(el('h3', { class: 'leaguename' }, `野手（${rows.bat.length}人）`));
  if (rows.bat.length) c.append(teamRosterTable(rows.bat, batCols, batSort, u));
  else c.append(el('div', { class: 'muted' }, '—'));
  c.append(el('h3', { class: 'leaguename' }, `投手（${rows.pit.length}人）`));
  if (rows.pit.length) c.append(teamRosterTable(rows.pit, pitCols, pitSort, u));
  else c.append(el('div', { class: 'muted' }, '—'));
}

/** 有限数のみ返す（0除算由来の NaN/Infinity は無観測扱い＝'-'）。 */
function finiteOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

/** 現在離脱中（開幕ILの残り）の pid→イベント（ハブの故障者リストと同じ判定）。 */
function injuredMap(u) {
  const rt = u.game.gs.rt;
  const curDay = u.pendingDayOf(rt) - 1;
  const injured = new Map();
  for (const e of rt.seasonInjuries ?? []) {
    if (e.gamesLost > curDay) injured.set(e.id, e);
  }
  return { injured, curDay };
}

/** 選手配列 → 野手/投手の行データ（一軍サブタブ: 当年一軍観測＋WAR＋等級＋故障状態）。 */
function buildTeamRosterRows(players, u) {
  const { state } = u;
  const { injured, curDay } = injuredMap(u);
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
 * F2-4: 選手配列 → 野手/投手の行データ（二軍サブタブ: 当年**二軍**観測＝rt.farm.stats）。
 * 二軍のリーグ定数は farmStats＋farm順位表から導出（一軍と別水準。序盤の空観測でも安全に動く）。
 * minor=育成契約フラグ（名前セルにバッジ表示）。
 */
function buildFarmRosterRows(players, u) {
  const { state, game } = u;
  const rt = game.gs.rt;
  const farmStats = rt.farm ? rt.farm.stats.stats : new Map();
  // 二軍リーグ定数（wOBA スケール等の内部計算用。表には水準依存のWAR/wRC+を出さない）。
  const flc = rt.farm
    ? deriveLeagueConstants({ playerSeasons: [...farmStats.values()], standings: [...rt.farm.standings.values()] })
    : state.lc;
  const { injured, curDay } = injuredMap(u);
  const bat = [];
  const pit = [];
  for (const p of players) {
    const s = farmStats.get(p.id) ?? null;
    const inj = injured.get(p.id);
    const status = inj ? `離脱中(残${inj.gamesLost - curDay})` : '';
    const grade = teamScoutGrade(p, state.cfg, u);
    const minor = p.rosterStatus === 'minor';
    if (p.role === 'pitcher') {
      const has = !!s && (s.pitching.g > 0 || s.pitching.outs > 0);
      const m = has ? playerPitching(s, flc, state.cfg) : null;
      pit.push({
        id: p.id, name: p.name, age: p.age, minor,
        prole: m ? (m.gs * 2 >= m.g ? '先発' : '救援') : '-',
        g: m ? m.g : null, ip: m ? finiteOrNull(m.ip) : null,
        era: m ? finiteOrNull(m.era) : null, whip: m ? finiteOrNull(m.whip) : null,
        kbbPct: m ? finiteOrNull(m.kbbPct) : null, so: m ? m.so : null, sv: m ? m.sv : null,
        grade, status,
      });
    } else {
      const has = !!s && s.batting.pa > 0;
      const m = has ? playerBatting(s, flc) : null;
      bat.push({
        id: p.id, name: p.name, age: p.age, minor, pos: u.posJP(u.primaryPos(p)),
        pa: m ? m.pa : null, avg: m ? finiteOrNull(m.avg) : null, obp: m ? finiteOrNull(m.obp) : null,
        slg: m ? finiteOrNull(m.slg) : null, ops: m ? finiteOrNull(m.ops) : null,
        hr: m ? m.hr : null, rbi: m ? m.rbi : null, sb: m ? m.sb : null,
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

/**
 * セル値（列キー別・null='-'）。name 列は育成バッジ（F2-4）を含む要素を返すことがある
 * （呼び出し側 teamRosterTable が要素/文字列の両方を td へ収める）。
 */
function teamRosterCell(k, d, u) {
  if (k === 'name' && d.minor) {
    // 育成契約バッジ（F2-4）: 二軍サブタブで「支配下の二軍」と「育成」を一目で区別する。
    return u.el('span', {}, [String(d.name), u.el('span', { class: 'devbadge' }, '育成')]);
  }
  const v = d[k];
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
      cols.map(([k, , align]) => {
        const cell = teamRosterCell(k, d, u);
        // 要素セル（育成バッジ付き名前）は td 文字列化を避けて直接収める。
        return typeof cell === 'object' && cell !== null ? el('td', { class: align || '' }, [cell]) : td(cell, align);
      })));
    wrap.append(el('table', { class: 'stat' }, [el('thead', {}, head), el('tbody', {}, rows)]));
  };
  render();
  return wrap;
}

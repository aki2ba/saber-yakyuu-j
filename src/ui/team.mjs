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
import { playerBatting, playerPitching, hitterWAR, pitcherWAR, deriveLeagueConstants, uzrRuns, totalFieldInnings, playerBaserunning } from '../engine.mjs';
// H4: 「コーチの見立て」総合スカラーはヘッドレス層（game/training.mjs）が持つ（真値+スカウトノイズの
//   観測式・キャンプ成果の前後差にも使う共通式）。ここでは等級化(scoutGrade)だけを担う。
import { coachOverallScore } from '../game/training.mjs';
// Wave B（thyroxin/specs/gm_analytics_spec.md）: フォーム判定（好調▲/不調▼）バッジ。一軍一覧のみ。
//   teamFormMap で全選手ぶんの tier を軽量に取り、hot/cold の選手だけ playerFormOf で reasons を
//   取り直す（ホバー表示用・該当者は少数なので軽い）。
import { playerFormOf, teamFormMap } from '../game/form.mjs';
// Wave C（thyroxin/specs/gm_analytics_spec.md）: GMボード（弱点・飽和・有望若手・トレード相手サジェスト）。
//   すべて純関数・観測statline/farmStatsのみ（真値非参照）。表示はチームタブの「GM」サブタブ。
import { positionStrengthMap, prospectWatch, tradeTargetSuggestions, ownDepthSolutions, GB_POSITIONS, gbPosLabel } from '../game/gmBoard.mjs';

// タブ内ビュー状態（UIローカル。セーブ非対象＝ゲーム状態を一切変えない）。
const teamTabView = {
  sub: 'active', // 'active'=一軍(出場登録29) | 'farm'=二軍(支配下残+育成)
  batSort: { key: 'war', dir: -1 },
  pitSort: { key: 'war', dir: -1 },
  farmBatSort: { key: 'pa', dir: -1 }, // 二軍はWAR列が無いため打席/回を既定ソートに
  farmPitSort: { key: 'ip', dir: -1 },
};

// 列定義 [key, label, align]（phaseE_spec E1 の列構成）。
// ★ユーザー指摘「走塁指標も指標のとこに出てない」対応: WAR列の隣にBsR列（走塁の総合run換算）を追加。
const TEAM_BAT_COLS = [
  ['name', '選手', 'left'], ['pos', '位置', 'left'], ['age', '年齢'], ['pa', '打席'],
  ['avg', '打率'], ['obp', '出塁'], ['slg', '長打'], ['ops', 'OPS'], ['hr', '本'], ['rbi', '打点'], ['sb', '盗塁'],
  ['wrcPlus', 'wRC+'], ['war', 'WAR'], ['bsr', 'BsR'], ['grade', '等級'], ['status', '状態', 'left'],
];
const TEAM_PIT_COLS = [
  ['name', '選手', 'left'], ['prole', '役割', 'left'], ['age', '年齢'], ['g', '登板'], ['ip', '回'],
  ['era', '防御'], ['fip', 'FIP'], ['whip', 'WHIP'], ['kbbPct', 'K-BB%'], ['sv', 'S'], ['hld', 'H'],
  ['war', 'WAR'], ['grade', '等級'], ['status', '状態', 'left'],
];
// F2-4: 二軍サブタブの列＝**二軍成績列**（farmStats観測値）。WAR/wRC+はリーグ水準差のため非表示。
// ★R4: 二軍の守備(UZR)・走塁(BsR)も表示する。集計器は積んでいたのに表にも査定にも出しておらず、
//   「守備の上手い二軍野手」が可視化されず球団AIも見ていなかった（ユーザー指摘）。
//   得点値は二軍のリーグ定数（farmStats＋二軍順位表から導出）基準＝二軍平均に対する上積み。
const FARM_BAT_COLS = [
  ['name', '選手', 'left'], ['pos', '位置', 'left'], ['age', '年齢'], ['pa', '二軍打席'],
  ['avg', '二軍打率'], ['obp', '出塁'], ['slg', '長打'], ['ops', 'OPS'], ['hr', '本'], ['rbi', '打点'], ['sb', '盗塁'],
  ['uzr', '守備'], ['bsr', '走塁'],
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
const TEAM_COL_F1 = new Set(['uzr', 'bsr']); // R4: 二軍の守備/走塁 ＋ 一軍のBsR（得点値・小数1桁）
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

  // G4b: 冒頭に離脱者サマリ（ホームの故障者リストを撤去し統合＝三重表示の解消）。
  //   ホームと同じ判定（seasonInjuries・自チーム・残り離脱日数>0）。0名なら出さない。
  const curDay0 = u.pendingDayOf(rt) - 1;
  const injuredCount = (rt.seasonInjuries ?? [])
    .filter((e) => e.teamId === myId && e.gamesLost > curDay0).length;
  if (injuredCount) {
    c.append(el('div', { class: 'muted', style: 'margin:4px 0' }, [
      `離脱中: ${injuredCount}名　`,
      el('button', { class: 'link', onclick: () => u.gotoNews() }, '→ニュース'),
    ]));
  }

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
  // サブタブ: 一軍(出場登録) / 二軍(支配下残+育成) / 采配(G4b: ホームの采配パネルを移設) /
  //   GM(Wave C: 弱点・飽和・有望若手・トレードサジェスト。既存ボタンの文言は変更しない＝末尾に追加)
  c.append(el('div', { class: 'subtabs' }, [
    el('button', { class: 'subtab' + (sub === 'active' ? ' active' : ''), onclick: () => { teamTabView.sub = 'active'; u.rerender(); } }, `一軍・出場登録（${actives.length}人）`),
    el('button', { class: 'subtab' + (sub === 'farm' ? ' active' : ''), onclick: () => { teamTabView.sub = 'farm'; u.rerender(); } }, `二軍・支配下＋育成（${farmRoster.length}人）`),
    el('button', { class: 'subtab' + (sub === 'manager' ? ' active' : ''), onclick: () => { teamTabView.sub = 'manager'; u.rerender(); } }, '采配'),
    el('button', { class: 'subtab' + (sub === 'gm' ? ' active' : ''), onclick: () => { teamTabView.sub = 'gm'; u.rerender(); } }, 'GM'),
  ]));
  if (sub === 'manager') {
    // G4b: renderManagerPanel は再描画コールバック引数化済み。u.rerender（チームタブ再描画）を渡すことで
    //   方針変更後もチームタブ（采配サブタブ）に留まる（引数なし版=renderHub()直呼びだとホームへ強制遷移する回帰を避ける）。
    c.append(u.renderManagerPanel(() => u.rerender()));
    return;
  }
  if (sub === 'gm') {
    renderGmSubtab(c, u);
    return;
  }
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
  // Wave B: フォーム判定バッジは一軍一覧のみ（窓データ=playerGameLogは一軍試合のみのため）。
  const formMap = isFarm ? null : teamFormMap(gs);
  const rows = isFarm ? buildFarmRosterRows(players, u) : buildTeamRosterRows(players, u, formMap, gs);
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

/**
 * 選手配列 → 野手/投手の行データ（一軍サブタブ: 当年一軍観測＋WAR＋等級＋故障状態）。
 * formMap（Wave B・teamFormMap(gs)の結果）が渡されれば名前セルに好調▲/不調▼バッジを付ける
 * （gs=game.gsが必要・hot/coldの選手だけ playerFormOf で reasons 先頭をホバー用に取り直す）。
 */
function buildTeamRosterRows(players, u, formMap = null, gs = null) {
  const { state } = u;
  const { injured, curDay } = injuredMap(u);
  const bat = [];
  const pit = [];
  for (const p of players) {
    const s = state.res && state.res.statsById ? state.res.statsById.get(p.id) : null;
    const inj = injured.get(p.id);
    const status = inj ? `離脱中(残${inj.gamesLost - curDay})` : '';
    const grade = teamScoutGrade(p, state.cfg, u);
    const formTier = formMap ? formMap.get(p.id) ?? null : null;
    const formReason = (formTier === 'hot' || formTier === 'cold') && gs
      ? playerFormOf(gs, p.id).reasons[0]?.text ?? ''
      : '';
    if (p.role === 'pitcher') {
      const has = !!s && (s.pitching.g > 0 || s.pitching.outs > 0);
      const m = has ? playerPitching(s, state.lc, state.cfg) : null;
      pit.push({
        id: p.id, name: p.name, age: p.age, formTier, formReason,
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
        id: p.id, name: p.name, age: p.age, pos: u.posJP(u.primaryPos(p)), formTier, formReason,
        pa: m ? m.pa : null, avg: m ? finiteOrNull(m.avg) : null, obp: m ? finiteOrNull(m.obp) : null,
        slg: m ? finiteOrNull(m.slg) : null, ops: m ? finiteOrNull(m.ops) : null,
        hr: m ? m.hr : null, rbi: m ? m.rbi : null, sb: m ? m.sb : null,
        wrcPlus: m ? finiteOrNull(m.wrcPlus) : null,
        war: has ? finiteOrNull(hitterWAR(s, state.cfg, state.lc).war) : null,
        bsr: has ? finiteOrNull(playerBaserunning(s, state.cfg, state.lc).bsr) : null,
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
      // R4: 二軍の守備(UZR)・走塁(BsR)。守備は出場イニングがある選手のみ（DH専任は '-'）。
      const inn = has ? totalFieldInnings(s.fielding) : 0;
      const uzr = has && inn > 0 ? uzrRuns(s, state.cfg, flc) : null;
      const bsr = has ? playerBaserunning(s, state.cfg, flc).bsr : null;
      bat.push({
        id: p.id, name: p.name, age: p.age, minor, pos: u.posJP(u.primaryPos(p)),
        pa: m ? m.pa : null, avg: m ? finiteOrNull(m.avg) : null, obp: m ? finiteOrNull(m.obp) : null,
        slg: m ? finiteOrNull(m.slg) : null, ops: m ? finiteOrNull(m.ops) : null,
        hr: m ? m.hr : null, rbi: m ? m.rbi : null, sb: m ? m.sb : null,
        uzr: finiteOrNull(uzr), bsr: finiteOrNull(bsr),
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
  return u.scoutGrade(coachOverallScore(p, cfg));
}

/**
 * セル値（列キー別・null='-'）。name 列は育成バッジ（F2-4）／フォーム判定バッジ（Wave B）を
 * 含む要素を返すことがある（呼び出し側 teamRosterTable が要素/文字列の両方を td へ収める）。
 */
function teamRosterCell(k, d, u) {
  if (k === 'name' && d.minor) {
    // 育成契約バッジ（F2-4）: 二軍サブタブで「支配下の二軍」と「育成」を一目で区別する。
    return u.el('span', {}, [String(d.name), u.el('span', { class: 'devbadge' }, '育成')]);
  }
  if (k === 'name' && (d.formTier === 'hot' || d.formTier === 'cold')) {
    // Wave B（gm_analytics_spec.md）: 好調▲/不調▼バッジ。ホバー title に reasons 先頭を表示。
    const badge = d.formTier === 'hot'
      ? u.el('span', { class: 'formbadge good', title: d.formReason || '' }, '▲')
      : u.el('span', { class: 'formbadge bad', title: d.formReason || '' }, '▼');
    return u.el('span', {}, [String(d.name), badge]);
  }
  const v = d[k];
  if (v == null || v === '') return v === '' ? '' : '-';
  if (typeof v !== 'number') return v;
  if (TEAM_COL_FMT3.has(k)) return u.fmt3(v);
  if (TEAM_COL_F2.has(k)) return v.toFixed(2);
  if (TEAM_COL_F1.has(k)) return (v >= 0 ? '+' : '') + v.toFixed(1);
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
    // G9: 表示中テーブルのソート済みID配列をモーダルの前後ナビに渡す。
    const navIds = sorted.map((d) => d.id);
    const rows = sorted.map((d) => el('tr', { class: 'clickable', onclick: () => u.openModal(d.id, navIds) },
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

// ============================================================================
// Wave C（thyroxin/specs/gm_analytics_spec.md）: 「GM」サブタブ — 位置別戦力ヒート表・
//   狙い目の他球団若手・トレードの窓サジェスト。表示はすべて game/gmBoard.mjs の純関数から。
// ============================================================================

/** ヒート帯（0..6・null=無色）。ui.mjs statHeatBand と同じカット点（FanGraphs流の赤=良/青=悪）。
 *  gmBoard.mjs の pctl はすでに「高いほど良い」方向へ揃えてある（RP=FIP等の反転済み）ので
 *  ここでの方向反転は不要。 */
function gmHeatBand(pctl) {
  if (pctl == null) return null;
  if (pctl >= 0.9) return 6;
  if (pctl >= 0.75) return 5;
  if (pctl >= 0.6) return 4;
  if (pctl > 0.4) return 3;
  if (pctl > 0.25) return 2;
  if (pctl > 0.1) return 1;
  return 0;
}

/** 位置別戦力ヒート表の1セル（既存 heat トークン=table.stat td.heatN を流用）。
 *  ★=飽和（真のサプラス）・↺=起用のねじれ（misallocated・監査修正a/c/d）。両者は意味が異なるため
 *  別マークにする（misallocatedはトレード材料には使わない＝★とは独立の注意喚起）。 */
function gmHeatCell(u, cell) {
  const { el } = u;
  if (!cell || cell.value == null) return el('td', { class: 'gmcell muted' }, '-');
  const band = gmHeatBand(cell.pctl);
  const cls = 'gmcell' + (band != null && band !== 3 ? ` heat${band}` : '');
  const pctTxt = cell.pctl != null ? `${Math.round(cell.pctl * 100)}%` : '-';
  const titleParts = [`百分位${pctTxt}`];
  if (cell.weak) titleParts.push('弱点（下位20%）');
  if (cell.saturated) titleParts.push('飽和（同水準以上の控えが同ポジションに在籍）');
  if (cell.misallocated) titleParts.push('起用のねじれ（控えの観測が上回っています——スタメン変更で強化できる可能性）');
  return el('td', { class: cls, title: titleParts.join('・') }, [
    cell.saturated ? el('span', { class: 'gmsatmark', title: '飽和' }, '★') : '',
    cell.misallocated ? el('span', { class: 'gmmisallocmark', title: '起用のねじれ——控えの観測が上回っています' }, '↺') : '',
    pctTxt,
  ]);
}

/** 位置別戦力ヒート表（12球団×守備8位置+投手2枠）。自チームの行を先頭に固定する。 */
function renderGmPositionTable(c, u, psm, myId) {
  const { el, game } = u;
  const teams = (game.gs.league.teams ?? []).slice().sort((a, b) => {
    if (a.id === myId) return -1;
    if (b.id === myId) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const cellByKey = new Map(psm.cells.map((cc) => [`${cc.teamId}|${cc.pos}`, cc]));
  const head = el('tr', {}, [el('th', { class: 'left' }, '球団'), ...GB_POSITIONS.map((pos) => el('th', {}, gbPosLabel(pos)))]);
  const rows = teams.map((t) => {
    const mine = t.id === myId;
    return el('tr', { class: mine ? 'gmminerow' : '' }, [
      el('td', { class: 'left' }, mine ? `${t.name}（あなた）` : t.name),
      ...GB_POSITIONS.map((pos) => gmHeatCell(u, cellByKey.get(`${t.id}|${pos}`))),
    ]);
  });
  c.append(el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [el('thead', {}, head), el('tbody', {}, rows)])]));
}

/** 「狙い目の他球団若手」節（prospectWatch・行クリックで選手モーダル）。上限件数に達した場合は
 *  見出しに「他にも該当あり」を注記する（小修正5・list.truncatedはprospectWatchが付与）。 */
function renderGmProspectList(c, u, list) {
  const { el, game } = u;
  const suffix = list.truncated ? '・他にも該当あり' : '';
  c.append(el('h3', { class: 'leaguename' }, `狙い目の他球団若手（上位${list.length}人${suffix}）`));
  if (!list.length) {
    c.append(el('div', { class: 'muted' }, '現時点で該当する選手はいません（条件: 25歳以下・観測百分位が高い・出場機会が薄い）。'));
    return;
  }
  const tname = (teamId) => (game.gs.league.teams ?? []).find((t) => t.id === teamId)?.name ?? teamId;
  c.append(el('div', { class: 'awardlist' }, list.map((p) => el('div', {
    class: 'awardrow clickable', onclick: () => u.openModal(p.playerId),
  }, [
    el('span', {}, [u.playerLink(p.playerId), ` （${tname(p.teamId)}・${p.age}歳・${p.pos}・${p.source === 'farm' ? '二軍' : '一軍'}）`]),
    el('span', { class: 'muted' }, `　${p.text}`),
  ]))));
}

/** 「自軍の答え（格上げ候補）」節（ownDepthSolutions・監査修正で新設）。一軍の弱点位置を自軍の
 *  控え/二軍で埋められないかを、トレードを検討する前にまず提示する。行クリックで選手モーダル。 */
function renderGmOwnDepth(c, u, list) {
  const { el } = u;
  c.append(el('h3', { class: 'leaguename' }, `自軍の答え（格上げ候補・${list.length}人）`));
  if (!list.length) {
    c.append(el('div', { class: 'muted' }, '現時点で一軍の弱点位置を自軍の控え/二軍だけで埋められる候補はいません。'));
    return;
  }
  c.append(el('div', { class: 'awardlist' }, list.map((p) => el('div', {
    class: 'awardrow clickable', onclick: () => u.openModal(p.playerId),
  }, [
    el('span', {}, [u.playerLink(p.playerId), ` （${gbPosLabel(p.weakPos)}の弱点へ・${p.source === 'farm' ? '二軍' : '一軍控え'}）`]),
    el('span', { class: 'muted' }, `　${p.text}`),
  ]))));
}

/** 「トレードの窓」節（tradeTargetSuggestions・既存ストーブ画面のトレードタブへの導線ボタン）。 */
function renderGmTradeSuggestions(c, u, list) {
  const { el } = u;
  c.append(el('h3', { class: 'leaguename' }, `トレードの窓（${list.length}件）`));
  if (!list.length) {
    c.append(el('div', { class: 'muted' }, '現時点で自球団の飽和位置と他球団の弱点位置が一致するマッチはありません。'));
    return;
  }
  c.append(el('div', { class: 'awardlist' }, list.map((s) => el('div', { class: 'awardrow' }, [
    el('span', {}, s.text),
    el('button', { onclick: () => u.gotoTrade(s.myBackupId) }, 'トレード画面へ'),
  ]))));
}

/**
 * 「GM」サブタブ本体（Wave C）。gmBoard.mjs の純関数の結果をそのまま表示する（保存なし・
 * 毎回その場で導出）。表示順は弱点ヒート→自軍の答え（内部解を先に）→狙い目の他球団若手→
 * トレードの窓（監査修正・GM定説「まず自軍を見る」）。 c=コンテンツ要素・u=teamTabDeps()。
 */
function renderGmSubtab(c, u) {
  const { el, game } = u;
  const gs = game.gs;
  const myId = gs.playerTeamId;
  c.append(el('div', { class: 'muted', style: 'margin:4px 0' },
    '観測成績（wOBA/K-BB%/FIP）のリーグ内百分位に基づく位置別戦力表。自チームの行を先頭に固定。'
    + '弱点=下位20%（青系ヒート）・★=飽和（真のサプラス。同水準以上の控えが同ポジションに在籍）・'
    + '↺=起用のねじれ（控えの観測がレギュラーを上回っています——スタメン変更で強化できる可能性）。'
    + '能力値そのものではなく観測結果です。'));
  const psm = positionStrengthMap(gs);
  renderGmPositionTable(c, u, psm, myId);
  renderGmOwnDepth(c, u, ownDepthSolutions(gs));
  renderGmProspectList(c, u, prospectWatch(gs));
  renderGmTradeSuggestions(c, u, tradeTargetSuggestions(gs));
}

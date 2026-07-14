// ============================================================================
// フェーズH1: ストーリーライン（連続ニュース・ライバル・引退ロード・phaseH_fun_spec H1）。
//
//   titleRaces(state)              … 当季タイトル争い（打率/HR/打点/盗塁/防御率/勝利/S/K）の
//                                     各リーグ上位3。首位・2位が僅差なら close=true（激戦）。
//   titleRaceHeadlines(state, names)  … 激戦カテゴリの見出しテキスト。
//   rookieRace(state)              … 当季新人（デビュー年=当年）の観測ベースWAR近似順位。
//   rookieRaceHeadlines(state, names) … 各リーグの新人王レース首位の見出しテキスト。
//   recordPaces(state)             … leagueRecords（awards.mjs）のシーズン記録と当季ペースを比較し、
//                                     105%超ペース＋消化50%以上の選手を検出。
//   recordPaceHeadlines(state, names) … 記録ペース見出しテキスト。
//   weeklyStorylineDigest(state, names) … 上記＋引退ロード候補見出しを1本にまとめる（「今週の見どころ」節）。
//   appendTransactionLog(state, off, completedYear, offYearIndex) … オフ確定結果を
//                                     state.transactionLog へコンパクト行として追記（advanceYearから呼ぶ）。
//   rivalriesOf(state, playerId)   … transactionLog から因縁関係（トレード相手/FA・戦力外の旧所属/
//                                     同年同round指名の同期）を導出。
//   rivalryGameHeadlines(state, names, limit) … 自チーム試合で「因縁」該当選手が活躍した回を検出し
//                                     見出しテキストを生成（テンプレ選択は hashSeed 決定論）。
//   retirementRoadCandidates(state)   … 開幕時点で年齢閾値＋通算マイルストーンを満たす「今季が
//                                     集大成」候補（引退判定そのものには一切触れない）。
//   retirementRoadHeadlines(state, names) … 上記の見出しテキスト。
//   retirementCeremonies(state, off, completedYear) … 確定した引退者のうち功労者（通算PA/IP/
//                                     受賞数が閾値超）を「引退セレモニー」カード用データへ整形。
//   retirementCeremonyText(ceremony, names) … セレモニーカード1件のテキスト整形。
//   ownTeamRetirementHeadlines(state, ceremonies, myTeamId, completedYear, names)
//                                     … 自チーム所属だった功労者の引退を個別ニュース化。
//
// 設計原則（phaseH_fun_spec 全柱共通の鉄則・厳守）:
//   - 表示層のみ: すべて (state, careerStats, transactionLog, ...) の純関数。真値(trueAbility)は
//     一切参照しない（三層構造）。エンジン（sim/）には触れない。
//   - 決定論: 乱数は hashSeed(masterSeed, 'story', ...) 階層シードのみ。既存の生成/進行ストリーム
//     を一切消費しない（独立座標＝durability/breakoutと同じ前例）。
//   - transactionLog は additive save field（旧セーブは load 時に既定 [] で補完）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { qualifiedPA, qualifiedIP } from '../config.mjs';
import { observedWoba } from '../sim/manager.mjs';
import { leagueRecords, careerBatting, careerPitching, nicknameFor, playerAwardHistory } from './awards.mjs';

const idAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ============================================================================
// H1-1: レース追跡
// ============================================================================

/** タイトル争いカテゴリ定義（TITLE_LABELS(awards.mjs)と同キーで8種）。 */
const RACE_CATS = [
  { key: 'battingAvg', label: '首位打者', role: 'fielder', kind: 'rate', get: (b) => (b.ab > 0 ? b.h / b.ab : null), qualifies: (b, qPA) => b.pa >= qPA },
  { key: 'homeRun', label: '本塁打王', role: 'fielder', kind: 'count', get: (b) => b.hr },
  { key: 'rbi', label: '打点王', role: 'fielder', kind: 'count', get: (b) => b.rbi },
  { key: 'steal', label: '盗塁王', role: 'fielder', kind: 'count', get: (b) => b.sb },
  { key: 'era', label: '最優秀防御率', role: 'pitcher', kind: 'rateAsc', get: (p) => (p.outs > 0 ? (p.er * 27) / p.outs : null), qualifies: (p, qIP) => p.outs / 3 >= qIP },
  { key: 'wins', label: '最多勝', role: 'pitcher', kind: 'count', get: (p) => p.w },
  { key: 'save', label: '最多セーブ', role: 'pitcher', kind: 'count', get: (p) => p.sv },
  { key: 'strikeoutsP', label: '最多奪三振', role: 'pitcher', kind: 'count', get: (p) => p.so },
];

/**
 * 当季タイトル争い（各リーグ上位3・規定はリーグ内平均消化試合数に比例して換算）。
 * @param {Object} state GameState（state.rt が必要・シーズン中のみ意味を持つ）
 * @returns {{leagues:Array<{leagueId:string, categories:Object}>}}
 */
export function titleRaces(state) {
  const rt = state.rt;
  if (!rt) return { leagues: [] };
  const cfg = state.cfg;
  const st = cfg.tuning.storylines;
  // rt.standings は Map<teamId,row> でシーズン中も常に最新（rt.table は finalizeRuntime 後のみ埋まる）。
  const standRows = [...rt.standings.values()];
  const teamLg = new Map(standRows.map((r) => [r.teamId, r.league]));
  const leagueIds = [...new Set(standRows.map((r) => r.league))].sort();
  const gpByLeague = new Map();
  for (const lid of leagueIds) {
    const rows = standRows.filter((r) => r.league === lid);
    const avg = rows.length ? rows.reduce((a, r) => a + (r.g || 0), 0) / rows.length : 0;
    gpByLeague.set(lid, avg);
  }
  const seasons = [...rt.stats.stats.values()];
  const leagues = leagueIds.map((lid) => {
    const gp = gpByLeague.get(lid) || 0;
    const qPA = qualifiedPA(gp);
    const qIP = qualifiedIP(gp);
    const inLg = seasons.filter((s) => teamLg.get(s.teamId) === lid);
    const categories = {};
    for (const cat of RACE_CATS) {
      const pool = [];
      for (const s of inLg) {
        const line = cat.role === 'pitcher' ? s.pitching : s.batting;
        if (!line) continue;
        if (cat.qualifies && !cat.qualifies(line, cat.role === 'pitcher' ? qIP : qPA)) continue;
        const v = cat.get(line);
        if (v == null || Number.isNaN(v)) continue;
        if (cat.kind !== 'rateAsc' && v <= 0) continue; // 数え上げ0は掲載対象外
        pool.push({ playerId: s.playerId, value: v });
      }
      const asc = cat.kind === 'rateAsc';
      pool.sort((a, b) => (asc ? a.value - b.value : b.value - a.value) || idAsc(a.playerId, b.playerId));
      const leaders = pool.slice(0, 3);
      const margin = cat.kind === 'count' ? st.raceCloseMargin.count : st.raceCloseMargin.rate;
      const close = leaders.length >= 2 && Math.abs(leaders[0].value - leaders[1].value) <= margin;
      categories[cat.key] = { label: cat.label, kind: cat.kind, leaders, close };
    }
    return { leagueId: lid, categories };
  });
  return { leagues };
}

function fmtRaceValue(kind, v) {
  if (kind === 'rate') return v.toFixed(3).replace(/^0\./, '.');
  if (kind === 'rateAsc') return v.toFixed(2);
  return String(Math.round(v));
}

/** タイトル争いが激戦のカテゴリだけ見出しテキストへ（names={pnameOf,tnameOf,leagueNameOf}）。 */
export function titleRaceHeadlines(state, names = {}) {
  const { pnameOf = (id) => id, leagueNameOf = (id) => id } = names;
  const out = [];
  for (const lg of titleRaces(state).leagues) {
    for (const cat of Object.values(lg.categories)) {
      if (!cat.close) continue;
      const [l1, l2] = cat.leaders;
      out.push({
        text: `【${leagueNameOf(lg.leagueId)}】${cat.label}争いが激戦！首位 ${pnameOf(l1.playerId)}（${fmtRaceValue(cat.kind, l1.value)}） vs 2位 ${pnameOf(l2.playerId)}（${fmtRaceValue(cat.kind, l2.value)}）`,
        cls: 'info',
      });
    }
  }
  return out;
}

/** 生の投手ラインから簡易FIP（transactions.mjs observedValueOfと同式・replacement非減算）。 */
function simpleFip(pt, ip) {
  if (!ip) return 0;
  return (13 * (pt.hr || 0) + 3 * ((pt.bb || 0) - (pt.ibb || 0) + (pt.hbp || 0)) - 2 * (pt.so || 0)) / ip;
}

/**
 * 当季新人王レース（観測ベース近似: 野手=wOBA×PA／投手=-FIP×IP）。開幕年（前年成績を持つ選手が
 * 皆無＝全員デビュー）は awards.mjs の新人王同様に対象外（意味が立たないため）。
 * @returns {{leagues:Array<{leagueId:string, leaders:Array<{playerId,value,role}>}>}}
 */
export function rookieRace(state) {
  const rt = state.rt;
  if (!rt) return { leagues: [] };
  const cfg = state.cfg;
  const priorIds = new Set();
  for (const s of state.careerStats) if (s.season < state.year) priorIds.add(s.playerId);
  if (!priorIds.size) return { leagues: [] };
  const teamLg = new Map([...rt.standings.values()].map((r) => [r.teamId, r.league]));
  const byLeague = new Map();
  for (const s of rt.stats.stats.values()) {
    if (priorIds.has(s.playerId)) continue;
    const lid = teamLg.get(s.teamId);
    if (lid == null) continue;
    let value = null;
    let role = null;
    if (s.pitching && s.pitching.outs > 0) {
      role = 'pitcher';
      const ip = s.pitching.outs / 3;
      value = -simpleFip(s.pitching, ip) * ip;
    } else if (s.batting && s.batting.pa > 0) {
      role = 'fielder';
      value = observedWoba(s.batting, cfg) * s.batting.pa;
    }
    if (value == null) continue;
    if (!byLeague.has(lid)) byLeague.set(lid, []);
    byLeague.get(lid).push({ playerId: s.playerId, value, role });
  }
  const N = cfg.tuning.storylines.rookieRaceTopN ?? 5;
  const leagues = [...byLeague.keys()].sort().map((lid) => ({
    leagueId: lid,
    leaders: byLeague.get(lid).sort((a, b) => b.value - a.value || idAsc(a.playerId, b.playerId)).slice(0, N),
  }));
  return { leagues };
}

/** 各リーグの新人王レース首位だけ見出しテキストへ。 */
export function rookieRaceHeadlines(state, names = {}) {
  const { pnameOf = (id) => id, leagueNameOf = (id) => id } = names;
  const out = [];
  for (const lg of rookieRace(state).leagues) {
    if (!lg.leaders.length) continue;
    out.push({ text: `【${leagueNameOf(lg.leagueId)}】新人王レース、現在の首位は ${pnameOf(lg.leaders[0].playerId)}`, cls: 'info' });
  }
  return out;
}

/** シーズン記録カテゴリ（leagueRecords の season系キーと対応）。 */
const PACE_CATS = [
  ['seasonHR', 'homeRuns', (s) => s.batting && s.batting.hr, '本塁打'],
  ['seasonH', 'hits', (s) => s.batting && s.batting.h, '安打'],
  ['seasonSB', 'steals', (s) => s.batting && s.batting.sb, '盗塁'],
  ['seasonW', 'wins', (s) => s.pitching && s.pitching.w, '勝利'],
  ['seasonSO', 'strikeouts', (s) => s.pitching && s.pitching.so, '奪三振'],
  ['seasonSV', 'saves', (s) => s.pitching && s.pitching.sv, 'セーブ'],
];

/** careerStats から playerId→role の簡易マップ（leagueRecords が要求する playersById の代用）。 */
function roleMapFromCareer(careerStats) {
  const m = new Map();
  for (const s of careerStats) {
    if (m.has(s.playerId)) continue;
    if (s.pitching && (s.pitching.g > 0 || s.pitching.outs > 0)) m.set(s.playerId, 'pitcher');
    else if (s.batting && s.batting.pa > 0) m.set(s.playerId, 'fielder');
  }
  return m;
}

/**
 * シーズン記録ペース検出（leagueRecords の既存トップ1と当季ペースを比較）。
 * @returns {Array<{category,label,playerId,current,pace,recordValue,progress}>}
 */
export function recordPaces(state) {
  const rt = state.rt;
  if (!rt) return [];
  const cfg = state.cfg;
  const st = cfg.tuning.storylines;
  const roleMap = roleMapFromCareer(state.careerStats);
  const playersById = new Map([...roleMap].map(([id, role]) => [id, { role, name: id }]));
  const recs = leagueRecords({ careerStats: state.careerStats, playersById, cfg });
  const teamG = new Map([...rt.standings.values()].map((r) => [r.teamId, r.g]));
  const fullG = cfg.league.gamesPerSeason;
  const out = [];
  for (const [key, category, get, label] of PACE_CATS) {
    const top = recs[key];
    if (!top || !top.length) continue;
    const recordValue = top[0].value;
    if (!(recordValue > 0)) continue;
    for (const s of rt.stats.stats.values()) {
      const v = get(s);
      if (!v) continue;
      const g = teamG.get(s.teamId) || 0;
      const progress = fullG ? g / fullG : 0;
      if (progress < st.recordPaceMinProgress) continue;
      const pace = v / progress;
      if (pace >= recordValue * st.recordPaceThreshold) {
        out.push({ category, label, playerId: s.playerId, current: v, pace, recordValue, progress });
      }
    }
  }
  return out;
}

/** 記録ペース見出しテキスト（ペース比率の高い順に digestMaxItems 件まで）。 */
export function recordPaceHeadlines(state, names = {}) {
  const { pnameOf = (id) => id } = names;
  const max = state.cfg.tuning.storylines.digestMaxItems ?? 6;
  return recordPaces(state)
    .sort((a, b) => b.pace / b.recordValue - a.pace / a.recordValue || idAsc(a.playerId, b.playerId))
    .slice(0, max)
    .map((p) => ({
      text: `${pnameOf(p.playerId)}が${p.label}のシーズン記録ペース（現在${p.current}・ペース換算${Math.round(p.pace)}）`,
      cls: 'good',
    }));
}

// ============================================================================
// H1-3: 引退ロード（開幕時点の候補検出。実際の引退判定・確率は roster.mjs のまま不変）
// ============================================================================

function milestoneHit(agg, thresholds) {
  for (const [k, v] of Object.entries(thresholds || {})) {
    if ((agg[MILESTONE_FIELD[k]] ?? 0) >= v) return true;
  }
  return false;
}
const MILESTONE_FIELD = { hits: 'h', homeRuns: 'hr', wins: 'w', saves: 'sv', strikeouts: 'so' };

/**
 * 開幕時点の「引退ロード候補」（年齢閾値＋通算マイルストーンいずれか到達）。引退判定そのものは
 * roster.mjs の decideRetire が別途行う（本関数はニュース素材の検出のみ・非干渉）。
 * @returns {Array<{playerId,teamId,age,role}>}
 */
export function retirementRoadCandidates(state) {
  const cfg = state.cfg;
  const rr = cfg.tuning.storylines.retirementRoad;
  const out = [];
  for (const p of state.league.players) {
    if (p.rosterStatus !== 'active') continue;
    if (p.age < rr.ageThreshold) continue;
    const isPitcher = p.role === 'pitcher';
    const agg = isPitcher ? careerPitching(state.careerStats, p.id) : careerBatting(state.careerStats, p.id);
    const hit = milestoneHit(agg, isPitcher ? rr.pitcherMilestones : rr.batterMilestones);
    if (!hit) continue;
    out.push({ playerId: p.id, teamId: p.teamId, age: p.age, role: p.role });
  }
  return out.sort((a, b) => b.age - a.age || idAsc(a.playerId, b.playerId));
}

/** 引退ロード候補の見出しテキスト。 */
export function retirementRoadHeadlines(state, names = {}) {
  const { pnameOf = (id) => id } = names;
  return retirementRoadCandidates(state).map((c) => ({
    text: `${pnameOf(c.playerId)}（${c.age}歳）、今季が集大成のシーズンになるか`,
    cls: 'info',
  }));
}

/**
 * 「今週の見どころ」節: タイトル争い／新人王レース／記録ペース／引退ロードの見出しを1本化する
 * （ニュースタブの新設節。既存 weeklyDigest の隣に並べる想定・digestMaxItems で件数上限）。
 */
export function weeklyStorylineDigest(state, names = {}) {
  const max = state.cfg.tuning.storylines.digestMaxItems ?? 6;
  const out = [
    ...titleRaceHeadlines(state, names),
    ...rookieRaceHeadlines(state, names),
    ...recordPaceHeadlines(state, names),
    ...retirementRoadHeadlines(state, names),
  ];
  return out.slice(0, max);
}

// ============================================================================
// H1-2: ライバル・因縁（transactionLog）
// ============================================================================

/**
 * 完了年オフの確定結果（fa/trades/pickups/draftLog.picks）を state.transactionLog へ
 * コンパクト行として追記する（advanceYear から呼ぶ・additive）。
 * 行形式: {year, kind, playerId, playerId2?, from?, to?, round?}
 *   kind='fa'|'trade'|'pickup'|'draft'
 * @returns {Array} 追記した行（テスト用に返す）
 */
export function appendTransactionLog(state, off, completedYear, offYearIndex) {
  const rows = [];
  for (const f of off.fa ?? []) {
    rows.push({ year: completedYear, kind: 'fa', playerId: f.playerId, from: f.from, to: f.to });
  }
  for (const t of off.trades ?? []) {
    if (t.rejected) continue;
    rows.push({ year: completedYear, kind: 'trade', playerId: t.aPlayer, playerId2: t.bPlayer, from: t.aTeam, to: t.bTeam });
  }
  for (const pu of off.pickups ?? []) {
    rows.push({ year: completedYear, kind: 'pickup', playerId: pu.playerId, from: pu.from, to: pu.to });
  }
  const picks = off.draftLog ? off.draftLog.picks : null;
  if (picks) {
    for (const pick of picks) {
      rows.push({ year: completedYear, kind: 'draft', playerId: pick.prospectId, to: pick.teamId, round: pick.round });
    }
  }
  if (!state.transactionLog) state.transactionLog = [];
  state.transactionLog.push(...rows);
  return rows;
}

/**
 * 選手の因縁関係を transactionLog から導出する（同年同round指名の同期／トレード相手／
 * FA・戦力外の旧所属）。三層構造: すべて実際に起きた取引の事実のみ（真値非参照）。
 * @returns {Array} [{type:'trade'|'faOld'|'pickupOld'|'draftmate', year, oldTeamId?, newTeamId?,
 *                    otherPlayerId?, matchTeamId?, round?}]
 */
export function rivalriesOf(state, playerId) {
  const log = state.transactionLog || [];
  const out = [];
  for (const row of log) {
    if (row.kind === 'trade') {
      if (row.playerId === playerId) {
        out.push({ type: 'trade', year: row.year, otherPlayerId: row.playerId2, oldTeamId: row.from, newTeamId: row.to });
      } else if (row.playerId2 === playerId) {
        out.push({ type: 'trade', year: row.year, otherPlayerId: row.playerId, oldTeamId: row.to, newTeamId: row.from });
      }
    } else if (row.kind === 'fa' && row.playerId === playerId) {
      out.push({ type: 'faOld', year: row.year, oldTeamId: row.from, newTeamId: row.to });
    } else if (row.kind === 'pickup' && row.playerId === playerId) {
      out.push({ type: 'pickupOld', year: row.year, oldTeamId: row.from, newTeamId: row.to });
    }
  }
  const mine = log.find((r) => r.kind === 'draft' && r.playerId === playerId);
  if (mine) {
    for (const row of log) {
      if (row.kind !== 'draft' || row.year !== mine.year || row.round !== mine.round || row.playerId === playerId) continue;
      out.push({ type: 'draftmate', year: row.year, round: row.round, otherPlayerId: row.playerId, matchTeamId: row.to });
    }
  }
  return out;
}

/** 見出しマッチング用の「相手チーム」（旧所属 or 同期の在籍先）。 */
function rivalryMatchTeam(r) {
  return r.oldTeamId ?? r.matchTeamId ?? null;
}

function matchRivalry(state, playerId, oppTeamId) {
  const rivals = rivalriesOf(state, playerId);
  return rivals.find((r) => rivalryMatchTeam(r) === oppTeamId) || null;
}

const RIVALRY_TEMPLATES = {
  faOld: [
    (n, t) => `${n}が古巣${t}に牙をむく`,
    (n, t) => `${n}、${t}を出た男が意地を見せる`,
    (n, t) => `${n}、かつての本拠地${t}戦で躍動`,
  ],
  pickupOld: [
    (n, t) => `${n}、戦力外にした${t}を相手に一泡吹かせる`,
    (n, t) => `${n}、見限った球団${t}に結果で応える`,
  ],
  trade: [
    (n, t) => `${n}、かつての在籍先${t}を相手に一暴れ`,
    (n, t) => `${n}、トレードで去った${t}戦で存在感`,
  ],
  draftmate: [
    (n, t) => `${n}、同期指名組を擁する${t}との一戦で輝く`,
  ],
};

function isNotableBatter(bt) {
  return bt.hr >= 2 || bt.h >= 3;
}
function isNotablePitcher(pt) {
  return pt.k >= 10 || (pt.outs >= 21 && pt.r === 0);
}

/**
 * 自チーム試合（state.rt.playerGameLog）で「因縁」該当選手が活躍(notable)した場合の見出し
 * （直近の試合から新しい順・最大 limit 件）。決定論: テンプレ選択は
 * hashSeed(masterSeed,'story',year,day,playerId) の rng（表示文言のみ・結果に非干渉）。
 * @param {{pnameOf:Function, tnameOf:Function}} names
 */
export function rivalryGameHeadlines(state, names = {}, limit = 5) {
  const { pnameOf = (id) => id, tnameOf = (id) => id } = names;
  const rt = state.rt;
  if (!rt || !rt.playerGameLog) return [];
  const out = [];
  for (const rec of rt.playerGameLog.slice().reverse()) {
    const b = rec.box;
    if (!b) continue;
    for (const side of ['home', 'away']) {
      const oppTeamThisGame = side === 'home' ? rec.away : rec.home;
      for (const bt of b.batters[side] || []) {
        if (!isNotableBatter(bt)) continue;
        const hit = matchRivalry(state, bt.pid, oppTeamThisGame);
        if (hit) out.push(buildRivalryHeadline(state, bt.pid, rec.day, oppTeamThisGame, hit, pnameOf, tnameOf));
      }
      for (const pt of b.pitchers[side] || []) {
        if (!isNotablePitcher(pt)) continue;
        const hit = matchRivalry(state, pt.pid, oppTeamThisGame);
        if (hit) out.push(buildRivalryHeadline(state, pt.pid, rec.day, oppTeamThisGame, hit, pnameOf, tnameOf));
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function buildRivalryHeadline(state, playerId, day, oppTeamId, rivalry, pnameOf, tnameOf) {
  const list = RIVALRY_TEMPLATES[rivalry.type] || RIVALRY_TEMPLATES.faOld;
  const r = makeRng(hashSeed(state.masterSeed, 'story', state.year, day, playerId));
  const tpl = list[r.int(list.length)];
  return { text: tpl(pnameOf(playerId), tnameOf(oppTeamId)), cls: 'good', playerId, oppTeamId, day, type: rivalry.type };
}

// ============================================================================
// H1-3: 引退セレモニー（確定した引退者のうち功労者をカード化）
// ============================================================================

/**
 * 確定した引退者（off.retirees）のうち功労者（通算PA/IP/受賞数が閾値超）を
 * 「引退セレモニー」カード用データへ整形する（通算成績・受賞歴・二つ名・在籍球団）。
 * @returns {Array<{playerId,name,role,primaryPos,finalAge,retiredAfterYear,nickname,awards,career,teams}>}
 */
export function retirementCeremonies(state, off, completedYear) {
  const cfg = state.cfg;
  const rr = cfg.tuning.storylines.retirementRoad;
  const awardsHistory = state.awardsHistory.some((h) => h.year === completedYear)
    ? state.awardsHistory
    : state.awardsHistory.concat([{ year: completedYear, awards: off.awards }]);
  const out = [];
  for (const r of off.retirees ?? []) {
    const isPitcher = r.role === 'pitcher';
    const agg = isPitcher ? careerPitching(state.careerStats, r.id) : careerBatting(state.careerStats, r.id);
    const scale = isPitcher ? agg.ip : agg.pa;
    // playerAwardHistory: awardsHistory が対象年をすべて覆っていれば playersById は参照されない
    //   （recomputeAwardHistory のフォールバック対象年が空集合になるため・awards.mjs 参照）。
    const hist = playerAwardHistory(r.id, { careerStats: state.careerStats, teamHistory: state.teamHistory, playersById: new Map(), cfg, awardsHistory });
    const merit = scale >= (isPitcher ? rr.ceremonyMinIP : rr.ceremonyMinPA) || hist.length >= rr.ceremonyMinAwards;
    if (!merit) continue;
    const teams = [];
    for (const s of state.careerStats) {
      if (s.playerId === r.id && !teams.includes(s.teamId)) teams.push(s.teamId);
    }
    out.push({
      playerId: r.id, name: r.name, role: r.role, primaryPos: r.primaryPos, finalAge: r.finalAge,
      retiredAfterYear: r.retiredAfterYear, nickname: nicknameFor(r, state.careerStats, cfg),
      awards: hist, career: agg, teams,
    });
  }
  return out;
}

/** 引退セレモニーカード1件のテキスト整形（names={tnameOf}）。 */
export function retirementCeremonyText(ceremony, names = {}) {
  const { tnameOf = (id) => id } = names;
  const isPitcher = ceremony.role === 'pitcher';
  const c = ceremony.career;
  const line = isPitcher
    ? `通算${c.w}勝${c.l}敗${c.sv}S・防御率${Number.isFinite(c.era) ? c.era.toFixed(2) : '-'}（${c.ip.toFixed(0)}回）`
    : `通算${c.h}安打・${c.hr}本塁打・打率${c.avg.toFixed(3)}`;
  const teams = ceremony.teams.map((t) => tnameOf(t)).join('→');
  return `${ceremony.name}（「${ceremony.nickname}」・${ceremony.finalAge}歳）が引退。${line}。受賞${ceremony.awards.length}回。在籍: ${teams}`;
}

/** 自チーム所属だった功労者の引退だけを個別ニュース化（完了年時点の最終所属で判定）。 */
export function ownTeamRetirementHeadlines(state, ceremonies, myTeamId, completedYear, names = {}) {
  const finalTeam = new Map();
  for (const s of state.careerStats) if (s.season === completedYear) finalTeam.set(s.playerId, s.teamId);
  return ceremonies
    .filter((c) => finalTeam.get(c.playerId) === myTeamId)
    .map((c) => ({ text: `【引退】${retirementCeremonyText(c, names)}`, cls: 'info', playerId: c.playerId }));
}

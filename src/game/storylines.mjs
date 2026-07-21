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
//                                     P6: names.personalityOf を渡すと対象選手の性格タグを短い
//                                     一言として追記する（後方互換・省略時は従来と同一テキスト）。
//   draftClassHeadlines(state, names) … P5: 「今年の逸材」ドラフト前ニュース。market.mjs の
//                                     draftPreviewHeadlines（世代内評判consensus上位・真値非参照）
//                                     と draftScoutView（等級/伸びしろ/評判）を素材に、「今年の逸材」
//                                     「世代No.1右腕」「大器の匂い」等のテンプレ見出しへ変換する。
//   retirementRoadCandidates(state)   … 開幕時点で年齢閾値＋通算マイルストーンを満たす「今季が
//                                     集大成」候補（引退判定そのものには一切触れない）。
//   retirementRoadHeadlines(state, names) … 上記の見出しテキスト。
//   retirementCeremonies(state, off, completedYear) … 確定した引退者のうち功労者（通算PA/IP/
//                                     受賞数が閾値超）を「引退セレモニー」カード用データへ整形。
//   retirementCeremonyText(ceremony, names) … セレモニーカード1件のテキスト整形。
//   ownTeamRetirementHeadlines(state, ceremonies, myTeamId, completedYear, names)
//                                     … 自チーム所属だった功労者の引退を個別ニュース化。
//   playerStoryOf(state, playerId, names)  … P7: 選手詳細「物語」欄。transactionLog/awardsHistory/
//                                     careerStats/在籍情報だけから、出自（ドラフト経緯 or 生え抜き）・
//                                     移籍歴・栄光（受賞/二つ名）・節目（通算マイルストーン）・因縁
//                                     （同期指名）を時系列 [{year,text,kind}] へ合成する純関数。
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
import { leagueRecords, careerBatting, careerPitching, nicknameFor, playerAwardHistory, milestones } from './awards.mjs';
import { draftPreviewHeadlines, draftScoutView } from './market.mjs';

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
    // P7: 競合くじ情報（何球団が競合したか）を additive フィールド contenders として付す
    //   （pick.contested のときだけ・draftLog.lotteries から該当prospectの競合球団数を引く）。
    //   playerStoryOf の「{n}球団競合の末」表現の素。旧セーブ由来の行は未設定＝後方互換。
    const lotteryByProspect = new Map((off.draftLog.lotteries ?? []).map((l) => [l.prospectId, l]));
    for (const pick of picks) {
      const row = { year: completedYear, kind: 'draft', playerId: pick.prospectId, to: pick.teamId, round: pick.round };
      if (pick.contested) {
        const lot = lotteryByProspect.get(pick.prospectId);
        if (lot) row.contenders = lot.contenders.length;
      }
      rows.push(row);
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

// P6: 性格タグの短い一言（rivalryGameHeadlines への付記用）。全 PERSONALITIES に最低1バリアント。
// 決定論: hashSeed('newsvoice','rivalrySuffix',...) の独立座標＝テンプレ本体の選択（'story'座標）や
// 既存の乱数ストリームに一切干渉しない。personality が未知/null なら何も付記しない（後方互換）。
const PERSONALITY_RIVALRY_SUFFIX = {
  hardworking: ['地道な努力の成果'],
  streaky: ['ムラっ気が爆発した一戦', '乗ってくると誰にも止められない'],
  showboat: ['「見せ場は逃さない」が持論', 'スタンドを沸かせる立ち回り'],
  reticent: ['本人は多くを語らず', '口数少なく、結果だけを残す'],
  fighter: ['闘志を前面に', '気迫のプレー'],
  cool: ['表情ひとつ変えず', '淡々とこなす'],
  myPace: ['いつも通りのマイペース', '周囲に流されぬ独自のリズム'],
  leader: ['チームを鼓舞する一打', '後輩たちを引っ張る存在感'],
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
 * P6: names.personalityOf（id→PERSONALITIES|null）を渡すと、対象選手の性格タグに応じた短い
 * 一言を末尾に付記する（fun_theory_research P6・後方互換=省略時は従来と同一テキスト）。
 * @param {{pnameOf:Function, tnameOf:Function, personalityOf?:Function}} names
 */
export function rivalryGameHeadlines(state, names = {}, limit = 5) {
  const { pnameOf = (id) => id, tnameOf = (id) => id, personalityOf = () => null } = names;
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
        if (hit) out.push(buildRivalryHeadline(state, bt.pid, rec.day, oppTeamThisGame, hit, pnameOf, tnameOf, personalityOf));
      }
      for (const pt of b.pitchers[side] || []) {
        if (!isNotablePitcher(pt)) continue;
        const hit = matchRivalry(state, pt.pid, oppTeamThisGame);
        if (hit) out.push(buildRivalryHeadline(state, pt.pid, rec.day, oppTeamThisGame, hit, pnameOf, tnameOf, personalityOf));
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function buildRivalryHeadline(state, playerId, day, oppTeamId, rivalry, pnameOf, tnameOf, personalityOf = () => null) {
  const list = RIVALRY_TEMPLATES[rivalry.type] || RIVALRY_TEMPLATES.faOld;
  const r = makeRng(hashSeed(state.masterSeed, 'story', state.year, day, playerId));
  const tpl = list[r.int(list.length)];
  let text = tpl(pnameOf(playerId), tnameOf(oppTeamId));
  // P6: 性格タグの短い一言を付記（独立座標のhashSeed＝テンプレ本体の選択に非干渉・後方互換）。
  const personality = personalityOf(playerId);
  const suffixes = PERSONALITY_RIVALRY_SUFFIX[personality];
  if (suffixes && suffixes.length) {
    const sr = makeRng(hashSeed('newsvoice', 'rivalrySuffix', playerId, personality));
    text += `（${suffixes[sr.int(suffixes.length)]}）`;
  }
  return { text, cls: 'good', playerId, oppTeamId, day, type: rivalry.type };
}

// ============================================================================
// P5: 「今年の逸材」ドラフトクラス見出し（fun_theory_research_20260720 P5・phaseH_fun_spec 積み残し）
// ============================================================================

// テンプレ選択は hashSeed(masterSeed,'draftclass',yearIndex,kind,prospectId) の独立座標のみ＝
// プール生成(generatePool)・ドラフト解決(runDraft)の乱数ストリームには一切干渉しない。
const DRAFTCLASS_TOP_TEMPLATES = [
  (n, role) => `今年の逸材、${n}（${role}）にドラフト戦線の視線集中`,
  (n, role) => `世代最高評価は${n}（${role}）― スカウト陣の目玉`,
  (n, role) => `${n}（${role}）、今年の指名候補生の頂点に立つ`,
];
const DRAFTCLASS_PITCHER_TOP_TEMPLATES = [
  (n, arm) => `世代No.1${arm}との呼び声、${n}に球団関係者が熱視線`,
  (n, arm) => `${n}、今年一番の${arm}との評判`,
];
const DRAFTCLASS_FIELDER_TOP_TEMPLATES = [
  (n, pos) => `世代No.1の${pos}候補、${n}にドラフト上位球団が注目`,
  (n, pos) => `${n}、今年の${pos}候補では随一の評価`,
];
const DRAFTCLASS_UPSIDE_TEMPLATES = [
  (n, role) => `${n}（${role}）に「大器」の呼び声。伸びしろ十分の逸材`,
  (n, role) => `${n}、完成度よりポテンシャル型 ― 大器の匂いを漂わせる`,
  (n, role) => `${n}に大化けの期待。${role}としての伸びしろは世代屈指`,
];
const DRAFTCLASS_HIDDEN_TEMPLATES = [
  (n) => `隠し玉との噂も。${n}の評価、球団間で見立てが割れる`,
  (n) => `${n}に「隠し玉」の声 ― 一部球団だけが高く評価`,
];

/** draftClassHeadlines 内のテンプレ選択（決定論・独立座標）。 */
function pickDraftClassTpl(masterSeed, yearIndex, kind, prospectId, list) {
  const r = makeRng(hashSeed(masterSeed, 'draftclass', yearIndex, kind, prospectId));
  return list[r.int(list.length)];
}

/**
 * P5:「今年の逸材」ドラフト前ニュース。draftPreviewHeadlines（market.mjs・世代内評判consensus
 * 上位・真値非参照）の顔ぶれを draftScoutView（同・スカウトノイズ込みの等級/伸びしろ/評判）で
 * 肉付けし、テンプレ見出しへ変換する。真値(trueAbility)は一切参照しない（三層構造）。
 * state.awaitingDraft.pool（H2・プレイヤー参加型ドラフトの中断ペイロード）が無ければ空配列。
 * 呼び出し側は通常 round===1（プール確定直後・まだ誰も指名されていない状態）でのみ呼ぶ想定
 * （draftPreviewHeadlines と同じ前提。draft.mjs の既存「今年の目玉」節と同条件）。
 * @param {Object} state GameState（awaitingDraft/masterSeed/yearIndex/playerTeamId が必要）
 * @param {{pnameOf?:Function, posLabelOf?:Function}} names pnameOf: prospectId→表示名
 *   （既定は識別子そのまま・呼び出し側が pool から名前を引いて渡す）。posLabelOf: 守備位置コード
 *   →表示ラベル（既定は識別子そのまま＝本アプリの他画面と同じくコード表示）。
 * @returns {Array<{text:string, cls:string, prospectId:string, kind:string}>}
 */
export function draftClassHeadlines(state, names = {}) {
  const aw = state.awaitingDraft;
  if (!aw || !aw.pool || !aw.pool.length) return [];
  const { pnameOf = (id) => id, posLabelOf = (pos) => pos } = names;
  const preview = draftPreviewHeadlines(state); // consensus上位（真値非参照・追加の乱数消費なし）
  if (!preview.length) return [];
  const findP = (id) => aw.pool.find((p) => p.id === id);
  const roleLabelOf = (p) => (p.role === 'pitcher' ? '投手' : posLabelOf(p.primaryPos));
  const out = [];
  const max = state.cfg.tuning.storylines.draftClassMax ?? 6;

  // 総合トップ（世代内評判1位）＝「今年の逸材」。
  const topP = findP(preview[0].prospectId);
  if (topP) {
    const tpl = pickDraftClassTpl(state.masterSeed, state.yearIndex, 'top', topP.id, DRAFTCLASS_TOP_TEMPLATES);
    out.push({ text: tpl(pnameOf(topP.id), roleLabelOf(topP)), cls: 'good', prospectId: topP.id, kind: 'top' });
  }

  // ロール別トップ（プレビュー内で最上位の投手/野手それぞれ1名・総合トップと重複しない場合のみ）。
  let pitcherDone = false;
  let fielderDone = false;
  for (const h of preview) {
    if (pitcherDone && fielderDone) break;
    const p = findP(h.prospectId);
    if (!p || p.id === topP?.id) continue;
    if (p.role === 'pitcher' && !pitcherDone) {
      pitcherDone = true;
      const arm = `世代No.1${p.throws === 'L' ? '左腕' : '右腕'}`;
      const tpl = pickDraftClassTpl(state.masterSeed, state.yearIndex, 'pitcherTop', p.id, DRAFTCLASS_PITCHER_TOP_TEMPLATES);
      out.push({ text: tpl(pnameOf(p.id), arm), cls: 'info', prospectId: p.id, kind: 'pitcherTop' });
    } else if (p.role === 'fielder' && !fielderDone) {
      fielderDone = true;
      const tpl = pickDraftClassTpl(state.masterSeed, state.yearIndex, 'fielderTop', p.id, DRAFTCLASS_FIELDER_TOP_TEMPLATES);
      out.push({ text: tpl(pnameOf(p.id), posLabelOf(p.primaryPos)), cls: 'info', prospectId: p.id, kind: 'fielderTop' });
    }
  }

  // 「大器」「隠し玉」評判（プレビュー内・自球団スカウトレポート＝draftScoutView 由来）。
  const used = new Set(out.map((o) => o.prospectId));
  for (const h of preview) {
    if (out.length >= max) break;
    const p = findP(h.prospectId);
    if (!p || used.has(p.id)) continue;
    const sv = draftScoutView(state, p, aw.pool);
    if (sv.upside === '大器') {
      const tpl = pickDraftClassTpl(state.masterSeed, state.yearIndex, 'upside', p.id, DRAFTCLASS_UPSIDE_TEMPLATES);
      out.push({ text: tpl(pnameOf(p.id), roleLabelOf(p)), cls: 'info', prospectId: p.id, kind: 'upside' });
      used.add(p.id);
    } else if (sv.hype === '隠し玉') {
      const tpl = pickDraftClassTpl(state.masterSeed, state.yearIndex, 'hidden', p.id, DRAFTCLASS_HIDDEN_TEMPLATES);
      out.push({ text: tpl(pnameOf(p.id)), cls: 'info', prospectId: p.id, kind: 'hidden' });
      used.add(p.id);
    }
  }
  return out.slice(0, max);
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

// ============================================================================
// P7: 選手詳細の「物語」欄（fun_theory_research_20260720 P7・愛着/世代物語）
//
//   playerStoryOf(state, playerId, names) … 既存データ（transactionLog/awardsHistory/careerStats/
//     在籍情報）だけから、その選手の歩みを時系列の出来事配列へ合成する純関数。保存データは増やさず
//     （§17）、モーダルを開くたび毎回導出する。エンジン（sim/）・trueAbility には一切触れない。
//   シグネチャ注記: 他の *Headlines 系関数（titleRaceHeadlines 等）と同じ規約で第3引数に
//     names={pnameOf,tnameOf,posLabelOf}（省略時は識別子そのまま）を取る＝テキスト整形をUI側の
//     名前解決に委ねる（本ファイルは表示名テーブルを持たない）。
// ============================================================================

/** state.league.players / farm / retiredPlayers を統合した playerId→選手レコードのマップ。
 *  game/index.mjs の allPlayersById と同じ発想だが、循環import（index.mjs→storylines.mjs）を
 *  避けるためここでも同じ3ソースから独立に構築する。 */
function localPlayersById(state) {
  const m = new Map((state.league?.players ?? []).map((p) => [p.id, p]));
  for (const d of state.league?.farm ?? []) if (!m.has(d.id)) m.set(d.id, d);
  for (const r of state.retiredPlayers ?? []) if (!m.has(r.id)) m.set(r.id, r);
  return m;
}

/** その選手の careerStats のうち最古/最新の1行（season最小/最大）。無ければ null。 */
function firstCareerRow(state, playerId) {
  let best = null;
  for (const s of state.careerStats) {
    if (s.playerId !== playerId) continue;
    if (!best || s.season < best.season) best = s;
  }
  return best;
}
function lastCareerRow(state, playerId) {
  let best = null;
  for (const s of state.careerStats) {
    if (s.playerId !== playerId) continue;
    if (!best || s.season > best.season) best = s;
  }
  return best;
}

/** playerStoryOf のタイムライン内での同年tie-break順（出自→移籍/因縁→節目/栄光）。 */
const STORY_KIND_ORDER = ['origin', 'transfer', 'rivalry', 'milestone', 'award', 'nickname'];

/** kind→日本語カテゴリ名（UI側の見出し/アイコン分けに使える。栄光=award/nickname を束ねる）。 */
export const STORY_KIND_LABELS = {
  origin: '出自', transfer: '移籍歴', award: '栄光', nickname: '栄光', milestone: '節目', rivalry: '因縁',
};

/**
 * P7: 選手の「物語」— その選手の歩みを時系列の出来事配列へ合成する（表示層のみ・純関数）。
 * 既存データだけから毎回導出する（保存フィールドを増やさない＝§17）。trueAbility は一切参照しない。
 *
 *   出自   : transactionLog の draft 行（競合くじ情報 contenders があれば「n球団競合の末」を追記）。
 *            ログに無い選手（初期世界生成/ログ開始前からの在籍）は最も古い在籍先を「生え抜き」として
 *            フォールバック表示する（年不明＝year:null・タイムライン先頭に置く）。
 *   移籍歴 : transactionLog のトレード/FA/戦力外拾い上げ（戦力外→復活は市場非効率の宝として素直に
 *            事実を書くだけで十分ドラマになる＝誇張しない）。
 *   栄光   : playerAwardHistory（MVP/新人王/タイトル/ベストナイン/守備の栄誉賞）＋ nicknameFor
 *            （二つ名そのものには「獲得年」が無いため、直近の在籍年＝物語上「現在はこう呼ばれる」の
 *            位置に1件だけ置く。「未知数」＝サンプル不足はノイズなので出さない）。
 *   節目   : careerBatting/careerPitching の通算値が awards.mjs の milestones() 閾値
 *            （安打/本塁打/勝利/セーブ/奪三振）を跨いだ年を検出（在籍全年を走査・閾値は流用のみで
 *            変更しない）。
 *   因縁   : rivalriesOf の draftmate（同年同round指名の同期）のみを採用する。trade/faOld/pickupOld
 *            は移籍歴セクションと内容が重複する（transactionLogの同じ行が出処）ため、ここでは
 *            二重掲載を避けて省く。
 *
 * @param {Object} state GameState（transactionLog/awardsHistory/careerStats/teamHistory/league/
 *   retiredPlayers が必要。合成フィクスチャでも可＝欠けたフィールドは空扱い）
 * @param {string} playerId
 * @param {{pnameOf?:Function, tnameOf?:Function, posLabelOf?:Function}} names 表示名解決（省略時は
 *   識別子そのまま。他の *Headlines 系関数と同じ規約）
 * @returns {Array<{year:number|null, text:string, kind:string}>} 年昇順（同年は出自→移籍/因縁→
 *   節目/栄光の順・さらに同点はテキスト昇順で決定論的に確定）
 */
export function playerStoryOf(state, playerId, names = {}) {
  const { tnameOf = (id) => id, pnameOf = (id) => id, posLabelOf = (pos) => pos } = names;
  const cfg = state.cfg;
  const log = state.transactionLog || [];
  const careerStats = state.careerStats || [];
  const events = [];

  const playersById = localPlayersById(state);
  const rec = playersById.get(playerId) || null;

  // --- 出自: ドラフト指名 or 生え抜きフォールバック ---
  const myLogRows = log.filter((r) => r.playerId === playerId).sort((a, b) => a.year - b.year || idAsc(a.kind, b.kind));
  const draftRow = myLogRows.find((r) => r.kind === 'draft');
  if (draftRow) {
    const team = tnameOf(draftRow.to);
    const n = draftRow.contenders;
    const prefix = n && n >= 2 ? `${n}球団競合の末、` : '';
    events.push({ year: draftRow.year, text: `${prefix}ドラフト${draftRow.round}位で${team}に入団`, kind: 'origin' });
  } else {
    const earliestMove = myLogRows.find((r) => r.kind === 'trade' || r.kind === 'fa' || r.kind === 'pickup');
    if (earliestMove) {
      // ログ開始前からの在籍＝その最初の移籍の「元の所属」を生え抜き扱い（起源の年は不明）。
      events.push({ year: null, text: `${tnameOf(earliestMove.from)}の生え抜き`, kind: 'origin' });
    } else {
      const fc = firstCareerRow(state, playerId);
      const teamId = fc ? fc.teamId : (rec ? rec.teamId : null);
      if (teamId != null) events.push({ year: fc ? fc.season : null, text: `${tnameOf(teamId)}の生え抜き`, kind: 'origin' });
    }
  }

  // --- 移籍歴: トレード/FA/戦力外拾い上げ ---
  for (const row of myLogRows) {
    if (row.kind === 'trade') {
      events.push({ year: row.year, text: `${tnameOf(row.from)}から${tnameOf(row.to)}へトレード`, kind: 'transfer' });
    } else if (row.kind === 'fa') {
      events.push({ year: row.year, text: `FAで${tnameOf(row.from)}から${tnameOf(row.to)}へ移籍`, kind: 'transfer' });
    } else if (row.kind === 'pickup') {
      events.push({ year: row.year, text: `${tnameOf(row.from)}を戦力外、${tnameOf(row.to)}が拾い上げ`, kind: 'transfer' });
    }
  }

  // --- 栄光: 受賞履歴 ＋ 二つ名 ---
  const hist = playerAwardHistory(playerId, {
    careerStats, teamHistory: state.teamHistory || [], playersById, cfg, awardsHistory: state.awardsHistory || [],
  });
  for (const a of hist) {
    events.push({ year: a.year, text: `${a.label}${a.pos ? `（${posLabelOf(a.pos)}）` : ''}を獲得`, kind: 'award' });
  }
  if (rec) {
    const nick = nicknameFor(rec, careerStats, cfg);
    if (nick !== '未知数') {
      const lc = lastCareerRow(state, playerId);
      events.push({ year: lc ? lc.season : state.year, text: `「${nick}」の異名で呼ばれるように`, kind: 'nickname' });
    }
  }

  // --- 節目: 通算マイルストーン到達（awards.mjs の閾値をそのまま流用） ---
  const years = [...new Set(careerStats.filter((s) => s.playerId === playerId).map((s) => s.season))].sort((a, b) => a - b);
  for (const y of years) {
    for (const m of milestones({ careerStats, playersById, cfg, year: y })) {
      if (m.playerId !== playerId) continue;
      events.push({ year: y, text: `通算${m.threshold}${m.unit}達成`, kind: 'milestone' });
    }
  }

  // --- 因縁: 同年同round指名の同期のみ（トレード/FA/戦力外はtransactionLogの同一行＝移籍歴と重複するため省く） ---
  for (const r of rivalriesOf(state, playerId)) {
    if (r.type !== 'draftmate') continue;
    events.push({ year: r.year, text: `${pnameOf(r.otherPlayerId)}とは同期指名（${r.round}位）の間柄（${tnameOf(r.matchTeamId)}）`, kind: 'rivalry' });
  }

  const yearKey = (y) => (y == null ? -Infinity : y);
  events.sort((a, b) =>
    yearKey(a.year) - yearKey(b.year) ||
    STORY_KIND_ORDER.indexOf(a.kind) - STORY_KIND_ORDER.indexOf(b.kind) ||
    idAsc(a.text, b.text));
  return events;
}

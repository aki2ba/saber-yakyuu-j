// ============================================================================
// フェーズC4: 表彰・記録・二つ名（§16/§17・phaseC_spec C4）
//
//   computeSeasonAwards({playerSeasons, standings, playersById, cfg, allCareerStats, year})
//     … 完了シーズンの "観測成績/WAR" から各リーグの表彰を選定する（MVP/新人王/ベストナイン/
//        守備の栄誉賞/タイトル9種）。選定は観測集計と WAR のみ（trueAbility 非参照＝三層構造）。
//   playerAwardHistory(playerId, {careerStats, teamHistory, playersById, cfg, firstSeason})
//     … 全年の表彰を再計算し、その選手の受賞履歴を集める（受賞は careerStats から決定論再現）。
//   leagueRecords({careerStats, playersById, cfg})   … シーズン/通算のトップN リーグ記録。
//   teamRecords(teamHistory, cfg)                     … 球団史（年度別順位・日本一）。
//   milestones({careerStats, playersById, cfg, year}) … 当年に通算で跨いだマイルストーン通知。
//   nicknameFor(player, careerStats, cfg)             … 通算観測パターンから二つ名を自動付与。
//
// 決定論: すべて (careerStats, teamHistory) の純関数。同値タイは playerId 昇順で割る。
// エンジン不変: 集計/表示のみ。1年目レギュラーシーズン（既存50較正）には一切干渉しない。
// ============================================================================
import { deriveLeagueConstants } from '../sim/leagueConstants.mjs';
import { playerBatting, playerPitching } from '../sim/metrics.mjs';
import { hitterWAR, pitcherWAR } from '../sim/war.mjs';
import { uzrRuns, centeredOAAOuts, totalFieldInnings } from '../sim/fielding.mjs';
import { qualifiedPA, qualifiedIP } from '../config.mjs';
import { FIELD_POSITIONS } from '../model/positions.mjs';

/** 守備の栄誉賞の架空名（§16: 実在の「ゴールデングラブ」を避ける）。 */
export const DEF_AWARD_NAME = 'ベストディフェンダー賞';

/** ベストナインのポジション並び（P＝先発格・DH は DH リーグのみ計上）。 */
const BEST_NINE_POS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];

/** タイトル定義（key→表示名・観測ベース）。守備の栄誉賞/MVP/新人王/ベストナインは別枠。 */
export const TITLE_LABELS = {
  battingAvg: '首位打者', homeRun: '本塁打王', rbi: '打点王', steal: '盗塁王',
  era: '最優秀防御率', wins: '最多勝', strikeoutsP: '最多奪三振', hold: '最優秀中継ぎ', save: '最多セーブ',
};

/** リーグ定数（wOBA/FIP/RPW…）を当年の観測から導出。標準の deriveLeagueConstants を使う。 */
export function seasonLeagueConstants(playerSeasons, standings) {
  return deriveLeagueConstants({ playerSeasons, standings });
}

/** teamId→league の対応（順位表 standings 行から）。 */
function teamLeagueMap(standings) {
  const m = new Map();
  for (const r of standings || []) m.set(r.teamId, r.league ?? 'ALL');
  return m;
}

/**
 * 1選手・1シーズンの観測指標＋WAR（表彰選定の素）。role で打者/投手に分岐する。
 * すべて既存の指標器（metrics/war/fielding）の再利用＝観測とWARのみ（真値非参照）。
 */
export function evalSeason(s, player, cfg, lc) {
  if (player.role === 'pitcher') {
    const p = playerPitching(s, lc, cfg);
    const w = pitcherWAR(s, cfg, lc);
    return {
      role: 'pitcher', war: w.war, ip: p.ip, era: p.era, fip: p.fip,
      w: p.w, l: p.l, so: p.so, sv: p.sv, hld: p.hld, g: p.g, gs: p.gs,
    };
  }
  const b = playerBatting(s, lc);
  const w = hitterWAR(s, cfg, lc);
  const uzr = uzrRuns(s, cfg, lc);
  const oaa = centeredOAAOuts(s, lc);
  const innings = totalFieldInnings(s.fielding);
  return {
    role: 'fielder', war: w.war, pa: b.pa, avg: b.avg, hr: b.hr, rbi: b.rbi, sb: b.sb,
    h: b.h, obp: b.obp, ops: b.ops, wrcPlus: b.wrcPlus, uzr, oaa,
    defScore: uzr + 0.8 * oaa, innings,
  };
}

/** 各 playerSeason を {id, teamId, player, ev} 化（未知IDは除外）。 */
function buildEvals(playerSeasons, playersById, cfg, lc) {
  const out = [];
  for (const s of playerSeasons) {
    const p = playersById.get(s.playerId);
    if (!p) continue;
    out.push({ id: s.playerId, teamId: s.teamId, player: p, ev: evalSeason(s, p, cfg, lc) });
  }
  return out;
}

/** 最大値リーダー（同値は playerId 昇順）。valFn が null を返す要素は無視。 */
function leaderMax(list, valFn, filterFn) {
  let best = null;
  for (const e of list) {
    if (filterFn && !filterFn(e)) continue;
    const v = valFn(e);
    if (v == null || Number.isNaN(v)) continue;
    if (!best || v > best.v || (v === best.v && e.id < best.id)) best = { id: e.id, v, e };
  }
  return best;
}

/** 最小値リーダー（防御率など・同値は playerId 昇順）。 */
function leaderMin(list, valFn, filterFn) {
  let best = null;
  for (const e of list) {
    if (filterFn && !filterFn(e)) continue;
    const v = valFn(e);
    if (v == null || Number.isNaN(v)) continue;
    if (!best || v < best.v || (v === best.v && e.id < best.id)) best = { id: e.id, v, e };
  }
  return best;
}

const asTitle = (r) => (r ? { playerId: r.id, value: r.v } : null);

/**
 * 完了シーズンの表彰を各リーグごとに選定する（観測成績/WAR ベース・§55）。
 * @returns {{year:number, leagues:Array}} leagues[]= {leagueId, mvp, roty, titles, bestNine, gloves}
 */
export function computeSeasonAwards({ playerSeasons, standings, playersById, cfg, allCareerStats = null, year = null }) {
  const lc = seasonLeagueConstants(playerSeasons, standings);
  const evals = buildEvals(playerSeasons, playersById, cfg, lc);
  const lgOf = teamLeagueMap(standings);
  const qPA = qualifiedPA(cfg.league.gamesPerSeason);
  const qIP = qualifiedIP(cfg.league.gamesPerSeason);
  const A = cfg.tuning.awards;

  // 新人（当年デビュー）判定: 当年より前の season を持たない playerId。allCareerStats 未指定なら空。
  const priorIds = new Set();
  if (allCareerStats && year != null) {
    for (const s of allCareerStats) if (s.season < year) priorIds.add(s.playerId);
  }
  const isRookie = (id) => !priorIds.has(id);

  // リーグ集合（順位表の league から）。
  const leagueIds = [...new Set([...lgOf.values()])].sort();
  const leagues = leagueIds.map((lid) => {
    const inLg = evals.filter((e) => lgOf.get(e.teamId) === lid);
    const bat = inLg.filter((e) => e.ev.role === 'fielder');
    const pit = inLg.filter((e) => e.ev.role === 'pitcher');

    const titles = {
      battingAvg: asTitle(leaderMax(bat, (e) => e.ev.avg, (e) => e.ev.pa >= qPA)),
      homeRun: asTitle(leaderMax(bat, (e) => e.ev.hr, (e) => e.ev.hr > 0)),
      rbi: asTitle(leaderMax(bat, (e) => e.ev.rbi, (e) => e.ev.rbi > 0)),
      steal: asTitle(leaderMax(bat, (e) => e.ev.sb, (e) => e.ev.sb > 0)),
      era: asTitle(leaderMin(pit, (e) => e.ev.era, (e) => e.ev.ip >= qIP)),
      wins: asTitle(leaderMax(pit, (e) => e.ev.w, (e) => e.ev.w > 0)),
      strikeoutsP: asTitle(leaderMax(pit, (e) => e.ev.so, (e) => e.ev.so > 0)),
      hold: asTitle(leaderMax(pit, (e) => e.ev.hld, (e) => e.ev.hld > 0)),
      save: asTitle(leaderMax(pit, (e) => e.ev.sv, (e) => e.ev.sv > 0)),
    };

    // MVP: リーグ内 WAR 最高（打者/投手横断）。新人王: 新人のうち WAR 最高（最低出場ゲートあり）。
    //   開幕年（priorIds 空＝全員デビュー）は新人王の意味が立たないため付与しない。
    const mvp = asMvp(leaderMax(inLg, (e) => e.ev.war));
    const rotyGate = (e) => isRookie(e.id) && (e.ev.role === 'pitcher' ? e.ev.ip >= A.rotyMinIp : e.ev.pa >= A.rotyMinPa);
    const roty = priorIds.size ? asMvp(leaderMax(inLg, (e) => e.ev.war, rotyGate)) : null;

    // ベストナイン: 各ポジション（primaryPos）で WAR 最高。P は先発格（gs 最多寄り）を優先。
    const bestNine = [];
    for (const pos of BEST_NINE_POS) {
      let r;
      if (pos === 'P') {
        r = leaderMax(pit, (e) => e.ev.war, (e) => e.ev.gs >= 10) || leaderMax(pit, (e) => e.ev.war);
      } else {
        const atPos = inLg.filter((e) => e.player.primaryPos === pos);
        if (pos === 'DH' && !atPos.length) continue; // DH不在リーグは DH 枠なし
        r = leaderMax(atPos, (e) => e.ev.war);
      }
      if (r) bestNine.push({ pos, playerId: r.id, war: r.v });
    }

    // 守備の栄誉賞（UZR+OAA）: 8守備位置で defScore 最高（最低守備イニングゲート）。
    const gloves = [];
    for (const pos of FIELD_POSITIONS) {
      const atPos = bat.filter((e) => e.player.primaryPos === pos && e.ev.innings >= A.gloveMinInnings);
      const r = leaderMax(atPos, (e) => e.ev.defScore);
      if (r) gloves.push({ pos, playerId: r.id, defScore: r.v, uzr: r.e.ev.uzr, oaa: r.e.ev.oaa });
    }

    return { leagueId: lid, mvp, roty, titles, bestNine, gloves };
  });

  return { year, leagues };
}

const asMvp = (r) => (r ? { playerId: r.id, war: r.v } : null);

/**
 * 選手の受賞履歴（全年の表彰を再計算して収集）。determinism: careerStats/teamHistory から純関数で復元。
 * @returns {Array} [{year, kind, label, pos?}]（kind='mvp'|'roty'|'title'|'bestNine'|'glove'）
 */
export function playerAwardHistory(playerId, { careerStats, teamHistory, playersById, cfg }) {
  const byYear = new Map();
  for (const s of careerStats) {
    if (!byYear.has(s.season)) byYear.set(s.season, []);
    byYear.get(s.season).push(s);
  }
  const out = [];
  for (const hist of teamHistory) {
    const year = hist.year;
    const ps = byYear.get(year);
    if (!ps) continue;
    const aw = computeSeasonAwards({ playerSeasons: ps, standings: hist.standings, playersById, cfg, allCareerStats: careerStats, year });
    for (const lg of aw.leagues) {
      if (lg.mvp && lg.mvp.playerId === playerId) out.push({ year, kind: 'mvp', label: 'MVP' });
      if (lg.roty && lg.roty.playerId === playerId) out.push({ year, kind: 'roty', label: '新人王' });
      for (const k of Object.keys(lg.titles)) {
        const t = lg.titles[k];
        if (t && t.playerId === playerId) out.push({ year, kind: 'title', label: TITLE_LABELS[k], titleKey: k, value: t.value });
      }
      for (const b of lg.bestNine) if (b.playerId === playerId) out.push({ year, kind: 'bestNine', label: 'ベストナイン', pos: b.pos });
      for (const g of lg.gloves) if (g.playerId === playerId) out.push({ year, kind: 'glove', label: DEF_AWARD_NAME, pos: g.pos });
    }
  }
  out.sort((a, b) => a.year - b.year);
  return out;
}

// --- 通算集計（二つ名・記録・マイルストーンの素。観測のみ・§17） ------------------
/** 打撃の通算生カウント合算（careerStats の batting を全年で足す）。 */
export function careerBatting(careerStats, playerId) {
  const acc = { pa: 0, ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, so: 0, sf: 0, sb: 0, cs: 0, rbi: 0, ibb: 0 };
  let seasons = 0;
  for (const s of careerStats) {
    if (s.playerId !== playerId || !s.batting) continue;
    seasons++;
    for (const k of Object.keys(acc)) acc[k] += s.batting[k] || 0;
  }
  const avg = acc.ab ? acc.h / acc.ab : 0;
  const tb = acc.b1 + 2 * acc.b2 + 3 * acc.b3 + 4 * acc.hr;
  const slg = acc.ab ? tb / acc.ab : 0;
  const bbPct = acc.pa ? acc.bb / acc.pa : 0;
  return { ...acc, seasons, avg, slg, iso: slg - avg, bbPct };
}

/** 投手の通算生カウント合算。 */
export function careerPitching(careerStats, playerId) {
  const acc = { outs: 0, bf: 0, h: 0, hr: 0, bb: 0, ibb: 0, hbp: 0, so: 0, er: 0, r: 0, w: 0, l: 0, sv: 0, hld: 0, g: 0, gs: 0 };
  let seasons = 0;
  for (const s of careerStats) {
    if (s.playerId !== playerId || !s.pitching) continue;
    seasons++;
    for (const k of Object.keys(acc)) acc[k] += s.pitching[k] || 0;
  }
  const ip = acc.outs / 3;
  return { ...acc, seasons, ip, era: ip ? (acc.er * 9) / ip : 0, bbPer9: ip ? (acc.bb * 9) / ip : 0, kPer9: ip ? (acc.so * 9) / ip : 0 };
}

/**
 * 二つ名（§16 Lv4回避）: 通算 "観測" 集計のパターンで自動付与する（priority 順・最初の一致）。
 * trueAbility を一切見ない＝出場して積み上げた観測（H/HR/SB/BB%・IP/BB9/K9/S）のみで決める。
 * サンプルが薄い（IP/PA ゲート未満）選手は「未知数」を返す（キャラ立ては通算実績で）。
 */
export function nicknameFor(player, careerStats, cfg) {
  const N = cfg.tuning.awards.nickname;
  if (player.role === 'pitcher') {
    const c = careerPitching(careerStats, player.id);
    if (c.ip < N.ipGate) return '未知数';
    if (c.sv >= N.closerSv) return '守護神';
    if (c.bbPer9 <= N.precisionBbPer9) return '精密機械';
    if (c.kPer9 >= N.strikeoutKPer9) return 'ドクターK';
    if (c.ip >= N.workhorseIp) return '鉄腕';
    return c.bbPer9 <= 3.0 ? '技巧派' : '本格派';
  }
  const c = careerBatting(careerStats, player.id);
  if (c.pa < N.paGate) return '未知数';
  if (c.sb >= N.speedSb) return '韋駄天';
  if (c.hr >= N.bigSluggerHr) return '巨砲';
  if (c.hr >= N.sluggerHr) return '大砲';
  if (c.h >= N.hitMachineH && c.avg >= N.hitMachineAvg) return '安打製造機';
  if (c.iso >= N.isoSlugger && c.hr >= N.isoSluggerHr) return 'スラッガー';
  if (c.bbPct >= N.onbaseBbPct) return '出塁の職人';
  return 'いぶし銀';
}

// --- 記録の時代補正（D3・§11.3「記録の文脈」）------------------------------------
/**
 * 通算の「時代補正 +指標」（D3・§11.3）: 各シーズンの記録を**その年の**リーグ環境で正規化し、
 * PA/IP 加重で通算平均する。wRC+ / ERA- / FIP- は元々その年の lgwOBA/lgERA/lgFIP に対する相対値
 * ゆえ、打高時代の .320 と投高時代の .290 が「同価値」として揃う（生の打率/防御率が時代で化ける
 * のを補正する）。各年の lc はその年の全選手観測から導出（seasonLeagueConstants・観測のみ・三層構造）。
 *
 * 決定論: (careerStats, teamHistory) の純関数（各年の lc は当年の playerSeasons/standings から再現）。
 * @param {string} playerId
 * @param {{careerStats:Array, teamHistory:Array, playersById:Map, cfg:Object}} ctx
 * @returns {{role:string, seasons:number, wrcPlus:number|null, eraMinus:number|null,
 *            fipMinus:number|null, byYear:Array}} 加重通算＋年次内訳（未出場は null）
 */
export function careerEraPlus(playerId, { careerStats, teamHistory, playersById, cfg }) {
  const player = playersById.get(playerId);
  if (!player) return { role: null, seasons: 0, wrcPlus: null, eraMinus: null, fipMinus: null, byYear: [] };
  // 年→その年の全 playerSeasons（当年リーグ環境の母集団）と standings（PF/リーグ判定の素）。
  const byYear = new Map();
  for (const s of careerStats) {
    if (!byYear.has(s.season)) byYear.set(s.season, []);
    byYear.get(s.season).push(s);
  }
  const standByYear = new Map();
  for (const h of teamHistory || []) standByYear.set(h.year, h.standings);

  const out = [];
  let num = 0; // 加重合計（分子）
  let den = 0; // 加重（PA or IP）合計
  const isPit = player.role === 'pitcher';
  for (const season of [...byYear.keys()].sort((a, b) => a - b)) {
    const ps = byYear.get(season);
    const mine = ps.find((s) => s.playerId === playerId);
    if (!mine) continue;
    const lc = seasonLeagueConstants(ps, standByYear.get(season) || null);
    if (isPit) {
      const pm = playerPitching(mine, lc, cfg);
      if (!pm.ip) continue;
      out.push({ year: season, ip: pm.ip, eraMinus: pm.eraMinus, fipMinus: pm.fipMinus });
      num += pm.fipMinus * pm.ip; // 代表値は FIP-（守備/運に頑健）
      den += pm.ip;
    } else {
      const bm = playerBatting(mine, lc);
      if (!bm.pa) continue;
      out.push({ year: season, pa: bm.pa, wrcPlus: bm.wrcPlus });
      num += bm.wrcPlus * bm.pa;
      den += bm.pa;
    }
  }
  const wt = den ? num / den : null;
  if (isPit) {
    // ERA- も別途 IP 加重（表示用）。
    let eraNum = 0;
    for (const r of out) eraNum += r.eraMinus * r.ip;
    return { role: 'pitcher', seasons: out.length, wrcPlus: null, eraMinus: den ? eraNum / den : null, fipMinus: wt, byYear: out };
  }
  return { role: 'fielder', seasons: out.length, wrcPlus: wt, eraMinus: null, fipMinus: null, byYear: out };
}

// --- 記録（球団史・リーグ記録・マイルストーン） --------------------------------
/** 球団史: 各年の順位（自リーグ内）と日本一。teamHistory から。 */
export function teamRecords(teamHistory, teamId) {
  const rows = [];
  for (const h of teamHistory) {
    const row = h.standings.find((r) => r.teamId === teamId);
    if (!row) continue;
    const lgRows = h.standings.filter((r) => (r.league ?? 'ALL') === (row.league ?? 'ALL'));
    lgRows.sort((a, b) => (b.w - b.l) - (a.w - a.l) || (b.rs - b.ra) - (a.rs - a.ra));
    const rank = lgRows.findIndex((r) => r.teamId === teamId) + 1;
    rows.push({ year: h.year, rank, w: row.w, l: row.l, t: row.t, champion: h.champion === teamId });
  }
  return rows;
}

/** 全球団の日本一回数（球団史サマリ）。 */
export function championCounts(teamHistory) {
  const m = new Map();
  for (const h of teamHistory) if (h.champion) m.set(h.champion, (m.get(h.champion) || 0) + 1);
  return m;
}

/** トップN リーグ記録（シーズン単発＋通算）。観測集計から。 */
export function leagueRecords({ careerStats, playersById, cfg }) {
  const topN = cfg.tuning.awards.topN;
  const nameOf = (id) => (playersById.get(id) ? playersById.get(id).name : id);
  // シーズン単発トップN（各年の生カウント）。
  const seasonTop = (get, role) => {
    const rows = [];
    for (const s of careerStats) {
      const p = playersById.get(s.playerId);
      if (!p || p.role !== role) continue;
      const v = get(s);
      if (v == null || v <= 0) continue;
      rows.push({ playerId: s.playerId, name: nameOf(s.playerId), year: s.season, value: v });
    }
    rows.sort((a, b) => b.value - a.value || (a.playerId < b.playerId ? -1 : 1));
    return rows.slice(0, topN);
  };
  // 通算トップN（選手横断で合算）。
  const careerTop = (accKind, get) => {
    const byId = new Map();
    const ids = new Set(careerStats.map((s) => s.playerId));
    for (const id of ids) {
      const p = playersById.get(id);
      if (!p) continue;
      const agg = accKind === 'bat' ? careerBatting(careerStats, id) : careerPitching(careerStats, id);
      const v = get(agg);
      if (v == null || v <= 0) continue;
      byId.set(id, { playerId: id, name: nameOf(id), value: v });
    }
    return [...byId.values()].sort((a, b) => b.value - a.value || (a.playerId < b.playerId ? -1 : 1)).slice(0, topN);
  };
  return {
    seasonHR: seasonTop((s) => s.batting && s.batting.hr, 'fielder'),
    seasonH: seasonTop((s) => s.batting && s.batting.h, 'fielder'),
    seasonSB: seasonTop((s) => s.batting && s.batting.sb, 'fielder'),
    seasonW: seasonTop((s) => s.pitching && s.pitching.w, 'pitcher'),
    seasonSO: seasonTop((s) => s.pitching && s.pitching.so, 'pitcher'),
    seasonSV: seasonTop((s) => s.pitching && s.pitching.sv, 'pitcher'),
    careerHR: careerTop('bat', (a) => a.hr),
    careerH: careerTop('bat', (a) => a.h),
    careerSB: careerTop('bat', (a) => a.sb),
    careerW: careerTop('pit', (a) => a.w),
    careerSO: careerTop('pit', (a) => a.so),
    careerSV: careerTop('pit', (a) => a.sv),
  };
}

/** マイルストーン定義（通算 accessor・カテゴリ名・単位）。 */
const MILESTONE_DEFS = [
  { key: 'hits', role: 'fielder', label: '通算安打', unit: '本安打', get: (a) => a.h },
  { key: 'homeRuns', role: 'fielder', label: '通算本塁打', unit: '本塁打', get: (a) => a.hr },
  { key: 'wins', role: 'pitcher', label: '通算勝利', unit: '勝', get: (a) => a.w },
  { key: 'saves', role: 'pitcher', label: '通算セーブ', unit: 'S', get: (a) => a.sv },
  { key: 'strikeouts', role: 'pitcher', label: '通算奪三振', unit: '奪三振', get: (a) => a.so },
];

/**
 * 当年 year に通算で跨いだマイルストーンを検出（通算[〜year] >= T かつ 通算[〜year-1] < T）。
 * @returns {Array} [{playerId, name, category, threshold, total, unit}]
 */
export function milestones({ careerStats, playersById, cfg, year }) {
  const thr = cfg.tuning.awards.milestones;
  const through = (id, y) => careerStats.filter((s) => s.playerId === id && s.season <= y);
  const out = [];
  const ids = new Set(careerStats.filter((s) => s.season === year).map((s) => s.playerId));
  for (const id of [...ids].sort()) {
    const p = playersById.get(id);
    if (!p) continue;
    for (const def of MILESTONE_DEFS) {
      if (p.role !== def.role) continue;
      const cur = def.role === 'fielder' ? careerBatting(through(id, year), id) : careerPitching(through(id, year), id);
      const prev = def.role === 'fielder' ? careerBatting(through(id, year - 1), id) : careerPitching(through(id, year - 1), id);
      const now = def.get(cur);
      const before = def.get(prev);
      for (const T of thr[def.key]) {
        if (now >= T && before < T) {
          out.push({ playerId: id, name: p.name, category: def.label, threshold: T, total: now, unit: def.unit });
        }
      }
    }
  }
  return out;
}

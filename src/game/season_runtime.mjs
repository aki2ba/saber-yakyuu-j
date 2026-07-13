// ============================================================================
// フェーズC1a: 1シーズンの「日次進行ランタイム」（ヘッドレス・UI非依存）
//
// season.mjs の simulateSeason は「1シーズン一括」だが、ゲームシェルは day（節）単位で
// 進めたい。ここでは simulateSeason と *同一の per-game 処理*（playScheduledGame）を
// schedule の index（gi）順に1日ぶんずつ駆動する。gi は階層シードの座標なので、
// 一括実行でも日次分割実行でも結果は bit 単位で同一になる（既存50較正指標が不変）。
//
// 決定論: 乱数は makeRng(hashSeed(seed, ...)) のみ。Date.now/Math.random 非使用。
//   セーブ/ロードは save.mjs が「開幕状態から cursor まで再走（replay）」で復元する
//   （seed と cursor が RNG カーソルに相当する。usage/集計はこの再走で厳密に再現される）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { createTeamSeason } from '../model/statline.mjs';
import { NEUTRAL_PARK } from '../model/battedball.mjs';
import {
  buildSchedule,
  buildTeamCharts,
  makeSeasonStats,
  playScheduledGame,
  finalizeStandings,
  dayScaleOf,
} from '../sim/season.mjs';
import { createUsageState } from '../sim/usage.mjs';
import { buildDepthChart } from '../sim/team.mjs';
import { simulatePostseason } from '../sim/postseason.mjs';
import { buildBoxScore } from './boxscore.mjs';
import { applyRosterMovesForDay, createMovesState } from './roster_moves.mjs';

/**
 * シーズン終了時点でまだ癒えていない故障を、翌シーズンの開幕IL（pendingInjuries）へ持ち越す（R3）。
 * 「9月に全治半年の大怪我 → 翌年の開幕も出られない」を表現する。
 * @returns {Array<{id:string, daysLost:number}>} 翌季開幕時点の残り離脱 day 数
 */
export function carryOverInjuries(rt) {
  const out = [];
  const push = (usageByTeam) => {
    for (const u of usageByTeam.values()) {
      for (const [pid, until] of u.injuredUntil) {
        const remain = until - rt.finalDay;
        if (remain > 0) out.push({ id: pid, daysLost: remain });
      }
    }
  };
  push(rt.usageByTeam);
  if (rt.farm) push(rt.farm.usageByTeam);
  // 決定論・順序非依存（Map の走査順に依らない）
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * 二軍リーグのランタイムを組む（F2-2・phaseF_spec F2-2）。
 * 同じ12球団のファームを cfg.league.farm.leagues の2リーグ（完全架空名・一軍と同分割）で
 * ~110試合。**一軍と同じ playScheduledGame**・別の集計器(farmStats)・独立の階層シード
 * （hashSeed(seed,'farm') を根にする＝一軍の 'game'/'lineup' 系列と非干渉→一軍は farm の
 * 有無で byte 不変）。二軍ロスター＝登録外の支配下＋育成（league.farm・rosterStatus='minor'）。
 * 成立しない構成（ミニリーグ/旧テストの少人数ロスター）では null を返し二軍なしで動く。
 * @returns {?Object} FarmRuntime（可変・cursor が進行位置）
 */
function buildFarmRuntime(league, cfg, { season, seed, registeredByTeam, injuries = [] }) {
  const F = cfg.league.farm;
  if (!F || !(F.leagues ?? []).length) return null;
  const parentIds = (cfg.league.leagues ?? []).map((l) => l.id);
  // 二軍ロスター: 支配下の登録外＋育成（どちらも p.teamId で球団へ紐づく）
  const rosterByTeam = new Map(league.teams.map((t) => [t.id, []]));
  for (const p of league.players) {
    const reg = registeredByTeam.get(p.teamId);
    if (reg && !reg.has(p.id)) rosterByTeam.get(p.teamId)?.push(p);
  }
  for (const p of league.farm ?? []) rosterByTeam.get(p.teamId)?.push(p);
  // 成立チェック: 全球団で 投手>=ローテ+2・野手>=9。満たさなければ二軍リーグは組まない（旧構成互換）。
  for (const t of league.teams) {
    const r = rosterByTeam.get(t.id) ?? [];
    const nP = r.filter((p) => p.role === 'pitcher').length;
    if (nP < cfg.league.rotationSize + 2 || r.length - nP < 9) return null;
  }
  // 二軍チーム: 親球団と同一 id/名前/監督/本拠地。リーグだけ farm 側（親リーグと同分割で対応付け）。
  const teams = league.teams.map((t) => ({
    id: t.id,
    name: t.name,
    league: F.leagues[Math.max(0, parentIds.indexOf(t.league))]?.id ?? F.leagues[0].id,
    manager: t.manager,
    park: t.park,
  }));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const leagueDh = new Map(F.leagues.map((l) => [l.id, l.dh]));
  const chartsByTeam = new Map();
  for (const t of teams) {
    const r = rosterByTeam.get(t.id);
    chartsByTeam.set(t.id, {
      dh: buildDepthChart(r, cfg, { dh: true }),
      noDh: buildDepthChart(r, cfg, { dh: false }),
    });
  }
  // 起用AI: 一軍と同じ usage（priorPitch なし＝破綻救援ガード不作動。育成試合の簡略）。
  const usageByTeam = new Map(teams.map((t) => [t.id, createUsageState(t, chartsByTeam.get(t.id), cfg, null)]));
  // 開幕IL（F2-3）: 直前オフの故障者は二軍でも出場不可（IL選手が二軍戦に出る矛盾の防止・C2.4/§10.5）。
  //   1年目は injuries が空＝無影響（F2-2 と bit 同一）。
  if (injuries.length) {
    const teamOf = new Map();
    for (const [tid, r] of rosterByTeam) for (const p of r) teamOf.set(p.id, tid);
    for (const ev of injuries) {
      const tid = teamOf.get(ev.id);
      const days = ev.daysLost ?? ev.gamesLost; // R3: 開幕IL＝前季の故障の「残り離脱 day 数」
      if (tid == null || !days) continue;
      usageByTeam.get(tid)?.injuredUntil.set(ev.id, days);
    }
  }
  // 日程: buildSchedule を farm 用の試合数ノブで再利用（リーグ内22×5相手=110試合・交流戦なし）。
  const schedCfg = {
    ...cfg,
    league: {
      ...cfg.league,
      inLeagueGamesPerOpp: F.inLeagueGamesPerOpp,
      interLeagueGamesPerOpp: F.interLeagueGamesPerOpp,
      gamesPerSeason: F.gamesPerSeason,
    },
  };
  const farmSeed = hashSeed(seed, 'farm'); // 独立の階層シード根＝一軍の乱数列と非干渉
  const schedule = buildSchedule(teams, makeRng(hashSeed(farmSeed, 'schedule')), schedCfg);
  const standings = new Map();
  for (const t of teams) {
    standings.set(t.id, { ...createTeamSeason(t.id, season), name: t.name, league: t.league, il: { w: 0, l: 0, t: 0 } });
  }
  return {
    seed: farmSeed,
    dayScale: dayScaleOf(schedule, cfg), // R3: gamesLost→day 換算（二軍日程は~110試合）
    teams,
    teamById,
    leagueDh,
    rosterByTeam, // 二軍ロスター（UI/検証用: teamId → players）
    chartsByTeam,
    usageByTeam,
    schedule,
    standings,
    stats: makeSeasonStats(season), // farmStats: 一軍と別の集計器（per-(player,season)・§17集計値のみ）
    runSplit: { dh: { games: 0, runs: 0 }, noDh: { games: 0, runs: 0 } },
    cursor: 0,
    finished: false,
    table: null,
    standingsByLeague: null,
  };
}

/**
 * 二軍の試合を throughDay（含む）まで消化する（F2-2）。二軍は観戦/介入対象外＝スキップ消化のみ
 * （onEvent 無し・box 無し）。一軍と同じ playScheduledGame を farm の独立コンテキストで回す。
 * 全日程消化で順位表を確定し finished にする。
 * @returns {Array} 消化した試合の集計行 [{day,home,away,homeScore,awayScore,tie}]
 */
function advanceFarmThrough(rt, throughDay) {
  const f = rt.farm;
  if (!f || f.finished) return [];
  const pass = {
    statFor: f.stats.statFor,
    getBat: f.stats.getBat,
    getPitch: f.stats.getPitch,
    standings: f.standings,
    runSplit: f.runSplit,
  };
  const ctx = {
    seed: f.seed,
    park: rt.park,
    parkByTeam: rt.parkByTeam, // 二軍も親球団の本拠地 park を使う（専用球場は将来拡張）
    cfg: rt.cfg,
    leagueDh: f.leagueDh,
    teamById: f.teamById,
    chartsByTeam: f.chartsByTeam,
    usageByTeam: f.usageByTeam,
    pass,
    dayScale: f.dayScale,
    season: rt.season, // R6
    // 二軍戦の故障も当季ログへ積む（R3）: 二軍で壊れた選手はそのまま昇格候補から外れる。
    onInjury: (ev) => rt.injuryLog.push({ ...ev, farm: true }),
  };
  const games = [];
  while (f.cursor < f.schedule.length && f.schedule[f.cursor].day <= throughDay) {
    const g = f.schedule[f.cursor];
    const res = playScheduledGame(ctx, g, f.cursor);
    games.push({ day: g.day, home: g.home, away: g.away, homeScore: res.homeScore, awayScore: res.awayScore, tie: res.tie });
    f.cursor++;
  }
  if (f.cursor >= f.schedule.length) {
    const { table, standingsByLeague } = finalizeStandings(f.standings);
    f.table = table;
    f.standingsByLeague = standingsByLeague; // 二軍の順位表も記録（UI: 順位タブのサブ表示素材）
    f.finished = true;
  }
  return games;
}

/**
 * 1シーズンの日次ランタイムを開幕状態で作る。
 * @param {{teams:Array,players:Array}} league generateLeague の出力
 * @param {Object} cfg createConfig()
 * @param {{season:number, seed:number, park?:Object, playerTeamId:string, injuries?:Array}} opts
 *   injuries=直前オフで確定した故障 [{id,severity,gamesLost}]。各選手を新シーズン開幕から
 *   gamesLost 日ぶん離脱(IL)させ、起用AI/ベンチが穴を埋める（C2.4/§10.5）。空配列（1年目）は無影響。
 * @returns {Object} SeasonRuntime（可変・cursor が進行位置）
 */
export function startSeasonRuntime(league, cfg, { season, seed, park = NEUTRAL_PARK, playerTeamId, injuries = [], priorPitch = null, enableMoves = false, masterSeed = null }) {
  const { leagueDh, teamById, chartsByTeam, depthByTeam, registeredByTeam } = buildTeamCharts(league, cfg);
  // 本拠地球場マップ（D2・§11.2）: 球団ごとの park（generateLeague が付与）。無い球団は単一 park へ。
  const parkByTeam = new Map(league.teams.map((t) => [t.id, t.park ?? park]));
  const schedule = buildSchedule(league.teams, makeRng(hashSeed(seed, 'schedule')), cfg);
  const standings = new Map();
  for (const t of league.teams) {
    standings.set(t.id, { ...createTeamSeason(t.id, season), name: t.name, league: t.league, il: { w: 0, l: 0, t: 0 } });
  }
  const stats = makeSeasonStats(season);
  // priorPitch=前年の観測投手ライン(pid→line)。破綻救援ガード（多年運用・原則2）の"前歴"。
  //   1年目は null（前年なし）＝ガード不作動＝較正53指標が byte 不変（startYear が2年目以降のみ渡す）。
  const usageByTeam = new Map(league.teams.map((t) => [t.id, createUsageState(t, chartsByTeam.get(t.id), cfg, priorPitch)]));
  // 開幕IL: 故障選手を所属チームの起用状態に「day < gamesLost の間は不可」として載せる。
  //   day は schedule の節index（1日≒1試合）＝gamesLost をそのまま離脱日数として扱う。
  //   これで selectLineup/selectStarter/bullpenAvailable が離脱中の選手を除外し、ベンチ/控えが
  //   自然に穴を埋める（phaseA の起用AI資産）。injuries が空（1年目）なら一切効かない。
  const byId = new Map(league.players.map((p) => [p.id, p]));
  const seasonInjuries = [];
  for (const ev of injuries) {
    const p = byId.get(ev.id);
    const days = ev.daysLost ?? ev.gamesLost; // R3: 前季の故障の「残り離脱 day 数」
    if (!p || !days) continue; // 引退で消えた選手（pid不在）は無視
    const u = usageByTeam.get(p.teamId);
    if (u) u.injuredUntil.set(ev.id, days);
    seasonInjuries.push({ id: ev.id, name: p.name, teamId: p.teamId, role: p.role, primaryPos: p.primaryPos, severity: ev.severity, daysLost: days });
  }
  const runSplit = { dh: { games: 0, runs: 0 }, noDh: { games: 0, runs: 0 } };
  const finalDay = schedule.length ? schedule[schedule.length - 1].day : -1;
  // 二軍リーグ（F2-2）: 一軍と同じ day カレンダーに並走。成立しない構成（ミニリーグ）は null。
  const farm = buildFarmRuntime(league, cfg, { season, seed, registeredByTeam, injuries });
  return {
    league,
    cfg,
    season,
    seed,
    // キャリアのマスターシード（F2-3: 球団評価プロファイル＝キャリア中固定の座標。
    // 未提供（sim層/単体テスト）は season seed で代用＝同一シーズン内では同様に決定論）。
    masterSeed: masterSeed ?? seed,
    park,
    parkByTeam,
    playerTeamId,
    leagueDh,
    teamById,
    chartsByTeam,
    depthByTeam,
    registeredByTeam, // F2-2: 出場登録29人（teamId → Set(pid)。登録外＋育成＝二軍）
    farm,
    // 出場登録入替（F2-3）: enableMoves（=2年目以降のゲーム層のみ）かつ farm 成立時のみ作動。
    moves: createMovesState(league, { enableMoves, masterSeed: masterSeed ?? seed, season, farm }),
    rosterMoves: [], // 当該シーズンの昇降格ニュースログ（§17: 当該シーズンのみ・replayで再構築）
    // 育成→支配下の季節中昇格ログ（§req_20260708）: league.players/farmを直接動かすため、過去年は
    // offseasonTransitionのみのreplay近道が効かない。年末にGameState.farmPromotionLogへ畳み込んで
    // 永続化し、load時は「その年の分」をこのログからreplay適用する（day単位の再シムは不要）。
    farmPromotionLog: [],
    // 故障（R3）: gamesLost→day 換算と、当季に試合中発生した故障のログ（一軍＋二軍）。
    //   §17: 当該シーズンのみ（save には GameState 側で年ごとに畳み込んで永続）。
    dayScale: dayScaleOf(schedule, cfg),
    injuryLog: [],
    schedule,
    standings,
    stats,
    usageByTeam,
    runSplit,
    cursor: 0, // 次に処理する schedule の index（= gi。day 境界でのみ止まる）
    finalDay,
    seasonInjuries, // 当該シーズン開幕IL（ハブ表示用・[{id,name,teamId,severity,gamesLost}]・当年のみ）
    playerGameLog: [], // 自チームの試合結果（当該シーズンのみ・§17）
    // 采配介入（フェーズC1b）: 自チーム監督プロファイルの人間差し替えログ。
    //   [{ day, teamId, manager:{buntTend,stealTend,ibbTend,quickHook} }]（絶対値）。
    //   その day 以降の試合に効く。save に含め、load 時に replay で同一 day に再適用＝決定論を保つ。
    interventions: [],
    finished: false,
    table: null,
    standingsByLeague: null,
    postseason: null,
  };
}

/** 次に処理する day（節）。全消化後は finalDay+1。 */
export function pendingDay(rt) {
  return rt.cursor < rt.schedule.length ? rt.schedule[rt.cursor].day : rt.finalDay + 1;
}

/**
 * 采配介入を適用（フェーズC1b）。この day に効く監督プロファイルの差し替えを teamById へ反映する。
 * live 実行でも load 後の replay でも同一 day で同一に呼ばれる＝決定論を保つ（絶対値パッチ）。
 */
function applyInterventionsForDay(rt, d) {
  for (const iv of rt.interventions) {
    if (iv.day !== d) continue;
    const team = rt.teamById.get(iv.teamId);
    if (team) team.manager = { ...team.manager, ...iv.manager };
  }
}

/**
 * 1日（節）ぶんの試合をまとめて消化する。schedule は day 昇順・同一 day が連続するため、
 * cursor は必ず day 境界で止まる（save/load の cursor 再走が day 単位で正確になる）。
 * @param {Object} rt SeasonRuntime
 * @param {{collectPlayerEvents?:boolean}} opts collectPlayerEvents=自チーム試合の観戦実況イベントを返す
 * @returns {{day:number, games:Array, playerGames:Array, playerEvents:?Array, seasonEnded:boolean}}
 *   playerEvents は §17（生イベントは当該シーズンのみ・永続しない）に従い返却のみ・rt/save には積まない。
 */
export function advanceRuntimeDay(rt, opts = {}) {
  if (rt.finished) return { day: pendingDay(rt), games: [], farmGames: [], rosterMoves: [], playerGames: [], playerEvents: null, seasonEnded: false };
  const d = pendingDay(rt);
  applyInterventionsForDay(rt, d); // この day 以降に効く采配差し替えを反映（live/replay 共通）
  // 出場登録の入替（F2-3）: その日の試合前に IL補充/復帰・成績入替を適用（2年目以降のみ。
  // 1年目・sim層は rt.moves=null で完全不作動＝simulateSeason と bit 同一を維持・鉄則7）。
  const rosterMoves = applyRosterMovesForDay(rt, d);
  const pass = {
    statFor: rt.stats.statFor,
    getBat: rt.stats.getBat,
    getPitch: rt.stats.getPitch, // 破綻救援ガードの当年観測（多年運用・原則2）
    standings: rt.standings,
    runSplit: rt.runSplit,
  };
  const ctx = {
    seed: rt.seed,
    park: rt.park,
    parkByTeam: rt.parkByTeam,
    cfg: rt.cfg,
    leagueDh: rt.leagueDh,
    teamById: rt.teamById,
    chartsByTeam: rt.chartsByTeam,
    usageByTeam: rt.usageByTeam,
    pass,
    dayScale: rt.dayScale,
    season: rt.season, // R6: 直近故障の残債（指数減衰）の計算に使う
    // 故障ログ（R3・当季のみ・§17集計値）: オフに後遺/故障歴へ落とし、save に永続して
    //   load の replay（season を再シムしない）で同一の真値を再構築する（farmPromotionLog と同方式）。
    onInjury: (ev) => rt.injuryLog.push(ev),
  };
  const games = [];
  const playerGames = [];
  let playerEvents = null;
  while (rt.cursor < rt.schedule.length && rt.schedule[rt.cursor].day === d) {
    const g = rt.schedule[rt.cursor];
    const isPlayer = g.home === rt.playerTeamId || g.away === rt.playerTeamId;
    // 観戦実況/ボックススコア: 自チーム試合は常時イベント収集（onEvent は乱数非消費＝
    // 観戦/ダイジェスト/スキップのどれでも試合結果は不変）。生イベントは box 集計を組んだら
    // 捨て、観戦用（opts.collectPlayerEvents）のときだけ返却する（§17: 生イベント非永続）。
    let events = null;
    pass.onEvent = isPlayer ? (e) => events.push(e) : undefined;
    if (pass.onEvent) events = [];
    const res = playScheduledGame(ctx, g, rt.cursor);
    const rec = {
      day: d,
      home: g.home,
      away: g.away,
      homeScore: res.homeScore,
      awayScore: res.awayScore,
      tie: res.tie,
      innings: res.innings,
    };
    if (isPlayer && events) {
      // E4: 日程・結果タブの簡易ボックススコア（両軍打者/投手の当日ライン・集計行のみ）。
      // live も load の replay も同一イベント列から再構築される（決定論・save は集計値のみ）。
      rec.box = buildBoxScore(events);
    }
    games.push(rec);
    if (isPlayer) {
      rt.playerGameLog.push(rec); // 集計値のみ（イベントは積まない・§17）
      playerGames.push(rec);
      if (opts.collectPlayerEvents && events) playerEvents = events;
    }
    rt.cursor++;
  }
  // 二軍の同日試合（F2-2）: 一軍と同じ day カレンダーで並走消化（<=d ＝ 一軍が全休日を飛ばしても
  // 取り残さない）。二軍は独立シード根（hashSeed(seed,'farm')）＝一軍の結果は二軍の有無で byte 不変。
  const farmGames = advanceFarmThrough(rt, d);
  let seasonEnded = false;
  if (rt.cursor >= rt.schedule.length) {
    finalizeRuntime(rt);
    seasonEnded = true;
  }
  return { day: d, games, farmGames, rosterMoves, playerGames, playerEvents, seasonEnded };
}

/** レギュラーシーズン終了時の確定（順位表＋ポストシーズン）。simulateSeason と同一の座標/シード。 */
function finalizeRuntime(rt) {
  // 二軍の残り日程を洗い流す（F2-2）: 通常は二軍(~110試合)が一軍(143試合)より先に終わるが、
  // 日程直列化の揺らぎで残っても、一軍シーズン確定時に必ず全消化する（=二軍全日程消化の保証）。
  advanceFarmThrough(rt, Infinity);
  const { table, standingsByLeague } = finalizeStandings(rt.standings);
  rt.table = table;
  rt.standingsByLeague = standingsByLeague;
  let postseason = null;
  if ((rt.cfg.league.leagues ?? []).length === 2) {
    postseason = simulatePostseason({
      rankings: rt.cfg.league.leagues.map((l) => ({ id: l.id, rows: standingsByLeague[l.id] ?? [] })),
      chartsByTeam: rt.chartsByTeam,
      teamById: rt.teamById,
      leagueDh: rt.leagueDh,
      cfg: rt.cfg,
      seed: hashSeed(rt.seed, 'postseason'),
      season: rt.season,
      park: rt.park,
      parkByTeam: rt.parkByTeam,
    });
  }
  rt.postseason = postseason;
  rt.finished = true;
}

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
} from '../sim/season.mjs';
import { createUsageState } from '../sim/usage.mjs';
import { simulatePostseason } from '../sim/postseason.mjs';

/**
 * 1シーズンの日次ランタイムを開幕状態で作る。
 * @param {{teams:Array,players:Array}} league generateLeague の出力
 * @param {Object} cfg createConfig()
 * @param {{season:number, seed:number, park?:Object, playerTeamId:string, injuries?:Array}} opts
 *   injuries=直前オフで確定した故障 [{id,severity,gamesLost}]。各選手を新シーズン開幕から
 *   gamesLost 日ぶん離脱(IL)させ、起用AI/ベンチが穴を埋める（C2.4/§10.5）。空配列（1年目）は無影響。
 * @returns {Object} SeasonRuntime（可変・cursor が進行位置）
 */
export function startSeasonRuntime(league, cfg, { season, seed, park = NEUTRAL_PARK, playerTeamId, injuries = [], priorPitch = null }) {
  const { leagueDh, teamById, chartsByTeam, depthByTeam } = buildTeamCharts(league, cfg);
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
    if (!p || !ev.gamesLost) continue; // 引退で消えた選手（pid不在）は無視
    const u = usageByTeam.get(p.teamId);
    if (u) u.injuredUntil.set(ev.id, ev.gamesLost);
    seasonInjuries.push({ id: ev.id, name: p.name, teamId: p.teamId, role: p.role, primaryPos: p.primaryPos, severity: ev.severity, gamesLost: ev.gamesLost });
  }
  const runSplit = { dh: { games: 0, runs: 0 }, noDh: { games: 0, runs: 0 } };
  const finalDay = schedule.length ? schedule[schedule.length - 1].day : -1;
  return {
    league,
    cfg,
    season,
    seed,
    park,
    parkByTeam,
    playerTeamId,
    leagueDh,
    teamById,
    chartsByTeam,
    depthByTeam,
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
  if (rt.finished) return { day: pendingDay(rt), games: [], playerGames: [], playerEvents: null, seasonEnded: false };
  const d = pendingDay(rt);
  applyInterventionsForDay(rt, d); // この day 以降に効く采配差し替えを反映（live/replay 共通）
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
  };
  const games = [];
  const playerGames = [];
  let playerEvents = null;
  while (rt.cursor < rt.schedule.length && rt.schedule[rt.cursor].day === d) {
    const g = rt.schedule[rt.cursor];
    const isPlayer = g.home === rt.playerTeamId || g.away === rt.playerTeamId;
    // 観戦実況: 自チーム試合のみイベント収集（onEvent は乱数非消費＝観戦/スキップで結果不変）。
    let events = null;
    pass.onEvent = isPlayer && opts.collectPlayerEvents ? (e) => events.push(e) : undefined;
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
    games.push(rec);
    if (isPlayer) {
      rt.playerGameLog.push(rec); // 集計値のみ（イベントは積まない・§17）
      playerGames.push(rec);
      if (events) playerEvents = events;
    }
    rt.cursor++;
  }
  let seasonEnded = false;
  if (rt.cursor >= rt.schedule.length) {
    finalizeRuntime(rt);
    seasonEnded = true;
  }
  return { day: d, games, playerGames, playerEvents, seasonEnded };
}

/** レギュラーシーズン終了時の確定（順位表＋ポストシーズン）。simulateSeason と同一の座標/シード。 */
function finalizeRuntime(rt) {
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

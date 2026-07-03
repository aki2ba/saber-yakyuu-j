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
 * @param {{season:number, seed:number, park?:Object, playerTeamId:string}} opts
 * @returns {Object} SeasonRuntime（可変・cursor が進行位置）
 */
export function startSeasonRuntime(league, cfg, { season, seed, park = NEUTRAL_PARK, playerTeamId }) {
  const { leagueDh, teamById, chartsByTeam, depthByTeam } = buildTeamCharts(league, cfg);
  const schedule = buildSchedule(league.teams, makeRng(hashSeed(seed, 'schedule')), cfg);
  const standings = new Map();
  for (const t of league.teams) {
    standings.set(t.id, { ...createTeamSeason(t.id, season), name: t.name, league: t.league, il: { w: 0, l: 0, t: 0 } });
  }
  const stats = makeSeasonStats(season);
  const usageByTeam = new Map(league.teams.map((t) => [t.id, createUsageState(t, chartsByTeam.get(t.id), cfg)]));
  const runSplit = { dh: { games: 0, runs: 0 }, noDh: { games: 0, runs: 0 } };
  const finalDay = schedule.length ? schedule[schedule.length - 1].day : -1;
  return {
    league,
    cfg,
    season,
    seed,
    park,
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
    playerGameLog: [], // 自チームの試合結果（当該シーズンのみ・§17）
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
 * 1日（節）ぶんの試合をまとめて消化する。schedule は day 昇順・同一 day が連続するため、
 * cursor は必ず day 境界で止まる（save/load の cursor 再走が day 単位で正確になる）。
 * @returns {{day:number, games:Array, playerGames:Array, seasonEnded:boolean}}
 */
export function advanceRuntimeDay(rt) {
  if (rt.finished) return { day: pendingDay(rt), games: [], playerGames: [], seasonEnded: false };
  const d = pendingDay(rt);
  const pass = {
    statFor: rt.stats.statFor,
    getBat: rt.stats.getBat,
    standings: rt.standings,
    runSplit: rt.runSplit,
  };
  const ctx = {
    seed: rt.seed,
    park: rt.park,
    cfg: rt.cfg,
    leagueDh: rt.leagueDh,
    teamById: rt.teamById,
    chartsByTeam: rt.chartsByTeam,
    usageByTeam: rt.usageByTeam,
    pass,
  };
  const games = [];
  const playerGames = [];
  while (rt.cursor < rt.schedule.length && rt.schedule[rt.cursor].day === d) {
    const g = rt.schedule[rt.cursor];
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
    if (g.home === rt.playerTeamId || g.away === rt.playerTeamId) {
      rt.playerGameLog.push(rec);
      playerGames.push(rec);
    }
    rt.cursor++;
  }
  let seasonEnded = false;
  if (rt.cursor >= rt.schedule.length) {
    finalizeRuntime(rt);
    seasonEnded = true;
  }
  return { day: d, games, playerGames, seasonEnded };
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
    });
  }
  rt.postseason = postseason;
  rt.finished = true;
}

// ============================================================================
// 日程生成・シーズン実行・順位表（1-4a/f）
//
// 12球団総当たり: 各ペア13試合（うちホーム7/6）→ 各チーム143試合・リーグ858試合。
// ※S1は総当たり近似。リーグ内125＋交流戦18＋「節」カレンダーは S3 日程v2 で導入。
// 各試合は階層シードで独立・順序非依存に実行（並列化・再現の前提, §17/§19）。
// 先発は各チームの登板数 % rotationSize（中6日=6人）でローテを回す。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { createPlayerSeason, createTeamSeason } from '../model/statline.mjs';
import { NEUTRAL_PARK } from '../model/battedball.mjs';
import { buildDepthChart } from './team.mjs';
import { simulateGame } from './game.mjs';

/**
 * 総当たり日程を生成（{home,away} のリスト）。
 * 対戦相手ごとの試合数 = round(gamesPerSeason / (球団数-1))。
 * 6球団×140 → 5相手×28、12球団×143 → 11相手×13。ホスト側はペアごとに交互（C-6均衡化）。
 */
export function buildSchedule(teams, rng, gamesPerSeason) {
  const ids = teams.map((t) => t.id);
  const n = ids.length;
  const perPair = Math.round(gamesPerSeason / (n - 1));
  const games = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const startHome = (i + j) % 2; // ペアごとにホスト開始を入替（低index偏りを解消）
      for (let k = 0; k < perPair; k++) {
        const iHosts = k % 2 === startHome;
        games.push(iHosts ? { home: ids[i], away: ids[j] } : { home: ids[j], away: ids[i] });
      }
    }
  }
  // 順序をシャッフル（同一チームの試合が偏らないように）
  for (let i = games.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = games[i];
    games[i] = games[j];
    games[j] = t;
  }
  return games;
}

/**
 * 1シーズンを実行。
 * @param {{teams:Array,players:Array,masterSeed:number}} league
 * @param {Object} cfg
 * @param {{season?:number, seed?:number, park?:Object}} opts
 * @returns {{season:number, standings:Array, playerSeasons:Array, statsById:Map, depthByTeam:Map}}
 */
export function simulateSeason(league, cfg, opts = {}) {
  const season = opts.season ?? 2026;
  const seed = opts.seed ?? league.masterSeed ?? 20260701;
  const park = opts.park ?? NEUTRAL_PARK;

  // 編成表
  // TODO(S2): DH無し試合（L1主催）は initSide v2 で投手打席へ差し替える。S1では全試合DH打順で従来動作を維持。
  const depthByTeam = new Map();
  for (const t of league.teams) {
    const roster = league.players.filter((p) => p.teamId === t.id);
    depthByTeam.set(t.id, buildDepthChart(roster, cfg, { dh: true }));
  }

  // 集計器
  const stats = new Map();
  const statFor = (pid, teamId) => {
    let s = stats.get(pid);
    if (!s) {
      s = createPlayerSeason(pid, season);
      s.teamId = teamId;
      stats.set(pid, s);
    }
    return s;
  };
  const standings = new Map();
  for (const t of league.teams) standings.set(t.id, { ...createTeamSeason(t.id, season), name: t.name });

  // スプレー収集（§16, §17: 生イベントは最新シーズンのみ保持）。opts.collectSpray で有効化。
  const spray = opts.collectSpray ? new Map() : null;
  const capPerBatter = opts.sprayCap ?? 600;
  const onBattedBall = spray
    ? (batterId, teamId, bb, result) => {
        let arr = spray.get(batterId);
        if (!arr) {
          arr = [];
          spray.set(batterId, arr);
        }
        if (arr.length < capPerBatter) {
          arr.push({ sprayDeg: bb.sprayDeg, distanceM: bb.distanceM, laDeg: bb.laDeg, evKmh: bb.evKmh, result });
        }
      }
    : undefined;

  // 日程実行
  const schedule = buildSchedule(league.teams, makeRng(hashSeed(seed, 'schedule')), cfg.league.gamesPerSeason);
  const gameCount = new Map(league.teams.map((t) => [t.id, 0]));

  const rotationSize = cfg.league.rotationSize;
  schedule.forEach((g, gi) => {
    const rng = makeRng(hashSeed(seed, 'game', gi));
    const hGC = gameCount.get(g.home);
    const aGC = gameCount.get(g.away);
    const res = simulateGame(
      { teamId: g.home, depth: depthByTeam.get(g.home), starterIdx: hGC % rotationSize },
      { teamId: g.away, depth: depthByTeam.get(g.away), starterIdx: aGC % rotationSize },
      cfg,
      rng,
      statFor,
      park,
      onBattedBall,
    );
    gameCount.set(g.home, hGC + 1);
    gameCount.set(g.away, aGC + 1);

    const H = standings.get(g.home);
    const A = standings.get(g.away);
    H.g++;
    A.g++;
    H.rs += res.homeScore;
    H.ra += res.awayScore;
    A.rs += res.awayScore;
    A.ra += res.homeScore;
    if (res.tie) {
      H.t++;
      A.t++;
    } else if (res.homeScore > res.awayScore) {
      H.w++;
      A.l++;
    } else {
      A.w++;
      H.l++;
    }
  });

  const table = [...standings.values()].sort((a, b) => winPct(b) - winPct(a) || b.rs - b.ra - (a.rs - a.ra));
  return { season, standings: table, playerSeasons: [...stats.values()], statsById: stats, depthByTeam, spray };
}

/** 勝率（引分除く） */
export function winPct(t) {
  const dec = t.w + t.l;
  return dec === 0 ? 0 : t.w / dec;
}

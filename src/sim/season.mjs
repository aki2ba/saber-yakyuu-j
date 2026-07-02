// ============================================================================
// 日程生成・シーズン実行・順位表（1-4a/f → フェーズA S3 で日程v2・日次起用AI・PSを導入）
//
// 日程v2（§S3-1）: リーグ内5相手×25（ホーム13/12交互）=125 ＋ 交流戦6相手×3=18 → 143試合。
//   「節」（day）単位に直列化: 各チーム1日1試合・連続 maxTeamConsecDays 日で休日を挟む。
//   試合のDH有無 = ホーム球団の所属リーグ規則（§S2-2）。
// 日次スタメンAI（§S3-2・usage.mjs）: 先発は中5日以上、救援は3連投禁止/前日30球で不可、
//   捕手厚めの休養・プラトーン・25試合ごとの観測ベース見直しで当日スタメンを組む。
// 各試合は階層シードで独立に実行（§17/§19）。起用状態（疲労・見直し）は day 順に逐次更新
// されるため、日程は day 昇順で回す。
// ポストシーズン（§S3-3・postseason.mjs）: CS→日本シリーズ。統計はレギュラーと分離集計。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { createPlayerSeason, createTeamSeason, createBattingLine } from '../model/statline.mjs';
import { NEUTRAL_PARK } from '../model/battedball.mjs';
import { buildDepthChart } from './team.mjs';
import { simulateGame } from './game.mjs';
import { createUsageState, selectStarter, selectLineup, bullpenAvailable, recordGameUsage } from './usage.mjs';
import { simulatePostseason } from './postseason.mjs';

/**
 * 日程v2を生成し「節」（day）単位に直列化する（§S3-1）。
 * 2リーグ×同数構成: リーグ内 各相手 inLeagueGamesPerOpp 試合（ホームは13/12を交互）＋
 * 交流戦 各相手 interLeagueGamesPerOpp 試合（3連戦を一方の本拠地で・ホスト交互）。
 * それ以外の構成は旧・総当たり近似にフォールバック（day直列化は同様に適用）。
 * @param {Array} teams league.teams（t.league でリーグ判定）
 * @param {Object} rng 決定論rng（シャッフル用）
 * @param {Object} cfg createConfig() の設定
 * @returns {Array<{home:string, away:string, day:number}>} day 昇順
 */
export function buildSchedule(teams, rng, cfg) {
  const byLeague = new Map();
  for (const t of teams) {
    const key = t.league ?? '';
    if (!byLeague.has(key)) byLeague.set(key, []);
    byLeague.get(key).push(t.id);
  }
  const groups = [...byLeague.values()];
  const canV2 = groups.length === 2 && groups[0].length === groups[1].length && groups[0].length >= 2;

  const flat = [];
  if (canV2) {
    const nIn = cfg.league.inLeagueGamesPerOpp ?? 25;
    const nInter = cfg.league.interLeagueGamesPerOpp ?? 3;
    // リーグ内: 各ペア nIn 試合。「追加ホーム」（13試合目）は (i+j) 偶奇で振り分け＝
    // 各チームの追加ホスト数が2or3に均され、リーグ内ホームは62or63試合になる。
    for (const g of groups) {
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const extraToI = (i + j) % 2 === 0;
          for (let k = 0; k < nIn; k++) {
            const iHosts = (k % 2 === 0) === extraToI;
            flat.push(iHosts ? { home: g[i], away: g[j] } : { home: g[j], away: g[i] });
          }
        }
      }
    }
    // 交流戦: 各ペア nInter 試合を一方の本拠地で（(a+b) 偶奇でホスト交互＝各チーム3カード主催・
    // 交流戦ホームは9試合。総ホームは71or72試合でほぼ均衡）。
    const [A, B] = groups;
    for (let a = 0; a < A.length; a++) {
      for (let b = 0; b < B.length; b++) {
        const hostA = (a + b) % 2 === 0;
        for (let k = 0; k < nInter; k++) {
          flat.push(hostA ? { home: A[a], away: B[b] } : { home: B[b], away: A[a] });
        }
      }
    }
  } else {
    // フォールバック: 総当たり近似（対戦相手ごとの試合数 = round(G/(n-1))・ホストはペア内交互）
    const ids = teams.map((t) => t.id);
    const n = ids.length;
    const perPair = Math.round((cfg.league.gamesPerSeason ?? 143) / (n - 1));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const startHome = (i + j) % 2;
        for (let k = 0; k < perPair; k++) {
          const iHosts = k % 2 === startHome;
          flat.push(iHosts ? { home: ids[i], away: ids[j] } : { home: ids[j], away: ids[i] });
        }
      }
    }
  }

  // シャッフル（同一カードの偏り解消）→ 節カレンダーへ直列化
  for (let i = flat.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = flat[i];
    flat[i] = flat[j];
    flat[j] = t;
  }
  return serializeDays(flat, teams, cfg.tuning?.schedule?.maxTeamConsecDays ?? 6);
}

/**
 * フラットな試合リストを day 単位へ直列化（§S3-1）。各チーム1日1試合。
 * 連続 maxConsec 日出場したチームは翌日を休日にする（連投制限・中6日の時間基盤）。
 */
function serializeDays(flat, teams, maxConsec) {
  const remaining = flat.slice();
  const consec = new Map(teams.map((t) => [t.id, 0]));
  const out = [];
  let day = 0;
  while (remaining.length) {
    const busy = new Set(); // 今日もう試合が入った（or 休日の）チーム
    for (const [tid, c] of consec) if (c >= maxConsec) busy.add(tid);
    const played = new Set();
    for (let i = 0; i < remaining.length; ) {
      const g = remaining[i];
      if (busy.has(g.home) || busy.has(g.away)) {
        i++;
        continue;
      }
      busy.add(g.home);
      busy.add(g.away);
      played.add(g.home);
      played.add(g.away);
      out.push({ home: g.home, away: g.away, day });
      remaining.splice(i, 1);
    }
    for (const t of teams) consec.set(t.id, played.has(t.id) ? consec.get(t.id) + 1 : 0);
    day++; // 誰も組めない日は全休日（consecがリセットされ翌日は必ず進む）
  }
  return out;
}

/**
 * 1シーズンを実行。
 * @param {{teams:Array,players:Array,masterSeed:number}} league
 * @param {Object} cfg
 * @param {{season?:number, seed?:number, park?:Object, postseason?:boolean}} opts
 * @returns {{season:number, standings:Array, standingsByLeague:Object, playerSeasons:Array,
 *   statsById:Map, depthByTeam:Map, runSplit:Object, usageByTeam:Map, postseason:?Object}}
 */
export function simulateSeason(league, cfg, opts = {}) {
  const season = opts.season ?? 2026;
  const seed = opts.seed ?? league.masterSeed ?? 20260701;
  const park = opts.park ?? NEUTRAL_PARK;

  // 編成表（試合のDH有無=ホーム球団の所属リーグ規則。各チームDH用/DH無し用の両方を用意）
  const leagueDh = new Map((cfg.league.leagues ?? []).map((l) => [l.id, l.dh]));
  const teamById = new Map(league.teams.map((t) => [t.id, t]));
  const chartsByTeam = new Map();
  for (const t of league.teams) {
    const roster = league.players.filter((p) => p.teamId === t.id);
    chartsByTeam.set(t.id, {
      dh: buildDepthChart(roster, cfg, { dh: true }),
      noDh: buildDepthChart(roster, cfg, { dh: false }),
    });
  }
  // 後方互換の depthByTeam: 各チームの所属リーグ規則での編成（リーグ未設定はDH有）
  const depthByTeam = new Map(
    league.teams.map((t) => {
      const c = chartsByTeam.get(t.id);
      return [t.id, (leagueDh.get(t.league) ?? true) ? c.dh : c.noDh];
    }),
  );

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
  // 観測成績の読み取り専用ビュー（S3 usage: 集計器を汚さない。未出場は空ライン＝priorへ回帰）
  const emptyBat = createBattingLine();
  const getBat = (pid) => {
    const s = stats.get(pid);
    return s ? s.batting : emptyBat;
  };
  const standings = new Map();
  for (const t of league.teams) {
    standings.set(t.id, { ...createTeamSeason(t.id, season), name: t.name, league: t.league });
  }

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

  // 日程v2（day昇順）＋日次起用状態（S3）
  const schedule = buildSchedule(league.teams, makeRng(hashSeed(seed, 'schedule')), cfg);
  const usageByTeam = new Map(league.teams.map((t) => [t.id, createUsageState(t, chartsByTeam.get(t.id), cfg)]));
  // 試合のDH規則別 得点集計（セパ得点差はDH規則単位で見る: 所属リーグ単位は球団戦力ノイズが乗る）
  const runSplit = { dh: { games: 0, runs: 0 }, noDh: { games: 0, runs: 0 } };

  schedule.forEach((g, gi) => {
    const rng = makeRng(hashSeed(seed, 'game', gi));
    // 試合のDH有無 = ホーム球団の所属リーグ規則（§S2-2。両チームとも同じ規則で編成）
    const gameDh = leagueDh.get(teamById.get(g.home).league) ?? true;
    const hC = chartsByTeam.get(g.home);
    const aC = chartsByTeam.get(g.away);
    const hU = usageByTeam.get(g.home);
    const aU = usageByTeam.get(g.away);

    // 先発投手（中5日以上）を先に決める＝互いのスタメン（プラトーン）判断の入力になる
    const hSp = selectStarter(hU, g.day, cfg);
    const aSp = selectStarter(aU, g.day, cfg);

    // 当日スタメン・ベンチ・救援可用リスト（usage.mjs）。乱数は試合ごとに独立の階層シード。
    const mkInit = (teamId, chart, u, starterPid, oppStarter, sideIdx) => {
      const sel = selectLineup(
        u,
        {
          day: g.day,
          dh: gameDh,
          oppPitcher: oppStarter,
          rng: makeRng(hashSeed(seed, 'lineup', gi, sideIdx)),
          getBat,
        },
        cfg,
      );
      return {
        teamId,
        depth: chart,
        starterPid,
        lineup: sel.lineup,
        bench: sel.bench,
        availableRelievers: bullpenAvailable(u, g.day, cfg),
        manager: teamById.get(teamId).manager,
        dh: gameDh,
      };
    };
    const hInit = mkInit(g.home, gameDh ? hC.dh : hC.noDh, hU, hSp, aC.dh.byId.get(aSp), 0);
    const aInit = mkInit(g.away, gameDh ? aC.dh : aC.noDh, aU, aSp, hC.dh.byId.get(hSp), 1);

    const res = simulateGame(hInit, aInit, cfg, rng, statFor, park, onBattedBall);

    // 投手使用ログ→日次疲労、野手の連続出場・見直しタイマーを更新（S2引き継ぎのTODO(S3)を解消）
    recordGameUsage(hU, { day: g.day, starterPid: hSp, lineup: hInit.lineup, pitcherLog: res.pitchers.home }, getBat, cfg);
    recordGameUsage(aU, { day: g.day, starterPid: aSp, lineup: aInit.lineup, pitcherLog: res.pitchers.away }, getBat, cfg);

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
    const split = gameDh ? runSplit.dh : runSplit.noDh;
    split.games++;
    split.runs += res.homeScore + res.awayScore;
  });

  const table = [...standings.values()].sort((a, b) => winPct(b) - winPct(a) || b.rs - b.ra - (a.rs - a.ra));
  // リーグ別順位表（table はソート済み→フィルタで順序が保たれる）
  const standingsByLeague = {};
  for (const row of table) {
    const lid = row.league ?? 'ALL';
    (standingsByLeague[lid] = standingsByLeague[lid] || []).push(row);
  }

  // ポストシーズン（§S3-3）: 2リーグ制のときのみ。統計はレギュラーシーズンと分離集計。
  let postseason = null;
  if ((opts.postseason ?? true) && (cfg.league.leagues ?? []).length === 2) {
    postseason = simulatePostseason({
      rankings: cfg.league.leagues.map((l) => ({ id: l.id, rows: standingsByLeague[l.id] ?? [] })),
      chartsByTeam,
      teamById,
      leagueDh,
      cfg,
      seed: hashSeed(seed, 'postseason'),
      park,
    });
  }

  return {
    season,
    standings: table,
    standingsByLeague,
    playerSeasons: [...stats.values()],
    statsById: stats,
    depthByTeam,
    spray,
    runSplit,
    usageByTeam,
    postseason,
  };
}

/** 勝率（引分除く） */
export function winPct(t) {
  const dec = t.w + t.l;
  return dec === 0 ? 0 : t.w / dec;
}

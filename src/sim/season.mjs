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
import { createPlayerSeason, createTeamSeason, createBattingLine, createPitchingLine } from '../model/statline.mjs';
import { NEUTRAL_PARK } from '../model/battedball.mjs';
import { buildDepthChart, selectActiveRoster } from './team.mjs';
import { simulateGame } from './game.mjs';
import { createUsageState, selectStarter, selectLineup, bullpenAvailable, recordGameUsage } from './usage.mjs';
import { simulatePostseason } from './postseason.mjs';
import { makeDeriveContext, makeAccumulateContext, deriveTables } from './context.mjs';

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

// ============================================================================
// 日次ループの共有部品（フェーズC1・ゲーム層から day 単位で駆動するために切り出し）。
//   simulateSeason（一括）と src/game/ の日次ランナーが「同一の per-game 処理」を共有する。
//   → ゲーム層で day を刻んでも、一括APIと bit 単位で同一結果になる（既存50較正が不変）。
// ============================================================================

/**
 * 編成表一式を作る（DH有/無の depth chart・リーグDH規則・teamById・後方互換 depthByTeam）。
 * F2-2: 一軍デプスチャートは「出場登録 rosterActive 人」（selectActiveRoster が支配下から選抜）
 * のみで編成する。登録外の支配下＋育成は二軍（season_runtime の farm リーグ）へ回る。
 * @param {{teams:Array,players:Array}} league
 * @returns {{leagueDh:Map, teamById:Map, chartsByTeam:Map, depthByTeam:Map, registeredByTeam:Map}}
 *   registeredByTeam: teamId → Set(登録選手id)（二軍ロスターの補集合判定に使う）
 */
export function buildTeamCharts(league, cfg) {
  const leagueDh = new Map((cfg.league.leagues ?? []).map((l) => [l.id, l.dh]));
  const teamById = new Map(league.teams.map((t) => [t.id, t]));
  const chartsByTeam = new Map();
  const registeredByTeam = new Map();
  for (const t of league.teams) {
    const roster = league.players.filter((p) => p.teamId === t.id);
    const active = selectActiveRoster(roster, cfg); // 出場登録（roster<=rosterActive なら全員＝旧挙動）
    registeredByTeam.set(t.id, new Set(active.map((p) => p.id)));
    chartsByTeam.set(t.id, {
      dh: buildDepthChart(active, cfg, { dh: true }),
      noDh: buildDepthChart(active, cfg, { dh: false }),
    });
  }
  // 後方互換の depthByTeam: 各チームの所属リーグ規則での編成（リーグ未設定はDH有）
  const depthByTeam = new Map(
    league.teams.map((t) => {
      const c = chartsByTeam.get(t.id);
      return [t.id, (leagueDh.get(t.league) ?? true) ? c.dh : c.noDh];
    }),
  );
  return { leagueDh, teamById, chartsByTeam, depthByTeam, registeredByTeam };
}

/**
 * 観測成績の集計器を1つ作る（三層構造 layer2・未出場は空ライン＝priorへ回帰）。
 * 各パスは独立の集計器で走る（pass1導出用の集計は破棄する）。
 * @returns {{stats:Map, statFor:Function, getBat:Function}}
 */
export function makeSeasonStats(season) {
  const stats = new Map();
  const emptyBat = createBattingLine();
  const emptyPitch = createPitchingLine();
  const statFor = (pid, teamId) => {
    let s = stats.get(pid);
    if (!s) {
      s = createPlayerSeason(pid, season);
      s.teamId = teamId;
      stats.set(pid, s);
    }
    return s;
  };
  const getBat = (pid) => {
    const s = stats.get(pid);
    return s ? s.batting : emptyBat;
  };
  // 当年の観測投手ライン（破綻救援ガード用・読み取り専用）。未出場は空ライン＝ガード非該当。
  const getPitch = (pid) => {
    const s = stats.get(pid);
    return s ? s.pitching : emptyPitch;
  };
  return { stats, statFor, getBat, getPitch };
}

/**
 * 1試合（schedule[gi]）を実行し、起用状態・順位/得点集計・文脈フックを更新する。
 * simulateSeason の runPass のループ本体をそのまま切り出したもの（挙動は完全同一）。
 * @param {{seed:number, park:Object, cfg:Object, leagueDh:Map, teamById:Map,
 *   chartsByTeam:Map, usageByTeam:Map, pass:Object}} ctx
 * @param {{home:string, away:string, day:number}} g
 * @param {number} gi schedule内index（＝階層シード座標。日次実行でも一括と同一にする鍵）
 * @returns {Object} simulateGame の結果
 */
export function playScheduledGame(ctx, g, gi) {
  const { seed, park, cfg, leagueDh, teamById, chartsByTeam, usageByTeam, pass } = ctx;
  // 本拠地球場（D2・§11.2）: 試合はホーム球団の本拠地 park で行う（ビジターは相手本拠地 park）。
  //   parkByTeam 未提供時は単一 park（NEUTRAL/明示park）へフォールバック＝後方互換。
  const gamePark = (ctx.parkByTeam && ctx.parkByTeam.get(g.home)) || park;
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
        getBat: pass.getBat,
      },
      cfg,
    );
    return {
      teamId,
      depth: chart,
      starterPid,
      lineup: sel.lineup,
      bench: sel.bench,
      // 破綻救援ガード（多年運用・原則2）: 当年観測(pass.getPitch)＋独立の階層シードRNGで確率間引き。
      //   penGuard は既存ストリーム(game/lineup)と別座標＝1年目（前歴なしで不作動）は byte 不変。
      availableRelievers: bullpenAvailable(u, g.day, cfg, pass.getPitch, makeRng(hashSeed(seed, 'penGuard', gi, sideIdx))),
      manager: teamById.get(teamId).manager,
      dh: gameDh,
    };
  };
  const hInit = mkInit(g.home, gameDh ? hC.dh : hC.noDh, hU, hSp, aC.dh.byId.get(aSp), 0);
  const aInit = mkInit(g.away, gameDh ? aC.dh : aC.noDh, aU, aSp, hC.dh.byId.get(hSp), 1);

  const res = simulateGame(hInit, aInit, cfg, rng, pass.statFor, gamePark, pass.onBattedBall, {
    gameContext: pass.gameContext,
    onEvent: pass.onEvent, // 観戦実況フック（フェーズC1・通常シムでは undefined＝無影響）
  });

  // 投手使用ログ→日次疲労、野手の連続出場・見直しタイマーを更新
  recordGameUsage(hU, { day: g.day, starterPid: hSp, lineup: hInit.lineup, pitcherLog: res.pitchers.home }, pass.getBat, cfg);
  recordGameUsage(aU, { day: g.day, starterPid: aSp, lineup: aInit.lineup, pitcherLog: res.pitchers.away }, pass.getBat, cfg);

  // WPA ゼロサム検査（§B2）: ホーム側WPA累計が 勝者±0.5/引分0 に一致するか（決着の整合）。
  if (pass.gameContext && pass.gameContext.mode === 'accumulate' && pass.contextCheck) {
    const expected = res.tie ? 0 : res.homeScore > res.awayScore ? 0.5 : -0.5;
    const err = Math.abs(pass.gameContext.gameHomeWpa - expected);
    if (err > pass.contextCheck.wpaMaxErr) pass.contextCheck.wpaMaxErr = err;
  }

  if (pass.standings) {
    const H = pass.standings.get(g.home);
    const A = pass.standings.get(g.away);
    H.g++;
    A.g++;
    H.rs += res.homeScore;
    H.ra += res.awayScore;
    A.rs += res.awayScore;
    A.ra += res.homeScore;
    // パークファクター導出用の得点スプリット（D2・§11.2）: この試合の総得点(両軍)を
    //   ホーム球団は「本拠地(home)」に、ビジター球団は「敵地(road)」に計上する。
    //   PF(team) = 本拠地の得点/試合 ÷ 敵地の得点/試合（自チーム攻守力は比で相殺）。
    const totalRuns = res.homeScore + res.awayScore;
    H.hpRuns = (H.hpRuns || 0) + totalRuns;
    H.hpG = (H.hpG || 0) + 1;
    A.rpRuns = (A.rpRuns || 0) + totalRuns;
    A.rpG = (A.rpG || 0) + 1;
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
    // 交流戦成績（S4 UI）: 別リーグ同士の対戦を各チームの il へ計上
    if (teamById.get(g.home).league !== teamById.get(g.away).league) {
      if (res.tie) {
        H.il.t++;
        A.il.t++;
      } else if (res.homeScore > res.awayScore) {
        H.il.w++;
        A.il.l++;
      } else {
        A.il.w++;
        H.il.l++;
      }
    }
  }
  if (pass.runSplit) {
    const split = gameDh ? pass.runSplit.dh : pass.runSplit.noDh;
    split.games++;
    split.runs += res.homeScore + res.awayScore;
  }
  return res;
}

/**
 * 順位表を確定（勝率降順→得失点差）。リーグ別順位表も返す。
 * @param {Map} standings teamId → 順位行
 * @returns {{table:Array, standingsByLeague:Object}}
 */
export function finalizeStandings(standings) {
  const table = [...standings.values()].sort((a, b) => winPct(b) - winPct(a) || b.rs - b.ra - (a.rs - a.ra));
  const standingsByLeague = {};
  for (const row of table) {
    const lid = row.league ?? 'ALL';
    (standingsByLeague[lid] = standingsByLeague[lid] || []).push(row);
  }
  return { table, standingsByLeague };
}

/**
 * 1シーズンを実行。
 * @param {{teams:Array,players:Array,masterSeed:number}} league
 * @param {Object} cfg
 * @param {{season?:number, seed?:number, park?:Object, postseason?:boolean, context?:boolean}} opts
 *   context=true で文脈指標（RE24/WPA/LI・§B2）を2パスで算出する。pass1でRE行列/WE表/LI表を
 *   大標本導出→焼き固め、pass2（同一シード＝同一試合の再走）で ΔRE/ΔWPA/LI を選手へ加算する。
 *   context無効時は単一パス＝従来と完全同一（乱数消費も不変・較正30指標が不変）。
 * @returns {{season:number, standings:Array, standingsByLeague:Object, playerSeasons:Array,
 *   statsById:Map, depthByTeam:Map, runSplit:Object, usageByTeam:Map, postseason:?Object,
 *   contextTables?:Object, contextCheck?:Object}}
 */
export function simulateSeason(league, cfg, opts = {}) {
  const season = opts.season ?? 2026;
  const seed = opts.seed ?? league.masterSeed ?? 20260701;
  const park = opts.park ?? NEUTRAL_PARK;
  // 本拠地球場マップ（D2・§11.2）: 球団ごとの park（generateLeague が付与）。無い球団は単一 park へ。
  //   opts.park を明示した場合も、park を持つ球団はその本拠地 park を優先する（本拠地/ビジターの正しさ）。
  const parkByTeam = new Map(league.teams.map((t) => [t.id, t.park ?? park]));

  // 編成表（試合のDH有無=ホーム球団の所属リーグ規則。各チームDH用/DH無し用の両方を用意）
  const { leagueDh, teamById, chartsByTeam, depthByTeam } = buildTeamCharts(league, cfg);

  // 観測成績の読み取り専用ビューを持つ集計器を作る（S3 usage: 未出場は空ライン＝priorへ回帰）。
  // 各パスは独立の集計器で走る（三層構造・pass1導出用の集計は破棄する）。
  const makeStats = () => makeSeasonStats(season);

  const standings = new Map();
  for (const t of league.teams) {
    // il = 交流戦成績（S4 UI「2リーグ順位表＋交流戦成績」の素材。所属リーグが異なる対戦のみ勘定）
    standings.set(t.id, { ...createTeamSeason(t.id, season), name: t.name, league: t.league, il: { w: 0, l: 0, t: 0 } });
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

  // 日程v2（day昇順）。日程は一度だけ生成し、各パスで同一に消化する（同一試合＝決定論）。
  const schedule = buildSchedule(league.teams, makeRng(hashSeed(seed, 'schedule')), cfg);
  // 試合のDH規則別 得点集計（セパ得点差はDH規則単位で見る: 所属リーグ単位は球団戦力ノイズが乗る）
  const runSplit = { dh: { games: 0, runs: 0 }, noDh: { games: 0, runs: 0 } };

  /**
   * 日程を1パス消化する。集計器・順位/得点集計・文脈フックを注入する。
   * pass ごとに起用状態(usage)を新規生成＝同一シードなら選手成績も同一に進む（決定論）。
   * @param {{statFor:Function, getBat:Function, standings?:Map, runSplit?:Object,
   *   onBattedBall?:Function, gameContext?:Object, contextCheck?:Object}} pass
   * @returns {Map} usageByTeam（消化後の起用状態）
   */
  const runPass = (pass) => {
    const usageByTeam = new Map(league.teams.map((t) => [t.id, createUsageState(t, chartsByTeam.get(t.id), cfg)]));
    const ctx = { seed, park, parkByTeam, cfg, leagueDh, teamById, chartsByTeam, usageByTeam, pass };
    schedule.forEach((g, gi) => playScheduledGame(ctx, g, gi));
    return usageByTeam;
  };

  // 文脈指標（§B2）の2パス導出: pass1でRE行列/WE表/LI表を大標本から焼き、pass2（同一試合の再走）で
  // 選手へ ΔRE/ΔWPA/LI を加算する。context無効時は単一パス（従来と完全同一・較正30指標が不変）。
  let contextTables = null;
  let contextCheck = null;
  if (opts.context) {
    const derive = makeStats();
    const dgc = makeDeriveContext(cfg);
    runPass({ statFor: derive.statFor, getBat: derive.getBat, getPitch: derive.getPitch, gameContext: dgc }); // pass1: 導出のみ（集計は破棄）
    contextTables = deriveTables(dgc, cfg);
    contextCheck = { wpaMaxErr: 0 };
  }

  const main = makeStats();
  const usageByTeam = runPass({
    statFor: main.statFor,
    getBat: main.getBat,
    getPitch: main.getPitch,
    standings,
    runSplit,
    onBattedBall,
    gameContext: contextTables ? makeAccumulateContext(contextTables, cfg) : null,
    contextCheck,
  });
  const stats = main.stats;

  const { table, standingsByLeague } = finalizeStandings(standings);

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
      season, // 日本シリーズの主催リーグを年の偶奇で交互にするため（NPB方式）
      park,
      parkByTeam,
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
    contextTables, // §B2: RE行列/WE表/LI表（context有効時のみ・非null）
    contextCheck, // §B2: { wpaMaxErr } ゼロサム検査の最大誤差（context有効時のみ）
  };
}

/** 勝率（引分除く） */
export function winPct(t) {
  const dec = t.w + t.l;
  return dec === 0 ? 0 : t.w / dec;
}

/** ゲーム差（NPB慣例: 首位との勝敗差の平均。首位行の「-」表記は表示側で行う）。負値もそのまま返す。 */
export function gamesBehind(leader, t) {
  return leader ? ((leader.w - t.w) + (t.l - leader.l)) / 2 : 0;
}

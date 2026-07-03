// ============================================================================
// ポストシーズン（フェーズA S3 / §S3-3）
//
// クライマックスシリーズ（CS）→ 日本シリーズを NPB 規則で実行する:
//   CS 1st   : リーグ2位 vs 3位。csFirstWins(2)戦先勝・全試合2位の本拠地。
//   CS Final : リーグ1位 vs CS1st勝者。1位に csFinalAdv(1)勝のアドバンテージ・
//              csFinalWins(4)勝先取・全試合1位の本拠地。
//   日本シリーズ: 両リーグ王者。japanSeriesWins(4)勝先取・2-3-2 の本拠地パターン
//              （レギュラーシーズン勝率上位が第1,2,6,7戦を主催。同率は得失点差→先着）。
// 延長は決着まで（引分なし・maxInnings:Infinity）。DH規則=ホーム球団のリーグ（§S2-2と同じ）。
// 統計はレギュラーシーズンと分離集計（専用の stats Map。混ぜない・§S3-3）。
// 起用はシリーズ内でローテを頭から回す簡易版（日次疲労の持ち越しはフェーズB以降）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { createPlayerSeason } from '../model/statline.mjs';
import { NEUTRAL_PARK } from '../model/battedball.mjs';
import { simulateGame } from './game.mjs';

/**
 * ポストシーズン一式を実行。
 * @param {Object} input
 * @param {Array<{id:string, rows:Array}>} input.rankings リーグ別順位（rows=順位表の行・勝率降順）
 * @param {Map} input.chartsByTeam teamId → {dh,noDh} 編成表
 * @param {Map} input.teamById teamId → チーム（league/manager 参照）
 * @param {Map} input.leagueDh リーグid → DH有無
 * @param {number} input.seed ポストシーズン用シード（レギュラーシーズンから分離）
 * @returns {{csFirst:Object, csFinal:Object, japanSeries:?Object, champion:?string,
 *   playerSeasons:Array, statsById:Map}}
 */
export function simulatePostseason({ rankings, chartsByTeam, teamById, leagueDh, cfg, seed, season = 2026, park = NEUTRAL_PARK }) {
  const rules = cfg.league.postseason ?? {};
  const csFirstWins = rules.csFirstWins ?? 2;
  const csFinalWins = rules.csFinalWins ?? 4;
  const csFinalAdv = rules.csFinalAdv ?? 1;
  const jsWins = rules.japanSeriesWins ?? 4;

  // ポストシーズン専用の集計器（レギュラーシーズンと混ぜない）
  const stats = new Map();
  const statFor = (pid, teamId) => {
    let s = stats.get(pid);
    if (!s) {
      s = createPlayerSeason(pid, 'postseason');
      s.teamId = teamId;
      stats.set(pid, s);
    }
    return s;
  };
  const psGames = new Map(); // teamId → ポストシーズン消化試合数（ローテを頭から回す）

  /** 1試合（延長は決着まで）。DH規則=ホーム球団リーグ。 */
  const playGame = (stage, gi, homeId, awayId) => {
    const rng = makeRng(hashSeed(seed, stage, gi));
    const dh = leagueDh.get(teamById.get(homeId).league) ?? true;
    const init = (teamId) => {
      const c = chartsByTeam.get(teamId);
      const n = psGames.get(teamId) ?? 0;
      psGames.set(teamId, n + 1);
      return {
        teamId,
        depth: dh ? c.dh : c.noDh,
        starterIdx: n, // シリーズはローテ頭から順に（中n日はシリーズ間隔で担保される簡易版）
        manager: teamById.get(teamId).manager,
        dh,
      };
    };
    const res = simulateGame(init(homeId), init(awayId), cfg, rng, statFor, park, undefined, {
      maxInnings: Infinity, // 延長は決着まで（引分なし・§S3-3）
    });
    return { home: homeId, away: awayId, homeScore: res.homeScore, awayScore: res.awayScore, innings: res.innings };
  };

  /** シリーズ（winsNeeded 勝先取。advA=チームaの初期アド、hosts=第n戦のホスト列・末尾を繰返し） */
  const playSeries = (stage, a, b, { winsNeeded, advA = 0, hosts }) => {
    const wins = { [a]: advA, [b]: 0 };
    const games = [];
    let gi = 0;
    while (wins[a] < winsNeeded && wins[b] < winsNeeded) {
      const home = hosts[Math.min(gi, hosts.length - 1)];
      const away = home === a ? b : a;
      const g = playGame(stage, gi, home, away);
      games.push(g);
      wins[g.homeScore > g.awayScore ? g.home : g.away]++;
      gi++;
    }
    const winner = wins[a] >= winsNeeded ? a : b;
    return { teams: [a, b], winsNeeded, advantage: advA > 0 ? a : null, wins, games, winner };
  };

  // --- リーグごとの CS ------------------------------------------------------
  const csFirst = {};
  const csFinal = {};
  const finalists = []; // {league, teamId}
  for (const l of rankings) {
    const ids = l.rows.map((r) => r.teamId);
    const [t1, t2, t3] = ids;
    if (!t1) continue;
    let challenger = t2 ?? null;
    if (t2 && t3) {
      csFirst[l.id] = playSeries(`csFirst:${l.id}`, t2, t3, { winsNeeded: csFirstWins, hosts: [t2] });
      challenger = csFirst[l.id].winner;
    }
    if (challenger) {
      csFinal[l.id] = playSeries(`csFinal:${l.id}`, t1, challenger, {
        winsNeeded: csFinalWins,
        advA: csFinalAdv,
        hosts: [t1],
      });
      finalists.push({ league: l.id, teamId: csFinal[l.id].winner });
    } else {
      finalists.push({ league: l.id, teamId: t1 }); // 相手不在（縮小構成の安全弁）
    }
  }

  // --- 日本シリーズ（2-3-2） -------------------------------------------------
  let japanSeries = null;
  let champion = finalists.length === 1 ? finalists[0].teamId : null;
  if (finalists.length >= 2) {
    const [fa, fb] = [finalists[0].teamId, finalists[1].teamId];
    // 本拠地アドバンテージ: NPB方式＝主催リーグを年の偶奇で交互（勝率無関係）。
    // 偶数年は leagues[0]、奇数年は leagues[1] のリーグ王者が第1,2,6,7戦を主催。
    const leagues = cfg.league.leagues ?? [];
    const hostLeague = leagues.length === 2 ? leagues[season % 2].id : finalists[0].league;
    const aFirst = finalists[0].league === hostLeague;
    const upper = aFirst ? fa : fb;
    const lower = aFirst ? fb : fa;
    const hosts = [upper, upper, lower, lower, lower, upper, upper]; // 2-3-2
    japanSeries = playSeries('japanSeries', upper, lower, { winsNeeded: jsWins, hosts });
    champion = japanSeries.winner;
  }

  return { csFirst, csFinal, japanSeries, champion, playerSeasons: [...stats.values()], statsById: stats };
}

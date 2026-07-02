// ポストシーズン（S3 postseason.mjs）のテスト。
// CS1st(2位vs3位・2戦先勝・2位本拠地)→CSFinal(1位に1勝アド・4勝先取)→日本シリーズ(4勝先取・2-3-2)。
// 延長は決着まで（引分なし）。統計はレギュラーシーズンと分離集計。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';

const cfg = createConfig();
const lg = generateLeague(2026, cfg);
const res = simulateSeason(lg, cfg, { seed: 2026 });
const post = res.postseason;

const allSeries = () => {
  const out = [];
  for (const l of ['L1', 'L2']) {
    if (post.csFirst[l]) out.push(post.csFirst[l]);
    if (post.csFinal[l]) out.push(post.csFinal[l]);
  }
  if (post.japanSeries) out.push(post.japanSeries);
  return out;
};

test('CS1st: リーグ2位vs3位・全試合2位本拠地・2戦先勝で決着（S3）', () => {
  const rules = cfg.league.postseason;
  for (const l of ['L1', 'L2']) {
    const rows = res.standingsByLeague[l];
    const s = post.csFirst[l];
    assert.ok(s, `${l} のCS1stが存在`);
    assert.deepEqual(s.teams, [rows[1].teamId, rows[2].teamId], '2位vs3位');
    for (const g of s.games) assert.equal(g.home, rows[1].teamId, '全試合2位の本拠地');
    assert.equal(s.wins[s.winner], rules.csFirstWins, '勝者は2勝');
    assert.ok(s.games.length >= 2 && s.games.length <= 3, '2〜3試合で決着');
    assert.equal(s.advantage, null, 'CS1stにアドバンテージなし');
  }
});

test('CSFinal: リーグ1位に1勝アド・4勝先取・全試合1位本拠地・勝者が日本シリーズへ（S3）', () => {
  const rules = cfg.league.postseason;
  const finalists = [];
  for (const l of ['L1', 'L2']) {
    const rows = res.standingsByLeague[l];
    const s = post.csFinal[l];
    assert.ok(s, `${l} のCSFinalが存在`);
    assert.equal(s.teams[0], rows[0].teamId, '1位が登場');
    assert.equal(s.teams[1], post.csFirst[l].winner, '相手はCS1st勝者');
    assert.equal(s.advantage, rows[0].teamId, '1位に1勝アドバンテージ');
    for (const g of s.games) assert.equal(g.home, rows[0].teamId, '全試合1位の本拠地');
    assert.equal(s.wins[s.winner], rules.csFinalWins, '勝者は計4勝（アド込み）');
    // 1位はアド1勝スタート → 実試合の勝ち数は最大でも3/4
    const [t1] = s.teams;
    const realWins = s.games.filter((g) => (g.homeScore > g.awayScore ? g.home : g.away) === t1).length;
    assert.equal(s.wins[t1], realWins + rules.csFinalAdv, 'アドバンテージが勝数に計上される');
    assert.ok(s.games.length <= 6, 'アド込みで最大6試合');
    finalists.push(s.winner);
  }
  assert.deepEqual(new Set(post.japanSeries.teams), new Set(finalists), '日本シリーズは両CS勝者');
});

test('日本シリーズ: 4勝先取・2-3-2の本拠地パターン・王者が確定（S3）', () => {
  const js = post.japanSeries;
  assert.ok(js, '日本シリーズが存在');
  assert.equal(js.wins[js.winner], cfg.league.postseason.japanSeriesWins);
  assert.ok(js.games.length >= 4 && js.games.length <= 7, '4〜7試合で決着');
  const upper = js.games[0].home;
  const lower = js.teams.find((t) => t !== upper);
  const hostPattern = [upper, upper, lower, lower, lower, upper, upper]; // 2-3-2
  js.games.forEach((g, i) => assert.equal(g.home, hostPattern[i], `第${i + 1}戦の主催`));
  assert.equal(post.champion, js.winner, 'championは日本シリーズ勝者');
});

test('ポストシーズン全試合: 引分なし（延長は決着まで）（S3）', () => {
  let games = 0;
  for (const s of allSeries()) {
    for (const g of s.games) {
      assert.notEqual(g.homeScore, g.awayScore, `引分が発生 (${s.teams.join('vs')} 第${games + 1}戦)`);
      assert.ok(g.innings >= 9, 'イニング数が妥当');
      games++;
    }
  }
  assert.ok(games >= 4 + 4 + 2 + 2 + 4, `ポストシーズンの試合数が妥当 (got ${games})`);
});

test('ポストシーズン統計はレギュラーシーズンと分離集計（混ざらない）（S3）', () => {
  // レギュラーシーズン: 総先発 = 2×858 のまま（PSの先発が混入していない）
  const totalGS = res.playerSeasons.reduce((a, s) => a + s.pitching.gs, 0);
  assert.equal(totalGS, 2 * 858, 'レギュラーシーズンのGS総数が不変');
  // PS側は専用の集計器に載る
  const psGames = allSeries().reduce((a, s) => a + s.games.length, 0);
  const psGS = post.playerSeasons.reduce((a, s) => a + s.pitching.gs, 0);
  assert.equal(psGS, 2 * psGames, 'PSのGS総数 = 2×PS試合数');
  for (const s of post.playerSeasons) {
    assert.equal(s.season, 'postseason', 'PS statlineはpostseasonラベル');
  }
});

test('ポストシーズン: 同一seedで決定論（S3）', () => {
  const res2 = simulateSeason(lg, cfg, { seed: 2026 });
  assert.equal(res2.postseason.champion, post.champion);
  assert.deepEqual(
    JSON.parse(JSON.stringify(res2.postseason.japanSeries.games)),
    JSON.parse(JSON.stringify(post.japanSeries.games)),
  );
});

test('opts.postseason=false でポストシーズンを省略できる（S3）', () => {
  const res3 = simulateSeason(lg, cfg, { seed: 99, postseason: false });
  assert.equal(res3.postseason, null);
});

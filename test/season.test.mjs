// 試合進行サブシステム（1-4）の単体テスト。編成・進塁・シーズン整合を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { buildDepthChart } from '../src/sim/team.mjs';
import { advanceRunners } from '../src/sim/game.mjs';
import { simulateSeason, buildSchedule, winPct } from '../src/sim/season.mjs';
import { makeRng } from '../src/rng.mjs';
import { FIELD_POSITIONS } from '../src/model/positions.mjs';

const cfg = createConfig();

test('buildDepthChart: 打順9・守備8ポジ充足・ローテ5・ブルペン', () => {
  const lg = generateLeague(1, cfg);
  const roster = lg.players.filter((p) => p.teamId === 'T1');
  const d = buildDepthChart(roster);
  assert.equal(d.lineup.length, 9);
  for (const pos of FIELD_POSITIONS) assert.ok(d.defense[pos], `守備 ${pos}`);
  assert.equal(d.rotation.length, 5);
  assert.ok(d.bullpen.length >= 5);
  // 投手は打順に入らない（全球団DH有）
  const lineupIds = new Set(d.lineup.map((s) => s.playerId));
  for (const pid of d.rotation) assert.ok(!lineupIds.has(pid), '投手が打順に不在');
});

test('advanceRunners: 本塁打は全走者＋打者が生還', () => {
  const bases = ['r1', 'r2', 'r3'];
  const runs = advanceRunners(bases, 'HR', 'batter', false, 0);
  assert.equal(runs, 4);
  assert.deepEqual(bases, [null, null, null]);
});

test('advanceRunners: 満塁四球は押し出し1点', () => {
  const bases = ['r1', 'r2', 'r3'];
  const runs = advanceRunners(bases, 'BB', 'batter', false, 1);
  assert.equal(runs, 1);
  assert.deepEqual(bases, ['batter', 'r1', 'r2']);
});

test('advanceRunners: 走者なし四球は得点なし・一塁のみ', () => {
  const bases = [null, null, null];
  const runs = advanceRunners(bases, 'BB', 'batter', false, 0);
  assert.equal(runs, 0);
  assert.deepEqual(bases, ['batter', null, null]);
});

test('advanceRunners: 三塁走者・空中アウト(2アウト未満)は犠飛で生還', () => {
  const bases = [null, null, 'r3'];
  const runs = advanceRunners(bases, 'out', 'batter', true, 1);
  assert.equal(runs, 1);
  assert.deepEqual(bases, [null, null, null]);
});

test('advanceRunners: 2アウトの空中アウトは犠飛不成立', () => {
  const bases = [null, null, 'r3'];
  const runs = advanceRunners(bases, 'out', 'batter', true, 2);
  assert.equal(runs, 0);
  assert.deepEqual(bases, [null, null, 'r3']);
});

test('buildSchedule: 総当たりで各チーム規定試合・ホーム偏りなし', () => {
  const lg = generateLeague(1, cfg);
  const G = cfg.league.gamesPerSeason;
  const games = buildSchedule(lg.teams, makeRng(1), G);
  assert.equal(games.length, (cfg.league.numTeams * G) / 2); // 6×140/2=420
  const count = new Map(lg.teams.map((t) => [t.id, 0]));
  const home = new Map(lg.teams.map((t) => [t.id, 0]));
  for (const g of games) {
    count.set(g.home, count.get(g.home) + 1);
    count.set(g.away, count.get(g.away) + 1);
    home.set(g.home, home.get(g.home) + 1);
  }
  for (const t of lg.teams) {
    assert.equal(count.get(t.id), G, `${t.id} の試合数`);
    assert.equal(home.get(t.id), G / 2, `${t.id} のホーム数（均衡）`); // 28×偶数=14/14
  }
});

test('simulateSeason: 各チーム規定試合・勝敗引分の整合', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { season: 2026, seed: 2026 });
  assert.equal(res.standings.length, cfg.league.numTeams);
  let totalW = 0;
  let totalL = 0;
  for (const t of res.standings) {
    assert.equal(t.w + t.l + t.t, cfg.league.gamesPerSeason, `${t.teamId} 消化`);
    totalW += t.w;
    totalL += t.l;
  }
  assert.equal(totalW, totalL, 'リーグの総勝＝総敗');
});

test('同じリーグで別シーズンseedは別結果・同seedは同結果（UI再シミュレートの基盤）', () => {
  const lg = generateLeague(2026, cfg);
  const key = (r) => r.standings.map((t) => t.teamId + ':' + t.w).join();
  const a = simulateSeason(lg, cfg, { seed: 111 });
  const b = simulateSeason(lg, cfg, { seed: 222 });
  const a2 = simulateSeason(lg, cfg, { seed: 111 });
  assert.notEqual(key(a), key(b), '同じ選手でも別seedなら別のシーズン結果');
  assert.equal(key(a), key(a2), '同seedは同結果（決定論は保つ）');
});

test('simulateSeason: 決定論（同一seedで同一順位・同一成績）', () => {
  const lg = generateLeague(2026, cfg);
  const a = simulateSeason(lg, cfg, { seed: 42 });
  const b = simulateSeason(lg, cfg, { seed: 42 });
  assert.deepEqual(
    a.standings.map((t) => [t.teamId, t.w, t.l, t.rs, t.ra]),
    b.standings.map((t) => [t.teamId, t.w, t.l, t.rs, t.ra]),
  );
});

test('投手の登板/先発が引分含め正しく計上され幽霊登板がない（A-1/A-2/A-5修正）', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  const numGames = (cfg.league.numTeams * cfg.league.gamesPerSeason) / 2; // 6×140/2=420
  const totalGS = res.playerSeasons.reduce((a, s) => a + s.pitching.gs, 0);
  assert.equal(totalGS, 2 * numGames, `総先発=2×試合数 (got ${totalGS})`);
  const totalSV = res.playerSeasons.reduce((a, s) => a + s.pitching.sv, 0);
  assert.ok(totalSV > 100, `セーブが計上される（幽霊リリーフで無効化されない）(got ${totalSV})`);
  for (const s of res.playerSeasons) {
    if (s.pitching.outs > 0) assert.ok(s.pitching.g > 0, `投球あり→登板あり: ${s.playerId}`);
    assert.ok(s.pitching.gs <= s.pitching.g, '先発数<=登板数');
  }
});

test('勝敗が決勝点ベースで配分され、先発に無決着・救援に勝敗が付く', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  // 先発の無決着率が妥当（旧・簡易判定では~2%だった）
  const starters = res.playerSeasons.filter((s) => s.pitching.gs >= 15);
  const totGs = starters.reduce((a, s) => a + s.pitching.gs, 0);
  const totDec = starters.reduce((a, s) => a + s.pitching.w + s.pitching.l, 0);
  const ndRate = 1 - totDec / totGs;
  assert.ok(ndRate > 0.15, `先発の無決着率 ${(ndRate * 100).toFixed(0)}% > 15%`);
  // 救援にも勝敗が付く（旧判定ではほぼゼロ）
  const relDec = res.playerSeasons
    .filter((s) => s.pitching.gs === 0)
    .reduce((a, s) => a + s.pitching.w + s.pitching.l, 0);
  assert.ok(relDec > 50, `救援の勝敗が計上される (got ${relDec})`);
});

test('盗塁死が投手IPに算入され勘定恒等式 Σ守備アウト(除DH)/8 == Σ投手アウト を保つ（監査A2）', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  let posOuts = 0, pOuts = 0, cs = 0;
  for (const s of res.playerSeasons) {
    for (const k of Object.keys(s.fielding.positionOuts)) if (k !== 'DH') posOuts += s.fielding.positionOuts[k];
    pOuts += s.pitching.outs;
    cs += s.batting.cs;
  }
  assert.ok(cs > 0, '盗塁死が発生している');
  assert.equal(posOuts / 8, pOuts, 'CSが投手アウトに算入され守備アウト(除DH)/8と一致');
});

test('simulateSeason: 打席が回り主力に妥当なPA/投球回が付く', () => {
  const lg = generateLeague(7, cfg);
  const res = simulateSeason(lg, cfg, { seed: 7 });
  const maxPA = Math.max(...res.playerSeasons.map((s) => s.batting.pa));
  const maxOuts = Math.max(...res.playerSeasons.map((s) => s.pitching.outs));
  assert.ok(maxPA > 400, `規定打席級が存在 (maxPA=${maxPA})`);
  assert.ok(maxOuts / 3 > 100, `100投球回超の投手が存在 (maxIP=${(maxOuts / 3).toFixed(0)})`);
});

test('継投: セーブが抑えに集中し、ホールド/BS/完投/完封が妥当に計上される（監査B2/B3/B4）', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  let sv = 0, hld = 0, bs = 0, cg = 0, sho = 0;
  const svHolders = [];
  for (const s of res.playerSeasons) {
    const p = s.pitching;
    sv += p.sv; hld += p.hld; bs += p.bs; cg += p.cg; sho += p.sho;
    if (p.sv > 0) svHolders.push(p.sv);
  }
  assert.ok(sv > 0, 'セーブが発生している');
  assert.ok(hld > 0, 'ホールドが発生している（監査B3）');
  assert.ok(bs > 0, 'ブローンセーブが発生している（監査B3）');
  assert.ok(cg > 0, '完投が発生している（監査B4）');
  assert.ok(sho <= cg, '完封は完投の部分集合（監査B4）');
  // 抑え固定(B2): 最多セーブ手にセーブが集中する（幽霊救援に分散しない）
  const maxSv = Math.max(...svHolders);
  assert.ok(maxSv >= 20, `抑えにセーブが集中している (maxSV=${maxSv})`);
});

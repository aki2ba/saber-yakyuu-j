// 試合進行サブシステム（1-4）の単体テスト。編成・進塁・シーズン整合を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { buildDepthChart, hitScore, obpScore, powerScore } from '../src/sim/team.mjs';
import { advanceRunners } from '../src/sim/game.mjs';
import { simulateSeason, buildSchedule, winPct } from '../src/sim/season.mjs';
import { leagueSummaryByLeague } from '../src/sim/leagueStats.mjs';
import { makeRng } from '../src/rng.mjs';
import { FIELD_POSITIONS } from '../src/model/positions.mjs';

const cfg = createConfig();

test('buildDepthChart v2: 打順9・守備8ポジ充足・ローテ6・ブルペン役割・ベンチ・positionRank（S1）', () => {
  const lg = generateLeague(1, cfg);
  const roster = lg.players.filter((p) => p.teamId === 'T1');
  const d = buildDepthChart(roster, cfg);
  assert.equal(d.lineup.length, 9);
  for (const pos of FIELD_POSITIONS) assert.ok(d.defense[pos], `守備 ${pos}`);
  assert.equal(d.rotation.length, cfg.league.rotationSize, 'ローテは6人（中6日）');
  assert.ok(d.bullpen.length >= 5);
  // 投手は打順に入らない（DH有の既定編成）
  const lineupIds = new Set(d.lineup.map((s) => s.playerId));
  for (const pid of d.rotation) assert.ok(!lineupIds.has(pid), '投手が打順に不在');
  // ベンチ: スタメン外の野手全員（野手 − 守備8 − DH1）・hitScore降順（F2-1: 野手34-37人へ拡大）
  const nF = roster.filter((p) => p.role === 'fielder').length;
  assert.equal(d.bench.length, nF - 8 - 1);
  for (const pid of d.bench) assert.ok(!lineupIds.has(pid), 'ベンチはスタメン外');
  for (let i = 1; i < d.bench.length; i++) {
    assert.ok(hitScore(d.byId.get(d.bench[i - 1])) >= hitScore(d.byId.get(d.bench[i])), 'ベンチはhitScore降順');
  }
  // positionRank: 各ポジションに全野手のランキング
  for (const pos of FIELD_POSITIONS) {
    assert.equal(d.positionRank[pos].length, nF, `${pos} の候補ランキング`);
    assert.ok(d.positionRank[pos].includes(d.defense[pos]), `${pos} のスタメンは候補内`);
  }
  // ブルペン役割: closer/setup8/setup7/middle[]/long（投手33-36−ローテ6を全割当）
  const r = d.bullpenRoles;
  assert.ok(r.closer && r.setup8 && r.setup7 && r.long, '主要役割が埋まる');
  assert.equal(r.closer, d.bullpen[0], 'closerはrelieverScore最上位');
  assert.equal(r.long, d.bullpen[d.bullpen.length - 1], 'longは最下位');
  assert.equal(3 + r.middle.length + 1, d.bullpen.length, '役割の合計=ブルペン人数');
});

test('打順アーキタイプ: 1番=OBP×俊足 / 3番=最強総合 / 4番=最強パワー / 9番=最弱（DH有）（S1）', () => {
  const lg = generateLeague(1, cfg);
  for (const t of lg.teams.slice(0, 3)) {
    const roster = lg.players.filter((p) => p.teamId === t.id);
    const d = buildDepthChart(roster, cfg);
    const L = d.lineup.map((s) => d.byId.get(s.playerId));
    // 9番はスタメン9人の中で hitScore 最弱
    for (let i = 0; i < 8; i++) assert.ok(hitScore(L[8]) <= hitScore(L[i]), `9番が最弱 (${t.id})`);
    // 3番は最強総合（9番決定後の残りで最大）
    for (const i of [0, 1, 3, 4, 5, 6, 7]) assert.ok(hitScore(L[2]) >= hitScore(L[i]), `3番が最強総合 (${t.id})`);
    // 4番は3番を除き powerScore 最大、5番は次点
    for (const i of [0, 1, 4, 5, 6, 7, 8]) assert.ok(powerScore(L[3]) >= powerScore(L[i]), `4番が最強パワー (${t.id})`);
    for (const i of [0, 1, 5, 6, 7, 8]) assert.ok(powerScore(L[4]) >= powerScore(L[i]), `5番が次点パワー (${t.id})`);
    // 1番はOBP×俊足の合成が残り（2,6,7,8番）以上
    const lead = (p) => obpScore(p) + cfg.tuning.depth.leadoffSpeedW * (p.trueAbility.common.speed - 50);
    for (const i of [1, 5, 6, 7]) assert.ok(lead(L[0]) >= lead(L[i]), `1番がOBP×俊足 (${t.id})`);
    // 6-8番は hitScore 降順
    assert.ok(hitScore(L[5]) >= hitScore(L[6]) && hitScore(L[6]) >= hitScore(L[7]), `6-8番は降順 (${t.id})`);
  }
});

test('buildDepthChart v2: DH無し編成は9番=投手プレースホルダ（S2が当日先発を充填）（S1）', () => {
  const lg = generateLeague(1, cfg);
  const roster = lg.players.filter((p) => p.teamId === 'T1');
  const d = buildDepthChart(roster, cfg, { dh: false });
  assert.equal(d.lineup.length, 9);
  assert.equal(d.lineup[8].pos, 'P', '9番は投手スロット');
  assert.equal(d.lineup[8].playerId, null, '当日の先発はS2 initSide v2が充填');
  assert.ok(!d.lineup.some((s) => s.pos === 'DH'), 'DHスロットなし');
  // 野手8人は守備位置と整合
  const posSet = new Set(d.lineup.slice(0, 8).map((s) => s.pos));
  assert.equal(posSet.size, 8);
  // ベンチはDH非選抜のぶん1人多い（野手 − 守備8。F2-1: 野手34-37人へ拡大）
  const nF = roster.filter((p) => p.role === 'fielder').length;
  assert.equal(d.bench.length, nF - 8);
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

test('buildSchedule v2: リーグ内125＋交流戦18＝143試合・858試合・ホーム71/72（S3）', () => {
  const lg = generateLeague(1, cfg);
  const G = cfg.league.gamesPerSeason;
  const games = buildSchedule(lg.teams, makeRng(1), cfg);
  assert.equal(games.length, (cfg.league.numTeams * G) / 2); // 12×143/2=858
  const leagueOf = new Map(lg.teams.map((t) => [t.id, t.league]));
  const count = new Map(lg.teams.map((t) => [t.id, 0]));
  const inLeague = new Map(lg.teams.map((t) => [t.id, 0]));
  const inter = new Map(lg.teams.map((t) => [t.id, 0]));
  const home = new Map(lg.teams.map((t) => [t.id, 0]));
  for (const g of games) {
    const same = leagueOf.get(g.home) === leagueOf.get(g.away);
    for (const tid of [g.home, g.away]) {
      count.set(tid, count.get(tid) + 1);
      (same ? inLeague : inter).set(tid, (same ? inLeague : inter).get(tid) + 1);
    }
    home.set(g.home, home.get(g.home) + 1);
  }
  for (const t of lg.teams) {
    assert.equal(count.get(t.id), G, `${t.id} の試合数`);
    assert.equal(inLeague.get(t.id), 125, `${t.id} のリーグ内試合数（5相手×25）`);
    assert.equal(inter.get(t.id), 18, `${t.id} の交流戦試合数（6相手×3）`);
    const h = home.get(t.id);
    assert.ok(h === 71 || h === 72, `${t.id} のホーム数がほぼ均衡 (got ${h})`);
  }
});

test('buildSchedule v2: day直列化＝1日1試合・連続出場上限・休日が挟まる（S3）', () => {
  const lg = generateLeague(1, cfg);
  const games = buildSchedule(lg.teams, makeRng(1), cfg);
  const maxConsec = cfg.tuning.schedule.maxTeamConsecDays;
  let prevDay = 0;
  const lastDay = new Map();
  const consec = new Map();
  for (const g of games) {
    assert.ok(g.day >= prevDay, 'dayは昇順に直列化されている');
    prevDay = g.day;
    for (const tid of [g.home, g.away]) {
      assert.notEqual(lastDay.get(tid), g.day, `1日1試合 (${tid} day=${g.day})`);
      const c = lastDay.get(tid) === g.day - 1 ? consec.get(tid) + 1 : 1;
      consec.set(tid, c);
      assert.ok(c <= maxConsec, `連続出場は${maxConsec}日まで (${tid} day=${g.day})`);
      lastDay.set(tid, g.day);
    }
  }
  const totalDays = games[games.length - 1].day + 1;
  assert.ok(totalDays >= 150, `休日が挟まりシーズンは143日より長い (days=${totalDays})`);
  assert.ok(totalDays <= 220, `過剰な空白日はない (days=${totalDays})`);
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
  const numGames = (cfg.league.numTeams * cfg.league.gamesPerSeason) / 2; // 12×143/2=858
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

test('リーグ別集計（leagueSummaryByLeague）とDH規則別の得点集計（runSplit）（S3）', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  const by = leagueSummaryByLeague(res, lg.teams);
  assert.ok(by.L1 && by.L2, '両リーグのサマリが出る');
  assert.equal(by.L1.gamesPerTeam, cfg.league.gamesPerSeason);
  assert.equal(by.L2.gamesPerTeam, cfg.league.gamesPerSeason);
  assert.ok(by.L1.batting.pa > 0 && by.L2.batting.pa > 0, 'リーグ別の打撃集計');
  assert.ok(by.L1.runsPerTeamPerGame > 2 && by.L2.runsPerTeamPerGame > 2);
  // リーグ別順位表: 6球団ずつ・勝率降順
  for (const l of ['L1', 'L2']) {
    const rows = res.standingsByLeague[l];
    assert.equal(rows.length, 6, `${l} は6球団`);
    for (let i = 1; i < rows.length; i++) assert.ok(winPct(rows[i - 1]) >= winPct(rows[i]), `${l} 勝率降順`);
  }
  // runSplit: セパ得点差は「試合のDH規則単位」で集計する（S4較正が消費。所属リーグ単位はノイズが乗る）
  assert.equal(res.runSplit.dh.games + res.runSplit.noDh.games, 858, '全試合が二分される');
  assert.equal(res.runSplit.dh.games, 429, 'DH有試合 = L2主催429試合');
  assert.ok(res.runSplit.dh.runs > 0 && res.runSplit.noDh.runs > 0);
});

test('交流戦成績: 各チーム18試合が il に計上され総勝=総敗（S4）', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026, postseason: false });
  let w = 0;
  let l = 0;
  for (const t of res.standings) {
    assert.equal(t.il.w + t.il.l + t.il.t, 18, `${t.teamId} の交流戦は18試合`);
    assert.ok(t.il.w <= t.w && t.il.l <= t.l && t.il.t <= t.t, '交流戦成績は総成績の部分集合');
    w += t.il.w;
    l += t.il.l;
  }
  assert.equal(w, l, '交流戦の総勝=総敗');
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

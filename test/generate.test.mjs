// 架空選手ジェネレータ（0-6）の単体テスト。決定論・編成・三層の器・値域を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLeague, generatePitcher, generateFielder, TEAM_COLORS } from '../src/generate.mjs';
import { validatePlayer } from '../src/model/player.mjs';
import { makeRng } from '../src/rng.mjs';
import { createConfig } from '../src/config.mjs';
import { FIELD_POSITIONS } from '../src/model/positions.mjs';

const cfg = createConfig();

test('generateLeague は決定論的（同一masterSeedで同一リーグ）', () => {
  const a = generateLeague(2026, cfg);
  const b = generateLeague(2026, cfg);
  assert.equal(a.players.length, b.players.length);
  // 名前・主要能力が完全一致
  for (let i = 0; i < a.players.length; i++) {
    assert.equal(a.players[i].name, b.players[i].name);
    assert.equal(a.players[i].trueAbility.common.speed, b.players[i].trueAbility.common.speed);
  }
});

test('TEAM_COLORS covers all generated team names', () => {
  const league = generateLeague(1, cfg);
  for (const t of league.teams) assert.ok(TEAM_COLORS[t.name], `color missing for ${t.name}`);
  assert.equal(Object.keys(TEAM_COLORS).length, 12);
});

test('別masterSeedは別リーグ', () => {
  const a = generateLeague(1, cfg);
  const b = generateLeague(2, cfg);
  assert.notEqual(a.players[0].name + a.players[10].name, b.players[0].name + b.players[10].name);
});

test('リーグ規模どおりの球団数・支配下70人/球団（投手33-36＋野手34-37）（F2-1）', () => {
  const lg = generateLeague(7, cfg);
  const R = cfg.tuning.roster;
  assert.equal(lg.teams.length, cfg.league.numTeams);
  assert.equal(lg.players.length, cfg.league.numTeams * R.controlledPerTeam);
  const pitCounts = new Set();
  for (const t of lg.teams) {
    assert.equal(t.playerIds.length, R.controlledPerTeam);
    const roster = lg.players.filter((p) => p.teamId === t.id);
    const pitchers = roster.filter((p) => p.role === 'pitcher');
    const fielders = roster.filter((p) => p.role === 'fielder');
    assert.equal(roster.length, R.controlledPerTeam, `${t.id} 支配下70人`);
    assert.ok(pitchers.length >= R.pitchersMin && pitchers.length <= R.pitchersMax, `${t.id} 投手 ${pitchers.length} は 33-36`);
    assert.equal(fielders.length, R.controlledPerTeam - pitchers.length, `${t.id} 野手=残り（34-37）`);
    pitCounts.add(pitchers.length);
  }
  assert.ok(pitCounts.size > 1, '投手数に球団差がある（33-36で散る）');
});

test('各守備位置に主ポジ野手が最低3人（一軍・二軍の同時編成が成立する充足・F2-1）', () => {
  const lg = generateLeague(7, cfg);
  for (const t of lg.teams) {
    const fielders = lg.players.filter((p) => p.teamId === t.id && p.role === 'fielder');
    for (const pos of FIELD_POSITIONS) {
      const n = fielders.filter((p) => p.primaryPos === pos).length;
      assert.ok(n >= 3, `${t.id} の ${pos} は主ポジ${n}人（最低3人必要）`);
    }
  }
});

test('育成選手 10-40人/球団・全員minor・球団の育成方針で人数差（F2-1・§12.1）', () => {
  const lg = generateLeague(7, cfg);
  const R = cfg.tuning.roster;
  assert.ok(Array.isArray(lg.farm), 'generateLeague が farm を返す');
  assert.ok(lg.farm.every((d) => d.rosterStatus === 'minor'), '育成は全員 rosterStatus=minor');
  assert.ok(lg.players.every((p) => p.rosterStatus === 'active'), '支配下に minor は混じらない');
  const counts = [];
  for (const t of lg.teams) {
    const farm = lg.farm.filter((d) => d.teamId === t.id);
    assert.ok(farm.length >= R.devCountMin && farm.length <= R.devCountMax, `${t.id} 育成 ${farm.length} は 10-40`);
    // 合計 80-110人/球団（支配下70＋育成10-40）
    const total = R.controlledPerTeam + farm.length;
    assert.ok(total >= 80 && total <= 110, `${t.id} 総保有 ${total} は 80-110`);
    counts.push(farm.length);
  }
  assert.ok(new Set(counts).size > 1, '育成人数に球団差がある（育成方針devFocusの発現）');
  // リーグ総人口 ~1,000-1,300人
  const totalPop = lg.players.length + lg.farm.length;
  assert.ok(totalPop >= 1000 && totalPop <= 1300, `リーグ総人口 ${totalPop} は 1000-1300`);
  // 育成人数は監督/フロントの devFocus と単調（写像 devCountFor の発現）
  const sorted = lg.teams.slice().sort((a, b) => a.manager.devFocus - b.manager.devFocus);
  const farmOf = (tid) => lg.farm.filter((d) => d.teamId === tid).length;
  assert.ok(farmOf(sorted[0].id) <= farmOf(sorted[sorted.length - 1].id), 'devFocus 最小球団 ≤ 最大球団の育成人数');
});

test('育成・下位支配下は若手が厚い（18-24中心・F2-1）', () => {
  const lg = generateLeague(7, cfg);
  const R = cfg.tuning.roster;
  const avg = (arr) => arr.reduce((a, p) => a + p.age, 0) / arr.length;
  // 育成は年齢帯 18-24 に収まり、平均は支配下より若い
  assert.ok(lg.farm.every((d) => d.age >= R.devAgeMin && d.age <= R.devAgeMax), '育成は 18-24');
  assert.ok(avg(lg.farm) < avg(lg.players), '育成の平均年齢 < 支配下');
  // 下位支配下（コア超過分）も若手帯: チームの野手 F21以降 / 投手 P14以降 は youngAgeMax 以下
  for (const t of lg.teams.slice(0, 3)) {
    const roster = lg.players.filter((p) => p.teamId === t.id);
    for (const p of roster) {
      const m = p.id.match(/^T\d+([PF])(\d+)$/);
      const idx = Number(m[2]);
      const isDepth = (m[1] === 'P' && idx > R.corePitchers) || (m[1] === 'F' && idx > R.coreFielders);
      if (isDepth) assert.ok(p.age >= R.youngAgeMin && p.age <= R.youngAgeMax, `${p.id} age=${p.age} は若手帯`);
    }
  }
});

test('育成選手も validatePlayer を通過し三層の器を持つ（F2-1）', () => {
  const lg = generateLeague(3, cfg);
  for (const d of lg.farm) {
    assert.equal(validatePlayer(d).length, 0, `invalid: ${d.id}`);
    assert.equal(typeof d.scoutSeed, 'number');
    assert.ok(/^T\d+D\d+$/.test(d.id), '育成IDは TxDn 形式（支配下と衝突しない）');
  }
});

test('育成込みの生成も決定論（同一masterSeedで farm まで一致）（F2-1）', () => {
  const a = generateLeague(2026, cfg);
  const b = generateLeague(2026, cfg);
  assert.equal(a.farm.length, b.farm.length);
  for (let i = 0; i < a.farm.length; i++) {
    assert.equal(a.farm[i].id, b.farm[i].id);
    assert.equal(a.farm[i].name, b.farm[i].name);
    assert.equal(a.farm[i].age, b.farm[i].age);
    assert.equal(a.farm[i].trueAbility.common.speed, b.farm[i].trueAbility.common.speed);
  }
});

test('名前プール拡張で衝突率が低い（同姓同名は少数派・F2-1）', () => {
  const lg = generateLeague(7, cfg);
  const names = lg.players.concat(lg.farm).map((p) => p.name);
  const uniq = new Set(names).size;
  assert.ok(uniq / names.length >= 0.8, `同姓同名は2割未満（unique ${uniq}/${names.length}）`);
});

test('全選手が validatePlayer を通過し、名前は非空・架空（実名でない体裁）', () => {
  const lg = generateLeague(3, cfg);
  for (const p of lg.players) {
    assert.equal(validatePlayer(p).length, 0, `invalid: ${p.id}`);
    assert.ok(p.name.length > 0);
    assert.ok(p.id.length > 0);
  }
});

test('リーグ割当: 前半6球団=L1（DH無）・後半6球団=L2（DH有）（S1）', () => {
  const lg = generateLeague(7, cfg);
  const l1 = lg.teams.filter((t) => t.league === 'L1');
  const l2 = lg.teams.filter((t) => t.league === 'L2');
  assert.equal(l1.length, 6);
  assert.equal(l2.length, 6);
  // 前半=L1・後半=L2 の並び
  for (let i = 0; i < 6; i++) assert.equal(lg.teams[i].league, 'L1', `T${i + 1} は L1`);
  for (let i = 6; i < 12; i++) assert.equal(lg.teams[i].league, 'L2', `T${i + 1} は L2`);
});

test('監督プロファイル: 各チームに buntTend/stealTend/ibbTend/quickHook（20-80・決定論）（S1）', () => {
  const a = generateLeague(7, cfg);
  const b = generateLeague(7, cfg);
  for (const t of a.teams) {
    for (const k of ['buntTend', 'stealTend', 'ibbTend', 'quickHook']) {
      assert.ok(t.manager[k] >= 20 && t.manager[k] <= 80, `${t.id}.manager.${k}=${t.manager[k]}`);
    }
  }
  // 決定論: 同一masterSeedで同一の監督
  assert.deepEqual(a.teams.map((t) => t.manager), b.teams.map((t) => t.manager));
  // チーム間で采配の個性が散っている（全員同値ではない）
  const bunts = new Set(a.teams.map((t) => t.manager.buntTend));
  assert.ok(bunts.size > 1, '監督の個性が分布から生成されている');
});

test('三層の器が埋まっている（trueAbility / scoutSeed / 空のcareer.seasons）', () => {
  const lg = generateLeague(3, cfg);
  const p = lg.players[0];
  assert.ok(p.trueAbility.pitching && p.trueAbility.fielding);
  assert.equal(typeof p.scoutSeed, 'number');
  assert.deepEqual(p.career.seasons, {});
});

test('能力素材は両登録分保持（投手も打撃/走塁/守備素材を持つ）', () => {
  const rng = makeRng(1);
  const p = generatePitcher(rng, 'X1');
  assert.ok(p.trueAbility.batting && p.trueAbility.baserunning && p.trueAbility.fielding);
});

test('レーティングは 20–80、球速は妥当域（km/h）', () => {
  const lg = generateLeague(9, cfg);
  for (const p of lg.players) {
    const c = p.trueAbility.common;
    for (const k of ['speed', 'arm', 'hands', 'reaction', 'power']) {
      assert.ok(c[k] >= 20 && c[k] <= 80, `${k}=${c[k]}`);
    }
    if (p.role === 'pitcher') {
      const v = p.trueAbility.pitching.velocityKmh;
      assert.ok(v >= 130 && v <= 165, `velocity ${v}`);
      assert.ok(p.trueAbility.pitching.pitches.length >= 2, '球種2以上');
      assert.ok(p.trueAbility.pitching.pitches.some((x) => x.type === 'fastball'), 'fastball必須');
    }
  }
});

test('各守備位置が主ポジ選手で埋まる', () => {
  const lg = generateLeague(11, cfg);
  const t0 = lg.teams[0];
  const roster = lg.players.filter((p) => p.teamId === t0.id && p.role === 'fielder');
  for (const pos of FIELD_POSITIONS) {
    const hasStarter = roster.some((p) => p.trueAbility.fielding.positionProf[pos] >= 50);
    assert.ok(hasStarter, `${pos} を主守備にする選手がいない`);
  }
});

test('declineRate は能力タイプと相関（速球派サンプルは技巧派より衰えが速い傾向）', () => {
  const rng = makeRng(123);
  let fastSum = 0;
  let fineSum = 0;
  let fastN = 0;
  let fineN = 0;
  for (let i = 0; i < 400; i++) {
    const p = generatePitcher(rng, `P${i}`);
    const pit = p.trueAbility.pitching;
    if (pit.velocityKmh >= 150) { fastSum += p.trueAbility.career.declineRate; fastN++; }
    if (pit.velocityKmh <= 143 && pit.control >= 55) { fineSum += p.trueAbility.career.declineRate; fineN++; }
  }
  if (fastN > 5 && fineN > 5) {
    assert.ok(fastSum / fastN > fineSum / fineN, '速球派の衰えが技巧派より速い');
  }
});

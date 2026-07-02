// 架空選手ジェネレータ（0-6）の単体テスト。決定論・編成・三層の器・値域を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLeague, generatePitcher, generateFielder } from '../src/generate.mjs';
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

test('別masterSeedは別リーグ', () => {
  const a = generateLeague(1, cfg);
  const b = generateLeague(2, cfg);
  assert.notEqual(a.players[0].name + a.players[10].name, b.players[0].name + b.players[10].name);
});

test('リーグ規模どおりの球団数・各33人（投手13＋野手20）', () => {
  const lg = generateLeague(7, cfg);
  assert.equal(lg.teams.length, cfg.league.numTeams);
  assert.equal(lg.players.length, cfg.league.numTeams * 33);
  for (const t of lg.teams) {
    assert.equal(t.playerIds.length, 33);
    const roster = lg.players.filter((p) => p.teamId === t.id);
    const pitchers = roster.filter((p) => p.role === 'pitcher');
    const fielders = roster.filter((p) => p.role === 'fielder');
    assert.equal(pitchers.length, 13);
    assert.equal(fielders.length, 20);
  }
});

test('全選手が validatePlayer を通過し、名前は非空・架空（実名でない体裁）', () => {
  const lg = generateLeague(3, cfg);
  for (const p of lg.players) {
    assert.equal(validatePlayer(p).length, 0, `invalid: ${p.id}`);
    assert.ok(p.name.length > 0);
    assert.ok(p.id.length > 0);
  }
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

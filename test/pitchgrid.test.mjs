// 球種格子 段階1（2-1/2-2）のテスト。球種選択・対球種splitの生成・能力相関。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { createPlayer, createTrueAbility, createPitch } from '../src/model/player.mjs';
import { makeRng } from '../src/rng.mjs';
import { selectPitch } from '../src/sim/pitchGrid.mjs';
import { pitchClass, FASTBALL_TYPES } from '../src/model/positions.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { paProbabilities } from '../src/sim/plateAppearance.mjs';

const cfg = createConfig();

test('pitchClass: 速球系はfastball, 変化球はbreaking', () => {
  assert.equal(pitchClass('fastball'), 'fastball');
  assert.equal(pitchClass('sinker'), 'fastball');
  assert.equal(pitchClass('slider'), 'breaking');
  assert.equal(pitchClass('fork'), 'breaking');
});

test('selectPitch: 速球系が重み付けで多く選ばれる', () => {
  const pit = createPlayer({
    role: 'pitcher',
    trueAbility: createTrueAbility({ pitching: { pitches: [createPitch('fastball'), createPitch('slider')] } }),
  });
  const rng = makeRng(1);
  let fb = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) if (FASTBALL_TYPES.has(selectPitch(pit, rng, cfg).type)) fb++;
  // fastballWeight=2 なので速球 ~2/3
  assert.ok(fb / n > 0.6 && fb / n < 0.72, `速球選択率 ${(fb / n).toFixed(2)}`);
});

test('決め球(高whiff球種)を持つ投手はK率を上げる（フォーク開花）', () => {
  const batter = createPlayer({ role: 'fielder', trueAbility: createTrueAbility() });
  const plain = createPlayer({ role: 'pitcher', trueAbility: createTrueAbility({ pitching: { velocityKmh: 146, pitches: [createPitch('fastball', { whiff: 50 })] } }) });
  const withFork = createPlayer({ role: 'pitcher', trueAbility: createTrueAbility({ pitching: { velocityKmh: 146, pitches: [createPitch('fastball', { whiff: 50 })] } }) });
  const forkPitch = createPitch('fork', { whiff: 80 });
  const kPlain = paProbabilities(batter, plain, cfg, 0, plain.trueAbility.pitching.pitches[0]).pK;
  const kFork = paProbabilities(batter, withFork, cfg, 0, forkPitch).pK;
  assert.ok(kFork > kPlain + 0.08, `決め球でK率上昇 (${kFork.toFixed(2)} vs ${kPlain.toFixed(2)})`);
});

test('対速球適性が高い打者は速球に対しKしにくい', () => {
  const fastballPitch = createPitch('fastball', { whiff: 55 });
  const pit = createPlayer({ role: 'pitcher', trueAbility: createTrueAbility({ pitching: { velocityKmh: 148, pitches: [fastballPitch] } }) });
  const weak = createPlayer({ role: 'fielder', trueAbility: createTrueAbility({ batting: { vsFastball: 30 } }) });
  const strong = createPlayer({ role: 'fielder', trueAbility: createTrueAbility({ batting: { vsFastball: 75 } }) });
  const kWeak = paProbabilities(weak, pit, cfg, 0, fastballPitch).pK;
  const kStrong = paProbabilities(strong, pit, cfg, 0, fastballPitch).pK;
  assert.ok(kStrong < kWeak, `対速球巧者はKしにくい (${kStrong.toFixed(2)} < ${kWeak.toFixed(2)})`);
});

test('シーズンで対速球splitが生成され、対速球適性と相関する', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  const byId = new Map(lg.players.map((p) => [p.id, p]));
  const reg = res.playerSeasons
    .filter((s) => s.batting.vsFastball.ab >= 150)
    .map((s) => ({ avg: s.batting.vsFastball.h / s.batting.vsFastball.ab, apt: byId.get(s.playerId).trueAbility.batting.vsFastball }));
  assert.ok(reg.length > 20, '対速球splitが十分たまる');
  const n = reg.length;
  const ma = reg.reduce((a, b) => a + b.avg, 0) / n;
  const mt = reg.reduce((a, b) => a + b.apt, 0) / n;
  let cov = 0, va = 0, vt = 0;
  for (const p of reg) { cov += (p.avg - ma) * (p.apt - mt); va += (p.avg - ma) ** 2; vt += (p.apt - mt) ** 2; }
  assert.ok(cov / Math.sqrt(va * vt) > 0.2, '対速球適性↔対速球打率が正相関');
});

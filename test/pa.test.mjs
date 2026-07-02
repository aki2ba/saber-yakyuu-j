// 打席規律層（1-1）の単体テスト。log5合成の基準回帰と能力の効き方、決定論を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, createTrueAbility, createPitch } from '../src/model/player.mjs';
import { createConfig } from '../src/config.mjs';
import { makeRng } from '../src/rng.mjs';
import {
  PA_OUTCOME,
  paProbabilities,
  resolvePADiscipline,
} from '../src/sim/plateAppearance.mjs';

const cfg = createConfig();

// 全能力50・球速146・whiff50の平均的な選手（log5がリーグ基準に戻るはず）
function avgBatter() {
  return createPlayer({ role: 'fielder', trueAbility: createTrueAbility() });
}
function avgPitcher() {
  return createPlayer({
    role: 'pitcher',
    trueAbility: createTrueAbility({
      pitching: { velocityKmh: 146, pitches: [createPitch('fastball', { whiff: 50 })] },
    }),
  });
}

test('平均 vs 平均はリーグ基準率に戻る（log5の要）', () => {
  const { pK, pBB, pHBP } = paProbabilities(avgBatter(), avgPitcher(), cfg);
  assert.ok(Math.abs(pK - 0.19) < 0.005, `pK=${pK}`);
  assert.ok(Math.abs(pBB - 0.08) < 0.005, `pBB=${pBB}`);
  assert.ok(Math.abs(pHBP - 0.009) < 0.003, `pHBP=${pHBP}`);
});

test('分岐確率は妥当（[0,1]・合計<1・IN_PLAYが残る）', () => {
  const { pK, pBB, pHBP, pInPlay } = paProbabilities(avgBatter(), avgPitcher(), cfg);
  for (const p of [pK, pBB, pHBP, pInPlay]) assert.ok(p >= 0 && p <= 1);
  assert.ok(pInPlay > 0.5, `IN_PLAY=${pInPlay}`);
});

test('多数抽選の集計がリーグ率に一致（20000打席）', () => {
  const rng = makeRng(2026);
  const b = avgBatter();
  const p = avgPitcher();
  const n = 20000;
  const c = { K: 0, BB: 0, HBP: 0, inPlay: 0 };
  for (let i = 0; i < n; i++) c[resolvePADiscipline(b, p, cfg, rng)]++;
  assert.ok(Math.abs(c.K / n - 0.19) < 0.015, `K%=${c.K / n}`);
  assert.ok(Math.abs(c.BB / n - 0.08) < 0.015, `BB%=${c.BB / n}`);
});

test('奪三振投手はK率を上げる', () => {
  const elite = createPlayer({
    role: 'pitcher',
    trueAbility: createTrueAbility({
      pitching: { velocityKmh: 155, pitches: [createPitch('fastball', { whiff: 80 })] },
    }),
  });
  const base = paProbabilities(avgBatter(), avgPitcher(), cfg).pK;
  const hi = paProbabilities(avgBatter(), elite, cfg).pK;
  assert.ok(hi > base + 0.05, `elite ${hi} vs base ${base}`);
});

test('コンタクト巧者はK率を下げる', () => {
  const contactHitter = createPlayer({
    role: 'fielder',
    trueAbility: createTrueAbility({ batting: { contact: 80, eye: 65 } }),
  });
  const base = paProbabilities(avgBatter(), avgPitcher(), cfg).pK;
  const lo = paProbabilities(contactHitter, avgPitcher(), cfg).pK;
  assert.ok(lo < base, `contact ${lo} < base ${base}`);
});

test('選球眼の高い打者はBB率を上げ、制球の良い投手は下げる', () => {
  const patient = createPlayer({
    role: 'fielder',
    trueAbility: createTrueAbility({ batting: { eye: 80 } }),
  });
  const control = createPlayer({
    role: 'pitcher',
    trueAbility: createTrueAbility({
      pitching: { velocityKmh: 146, control: 80, pitches: [createPitch('fastball', { whiff: 50 })] },
    }),
  });
  const base = paProbabilities(avgBatter(), avgPitcher(), cfg).pBB;
  assert.ok(paProbabilities(patient, avgPitcher(), cfg).pBB > base, '選球眼→BB増');
  assert.ok(paProbabilities(avgBatter(), control, cfg).pBB < base, '制球→BB減');
});

test('対戦巡目(TTO)が進むと打者有利（K率が下がる）', () => {
  const b = avgBatter();
  const p = avgPitcher();
  const first = paProbabilities(b, p, cfg, 0).pK;
  const third = paProbabilities(b, p, cfg, 2).pK;
  assert.ok(third < first, `3巡目K率 ${third} < 1巡目 ${first}`);
});

test('同一シードで決定論的', () => {
  const b = avgBatter();
  const p = avgPitcher();
  const r1 = makeRng(1);
  const r2 = makeRng(1);
  const seq1 = Array.from({ length: 50 }, () => resolvePADiscipline(b, p, cfg, r1));
  const seq2 = Array.from({ length: 50 }, () => resolvePADiscipline(b, p, cfg, r2));
  assert.deepEqual(seq1, seq2);
  assert.ok(Object.values(PA_OUTCOME).includes(seq1[0]));
});

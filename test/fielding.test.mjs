// 守備の能力→結果 結線（2-7）＋ OAA→UZR換算（2-8）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { rangeRating, mainPosition, uzrRuns, centeredOAAOuts, errRunsAboveAvg, totalFieldInnings } from '../src/sim/fielding.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { createTrueAbility, createPlayer } from '../src/model/player.mjs';

const cfg = createConfig();

test('rangeRating: ポジIQ/初動/走力が高いほど高い（50中心）', () => {
  const avg = createPlayer({ role: 'fielder', trueAbility: createTrueAbility() });
  const rangy = createPlayer({
    role: 'fielder',
    trueAbility: createTrueAbility({ common: { speed: 75, reaction: 75 }, fielding: { positioningIQ: 75 } }),
  });
  assert.ok(Math.abs(rangeRating(avg, cfg) - 50) < 1e-9, '平均選手=50');
  assert.ok(rangeRating(rangy, cfg) > 65, `名手 > 65 (got ${rangeRating(rangy, cfg)})`);
});

test('OAAが守備Rangeと正の相関を持つ（能力→結果の結線・M1解消）', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  const byId = new Map(lg.players.map((p) => [p.id, p]));
  const reg = res.playerSeasons
    .filter((s) => Object.values(s.fielding.positionOuts).reduce((a, b) => a + b, 0) / 3 >= 800)
    .map((s) => ({ oaa: s.fielding.oaaOuts, range: rangeRating(byId.get(s.playerId), cfg) }));
  assert.ok(reg.length > 30, '守備レギュラーが十分いる');
  const n = reg.length;
  const mo = reg.reduce((a, b) => a + b.oaa, 0) / n;
  const mr = reg.reduce((a, b) => a + b.range, 0) / n;
  let cov = 0, vo = 0, vr = 0;
  for (const p of reg) { cov += (p.oaa - mo) * (p.range - mr); vo += (p.oaa - mo) ** 2; vr += (p.range - mr) ** 2; }
  const r = cov / Math.sqrt(vo * vr);
  // B1較正済み: 一球シム化後の seed 2026 実現相関 ≈0.36（B1前0.30と同等以上）。下限を本来値へ締め直し。
  assert.ok(r > 0.2, `OAA↔Range 相関 > 0.2 (got ${r.toFixed(2)}) ＝守備能力が結果に効いている`);
  // ただし完全相関ではない（1年守備指標のノイズが正しく残る）
  assert.ok(r < 0.85, `1年OAAはノイズを含む (r=${r.toFixed(2)})`);
});

test('centeredOAAOuts: ポジション別に中心化され、出場守備者に負の値も出る', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  const lc = deriveLeagueConstants(res);
  const ss = res.playerSeasons.filter((s) => s.fielding.positionOuts.SS / 3 >= 100).map((s) => centeredOAAOuts(s, lc));
  assert.ok(ss.length >= 4, '遊撃手が複数出場');
  assert.ok(Math.min(...ss) < 0, '負のOAAが存在（中心化）＝出場守備者が全員プラスにならない');
  assert.ok(Math.max(...ss) > 0, '正のOAAも存在');
  assert.ok(Math.abs(ss.reduce((a, b) => a + b, 0)) < ss.length * 2, '遊撃手OAA合計が0付近');
});

test('errRunsAboveAvg: ポジション中心化＋uzrRunsに失策成分が合成される（監査A3）', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  const lc = deriveLeagueConstants(res);
  // ポジション別にErrR合計が0付近（中心化）
  const byPos = {};
  for (const s of res.playerSeasons) {
    if (totalFieldInnings(s.fielding) < 100) continue;
    const pos = mainPosition(s.fielding);
    (byPos[pos] = byPos[pos] || []).push(errRunsAboveAvg(s, cfg, lc));
  }
  for (const pos of Object.keys(byPos)) {
    const sum = byPos[pos].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum) < byPos[pos].length * 2, `ErrR合計が0付近 (${pos}: ${sum.toFixed(1)})`);
  }
  // uzrRuns = 範囲成分(中心化OAA×run/out) + ErrR + フレーミング の合成整合
  // （S3日次起用で複数ポジション出場が出るため、SS主戦でも捕手出場分の framingRuns を含めて検証）
  const s = res.playerSeasons.find((x) => totalFieldInnings(x.fielding) >= 100 && mainPosition(x.fielding) === 'SS');
  const rpo = cfg.tuning.field.runPerOutInfield;
  const expSS = centeredOAAOuts(s, lc) * rpo + errRunsAboveAvg(s, cfg, lc) + (s.fielding.framingRuns || 0);
  assert.ok(Math.abs(uzrRuns(s, cfg, lc) - expSS) < 1e-9, 'UZR=範囲+ErrR+フレーミング');
  // 失策がUZRに実際に効いている（ErrR非ゼロの野手が存在）
  const anyNonzero = res.playerSeasons.some(
    (x) => totalFieldInnings(x.fielding) >= 100 && Math.abs(errRunsAboveAvg(x, cfg, lc)) > 0.5,
  );
  assert.ok(anyNonzero, 'ErrRが非ゼロの野手が存在（hands/失策がUZRに反映）');
});

test('捕手フレーミングが守備runに接続され、uzrRunsに合成される（監査B5）', () => {
  const lg = generateLeague(2026, cfg);
  const res = simulateSeason(lg, cfg, { seed: 2026 });
  const lc = deriveLeagueConstants(res);
  const catchers = res.playerSeasons.filter(
    (s) => totalFieldInnings(s.fielding) >= 100 && mainPosition(s.fielding) === 'C',
  );
  assert.ok(catchers.length > 0, '規定守備の捕手が存在');
  // フレーミングrunが非ゼロの捕手が存在（framing能力→守備runの結線）
  assert.ok(
    catchers.some((s) => Math.abs(s.fielding.framingRuns || 0) > 0.5),
    'フレーミングrun非ゼロの捕手が存在',
  );
  // 捕手のuzrRuns = 範囲成分 + ErrR + フレーミング の合成整合
  const c = catchers.find((s) => Math.abs(s.fielding.framingRuns || 0) > 0.5);
  const rpo = cfg.tuning.field.runPerOutInfield;
  const expected = centeredOAAOuts(c, lc) * rpo + errRunsAboveAvg(c, cfg, lc) + c.fielding.framingRuns;
  assert.ok(Math.abs(uzrRuns(c, cfg, lc) - expected) < 1e-9, 'UZR=範囲+ErrR+フレーミング');
});

test('uzrRuns: OAAアウトに位置別run換算（内野0.75/外野0.90）', () => {
  const psSS = { fielding: { positionOuts: { SS: 3000, LF: 0, CF: 0, RF: 0, C: 0, '1B': 0, '2B': 0, '3B': 0 }, oaaOuts: 10 } };
  const psCF = { fielding: { positionOuts: { SS: 0, LF: 0, CF: 3000, RF: 0, C: 0, '1B': 0, '2B': 0, '3B': 0 }, oaaOuts: 10 } };
  assert.equal(mainPosition(psSS.fielding), 'SS');
  assert.ok(Math.abs(uzrRuns(psSS, cfg) - 7.5) < 1e-9, '内野 10out×0.75=7.5run');
  assert.ok(Math.abs(uzrRuns(psCF, cfg) - 9.0) < 1e-9, '外野 10out×0.90=9.0run');
});

// 守備の能力→結果 結線（2-7）＋ OAA→UZR換算（2-8）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import {
  rangeRating, mainPosition, uzrRuns, centeredOAAOuts, errRunsAboveAvg, totalFieldInnings,
  dprRunsAboveAvg, catcherBlockRuns, catcherRsbRuns, uzrComponents,
} from '../src/sim/fielding.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { advanceRunners } from '../src/sim/game.mjs';
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
  // 中心化の不変量は「主守備位置ごとに Σ centeredOAA = 0」。
  // （SSで100イニング以上守った選手の集合は、主ポジが他にあるユーティリティを含むため0にならない）
  const mainSS = res.playerSeasons
    .filter((s) => mainPosition(s.fielding) === 'SS' && totalFieldInnings(s.fielding) >= 1)
    .map((s) => centeredOAAOuts(s, lc));
  assert.ok(mainSS.length >= 4, '主戦遊撃手が複数');
  assert.ok(Math.abs(mainSS.reduce((a, b) => a + b, 0)) < 1e-6, '主ポジ=SS の centeredOAA 合計は厳密に0');
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
  // 内野手 UZR = RngR + ErrR + DPR（FanGraphs 定義・正典§1.1。フレーミングは捕手の成分）
  const s = res.playerSeasons.find((x) => totalFieldInnings(x.fielding) >= 100 && mainPosition(x.fielding) === 'SS');
  const rpo = cfg.tuning.field.runPerOutInfield;
  const expSS = centeredOAAOuts(s, lc) * rpo + errRunsAboveAvg(s, cfg, lc) + dprRunsAboveAvg(s, cfg, lc);
  assert.ok(Math.abs(uzrRuns(s, cfg, lc) - expSS) < 1e-9, '内野UZR=RngR+ErrR+DPR');
  // 失策がUZRに実際に効いている（ErrR非ゼロの野手が存在）
  const anyNonzero = res.playerSeasons.some(
    (x) => totalFieldInnings(x.fielding) >= 100 && Math.abs(errRunsAboveAvg(x, cfg, lc)) > 0.5,
  );
  assert.ok(anyNonzero, 'ErrRが非ゼロの野手が存在（hands/失策がUZRに反映）');
});

test('捕手守備run = ErrR + framing + blocking + rSB（UZRは付けない・正典§1.1）', () => {
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
  // 捕手は UZR（レンジ成分）を持たず、framing/blocking/rSB を別勘定する（FanGraphs 定義）
  const c = catchers.find((s) => Math.abs(s.fielding.framingRuns || 0) > 0.5);
  const expected =
    errRunsAboveAvg(c, cfg, lc) + c.fielding.framingRuns + catcherBlockRuns(c, cfg, lc) + catcherRsbRuns(c, cfg, lc);
  assert.ok(Math.abs(uzrRuns(c, cfg, lc) - expected) < 1e-9, '捕手守備run=ErrR+framing+blocking+rSB');
  assert.equal(uzrComponents(c, cfg, lc).rngR, 0, '捕手にレンジ成分は付かない');
});

test('uzrRuns: OAAアウトに位置別run換算（内野0.75/外野0.90）', () => {
  const psSS = { fielding: { positionOuts: { SS: 3000, LF: 0, CF: 0, RF: 0, C: 0, '1B': 0, '2B': 0, '3B': 0 }, oaaOuts: 10 } };
  const psCF = { fielding: { positionOuts: { SS: 0, LF: 0, CF: 3000, RF: 0, C: 0, '1B': 0, '2B': 0, '3B': 0 }, oaaOuts: 10 } };
  assert.equal(mainPosition(psSS.fielding), 'SS');
  assert.ok(Math.abs(uzrRuns(psSS, cfg) - 7.5) < 1e-9, '内野 10out×0.75=7.5run');
  assert.ok(Math.abs(uzrRuns(psCF, cfg) - 9.0) < 1e-9, '外野 10out×0.90=9.0run');
});

// ============================================================================
// 外野補殺（ARM）の塁状態の整合性。
// resolveAdv が「走らなかった(hold)」と「走って刺された(out)」を同じ false で返していたため、
// 刺された走者がアウトに数えられた上で塁にも残る「幽霊走者」が生まれていた（回帰テスト）。
// ============================================================================
test('外野補殺: 刺された走者は塁から消え、アウトが1つ増える（幽霊走者を作らない）', () => {
  const runner = createPlayer({ id: 'R2', role: 'fielder', trueAbility: createTrueAbility() });
  const batter = createPlayer({ id: 'B1', role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R2', runner], ['B1', batter]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) lines.set(pid, { baserunning: { advOpp: 0, advTaken: 0, adv2h1bOpp: 0, adv2h1bTaken: 0 } });
    return lines.get(pid);
  };
  const armLine = { armOpp: 0, armAdv: 0, armKill: 0, a: 0 };
  // rng.next()=0 → 必ず走り、必ず刺される（p>0 / pKill>0）
  const rng = { next: () => 0 };
  const ctx = {
    byId,
    statFor,
    teamId: 'T1',
    def: { arm: 90, line: armLine },
    outs: 0,
    outsAdded: 0,
  };

  const bases = [null, 'R2', null]; // 二塁走者
  const runs = advanceRunners(bases, '1B', 'B1', false, 0, rng, cfg, ctx);

  assert.equal(runs, 0, '刺されたので得点しない');
  assert.equal(ctx.outsAdded, 1, 'アウトが1つ増える');
  assert.equal(armLine.armKill, 1, '外野補殺が記録される');
  assert.equal(armLine.a, 1, '補殺(a)が記録される');
  assert.equal(bases[2], null, '刺された走者は三塁に居ない（幽霊走者を作らない）');
  assert.equal(bases[1], null, '刺された走者は二塁にも居ない');
  assert.equal(bases[0], 'B1', '打者は一塁');
});

test('外野補殺: 1打席で3アウト目を作らない（既に2アウト相当なら刺さない）', () => {
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R1', mk('R1')], ['R2', mk('R2')], ['B1', mk('B1')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) {
      lines.set(pid, {
        baserunning: { advOpp: 0, advTaken: 0, adv2h1bOpp: 0, adv2h1bTaken: 0, adv1t3bOpp: 0, adv1t3bTaken: 0 },
      });
    }
    return lines.get(pid);
  };
  const armLine = { armOpp: 0, armAdv: 0, armKill: 0, a: 0 };
  const rng = { next: () => 0 }; // 常に走り、常に刺される条件
  const ctx = { byId, statFor, teamId: 'T1', def: { arm: 90, line: armLine }, outs: 1, outsAdded: 0 };

  const bases = ['R1', 'R2', null]; // 一・二塁、1アウト
  advanceRunners(bases, '1B', 'B1', false, 1, rng, cfg, ctx);

  // 1アウト + 補殺1 = 2アウト。2人目は刺さない（outs + outsAdded < 2 のガード）
  assert.equal(ctx.outsAdded, 1, '補殺は1つまで（3アウト目を作らない）');
  assert.ok(armLine.armKill === 1, `補殺は1つ (got ${armLine.armKill})`);
});

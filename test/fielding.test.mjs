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
    if (!lines.has(pid)) lines.set(pid, { baserunning: { advOpp: 0, advTaken: 0, adv2h1bOpp: 0, adv2h1bTaken: 0, outsOnBase: 0 } });
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

test('外野補殺: 3アウト目までの走塁死は許可される（R1・R2の連続補殺・realism_r1）', () => {
  // canKillは<3へ緩和済み（時間プレー: 先に数えた得点はアウトより先に本塁を踏んだのと同義）。
  // 1アウト+2補殺=3アウトで打ち切り。
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R1', mk('R1')], ['R2', mk('R2')], ['B1', mk('B1')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) {
      lines.set(pid, {
        baserunning: { advOpp: 0, advTaken: 0, adv2h1bOpp: 0, adv2h1bTaken: 0, adv1t3bOpp: 0, adv1t3bTaken: 0, outsOnBase: 0 },
      });
    }
    return lines.get(pid);
  };
  const armLine = { armOpp: 0, armAdv: 0, armKill: 0, a: 0 };
  const rng = { next: () => 0 }; // 常に走り、常に刺される条件
  const ctx = { byId, statFor, teamId: 'T1', def: { arm: 90, line: armLine }, outs: 1, outsAdded: 0 };

  const bases = ['R1', 'R2', null]; // 一・二塁、1アウト
  advanceRunners(bases, '1B', 'B1', false, 1, rng, cfg, ctx);

  // 1アウト + 補殺2 = 3アウト（R2の本塁突入死・R1の三塁突入死が両方成立してよい）
  assert.equal(ctx.outsAdded, 2, '3アウト目に達するまでは連続補殺が起きる');
  assert.equal(armLine.armKill, 2, `補殺は2つ (got ${armLine.armKill})`);
  assert.equal(statFor('R1').baserunning.outsOnBase + statFor('R2').baserunning.outsOnBase, 2, 'outsOnBaseが両走者ぶん計上される');
});

test('外野補殺: 冒頭ガードは3アウト到達後の進塁で乱数を消費しない（realism_r1）', () => {
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R1', mk('R1')], ['R2', mk('R2')], ['B1', mk('B1')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) {
      lines.set(pid, {
        baserunning: { advOpp: 0, advTaken: 0, adv2h1bOpp: 0, adv2h1bTaken: 0, adv1t3bOpp: 0, adv1t3bTaken: 0, outsOnBase: 0 },
      });
    }
    return lines.get(pid);
  };
  const armLine = { armOpp: 0, armAdv: 0, armKill: 0, a: 0 };
  let calls = 0;
  const rng = { next: () => { calls++; return 0; } };
  // 2アウト相当で開始 → 1人目の補殺で3アウトに到達 → 2人目(R1)は冒頭ガードでrng非消費のまま自重
  const ctx = { byId, statFor, teamId: 'T1', def: { arm: 90, line: armLine }, outs: 2, outsAdded: 0 };

  const bases = ['R1', 'R2', null];
  advanceRunners(bases, '1B', 'B1', false, 2, rng, cfg, ctx);

  assert.equal(ctx.outsAdded, 1, '3アウト目で打ち切り、それ以上は増えない');
  assert.equal(armLine.armKill, 1, '補殺は1つのみ');
  // R2(2塁→本塁)の判定で厳密に2回(took/killed)のrng消費。R1(1塁→3塁)は3アウト到達済みにより
  // 冒頭ガードでrng非消費のまま即ADV_HOLD（=このテストの本題）。
  assert.equal(calls, 2, `2人目の判定はrngを一切消費しない (got ${calls} calls)`);
});

// ============================================================================
// タッグアップの深さ依存化（realism_r1_baserunning_spec §B）。
// 旧実装は飛距離に関わらず三塁走者が無条件生還していた（本塁付近のポップでも犠飛成立という穴）。
// ============================================================================
function mkBrLine() {
  return { advOpp: 0, advTaken: 0, tagOpp: 0, tagTaken: 0, tag3hOpp: 0, tag3hTaken: 0, outsOnBase: 0 };
}

test('タッグアップ: 浅い飛球(distanceM<tagMinDistM)は犠飛不成立・全走者自重（realism_r1 §B）', () => {
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R2', mk('R2')], ['R3', mk('R3')], ['B1', mk('B1')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) lines.set(pid, { baserunning: mkBrLine() });
    return lines.get(pid);
  };
  const armLine = { armOpp: 0, armAdv: 0, armKill: 0, a: 0 };
  const rng = { next: () => 0 }; // 「走る」側に倒れる設定だが、深さゲートで到達しないはず
  const ctx = { byId, statFor, teamId: 'T1', def: { arm: 90, line: armLine }, battedBall: { distanceM: 40 }, outs: 0, outsAdded: 0 };

  const bases = [null, 'R2', 'R3'];
  const runs = advanceRunners(bases, 'out', 'B1', true, 0, rng, cfg, ctx);

  assert.equal(runs, 0, '浅い飛球は犠飛にならない');
  assert.equal(ctx.sacFly, false, 'sacFlyフラグも立たない');
  assert.deepEqual(bases, [null, 'R2', 'R3'], '走者は動かない（自重）');
});

test('タッグアップ: 深い飛球で本塁生還すればsacFly=trueが立つ（realism_r1 §B）', () => {
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R3', mk('R3')], ['B1', mk('B1')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) lines.set(pid, { baserunning: mkBrLine() });
    return lines.get(pid);
  };
  const armLine = { armOpp: 0, armAdv: 0, armKill: 0, a: 0 };
  const seq = [0, 0.99]; // 1回目=took判定(走る)、2回目=killed判定(刺されない=生還)
  let call = 0;
  const rng = { next: () => seq[Math.min(call++, seq.length - 1)] };
  const ctx = { byId, statFor, teamId: 'T1', def: { arm: 50, line: armLine }, battedBall: { distanceM: 100 }, outs: 0, outsAdded: 0 };

  const bases = [null, null, 'R3'];
  const runs = advanceRunners(bases, 'out', 'B1', true, 0, rng, cfg, ctx);

  assert.equal(runs, 1, '深い飛球で生還');
  assert.equal(ctx.sacFly, true, 'sacFlyフラグが立つ');
  assert.equal(bases[2], null, '3塁が空く');
});

test('タッグアップ: 深い飛球でも自重すればsacFly=falseのまま3塁に残る（realism_r1 §B）', () => {
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R3', mk('R3')], ['B1', mk('B1')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) lines.set(pid, { baserunning: mkBrLine() });
    return lines.get(pid);
  };
  const armLine = { armOpp: 0, armAdv: 0, armKill: 0, a: 0 };
  const rng = { next: () => 0.999 }; // took判定で「走らない」側に倒れる
  const ctx = { byId, statFor, teamId: 'T1', def: { arm: 50, line: armLine }, battedBall: { distanceM: 60 }, outs: 0, outsAdded: 0 };

  const bases = [null, null, 'R3'];
  const runs = advanceRunners(bases, 'out', 'B1', true, 0, rng, cfg, ctx);

  assert.equal(runs, 0, '自重して無得点');
  assert.equal(ctx.sacFly, false, '犠飛不成立');
  assert.equal(bases[2], 'R3', '3塁に残る');
});

test('タッグアップ: 本塁憤死ならsacFly=false・outsAdded++（realism_r1 §B）', () => {
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R3', mk('R3')], ['B1', mk('B1')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) lines.set(pid, { baserunning: mkBrLine() });
    return lines.get(pid);
  };
  const armLine = { armOpp: 0, armAdv: 0, armKill: 0, a: 0 };
  const rng = { next: () => 0 }; // took=true、killed=true（強肩）
  const ctx = { byId, statFor, teamId: 'T1', def: { arm: 90, line: armLine }, battedBall: { distanceM: 100 }, outs: 0, outsAdded: 0 };

  const bases = [null, null, 'R3'];
  const runs = advanceRunners(bases, 'out', 'B1', true, 0, rng, cfg, ctx);

  assert.equal(runs, 0, '刺されたので無得点');
  assert.equal(ctx.sacFly, false, '犠飛不成立');
  assert.equal(ctx.outsAdded, 1, '本塁憤死で1アウト追加');
  assert.equal(bases[2], null, '3塁は空く（アウト）');
  assert.equal(armLine.armKill, 1, '外野手のarmKillが記録される（本塁補殺）');
  assert.equal(statFor('R3').baserunning.outsOnBase, 1, 'R3にoutsOnBaseが記録される');
});

// ============================================================================
// ゴロアウトの走者処理（DP/FC/進塁打の3分岐・realism_r1_baserunning_spec §A）。
// 旧実装はゴロアウトで走者が一切進塁しなかった（進塁打・ゴロ間の得点・満塁本塁封殺が不在）。
// ============================================================================
function mkFullLine() {
  return {
    batting: { gdp: 0 },
    baserunning: mkBrLine(),
    fielding: { dpOpp: 0, dpTurned: 0 },
  };
}
function mkGbCtx({ outs = 0, speed = 50 } = {}) {
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility({ common: { speed } }) });
  const byId = new Map([['R1', mk('R1')], ['R2', mk('R2')], ['R3', mk('R3')], ['B1', mk('B1')], ['F2B', mk('F2B')], ['FSS', mk('FSS')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) lines.set(pid, mkFullLine());
    return lines.get(pid);
  };
  return {
    byId,
    statFor,
    teamId: 'BAT',
    fieldingDefense: { '2B': 'F2B', SS: 'FSS' },
    fieldingTeamId: 'FLD',
    bType: 'GB',
    def: null,
    outs,
    outsAdded: 0,
  };
}

test('ゴロ: 併殺(DP)は0死満塁で1点（時間プレー）・R1アウト＋打者アウトでgbDp=true', () => {
  const ctx = mkGbCtx({ outs: 0 });
  const rng = { next: () => 0.1 }; // pDp(0.42) > 0.1 → DP分岐
  const bases = ['R1', 'R2', 'R3'];
  const runs = advanceRunners(bases, 'out', 'B1', false, 0, rng, cfg, ctx);

  assert.equal(runs, 1, '0死満塁のDPは3塁走者が生還する（時間プレー）');
  assert.equal(ctx.gbDp, true, 'gbDpが立つ');
  assert.equal(ctx.outsAdded, 1, 'R1のフォースアウトが1つ追加される');
  assert.deepEqual(bases, [null, null, 'R2'], 'R1除去・R3生還・R2は3塁へ進塁');
  assert.equal(ctx.statFor('B1').batting.gdp, 1, '打者にGDPが記録される');
  assert.equal(ctx.statFor('F2B').fielding.dpOpp, 1, '二塁手にdpOppが記録される');
  assert.equal(ctx.statFor('F2B').fielding.dpTurned, 1, '二塁手にdpTurnedが記録される');
  assert.equal(ctx.statFor('FSS').fielding.dpTurned, 1, '遊撃手にdpTurnedが記録される');
});

test('ゴロ: 併殺(DP)が3アウト目のフォースなら得点は入らない（1死満塁・公認規則5.08(b)相当）', () => {
  const ctx = mkGbCtx({ outs: 1 });
  const rng = { next: () => 0.1 }; // DP分岐
  const bases = ['R1', 'R2', 'R3'];
  const runs = advanceRunners(bases, 'out', 'B1', false, 1, rng, cfg, ctx);

  assert.equal(runs, 0, 'フォースの3アウト目は得点を無効化する');
  assert.equal(ctx.gbDp, true, 'gbDpは立つ（併殺自体は成立）');
  assert.equal(ctx.outsAdded, 1, 'R1のフォースアウトは記録される');
  assert.equal(bases[0], null, 'R1は除去される');
});

test('ゴロ: フィールダースチョイス(FC)は打者が一塁に生き、R1のみアウト（追加アウトなし）', () => {
  const ctx = mkGbCtx({ outs: 1 });
  const rng = { next: () => 0.5 }; // pDp(0.42) <= 0.5 < pDp+gbForceFc(0.72) → FC分岐
  const bases = ['R1', 'R2', null];
  const runs = advanceRunners(bases, 'out', 'B1', false, 1, rng, cfg, ctx);

  assert.equal(runs, 0, '3塁走者不在なので無得点');
  assert.equal(ctx.fcBatterSafe, true, 'fcBatterSafeが立つ');
  assert.equal(ctx.outsAdded, 0, 'FCは追加アウトを計上しない（打者アウト計上とR1除去で整合）');
  assert.deepEqual(bases, ['B1', null, 'R2'], '打者は一塁・R1除去・R2は3塁へ');
});

test('ゴロ: 進塁打（DP/FC不成立）は打者アウト・R1が二塁へ進む', () => {
  const ctx = mkGbCtx({ outs: 1 });
  const rng = { next: () => 0.9 }; // pDp+gbForceFc(0.72)を超える → 進塁打分岐
  const bases = ['R1', null, null];
  const runs = advanceRunners(bases, 'out', 'B1', false, 1, rng, cfg, ctx);

  assert.equal(runs, 0);
  assert.equal(ctx.gbDp, false);
  assert.equal(ctx.fcBatterSafe, false);
  assert.equal(ctx.outsAdded, 0, '進塁打に追加アウトはない（打者アウトのみ）');
  assert.deepEqual(bases, [null, 'R1', null], '打者は一塁を占有せず(アウト)、R1が二塁へ進む');
});

test('ゴロ: 進塁打で3塁走者が自重すると連鎖が塞がりR2・R1は進めない（占有衝突なし）', () => {
  const ctx = mkGbCtx({ outs: 1 });
  // 1回目=分岐選択(0.9=進塁打)、2回目=R3のgbAdv3h took判定(0.999=走らない→HOLD)
  const seq = [0.9, 0.999];
  let call = 0;
  const rng = { next: () => seq[Math.min(call++, seq.length - 1)] };
  const bases = ['R1', 'R2', 'R3'];
  const runs = advanceRunners(bases, 'out', 'B1', false, 1, rng, cfg, ctx);

  assert.equal(runs, 0, 'R3が自重したので無得点');
  assert.deepEqual(bases, ['R1', 'R2', 'R3'], '3塁が空かないためR2もR1も動けない（二重占有なし）');
});

test('ゴロ: 走者一塁なし（フォース不成立）は三塁走者のゴロゴー・二塁走者の三進のみ', () => {
  const ctx = mkGbCtx({ outs: 0 });
  // 1回目=R3のgbAdv3h took判定(0=走る)、2回目=killed判定(0.999=刺されない=生還)、
  // 3回目=R2のgbAdv2t3 took判定(0=走る)。R2側はdef不在・非gbAdv3hシナリオのためcanKill=false
  // となりkilled判定のrng消費は発生しない（3回で足りる）。
  const seq = [0, 0.999, 0];
  let call = 0;
  const rng = { next: () => seq[Math.min(call++, seq.length - 1)] };
  const bases = [null, 'R2', 'R3'];
  const runs = advanceRunners(bases, 'out', 'B1', false, 0, rng, cfg, ctx);

  assert.equal(runs, 1, '3塁走者が生還');
  assert.deepEqual(bases, [null, null, 'R2'], 'R3生還・R2は3塁へ（フォースなしでも進塁機会がある）');
});

test('ゴロ: 1死三塁で三塁走者がゴロゴー成功なら得点・OUTならoutsAdded、2死ゴロは無得点', () => {
  // TAKEN
  {
    const ctx = mkGbCtx({ outs: 1 });
    const rng = { next: () => 0 }; // took=走る、killed=刺されない→生還
    const seq = [0, 0.999];
    let call = 0;
    const rngSeq = { next: () => seq[Math.min(call++, seq.length - 1)] };
    const bases = [null, null, 'R3'];
    const runs = advanceRunners(bases, 'out', 'B1', false, 1, rngSeq, cfg, ctx);
    assert.equal(runs, 1, 'ゴロゴー成功で生還');
    assert.equal(bases[2], null);
    assert.equal(ctx.outsAdded, 0);
  }
  // OUT（本塁憤死）
  {
    const ctx = mkGbCtx({ outs: 1 });
    const rng = { next: () => 0 }; // took=走る、killed=刺される
    const bases = [null, null, 'R3'];
    const runs = advanceRunners(bases, 'out', 'B1', false, 1, rng, cfg, ctx);
    assert.equal(runs, 0, '本塁憤死で無得点');
    assert.equal(ctx.outsAdded, 1, '本塁憤死でoutsAddedが1増える');
    assert.equal(bases[2], null);
  }
  // 2死ゴロは走者処理そのものが発生しない（無得点・走者そのまま）
  {
    const ctx = mkGbCtx({ outs: 2 });
    const rng = { next: () => 0 };
    const bases = [null, null, 'R3'];
    const runs = advanceRunners(bases, 'out', 'B1', false, 2, rng, cfg, ctx);
    assert.equal(runs, 0, '2アウト後のゴロは無得点');
    assert.deepEqual(bases, [null, null, 'R3'], '2アウト後は走者そのまま');
    assert.equal(ctx.outsAdded, 0);
  }
});

test('ゴロ: ctxなし/fieldingDefenseなしはレガシー挙動（走者凍結）にフォールバックする', () => {
  const bases = ['R1', 'R2', 'R3'];
  // ctx自体が無い呼び出し（bTypeが伝わらないため、そもそもゴロ分岐に入らずisAirOutもfalse→走者そのまま）
  const runs = advanceRunners(bases, 'out', 'B1', false, 0, undefined, cfg, undefined);
  assert.equal(runs, 0);
  assert.deepEqual(bases, ['R1', 'R2', 'R3'], 'ctxなしでは走者は動かない（後方互換）');
});

test('2死1・2塁の単打: R2生還が数えられた後にR1が三塁突入死（3アウト目）でも得点は残る（時間プレー）', () => {
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R1', mk('R1')], ['R2', mk('R2')], ['B1', mk('B1')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) lines.set(pid, { baserunning: mkBrLine() });
    return lines.get(pid);
  };
  const armLine = { armOpp: 0, armAdv: 0, armKill: 0, a: 0 };
  // [R2: took=0(走る), killed=0.999(刺されない=生還)] [R1: took=0(走る), killed=0(刺される)]
  const seq = [0, 0.999, 0, 0];
  let call = 0;
  const rng = { next: () => seq[Math.min(call++, seq.length - 1)] };
  const ctx = { byId, statFor, teamId: 'T1', def: { arm: 90, line: armLine }, outs: 2, outsAdded: 0 };

  const bases = ['R1', 'R2', null];
  const runs = advanceRunners(bases, '1B', 'B1', false, 2, rng, cfg, ctx);

  assert.equal(runs, 1, 'R2の生還は先に数えられているので残る');
  assert.equal(ctx.outsAdded, 1, 'R1は三塁突入死（3アウト目）');
  assert.equal(bases[0], 'B1', '打者は一塁');
});

// ============================================================================
// 失策(E)時の走者進塁（realism_r1_baserunning_spec §C）。
// 旧実装はBB/HBPと同じ押し出しのみで、外野の落球でも非フォース走者が1個も進めなかった。
// ============================================================================
function mkErrCtx(errorFielderPos) {
  const mk = (id) => createPlayer({ id, role: 'fielder', trueAbility: createTrueAbility() });
  const byId = new Map([['R1', mk('R1')], ['R2', mk('R2')], ['R3', mk('R3')], ['B1', mk('B1')]]);
  const lines = new Map();
  const statFor = (pid) => {
    if (!lines.has(pid)) lines.set(pid, { baserunning: mkBrLine() });
    return lines.get(pid);
  };
  return { byId, statFor, teamId: 'T1', def: null, errorFielderPos, outs: 0, outsAdded: 0 };
}

test('失策(E): 外野失策は単打相当の進塁（二三塁が生還・一塁は三進を狙える）', () => {
  const ctx = mkErrCtx('LF');
  const rng = { next: () => 0 }; // 進塁判定は常に「走る」・「刺されない」側
  const bases = ['R1', 'R2', 'R3'];
  const runs = advanceRunners(bases, 'E', 'B1', false, 0, rng, cfg, ctx);

  assert.equal(runs, 2, '3塁は確定生還・2塁も生還（singleScore2判定でTAKEN）');
  assert.equal(bases[0], 'B1', '打者は一塁（失策で出塁）');
});

test('失策(E): 内野失策は満塁ならフォース連鎖が3塁まで届き確定生還', () => {
  const ctx = mkErrCtx('SS');
  const rng = { next: () => 0.999 }; // 使われても影響しない値（満塁は確定生還でresolveAdvを呼ばない）
  const bases = ['R1', 'R2', 'R3'];
  const runs = advanceRunners(bases, 'E', 'B1', false, 0, rng, cfg, ctx);

  assert.equal(runs, 1, '満塁の内野失策は3塁走者が確定生還（フォース連鎖）');
  assert.deepEqual(bases, ['B1', 'R1', 'R2'], '打者一塁・R1二塁・R2三塁へフォース進塁');
});

test('失策(E): 内野失策で走者一塁のみなら二塁への押し出しのみ（3塁走者なし）', () => {
  const ctx = mkErrCtx('2B');
  const rng = { next: () => 0 };
  const bases = ['R1', null, null];
  const runs = advanceRunners(bases, 'E', 'B1', false, 0, rng, cfg, ctx);

  assert.equal(runs, 0);
  assert.deepEqual(bases, ['B1', 'R1', null], '打者一塁・R1は二塁へ押し出し');
});

test('失策(E): 内野失策で二塁走者のみ（一塁なし）はフォース不成立・R2は現状維持', () => {
  const ctx = mkErrCtx('SS');
  const rng = { next: () => 0 }; // R3不在なのでgbAdv3hは呼ばれない
  const bases = [null, 'R2', null];
  const runs = advanceRunners(bases, 'E', 'B1', false, 0, rng, cfg, ctx);

  assert.equal(runs, 0);
  assert.deepEqual(bases, ['B1', 'R2', null], '打者一塁で出塁するがR2は非フォースにつき進まない');
});

test('失策(E): 内野失策で一塁なし・三塁走者のみはゴロゴー機会球（resolveAdv gbAdv3h）', () => {
  const ctx = mkErrCtx('SS');
  const seq = [0, 0.999]; // took=走る、killed=刺されない→生還
  let call = 0;
  const rng = { next: () => seq[Math.min(call++, seq.length - 1)] };
  const bases = [null, null, 'R3'];
  const runs = advanceRunners(bases, 'E', 'B1', false, 0, rng, cfg, ctx);

  assert.equal(runs, 1, 'フォース対象外のR3も機会球で生還しうる');
  assert.deepEqual(bases, ['B1', null, null]);
});

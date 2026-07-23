// ============================================================================
// Q1（thyroxin/research/baseball_game_mechanics_research_20260723.md Q1・信頼度）のテスト。
//
//   起用の安定→年次ドリフトSD縮小という双方向ループの検証:
//   ① cfg.game.usageTrust 既定OFF時はaging結果がbit同一（フラグゲート・applyAging直呼び前後比較）
//   ② ONで決定論（同一seedは同一結果）
//   ③ usageStabilityOf の分岐（フル出場≈1.0／ほぼ出場なし≈0／中間）
//   ④ trustMultの上下限（1.0−span 〜 1.0にクランプ・統計的検証＝H3-1ムラっ気テストの流儀を踏襲）
//   ⑤ trustLabelOf の3段階ラベル境界
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, qualifiedPA } from '../src/config.mjs';
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';
import { createBattingLine, createPitchingLine } from '../src/model/statline.mjs';
import { hashSeed } from '../src/rng.mjs';
import { applyAging } from '../src/game/aging.mjs';
import { usageStabilityOf, trustLabelOf, TRUST_LABELS_JP } from '../src/game/trust.mjs';

const cfg = createConfig(); // usageTrust 既定 false
const SEED = 20260723;
const TEAM_GAMES = 143;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const variance = (a) => { const m = mean(a); return mean(a.map((x) => (x - m) ** 2)); };

// ============================================================================
// ① フラグOFF時: aging結果がbit同一（usageStats/teamGames を渡しても無視される）
// ============================================================================

test('Q1: usageTrust既定OFF時はusageStats/teamGamesを渡してもaging結果がbit同一（フラグゲート）', () => {
  const peak = 27;
  const age = peak + 2;
  const N = 50;
  const withoutTrust = [];
  const withTrustArgs = [];
  const usageStats = new Map();
  for (let i = 0; i < N; i++) {
    const id = `P${i}`;
    const t1 = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
    withoutTrust.push(createPlayer({ id, age, role: 'fielder', trueAbility: t1 }));
    const t2 = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
    withTrustArgs.push(createPlayer({ id, age, role: 'fielder', trueAbility: t2 }));
    usageStats.set(id, { batting: { ...createBattingLine(), pa: 600, ph: 0 }, pitching: createPitchingLine() });
  }
  applyAging(withoutTrust, cfg, { seed: hashSeed(SEED, 'q1flagoff') });
  applyAging(withTrustArgs, cfg, { seed: hashSeed(SEED, 'q1flagoff'), usageStats, teamGames: TEAM_GAMES });
  for (let i = 0; i < N; i++) {
    assert.deepEqual(
      withTrustArgs[i].trueAbility, withoutTrust[i].trueAbility,
      `${withoutTrust[i].id}: フラグOFF時はusageStats指定の有無でaging結果が変わってはならない`,
    );
  }
});

test('Q1: usageTrust既定OFF時はcfg.game省略（旧経路の直呼び）でも例外にならない', () => {
  const t = createTrueAbility({ career: { peakAge: 27, declineRate: 0.5 } });
  const p = createPlayer({ id: 'NOFLAG', age: 29, role: 'fielder', trueAbility: t });
  const bareCfg = { tuning: cfg.tuning }; // game キー自体が無い最小cfg（旧テスト呼び出し相当）
  assert.doesNotThrow(() => applyAging([p], bareCfg, { seed: hashSeed(SEED, 'noflag') }));
});

// ============================================================================
// ② ONで決定論
// ============================================================================

test('Q1: usageTrust ON時も決定論（同一seed・同一usageStatsは同一結果）', () => {
  const trustCfg = createConfig({ game: { usageTrust: true } });
  const peak = 27;
  const age = peak + 3;
  const N = 30;
  const make = (prefix) => {
    const players = [];
    const usageStats = new Map();
    for (let i = 0; i < N; i++) {
      const id = `${prefix}${i}`;
      const t = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
      players.push(createPlayer({ id, age, role: 'fielder', trueAbility: t }));
      usageStats.set(id, { batting: { ...createBattingLine(), pa: 300 + i, ph: i % 5 } });
    }
    return { players, usageStats };
  };
  const a = make('D');
  const b = make('D');
  applyAging(a.players, trustCfg, { seed: hashSeed(SEED, 'q1deterministic'), usageStats: a.usageStats, teamGames: TEAM_GAMES });
  applyAging(b.players, trustCfg, { seed: hashSeed(SEED, 'q1deterministic'), usageStats: b.usageStats, teamGames: TEAM_GAMES });
  for (let i = 0; i < N; i++) assert.deepEqual(a.players[i].trueAbility, b.players[i].trueAbility);
});

// ============================================================================
// ③ usageStabilityOf の分岐
// ============================================================================

test('Q1: usageStabilityOf — フル出場の野手は≈1.0', () => {
  const row = { batting: { ...createBattingLine(), pa: qualifiedPA(TEAM_GAMES), ph: 0 } };
  const s = usageStabilityOf(row, TEAM_GAMES);
  assert.ok(s > 0.95 && s <= 1.0, `フル出場のstabilityが1.0付近でない: ${s}`);
});

test('Q1: usageStabilityOf — ほぼ出場なしの野手は≈0', () => {
  const row = { batting: { ...createBattingLine(), pa: 2, ph: 0 } };
  const s = usageStabilityOf(row, TEAM_GAMES);
  assert.ok(s >= 0 && s < 0.05, `ほぼ出場なしのstabilityが0付近でない: ${s}`);
});

test('Q1: usageStabilityOf — 中間出場の野手は0と1.0の間', () => {
  const row = { batting: { ...createBattingLine(), pa: Math.round(qualifiedPA(TEAM_GAMES) / 2), ph: 0 } };
  const s = usageStabilityOf(row, TEAM_GAMES);
  assert.ok(s > 0.15 && s < 0.85, `中間出場のstabilityが中間域でない: ${s}`);
});

test('Q1: usageStabilityOf — フル登板の先発投手は≈1.0、ほぼ登板なしは≈0、中間は中間域', () => {
  const fullStarterApps = Math.round(TEAM_GAMES / 6);
  const full = { pitching: { ...createPitchingLine(), g: fullStarterApps, gs: fullStarterApps, outs: fullStarterApps * 18 } };
  assert.ok(usageStabilityOf(full, TEAM_GAMES) > 0.9, 'フル登板の先発が1.0付近でない');
  const almostNone = { pitching: { ...createPitchingLine(), g: 1, gs: 0, outs: 1 } };
  assert.ok(usageStabilityOf(almostNone, TEAM_GAMES) < 0.1, 'ほぼ登板なしが0付近でない');
  const mid = { pitching: { ...createPitchingLine(), g: Math.round(fullStarterApps / 2), gs: Math.round(fullStarterApps / 2), outs: Math.round(fullStarterApps / 2) * 18 } };
  const s = usageStabilityOf(mid, TEAM_GAMES);
  assert.ok(s > 0.15 && s < 0.85, `中間登板のstabilityが中間域でない: ${s}`);
});

test('Q1: usageStabilityOf — 前季データが無い（null/undefined/空行）は0', () => {
  assert.equal(usageStabilityOf(null, TEAM_GAMES), 0);
  assert.equal(usageStabilityOf(undefined, TEAM_GAMES), 0);
  assert.equal(usageStabilityOf({}, TEAM_GAMES), 0);
  assert.equal(usageStabilityOf({ batting: createBattingLine() }, TEAM_GAMES), 0); // pa=0
  assert.equal(usageStabilityOf({ batting: { ...createBattingLine(), pa: 10 } }, 0), 0); // teamGames=0
});

// ============================================================================
// ④ trustMultの上下限（統計的検証・H3-1ムラっ気テストの流儀を踏襲）
// ============================================================================

test('Q1: 起用が安定した選手ほどaging drift SDが縮む（上限=1.0・下限=1.0−usageTrustDriftSpan）', () => {
  const N = 4000;
  const peak = 27;
  const age = peak + 2; // 'hands'プロファイル(peakShift=2,declineOffset=3)でcurveDelta=0の年齢帯（H3-1と同じ選定）
  const trustCfg = createConfig({ game: { usageTrust: true } });
  const span = trustCfg.game.usageTrustDriftSpan;

  const stablePlayers = [];
  const volatilePlayers = [];
  const stableRows = new Map();
  const volatileRows = new Map();
  for (let i = 0; i < N; i++) {
    const t1 = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
    stablePlayers.push(createPlayer({ id: `ST${i}`, age, role: 'fielder', trueAbility: t1 }));
    stableRows.set(`ST${i}`, { batting: { ...createBattingLine(), pa: qualifiedPA(TEAM_GAMES), ph: 0 } }); // stability=1.0
    const t2 = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
    volatilePlayers.push(createPlayer({ id: `VO${i}`, age, role: 'fielder', trueAbility: t2 }));
    volatileRows.set(`VO${i}`, { batting: { ...createBattingLine(), pa: 0, ph: 0 } }); // stability=0
  }
  applyAging(stablePlayers, trustCfg, { seed: hashSeed(SEED, 'q1bound'), usageStats: stableRows, teamGames: TEAM_GAMES });
  applyAging(volatilePlayers, trustCfg, { seed: hashSeed(SEED, 'q1bound'), usageStats: volatileRows, teamGames: TEAM_GAMES });

  const dStable = stablePlayers.map((p) => p.trueAbility.common.hands - 50);
  const dVolatile = volatilePlayers.map((p) => p.trueAbility.common.hands - 50);
  assert.ok(Math.abs(mean(dStable)) < 0.15, `安定群平均が0から乖離しすぎ（期待値保存の違反）: ${mean(dStable)}`);
  assert.ok(Math.abs(mean(dVolatile)) < 0.15, `不安定群平均が0から乖離しすぎ: ${mean(dVolatile)}`);

  const varStable = variance(dStable);
  const varVolatile = variance(dVolatile);
  const ratio = varStable / varVolatile; // (1-span)^2 が期待値（volatile側はtrustMult=1で無効果）
  const expectRatio = (1 - span) ** 2;
  assert.ok(ratio < 1, `安定群の分散が不安定群以上（trustMultが効いていない）: ratio=${ratio.toFixed(3)}`);
  assert.ok(ratio > expectRatio * 0.75 && ratio < expectRatio * 1.3, `分散比 ${ratio.toFixed(3)} が期待 ${expectRatio.toFixed(3)} から大きく外れる`);
});

// ============================================================================
// ⑤ trustLabelOf の3段階ラベル
// ============================================================================

test('Q1: trustLabelOf は3段階（stable/normal/volatile）を境界どおりに返す', () => {
  assert.equal(trustLabelOf(1.0), 'stable');
  assert.equal(trustLabelOf(0.66), 'stable');
  assert.equal(trustLabelOf(0.65), 'normal');
  assert.equal(trustLabelOf(0.5), 'normal');
  assert.equal(trustLabelOf(0.34), 'normal');
  assert.equal(trustLabelOf(0.33), 'volatile');
  assert.equal(trustLabelOf(0), 'volatile');
});

test('Q1: TRUST_LABELS_JP は3段階すべてに日本語ラベルを持つ', () => {
  for (const k of ['stable', 'normal', 'volatile']) {
    assert.equal(typeof TRUST_LABELS_JP[k], 'string');
    assert.ok(TRUST_LABELS_JP[k].length > 0);
  }
});

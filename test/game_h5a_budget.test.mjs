// ============================================================================
// H5-A: 年俸予算（経営レイヤー第1段）のテスト（phaseH_fun_spec H5-A）。
//   - budget の決定論付与（teamFinanceProfile・独立シード・帯内・球団差）
//   - 旧セーブ補完（finance フィールドを消した blob の load が同一 budget を再導出）
//   - 予算制約が実際に市場を締める（budget=0 で FA 成立が消える・既定では成立する）
//   - payroll 整合（refreshTeamFinance の確定値 = 支配下年俸合計）と人口/構成恒常
//   - 市場成立件数が概ね維持される（激減していない・緩い下限帯）
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, save, load } from '../src/game/index.mjs';
import { teamFinanceProfile } from '../src/generate.mjs';
import { salaryOf, sumSalary } from '../src/game/finance.mjs';

const SEED = 20260714;
const YEARS = 6;

/** N年運用して市場イベントを集計する。cfgMut(cfg)/mutate(state) で介入できる。 */
function runYears(seed, years, mutate = null, cfgMut = null) {
  const cfg = createConfig();
  if (cfgMut) cfgMut(cfg);
  const st = newGame(seed, 'T1', { cfg });
  if (mutate) mutate(st);
  const agg = { fa: 0, trades: 0, pickups: 0 };
  for (let y = 0; y < years; y++) {
    advanceTo(st, 'seasonEnd');
    const off = advanceYear(st);
    agg.fa += off.fa.length;
    agg.trades += off.trades.filter((t) => !t.rejected).length;
    agg.pickups += off.pickups.length;
  }
  return { st, agg, cfg };
}

test('H5-A: budget は決定論・帯内・球団差がある（teamFinanceProfile）', () => {
  const cfg = createConfig();
  const b = cfg.tuning.economy.budget;
  const ids = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
  const budgets = ids.map((id) => teamFinanceProfile(SEED, id, cfg).budget);
  const budgets2 = ids.map((id) => teamFinanceProfile(SEED, id, cfg).budget);
  assert.deepEqual(budgets, budgets2, '同一シード・同一球団は同一 budget（決定論）');
  for (const v of budgets) assert.ok(v >= b.min && v <= b.max, `budget ${v} が帯[${b.min},${b.max}]内`);
  assert.ok(new Set(budgets).size >= 4, '球団間で財力差が散らばる');
  const other = teamFinanceProfile(SEED + 1, 'T1', cfg).budget;
  assert.notEqual(other, budgets[0], '別シードは別の budget');
});

test('H5-A: 旧セーブ補完 — finance を消した blob の load が同一 budget を決定論再導出', () => {
  const { st } = runYears(SEED, 1);
  const blob = JSON.parse(JSON.stringify(save(st)));
  // blob 全体から finance キーを再帰的に削除（旧セーブ形式の再現）
  const strip = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const v of o) strip(v); return; }
    delete o.finance;
    for (const k of Object.keys(o)) strip(o[k]);
  };
  strip(blob);
  const restored = load(blob);
  // H5-C以降 budget は「teamFinanceProfile の市場規模 × ファン係数」で毎オフ再導出される。
  // finance を失った旧セーブは fanInterest=init(係数1.0) で補完されるため、budget は
  // 市場規模そのもの（teamFinanceProfile）と一致するのが正しい期待値（決定論補完）。
  const cfg2 = createConfig();
  for (const t of restored.league.teams) {
    assert.equal(t.finance.budget, teamFinanceProfile(restored.masterSeed, t.id, cfg2).budget, `${t.id} の budget が決定論再導出値と一致`);
    assert.equal(t.finance.fanInterest, cfg2.tuning.economy.fan.init, `${t.id} の fanInterest は init 補完`);
  }
});

test('H5-A: 予算制約が市場を実際に締める（budget=0 → FA成立ゼロ／既定 → 成立あり）', () => {
  // 既定予算: FA が一定数成立する（前提の確認）
  const normal = runYears(SEED, YEARS);
  assert.ok(normal.agg.fa > 0, `既定予算では FA が成立する（${normal.agg.fa}件）`);
  // 全球団 budget=0（config帯を0に潰す＝H5-C の毎オフ再導出でも恒常的に0）:
  // 「payroll(補償差引後) ≤ budget」を必ず満たせない＝FA成立が消える
  const broke = runYears(SEED, YEARS, (st) => {
    for (const t of st.league.teams) t.finance = { budget: 0, payroll: 0, fanInterest: 0.5 };
  }, (cfg) => {
    cfg.tuning.economy.budget = { ...cfg.tuning.economy.budget, mean: 0, sd: 0, min: 0, max: 0 };
  });
  assert.equal(broke.agg.fa, 0, 'budget=0 では FA が1件も成立しない（予算制約の実効性）');
});

test('H5-A: payroll 整合と人口/構成恒常（多年）', () => {
  const { st, cfg } = runYears(SEED, YEARS);
  const R = cfg.tuning.roster;
  assert.equal(st.league.players.length, cfg.league.numTeams * R.controlledPerTeam, '支配下人口は恒常');
  const floor = cfg.tuning.economy.salaryFloor;
  for (const t of st.league.teams) {
    const roster = st.league.players.filter((p) => p.teamId === t.id && p.rosterStatus === 'active');
    assert.equal(roster.length, R.controlledPerTeam, `${t.id} は支配下70人`);
    assert.equal(t.finance.payroll, sumSalary(roster, cfg), `${t.id} payroll = 支配下年俸合計`);
    for (const p of roster) assert.ok(salaryOf(p, cfg) >= floor, '年俸は下限以上');
  }
});

test('H5-A: 市場成立件数が激減していない（緩い下限帯・H5-A前実測 FA9.5/トレード5.9/拾い上げ15.3）', () => {
  const { agg } = runYears(SEED, YEARS);
  // 単seed・6年の緩い下限（決定論なので一度PASSすれば恒久）。激減検知が目的で上限は設けない。
  assert.ok(agg.fa / YEARS >= 3, `FA成立/年 ${(agg.fa / YEARS).toFixed(1)} ≥ 3`);
  assert.ok(agg.trades / YEARS >= 2, `トレード成立/年 ${(agg.trades / YEARS).toFixed(1)} ≥ 2`);
  assert.ok(agg.pickups / YEARS >= 6, `拾い上げ/年 ${(agg.pickups / YEARS).toFixed(1)} ≥ 6`);
});

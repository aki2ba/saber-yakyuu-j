// ============================================================================
// H5-C: ファン関心・収入の閉ループのテスト（phaseH_fun_spec H5-C）。
//   - fanInterest の更新が決定論・帯[min,max]内で有界（多年）
//   - 成績とファン関心の連動（勝ち組の関心 > 負け組・回帰の実効性）
//   - budget 比の有界性（金満/貧乏の暴走防止）・budget が fanInterest に連動して年次見直しされる
//   - スター流出でファン関心が下がる（純関数レベル）・旧セーブ補完
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, save, load } from '../src/game/index.mjs';
import { updateFanEconomy } from '../src/game/finance.mjs';

const SEED = 20260715;
const YEARS = 8;

function runYears(seed, years) {
  // budget連動は既定OFF（headless較正保護）→ 本テストは実プレイ相当（UI設定）を明示的に有効化
  const cfg = createConfig({ tuning: { economy: { fan: { budgetFloorMult: 0.75, budgetSpanMult: 0.5 } } } });
  const st = newGame(seed, 'T1', { cfg });
  const hist = []; // 年ごとの {teamId: fanInterest}
  for (let y = 0; y < years; y++) {
    advanceTo(st, 'seasonEnd');
    advanceYear(st);
    hist.push(new Map(st.league.teams.map((t) => [t.id, t.finance.fanInterest])));
  }
  return { st, hist, cfg };
}

test('H5-C: fanInterest は決定論・帯内で有界（多年）・budget も帯内', () => {
  const { st, hist, cfg } = runYears(SEED, YEARS);
  const eco = cfg.tuning.economy;
  for (const m of hist) {
    for (const [, fi] of m) assert.ok(fi >= eco.fan.min && fi <= eco.fan.max, `fanInterest ${fi} が帯内`);
  }
  for (const t of st.league.teams) {
    assert.ok(t.finance.budget >= eco.budget.min && t.finance.budget <= eco.budget.max, 'budget が帯内');
  }
  // 決定論
  const again = runYears(SEED, YEARS);
  for (const t of st.league.teams) {
    assert.equal(t.finance.fanInterest, again.st.league.teams.find((x) => x.id === t.id).finance.fanInterest, `${t.id} 決定論`);
  }
});

test('H5-C: 成績とファン関心が連動する（最終年: 上位半分の平均 > 下位半分の平均）', () => {
  const { st } = runYears(SEED, YEARS);
  const last = st.teamHistory.reduce((a, b) => (b.year > a.year ? b : a));
  const wp = (s) => s.w / (s.w + s.l);
  const sorted = last.standings.slice().sort((a, b) => wp(b) - wp(a));
  const fi = (tid) => st.league.teams.find((t) => t.id === tid).finance.fanInterest;
  const half = sorted.length / 2;
  const top = sorted.slice(0, half).reduce((s, r) => s + fi(r.teamId), 0) / half;
  const bot = sorted.slice(half).reduce((s, r) => s + fi(r.teamId), 0) / half;
  assert.ok(top > bot, `勝ち組の関心(${top.toFixed(3)}) > 負け組(${bot.toFixed(3)})`);
});

test('H5-C: budget 比が有界（構造上 (max×1.25)/(min×0.75) 以下・実測で確認）', () => {
  const { st, cfg } = runYears(SEED + 1, YEARS);
  const budgets = st.league.teams.map((t) => t.finance.budget);
  const ratio = Math.max(...budgets) / Math.min(...budgets);
  const eco = cfg.tuning.economy;
  const bound = (eco.budget.max * (eco.fan.budgetFloorMult + eco.fan.budgetSpanMult)) / (eco.budget.min * eco.fan.budgetFloorMult);
  assert.ok(ratio <= bound, `budget比 ${ratio.toFixed(2)} ≤ 構造上限 ${bound.toFixed(2)}`);
  assert.ok(ratio < 4, `budget比 ${ratio.toFixed(2)} が常識的な帯（<4）`);
});

test('H5-C: スター流出でファン関心が下がる・優勝で上がる（純関数）', () => {
  const cfg = createConfig();
  const eco = cfg.tuning.economy.fan;
  const mk = (fi) => ({ teams: [
    { id: 'TA', finance: { budget: 60000, payroll: 0, fanInterest: fi } },
    { id: 'TB', finance: { budget: 60000, payroll: 0, fanInterest: fi } },
  ] });
  const standings = [
    { teamId: 'TA', league: 'L1', w: 80, l: 60 },
    { teamId: 'TB', league: 'L1', w: 60, l: 80 },
  ];
  // スター流出: TA から高年俸選手が FA で出る
  const withLoss = mk(0.5);
  updateFanEconomy(withLoss, cfg, { standings, faMoves: [{ from: 'TA', to: 'TB', salary: eco.starSalary + 1 }] });
  const noLoss = mk(0.5);
  updateFanEconomy(noLoss, cfg, { standings, faMoves: [] });
  assert.ok(withLoss.teams[0].finance.fanInterest < noLoss.teams[0].finance.fanInterest, 'スター流出でファン関心が低下');
  // 優勝（勝率1位=TA）ボーナス: TA の関心が回帰+ボーナスで上昇、TB（最下位）は低下
  assert.ok(noLoss.teams[0].finance.fanInterest > 0.5, '勝率1位は回帰+優勝ボーナスで上昇');
  assert.ok(noLoss.teams[1].finance.fanInterest < 0.5, '最下位は分位回帰で低下');
});

test('H5-C: 旧セーブ（fanInterest 無し）は init で補完される', () => {
  const cfg = createConfig();
  const st = newGame(SEED + 2, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  advanceYear(st);
  const blob = JSON.parse(JSON.stringify(save(st)));
  for (const t of blob.leagueSnapshot.teams) { if (t.finance) delete t.finance.fanInterest; }
  const restored = load(blob, { cfg: createConfig() });
  for (const t of restored.league.teams) {
    assert.equal(t.finance.fanInterest, cfg.tuning.economy.fan.init, `${t.id} は init 補完`);
  }
});

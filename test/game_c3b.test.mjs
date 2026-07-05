// ============================================================================
// フェーズC3b: 選手市場（FA・トレード・戦力外/拾い上げ）のテスト。
//   - FA入札が "評価関数差で分かれる"（守備重視球団は守備型FAへ高く入札・§15）＋移籍が起きる
//   - トレードが "双方win" で成立（評価差＝gains from trade）／片方のみ得なら不成立
//   - プレイヤー起案トレードを AI が自評価で受諾/拒否（介入ログで再現・§介入）
//   - 戦力外→拾い上げ: 少なく歪んだ観測（少PA=上林型／不振=板山型）で切られた選手を、査定の違う
//     球団が拾い、翌季に観測が改善する例が "稀に" 出る（§12.2）
//   - 決定論（同一シードは bit 一致／別シードは別運命）／save-load で市場介入が再現
//   - 多年でリーグ人口・ロスター構成（役割13/20）が恒常（全移動が同型1:1スワップ/循環）
//   - 1年目（既存50較正相当）はオフシーズン前＝市場ゼロ（エンジン不変の担保）
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, save, load, proposeTrade } from '../src/game/index.mjs';
import { runTrades, releaseScore, observedValueOf } from '../src/game/transactions.mjs';
import { evaluateProspect } from '../src/game/market.mjs';
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';

const cfg = createConfig();
const SEED = 20260701;
const YEARS = 30;

/** N年運用し、市場イベント（FA/トレード/拾い上げ）と観測改善（回復）を集約する。 */
function runYears(seed, years, teamId = 'T1') {
  const st = newGame(seed, teamId, { cfg });
  const agg = { fa: 0, faMoved: 0, trades: 0, tradesRej: 0, pickups: 0, recoveries: 0, sig: [] };
  const obsByYear = new Map(); // year → Map(pid→line)（回復検出用）
  const pickedUp = [];
  for (let y = 0; y < years; y++) {
    advanceTo(st, 'seasonEnd');
    const year = st.year;
    const m = new Map();
    for (const s of st.careerStats) if (s.season === year) m.set(s.playerId, s);
    obsByYear.set(year, m);
    const off = advanceYear(st);
    agg.fa += off.fa.length;
    agg.faMoved += off.fa.filter((f) => f.to !== f.from).length;
    agg.trades += off.trades.filter((t) => !t.rejected).length;
    agg.tradesRej += off.trades.filter((t) => t.rejected).length;
    agg.pickups += off.pickups.length;
    for (const pu of off.pickups) pickedUp.push({ ...pu, year });
    agg.sig.push(`${off.fa.length},${off.trades.length},${off.pickups.length}`);
  }
  // 回復（拾い上げ後に観測が改善）: 切られた時の観測貢献 cutVal < 後年の観測貢献。
  for (const pu of pickedUp) {
    for (let ly = pu.year + 1; ly <= st.year; ly++) {
      const m = obsByYear.get(ly);
      if (!m || !m.has(pu.playerId)) continue;
      const v = observedValueOf({ id: pu.playerId, role: pu.role }, m, cfg);
      if (v == null) break;
      if (v > pu.cutVal + 4) agg.recoveries++;
      break;
    }
  }
  return { st, agg };
}

const RUN = runYears(SEED, YEARS);

// --- 合成プレイヤー（守備型SS / 強打SS。同型でトレード可能に両方SSにする） ------------
function defSS(id, teamId, age = 29) {
  return createPlayer({
    id, teamId, role: 'fielder', primaryPos: 'SS',
    trueAbility: createTrueAbility({
      common: { reaction: 74, arm: 72, power: 33, speed: 60 },
      batting: { ev: 33, contact: 36, eye: 38, la: 40 },
      fielding: { positionProf: { SS: 76 }, positioningIQ: 74 },
    }),
  });
}
function slugSS(id, teamId, age = 29) {
  return createPlayer({
    id, teamId, role: 'fielder', primaryPos: 'SS',
    trueAbility: createTrueAbility({
      common: { reaction: 40, arm: 44, power: 74, speed: 42 },
      batting: { ev: 74, contact: 70, eye: 68, la: 66 },
      fielding: { positionProf: { SS: 42 }, positioningIQ: 40 },
    }),
  });
}
function miniLeague(players) {
  for (const p of players) { p.rosterStatus = 'active'; p.age = 29; }
  const ids = [...new Set(players.map((p) => p.teamId))].sort();
  const teams = ids.map((id) => ({ id, playerIds: players.filter((p) => p.teamId === id).map((p) => p.id) }));
  return { teams, players, farm: [] };
}
const DEF_BLIND = { wBat: 1, wEye: 1, wDef: 0.1, ageBias: 0, noiseSd: 0 };
const DEF_SMART = { wBat: 1, wEye: 1, wDef: 1.6, ageBias: 0, noiseSd: 0 };
// トレード/査定は非プロテクトのみ対象。合成2選手を必ず非プロテクトにするため protectCount:0 の cfg。
function openCfg() {
  const c = createConfig();
  c.tuning.market.trade.protectCount = 0;
  c.tuning.market.trade.margin = 2;
  return c;
}

test('C3b: FA入札は評価関数差で分かれる（守備重視球団は守備型FAへ高く入札・§15）', () => {
  const dss = defSS('DFA', null);
  const sss = slugSS('SFA', null);
  // 守備を重める球団ほど「守備型FA − 強打FA」の相対入札が上がる（＝守備型を競り落としやすい）。
  const relSmart = evaluateProspect(DEF_SMART, dss, cfg) - evaluateProspect(DEF_SMART, sss, cfg);
  const relBlind = evaluateProspect(DEF_BLIND, dss, cfg) - evaluateProspect(DEF_BLIND, sss, cfg);
  assert.ok(relSmart > relBlind, `守備重視ほど守備型FAを相対的に高評価（smart ${relSmart.toFixed(0)} > blind ${relBlind.toFixed(0)}）`);
  // 実運用: FA移籍が多年で起き、勝者は流出元と別球団（＝評価差で動く）。
  assert.ok(RUN.agg.fa > 0, `20年でFA移籍が発生する（${RUN.agg.fa}）`);
  assert.ok(RUN.agg.faMoved === RUN.agg.fa, 'FA成立は必ず別球団への移籍（人的補償で構成恒常）');
});

test('C3b: トレードは双方winで成立／片方のみ得なら不成立（§15）', () => {
  const c = openCfg();
  // 守備型SS(team A) と 強打SS(team B)。A=守備軽視 / B=守備重視 → 評価差で双方得。
  const Xa = defSS('XA', 'A');
  const Xb = slugSS('XB', 'B');
  const league = miniLeague([Xa, Xb]);
  const profiles = new Map([['A', DEF_BLIND], ['B', DEF_SMART]]);
  const trades = runTrades(league, c, { profiles, masterSeed: 1, yearIndex: 1, interventions: [] });
  const ok = trades.find((t) => !t.rejected);
  assert.ok(ok, 'A(守備軽視)の守備型SSと B(守備重視)の強打SSが双方winで成立');
  assert.equal(Xa.teamId, 'B', '守備型SSは守備を重める球団へ');
  assert.equal(Xb.teamId, 'A', '強打SSは打撃を重める球団へ');
  // 片方のみ得（両球団とも守備軽視）→ 不成立。
  const Ya = defSS('YA', 'A');
  const Yb = slugSS('YB', 'B');
  const league2 = miniLeague([Ya, Yb]);
  const trades2 = runTrades(league2, c, { profiles: new Map([['A', DEF_BLIND], ['B', DEF_BLIND]]), masterSeed: 1, yearIndex: 1, interventions: [] });
  assert.equal(trades2.filter((t) => !t.rejected).length, 0, '双方winでなければ不成立');
  assert.equal(Ya.teamId, 'A', '不成立なら選手は動かない');
});

test('C3b: プレイヤー起案トレードを AI が自評価で受諾/拒否（介入ログで再現）', () => {
  const c = openCfg();
  // 受諾: 相手B(守備重視)は守備型SS(Xa)を強打SS(Xb)より高評価 → 受ける。
  const Xa = defSS('PA', 'A');
  const Xb = slugSS('PB', 'B');
  const league = miniLeague([Xa, Xb]);
  const iv = [{ phase: 'trade', yearIndex: 1, aTeam: 'A', aPlayer: 'PA', bTeam: 'B', bPlayer: 'PB' }];
  const t1 = runTrades(league, c, { profiles: new Map([['A', DEF_BLIND], ['B', DEF_SMART]]), masterSeed: 1, yearIndex: 1, interventions: iv });
  assert.ok(t1.some((t) => t.via === 'player' && !t.rejected), 'AIが得なら起案トレード成立');
  assert.equal(Xa.teamId, 'B', '起案成立で選手が移動');
  // 拒否: 相手B(守備軽視)は守備型SSを欲しがらない → 拒否（ログのみ・不動）。
  const Za = defSS('QA', 'A');
  const Zb = slugSS('QB', 'B');
  const league2 = miniLeague([Za, Zb]);
  const t2 = runTrades(league2, c, { profiles: new Map([['A', DEF_BLIND], ['B', DEF_BLIND]]), masterSeed: 1, yearIndex: 1, interventions: [{ phase: 'trade', yearIndex: 1, aTeam: 'A', aPlayer: 'QA', bTeam: 'B', bPlayer: 'QB' }] });
  assert.ok(t2.some((t) => t.via === 'player' && t.rejected), 'AIが損なら起案トレード拒否');
  assert.equal(Za.teamId, 'A', '拒否なら選手は動かない');
});

test('C3b: 戦力外→拾い上げ — 少なく歪んだ観測で切られ、査定違う球団が拾い観測が改善（板山/上林型・§12.2）', () => {
  const { agg } = RUN;
  assert.ok(agg.pickups > 0, `20年で戦力外→拾い上げが起きる（${agg.pickups}）`);
  // 稀に観測改善（切られた時の観測貢献より、拾われた翌季以降の観測貢献が上回る）が出る。
  assert.ok(agg.recoveries > 0, `拾い上げ後に観測が改善する例が出る（${agg.recoveries}/${agg.pickups}）＝余所では生きる`);
  // 放出は "観測" で歪む: 少PA（未確立=上林型）は観測貢献が高くても戦力外スコアが沈む。
  const b = createPlayer({ id: 'FEW', role: 'fielder', primaryPos: 'CF' });
  b.age = 29;
  const obsFew = new Map([['FEW', { batting: { pa: 40, ab: 36, h: 12, b1: 8, b2: 3, b3: 0, hr: 1, bb: 4, hbp: 0, so: 6, sf: 0, ibb: 0 } }]]);
  const obsFull = new Map([['FEW', { batting: { pa: 500, ab: 450, h: 150, b1: 100, b2: 37, b3: 3, hr: 10, bb: 45, hbp: 5, so: 70, sf: 5, ibb: 2 } }]]);
  const sFew = releaseScore(b, obsFew, cfg);
  const sFull = releaseScore(b, obsFull, cfg);
  assert.ok(sFew < sFull, `同等の好打率でも少PAは戦力外スコアが低い（few ${sFew.toFixed(1)} < full ${sFull.toFixed(1)}）＝出場機会依存で歪む`);
});

test('C3b: 決定論 — 同一シードの市場が bit 一致／別シードは別運命', () => {
  const a = runYears(SEED, YEARS);
  assert.equal(a.agg.sig.join(';'), RUN.agg.sig.join(';'), '市場イベント列が一致');
  assert.equal(a.agg.fa, RUN.agg.fa, 'FA数一致');
  assert.equal(a.agg.trades, RUN.agg.trades, 'トレード数一致');
  assert.equal(a.agg.pickups, RUN.agg.pickups, '拾い上げ数一致');
  const b = runYears(SEED + 7, YEARS);
  assert.notEqual(b.agg.sig.join(';'), RUN.agg.sig.join(';'), '別シードは別の市場');
});

test('C3b: save-load で市場介入（トレード起案）が再現される', () => {
  // 1年通し、トレード起案をログ→save→load→advanceYear、両者で同一結果。
  const mk = (seedTeam) => {
    const s = newGame(SEED, 'T1', { cfg });
    advanceTo(s, 'seasonEnd');
    // 自チームの野手2人を相手チームの同型野手と交換起案（成否は問わず「ログが再現される」ことを見る）。
    const mine = s.league.players.find((p) => p.teamId === 'T1' && p.role === 'fielder');
    const other = s.league.players.find((p) => p.teamId !== 'T1' && p.role === 'fielder' && p.primaryPos === mine.primaryPos);
    proposeTrade(s, mine.id, other.id);
    return s;
  };
  const straight = mk();
  const blob = JSON.parse(JSON.stringify(save(straight)));
  assert.ok(blob.marketInterventions.length >= 1, 'セーブに市場介入ログが含まれる');
  const restored = load(blob, { cfg });
  assert.equal(restored.marketInterventions.length, straight.marketInterventions.length, '介入ログが復元される');
  const offS = advanceYear(straight);
  const offR = advanceYear(restored);
  const sig = (off) => `${off.trades.map((t) => `${t.aPlayer}>${t.bPlayer}:${t.via}:${t.rejected ? 'x' : 'o'}`).sort().join('|')}`;
  assert.equal(sig(offR), sig(offS), 'load 後のトレード解決が無セーブ通しと一致（介入再現）');
});

test('C3b: 多年でリーグ人口・ロスター構成が恒常（全移動が同型1:1スワップ/循環）', () => {
  const P = RUN.st.league.players;
  const R = cfg.tuning.roster;
  assert.equal(P.length, cfg.league.numTeams * R.controlledPerTeam, '支配下人口は恒常');
  for (const t of RUN.st.league.teams) {
    const roster = P.filter((p) => p.teamId === t.id);
    const nPit = roster.filter((p) => p.role === 'pitcher').length;
    assert.equal(roster.length, R.controlledPerTeam, `${t.id} は支配下70人`);
    assert.ok(nPit >= R.pitchersMin && nPit <= R.pitchersMax, `${t.id} は投手33-36（${nPit}）`);
  }
  // FA/トレード/拾い上げを経ても育成 minor は支配下に混ざらない。
  assert.ok(P.every((p) => p.rosterStatus === 'active'), '支配下は全員 active');
});

test('C3b: 1年目（既存50較正相当）はオフシーズン前＝市場ゼロ（エンジン不変の担保）', () => {
  const st = newGame(SEED, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  assert.equal(st.yearIndex, 0, '1年目のまま（advanceYear 前は市場なし）');
  assert.equal(st.marketInterventions.length, 0, '市場介入ゼロ');
  // 1年目終了時点で FA/トレード/戦力外は一切走っていない（オフシーズン遷移が未実行）。
  assert.equal(st.league.players.length, cfg.league.numTeams * cfg.tuning.roster.controlledPerTeam, '1年目ロスターは生成時のまま');
});

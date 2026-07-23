// ============================================================================
// P4: 戦力外・FAの感情演出（fun_theory_research_20260720 P4）のテスト。
//   - veteranFarewellHeadlines: 「功労者」判定の分岐（在籍年数/通算安打/通算勝利いずれか閾値超）
//     ＋対象外（他球団への戦力外・功労者未満）は出ない。数値（in/out判定の元データ）は変えない。
//   - departedPlayerFollowUpHeadlines: 前年に自チームを出た選手（fa/trade/pickup）が当季活躍して
//     いる場合だけ後日談が出る（打者=wOBA、投手=FIPの代替水準比較）。年がずれていれば対象外。
//   - 決定論: 同一入力は同一出力（テンプレ選択は hashSeed 独立座標）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { veteranFarewellHeadlines, departedPlayerFollowUpHeadlines } from '../src/game/storylines.mjs';

const cfg = createConfig();

function batLine(o) {
  return { pa: 0, ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, so: 0, sf: 0, sb: 0, cs: 0, rbi: 0, ibb: 0, ...o };
}
function pitLine(o) {
  return { outs: 0, bf: 0, h: 0, hr: 0, bb: 0, ibb: 0, hbp: 0, so: 0, er: 0, r: 0, w: 0, l: 0, sv: 0, hld: 0, g: 0, gs: 0, ...o };
}
function careerRow(playerId, teamId, season, o = {}) {
  return { playerId, teamId, season, batting: o.batting ?? null, pitching: o.pitching ?? null, baserunning: {}, fielding: { positionOuts: {} } };
}
function baseState(o = {}) {
  return {
    cfg, masterSeed: 4242, year: 2035, careerStats: [], transactionLog: [],
    league: { players: [], farm: [] }, teamHistory: [], awardsHistory: [],
    rt: { schedule: [], playerGameLog: [], stats: { stats: new Map() }, finished: false },
    ...o,
  };
}
const names = { pnameOf: (id) => id, tnameOf: (id) => id };

// --- veteranFarewellHeadlines -----------------------------------------------

test('P4: veteranFarewellHeadlines — 在籍5年以上の野手は功労者として演出見出しになる', () => {
  const careerStats = [2030, 2031, 2032, 2033, 2034].map((y) => careerRow('P1', 'T1', y, { batting: batLine({ pa: 400, ab: 380, h: 100 }) }));
  const st = baseState({ careerStats });
  const off = { pickups: [{ playerId: 'P1', from: 'T1', to: 'T2', role: 'fielder', reason: 'score' }] };
  const heads = veteranFarewellHeadlines(st, off, 2034, 'T1', names);
  assert.equal(heads.length, 1, '在籍5年の功労者は1件見出しが出る');
  assert.equal(heads[0].playerId, 'P1');
  assert.equal(heads[0].cls, 'bad');
  assert.match(heads[0].text, /在籍5年/, '在籍年数が見出しに含まれる');
});

test('P4: veteranFarewellHeadlines — 在籍が短くても通算800安打/80勝なら功労者扱い', () => {
  const battingHeavy = [careerRow('H1', 'T1', 2034, { batting: batLine({ pa: 4000, ab: 3800, h: 850 }) })]; // 在籍1年扱いだがh>=800
  const stB = baseState({ careerStats: battingHeavy });
  const offB = { pickups: [{ playerId: 'H1', from: 'T1', to: 'T2', role: 'fielder', reason: 'score' }] };
  assert.equal(veteranFarewellHeadlines(stB, offB, 2034, 'T1', names).length, 1, '通算800安打は功労者扱い');

  const pitchingHeavy = [careerRow('W1', 'T1', 2034, { pitching: pitLine({ outs: 3000, w: 85, l: 40, sv: 0 }) })];
  const stP = baseState({ careerStats: pitchingHeavy });
  const offP = { pickups: [{ playerId: 'W1', from: 'T1', to: 'T2', role: 'pitcher', reason: 'budget' }] };
  assert.equal(veteranFarewellHeadlines(stP, offP, 2034, 'T1', names).length, 1, '通算80勝は功労者扱い');
});

test('P4: veteranFarewellHeadlines — 在籍が短く通算成績も小さい選手、他球団への戦力外は対象外', () => {
  const careerStats = [careerRow('S1', 'T1', 2034, { batting: batLine({ pa: 300, ab: 280, h: 70 }) })];
  const st = baseState({ careerStats });
  const off = { pickups: [{ playerId: 'S1', from: 'T1', to: 'T2', role: 'fielder', reason: 'score' }] };
  assert.equal(veteranFarewellHeadlines(st, off, 2034, 'T1', names).length, 0, '在籍1年・通算成績も小さい選手は対象外');

  const offOther = { pickups: [{ playerId: 'P1', from: 'T3', to: 'T2', role: 'fielder', reason: 'score' }] };
  assert.equal(veteranFarewellHeadlines(st, offOther, 2034, 'T1', names).length, 0, '他球団からの戦力外はmyTeamId視点で対象外');
});

test('P4: veteranFarewellHeadlines — 決定論（同一入力は同一テキスト）', () => {
  const careerStats = [2030, 2031, 2032, 2033, 2034].map((y) => careerRow('P1', 'T1', y, { batting: batLine({ pa: 400, ab: 380, h: 100 }) }));
  const st = baseState({ careerStats });
  const off = { pickups: [{ playerId: 'P1', from: 'T1', to: 'T2', role: 'fielder', reason: 'score' }] };
  const a = veteranFarewellHeadlines(st, off, 2034, 'T1', names);
  const b = veteranFarewellHeadlines(st, off, 2034, 'T1', names);
  assert.deepEqual(a, b, '同一入力は同一見出し');
});

// --- departedPlayerFollowUpHeadlines ----------------------------------------

test('P4: departedPlayerFollowUpHeadlines — 前年戦力外(pickup)で出た野手が当季活躍していれば後日談が出る', () => {
  const stats = new Map([['D1', { batting: batLine({ pa: 300, ab: 260, h: 100, b1: 60, b2: 15, b3: 5, hr: 20, bb: 30 }) }]]); // 高wOBA
  const st = baseState({
    transactionLog: [{ year: 2034, kind: 'pickup', playerId: 'D1', from: 'T1', to: 'T2' }],
    rt: { schedule: [], playerGameLog: [], stats: { stats }, finished: false },
  });
  const heads = departedPlayerFollowUpHeadlines(st, 'T1', names);
  assert.equal(heads.length, 1, '活躍していれば1件出る');
  assert.equal(heads[0].playerId, 'D1');
});

test('P4: departedPlayerFollowUpHeadlines — 打席/wOBAが基準未満なら後日談は出ない', () => {
  const lowPa = new Map([['D2', { batting: batLine({ pa: 50, ab: 45, h: 15 }) }]]); // 規定未満
  const st1 = baseState({
    transactionLog: [{ year: 2034, kind: 'fa', playerId: 'D2', from: 'T1', to: 'T2' }],
    rt: { schedule: [], playerGameLog: [], stats: { stats: lowPa }, finished: false },
  });
  assert.equal(departedPlayerFollowUpHeadlines(st1, 'T1', names).length, 0, '打席が少なすぎれば対象外');

  const badWoba = new Map([['D3', { batting: batLine({ pa: 300, ab: 290, h: 40 }) }]]); // 低打率・低wOBA
  const st2 = baseState({
    transactionLog: [{ year: 2034, kind: 'fa', playerId: 'D3', from: 'T1', to: 'T2' }],
    rt: { schedule: [], playerGameLog: [], stats: { stats: badWoba }, finished: false },
  });
  assert.equal(departedPlayerFollowUpHeadlines(st2, 'T1', names).length, 0, 'wOBAが代替水準を上回らなければ対象外');
});

test('P4: departedPlayerFollowUpHeadlines — 投手はFIPで判定（代替水準を大きく下回れば活躍扱い）', () => {
  const goodPitcher = new Map([['D4', { pitching: pitLine({ outs: 180, hr: 0, bb: 5, so: 100 }) }]]); // 好FIP
  const st1 = baseState({
    transactionLog: [{ year: 2034, kind: 'trade', playerId: 'D4', playerId2: 'X', from: 'T1', to: 'T2' }],
    rt: { schedule: [], playerGameLog: [], stats: { stats: goodPitcher }, finished: false },
  });
  assert.equal(departedPlayerFollowUpHeadlines(st1, 'T1', names).length, 1, '好FIPの投手は後日談が出る');

  const badPitcher = new Map([['D5', { pitching: pitLine({ outs: 180, hr: 20, bb: 40, so: 10 }) }]]);
  const st2 = baseState({
    transactionLog: [{ year: 2034, kind: 'trade', playerId: 'D5', playerId2: 'X', from: 'T1', to: 'T2' }],
    rt: { schedule: [], playerGameLog: [], stats: { stats: badPitcher }, finished: false },
  });
  assert.equal(departedPlayerFollowUpHeadlines(st2, 'T1', names).length, 0, '不振の投手は対象外');
});

test('P4: departedPlayerFollowUpHeadlines — トレードで自チームに来た選手(playerId本体)は対象外・実際に出た方(playerId2)だけ対象', () => {
  const stats = new Map([['D4', { pitching: pitLine({ outs: 180, hr: 0, bb: 5, so: 100 }) }]]);
  // row: playerId='D4' は from(T2)→to(T1) ＝ myTeamId(T1) に「来た」側。playerId2='X' が myTeamId を
  // 「出た」側（row.to(T1)→row.from(T2)）。X の観測データが無いので0件＝D4(来た側)は対象にならない。
  const stArrive = baseState({
    transactionLog: [{ year: 2034, kind: 'trade', playerId: 'D4', playerId2: 'X', from: 'T2', to: 'T1' }],
    rt: { schedule: [], playerGameLog: [], stats: { stats }, finished: false },
  });
  assert.equal(departedPlayerFollowUpHeadlines(stArrive, 'T1', names).length, 0, '来た選手(playerId本体)は対象外');

  // row: playerId='X' は from(T3)→to(T1)＝myTeamIdに来た側。playerId2='D4' は row.to(T1)→row.from(T3)
  // ＝myTeamIdを「出た」側。D4の好成績データがあるので1件＝出た側だけ対象になる。
  const stDepart = baseState({
    transactionLog: [{ year: 2034, kind: 'trade', playerId: 'X', playerId2: 'D4', from: 'T3', to: 'T1' }],
    rt: { schedule: [], playerGameLog: [], stats: { stats }, finished: false },
  });
  const heads = departedPlayerFollowUpHeadlines(stDepart, 'T1', names);
  assert.equal(heads.length, 1, 'row.to===myTeamId のとき playerId2 は myTeamId を出た側＝対象');
  assert.equal(heads[0].playerId, 'D4');
});

test('P4: departedPlayerFollowUpHeadlines — 年がずれた行（前年以外）は対象外。決定論', () => {
  const stats = new Map([['D1', { batting: batLine({ pa: 300, ab: 260, h: 100, hr: 20, bb: 30 }) }]]);
  const stOld = baseState({
    transactionLog: [{ year: 2033, kind: 'pickup', playerId: 'D1', from: 'T1', to: 'T2' }], // 前年(2034)ではない
    rt: { schedule: [], playerGameLog: [], stats: { stats }, finished: false },
  });
  assert.equal(departedPlayerFollowUpHeadlines(stOld, 'T1', names).length, 0, '前年以外の移籍は対象外');

  const st = baseState({
    transactionLog: [{ year: 2034, kind: 'pickup', playerId: 'D1', from: 'T1', to: 'T2' }],
    rt: { schedule: [], playerGameLog: [], stats: { stats }, finished: false },
  });
  const a = departedPlayerFollowUpHeadlines(st, 'T1', names);
  const b = departedPlayerFollowUpHeadlines(st, 'T1', names);
  assert.deepEqual(a, b, '同一入力は同一見出し（決定論）');
});

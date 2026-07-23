// ============================================================================
// P3: 週次目標（短期目標の階層・fun_theory_research_20260720 P3）のテスト。
//   - generateWeeklyGoal: 決定論・週の文脈と整合するテンプレ選択（理不尽な目標を出さない）
//   - evaluateWeeklyGoal: 達成判定の分岐（weekWinning/cardWinning/stopStreak/monthPace）
//   - recordCompletedWeeklyGoals: フラグOFF時は state.weeklyGoalLog を一切変えない（headless不変）。
//     フラグON時は週境界ごとに決定論で記録され、同一シードで再現する。
//   - weeklyGoalTrustBonus: フラグOFF/対象週0件は0。達成率に応じた小さなボーナス（上限cap）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceDay, advanceYear, save, load } from '../src/game/index.mjs';
import {
  generateWeeklyGoal, evaluateWeeklyGoal, recordCompletedWeeklyGoals, weeklyGoalTrustBonus,
} from '../src/game/goals.mjs';

const SEED = 20260723;

/** 合成 GameState フィクスチャ（rt.schedule/rt.playerGameLog を直接構成する）。 */
function fakeState(o = {}) {
  const cfg = o.cfg ?? createConfig();
  return {
    cfg, masterSeed: 777, year: 2030, playerTeamId: 'T1',
    weeklyGoalLog: [],
    rt: { schedule: [], playerGameLog: [], cursor: 0, finished: false },
    ...o,
  };
}
/** day に自チーム(T1)対oppの試合（rt.schedule用）。 */
function schedGame(day, opp, home = true) {
  return home ? { home: 'T1', away: opp, day } : { home: opp, away: 'T1', day };
}
/** day に自チーム(T1)対oppの消化済み試合結果（rt.playerGameLog用）。win: 自チーム視点の勝敗。 */
function playedGame(day, opp, win) {
  return { day, home: 'T1', away: opp, homeScore: win ? 5 : 2, awayScore: win ? 2 : 5, tie: false };
}

// --- generateWeeklyGoal ------------------------------------------------------

test('P3: generateWeeklyGoal — rt/playerTeamId が無い、または週内に自チーム試合が無ければ null', () => {
  assert.equal(generateWeeklyGoal({ cfg: createConfig() }, 0), null, 'rt が無い');
  const st = fakeState({ playerTeamId: null });
  assert.equal(generateWeeklyGoal(st, 0), null, 'playerTeamId が無い');
  const st2 = fakeState({ rt: { schedule: [schedGame(10, 'T2')], playerGameLog: [], finished: false } });
  assert.equal(generateWeeklyGoal(st2, 0), null, '週0(day0-6)に自チーム試合が無ければnull（day10はweek1）');
});

test('P3: generateWeeklyGoal — 文脈が無ければ常に weekWinning（プールが1件のみ＝理不尽な目標を出さない）', () => {
  // カード無し（対戦相手が毎日違う）・連敗無し（ログ空）・月境界と交差しない週（既定daysPerMonth=26）。
  const schedule = [schedGame(0, 'T2'), schedGame(1, 'T3'), schedGame(2, 'T4'), schedGame(3, 'T5'), schedGame(4, 'T6')];
  const st = fakeState({ rt: { schedule, playerGameLog: [], finished: false } });
  for (let seed = 0; seed < 20; seed++) {
    const goal = generateWeeklyGoal({ ...st, masterSeed: seed }, 0);
    assert.equal(goal.type, 'weekWinning', `文脈テンプレが無い週は常にweekWinning（seed=${seed}）`);
  }
});

test('P3: generateWeeklyGoal — 決定論（同一入力は同一出力）', () => {
  const schedule = [schedGame(0, 'T2'), schedGame(1, 'T2'), schedGame(2, 'T3')];
  const st = fakeState({ rt: { schedule, playerGameLog: [], finished: false } });
  const a = generateWeeklyGoal(st, 0);
  const b = generateWeeklyGoal(st, 0);
  assert.deepEqual(a, b, '同一state/weekは同一目標');
});

test('P3: generateWeeklyGoal — 週内に同一対戦相手が2試合以上あるときだけ cardWinning が候補に入る', () => {
  const schedule = [schedGame(0, 'T2'), schedGame(1, 'T2'), schedGame(2, 'T2'), schedGame(3, 'T4')];
  const types = new Set();
  for (let seed = 0; seed < 40; seed++) {
    const st = fakeState({ masterSeed: seed, rt: { schedule, playerGameLog: [], finished: false } });
    const goal = generateWeeklyGoal(st, 0);
    types.add(goal.type);
    if (goal.type === 'cardWinning') {
      assert.equal(goal.param.opp, 'T2', 'カード相手はT2（3試合の最頻対戦）');
      assert.equal(goal.param.games, 3, 'カードの試合数は3');
    }
  }
  assert.ok(types.has('cardWinning'), 'カードが存在する週は cardWinning が候補に入り選ばれうる');
});

test('P3: generateWeeklyGoal — 連敗中（>=2）のときだけ stopStreak が候補に入る。連敗が無ければ出さない', () => {
  const schedule = [schedGame(7, 'T2'), schedGame(8, 'T3')]; // week1 = day7-13
  const priorLosses = [playedGame(4, 'T2', false), playedGame(5, 'T2', false), playedGame(6, 'T2', false)]; // week1開始前に3連敗
  const types = new Set();
  for (let seed = 0; seed < 40; seed++) {
    const st = fakeState({ masterSeed: seed, rt: { schedule, playerGameLog: priorLosses, finished: false } });
    const goal = generateWeeklyGoal(st, 1);
    types.add(goal.type);
    if (goal.type === 'stopStreak') assert.equal(goal.param.streak, 3, '連敗数は3');
  }
  assert.ok(types.has('stopStreak'), '3連敗中の週はstopStreakが候補に入り選ばれうる');

  // 連敗が無い（直近が勝ち）場合は理不尽な目標として一切出さない
  const noStreak = fakeState({ rt: { schedule, playerGameLog: [playedGame(6, 'T2', true)], finished: false } });
  for (let seed = 0; seed < 20; seed++) {
    const goal = generateWeeklyGoal({ ...noStreak, masterSeed: seed }, 1);
    assert.notEqual(goal.type, 'stopStreak', '連敗していない週にstopStreakを出さない');
  }
});

test('P3: generateWeeklyGoal — 月の最終週（境界と交差）のときだけ monthPace が候補に入る', () => {
  const cfg = createConfig();
  cfg.game.daysPerWeek = 7;
  cfg.game.daysPerMonth = 7; // week0の終わり(day7)が月境界と一致＝week0は月内の最終週
  const schedule = [schedGame(0, 'T2'), schedGame(1, 'T3')];
  const types = new Set();
  for (let seed = 0; seed < 20; seed++) {
    const st = fakeState({ cfg, masterSeed: seed, rt: { schedule, playerGameLog: [], finished: false } });
    types.add(generateWeeklyGoal(st, 0).type);
  }
  assert.ok(types.has('monthPace'), '月の最終週はmonthPaceが候補に入り選ばれうる');

  // daysPerMonth=26（既定）なら week0(day0-6) は月末に届かない＝monthPaceは出ない
  const stDefault = fakeState({ rt: { schedule, playerGameLog: [], finished: false } });
  for (let seed = 0; seed < 20; seed++) {
    assert.notEqual(generateWeeklyGoal({ ...stDefault, masterSeed: seed }, 0).type, 'monthPace', '月末でない週にmonthPaceを出さない');
  }
});

// --- evaluateWeeklyGoal ------------------------------------------------------

test('P3: evaluateWeeklyGoal — weekWinning は週内の勝敗数で判定（引き分けはどちらにも数えない）', () => {
  const st = fakeState({ rt: { schedule: [], playerGameLog: [playedGame(0, 'T2', true), playedGame(1, 'T2', true), playedGame(2, 'T2', false)], finished: false } });
  const r = evaluateWeeklyGoal(st, { type: 'weekWinning' }, 0);
  assert.equal(r.achieved, true, '2勝1敗は勝ち越し達成');
  const st2 = fakeState({ rt: { schedule: [], playerGameLog: [playedGame(0, 'T2', false), playedGame(1, 'T2', false), playedGame(2, 'T2', true)], finished: false } });
  assert.equal(evaluateWeeklyGoal(st2, { type: 'weekWinning' }, 0).achieved, false, '1勝2敗は未達');
});

test('P3: evaluateWeeklyGoal — cardWinning は指定球団との対戦だけを集計する', () => {
  const games = [
    playedGame(0, 'T2', true), playedGame(1, 'T2', true), playedGame(2, 'T2', false), // T2: 2勝1敗
    playedGame(3, 'T4', false), playedGame(4, 'T4', false), // T4: 0勝2敗（対象外）
  ];
  const st = fakeState({ rt: { schedule: [], playerGameLog: games, finished: false } });
  const r = evaluateWeeklyGoal(st, { type: 'cardWinning', param: { opp: 'T2', games: 3 } }, 0);
  assert.equal(r.achieved, true, 'T2戦だけ見れば2勝1敗で達成');
  assert.equal(r.actual, '2勝1敗');
});

test('P3: evaluateWeeklyGoal — stopStreak は週内に1勝でもあれば達成（連敗を伸ばさなかった）', () => {
  const stWin = fakeState({ rt: { schedule: [], playerGameLog: [playedGame(0, 'T2', false), playedGame(1, 'T2', true)], finished: false } });
  assert.equal(evaluateWeeklyGoal(stWin, { type: 'stopStreak', param: { streak: 3 } }, 0).achieved, true);
  const stLose = fakeState({ rt: { schedule: [], playerGameLog: [playedGame(0, 'T2', false), playedGame(1, 'T2', false)], finished: false } });
  assert.equal(evaluateWeeklyGoal(stLose, { type: 'stopStreak', param: { streak: 3 } }, 0).achieved, false);
});

test('P3: evaluateWeeklyGoal — monthPace は月初からの累計勝率で判定（境界は>=0.5）', () => {
  const games5050 = [playedGame(0, 'T2', true), playedGame(1, 'T2', true), playedGame(2, 'T2', false), playedGame(3, 'T2', false)];
  const st = fakeState({ rt: { schedule: [], playerGameLog: games5050, finished: false } });
  const r = evaluateWeeklyGoal(st, { type: 'monthPace' }, 0);
  assert.equal(r.achieved, true, '勝率ちょうど.500は達成（>=）');
  const gamesLose = games5050.concat([playedGame(4, 'T2', false)]);
  const st2 = fakeState({ rt: { schedule: [], playerGameLog: gamesLose, finished: false } });
  assert.equal(evaluateWeeklyGoal(st2, { type: 'monthPace' }, 0).achieved, false, '勝率.500未満は未達');
});

// --- recordCompletedWeeklyGoals（フラグゲート・決定論） ---------------------

test('P3: フラグOFFのheadless経路（advanceDay）は state.weeklyGoalLog を一切変えない', () => {
  const cfg = createConfig(); // weeklyGoals 既定 false
  const st = newGame(SEED, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  assert.deepEqual(st.weeklyGoalLog, [], 'フラグOFFなら週次目標ログは常に空');
});

test('P3: フラグONで advanceDay を通すと週境界ごとに決定論で記録され、同一シードで再現する', () => {
  const cfg1 = createConfig();
  cfg1.game.weeklyGoals = true;
  const st1 = newGame(SEED, 'T1', { cfg: cfg1 });
  advanceTo(st1, 'seasonEnd');
  assert.ok(st1.weeklyGoalLog.length > 0, 'フラグONなら週次目標ログが積まれる');
  const weekKeys = st1.weeklyGoalLog.map((e) => `${e.year}-${e.week}`);
  assert.equal(new Set(weekKeys).size, weekKeys.length, '同一(year,week)の重複記録が無い');
  assert.ok(st1.weeklyGoalLog.every((e) => e.year === st1.firstSeason), '記録された年は開幕年のまま（1年目）');

  const cfg2 = createConfig();
  cfg2.game.weeklyGoals = true;
  const st2 = newGame(SEED, 'T1', { cfg: cfg2 });
  advanceTo(st2, 'seasonEnd');
  assert.deepEqual(st2.weeklyGoalLog, st1.weeklyGoalLog, '同一シードは同一の週次目標ログ（決定論）');
});

test('P3: recordCompletedWeeklyGoals はシーズン終了時に端数週も確定する（rt.finished）', () => {
  const cfg = createConfig();
  cfg.game.weeklyGoals = true;
  const st = newGame(SEED + 1, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  const lastDay = st.rt.playerGameLog.length ? st.rt.playerGameLog[st.rt.playerGameLog.length - 1].day : 0;
  const lastWeek = Math.floor(lastDay / cfg.game.daysPerWeek);
  assert.ok(st.weeklyGoalLog.some((e) => e.week === lastWeek), '最終節を含む端数週も記録される');
});

test('P3: save/load で週次目標ログが永続する（additive・旧セーブは[]補完）', () => {
  const cfg = createConfig();
  cfg.game.weeklyGoals = true;
  const st = newGame(SEED + 2, 'T1', { cfg });
  advanceDay(st); // 1日だけ進める（週の途中）
  const blob = JSON.parse(JSON.stringify(save(st)));
  assert.ok(Array.isArray(blob.weeklyGoalLog), 'save に weeklyGoalLog が含まれる');
  const restored = load(blob, { cfg: createConfig() });
  assert.deepEqual(restored.weeklyGoalLog, st.weeklyGoalLog, 'load で同一のログが復元される');
  delete blob.weeklyGoalLog;
  const old = load(blob, { cfg: createConfig() });
  assert.deepEqual(old.weeklyGoalLog, [], '旧セーブ（フィールド無し）は[]補完');
});

// --- weeklyGoalTrustBonus ----------------------------------------------------

test('P3: weeklyGoalTrustBonus — フラグOFF、または対象年の記録が0件なら0', () => {
  const cfgOff = createConfig(); // weeklyGoals 既定false
  const st = fakeState({ cfg: cfgOff, weeklyGoalLog: [{ year: 2030, week: 0, achieved: true }] });
  assert.equal(weeklyGoalTrustBonus(st), 0, 'フラグOFFなら常に0');

  const cfgOn = createConfig();
  cfgOn.game.weeklyGoals = true;
  const stEmpty = fakeState({ cfg: cfgOn, weeklyGoalLog: [] });
  assert.equal(weeklyGoalTrustBonus(stEmpty), 0, '記録が0件なら0');
});

test('P3: weeklyGoalTrustBonus — 達成率に比例し、上限は cfg.game.weeklyGoalTrustBonusMax', () => {
  const cfg = createConfig();
  cfg.game.weeklyGoals = true;
  const full = fakeState({
    cfg,
    weeklyGoalLog: [
      { year: 2030, week: 0, achieved: true }, { year: 2030, week: 1, achieved: true },
      { year: 2029, week: 0, achieved: false }, // 別年は対象外
    ],
  });
  assert.equal(weeklyGoalTrustBonus(full), cfg.game.weeklyGoalTrustBonusMax, '達成率100%は上限ボーナス');

  const half = fakeState({
    cfg,
    weeklyGoalLog: [{ year: 2030, week: 0, achieved: true }, { year: 2030, week: 1, achieved: false }],
  });
  assert.equal(weeklyGoalTrustBonus(half), Math.round(0.5 * cfg.game.weeklyGoalTrustBonusMax), '達成率50%は半分程度');
});

test('P3: 週次目標達成率ボーナスは owner.mjs の trustDelta と同じ合流点で加算される（advanceYear経由の回帰確認）', () => {
  const cfgA = createConfig();
  cfgA.game.allowFiring = false;
  cfgA.game.weeklyGoals = true;
  const stA = newGame(SEED + 3, 'T1', { cfg: cfgA });
  advanceTo(stA, 'seasonEnd');
  advanceYear(stA); // yearIndex 0→1（目標なし年・非干渉）
  advanceTo(stA, 'seasonEnd'); // 2年目終了
  // advanceYear直前に、2年目ぶんの週次目標を「全達成」で上書き（standings等は変えない＝比較対象と同一）。
  const y2 = stA.year;
  stA.weeklyGoalLog = stA.weeklyGoalLog.filter((e) => e.year !== y2).concat([{ year: y2, week: 0, achieved: true }]);
  const trustBefore = stA.ownerTrust;
  advanceYear(stA);
  const deltaWithBonus = stA.ownerTrust - trustBefore;

  // 同一シードの双子: 2年目ぶんの週次目標ログを空にした場合（=ボーナス0）と比較する。
  const cfgB = createConfig();
  cfgB.game.allowFiring = false;
  cfgB.game.weeklyGoals = true;
  const stB = newGame(SEED + 3, 'T1', { cfg: cfgB });
  advanceTo(stB, 'seasonEnd');
  advanceYear(stB);
  advanceTo(stB, 'seasonEnd');
  stB.weeklyGoalLog = stB.weeklyGoalLog.filter((e) => e.year !== y2); // 2年目ぶんを空に＝ボーナス0
  const trustBeforeB = stB.ownerTrust;
  advanceYear(stB);
  const deltaNoBonus = stB.ownerTrust - trustBeforeB;

  assert.equal(deltaWithBonus - deltaNoBonus, cfgA.game.weeklyGoalTrustBonusMax, '週次目標全達成ぶん、上限ボーナスだけ信任が余計に増える');
});

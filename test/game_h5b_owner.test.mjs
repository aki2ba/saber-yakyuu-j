// ============================================================================
// H5-B: オーナー目標・信任・解任のテスト（phaseH_fun_spec H5-B）。
//   - 目標生成の決定論と窓状態との整合（rebuilding に優勝/Aクラスを要求しない）
//   - 達成判定の境界（純関数）
//   - 解任イベント: 中断→resolveOwnerDecision（transfer/plea）→オフ処理続行
//   - allowFiring=false で解任なし／save-load での信任保存・目標の決定論再生成
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, resolveOwnerDecision, save, load } from '../src/game/index.mjs';
import { generateOwnerGoals, evaluateOwnerGoals, ownerLeagueRankOf, pickTransferOffer } from '../src/game/owner.mjs';

const SEED = 20260714;

/** 合成順位表（同一リーグ6球団・勝率降順で並べた w を与える）。 */
function synthStandings(ws) {
  return ws.map((w, i) => ({ teamId: `T${i + 1}`, league: 'L1', w, l: 140 - w }));
}
/** 合成 teamHistory（T1 の勝数列から。他5球団は70勝で埋める）。 */
function synthHistory(winsByYear) {
  return winsByYear.map((w, i) => ({
    year: 2027 + i,
    standings: [{ teamId: 'T1', league: 'L1', w, l: 140 - w }, ...[2, 3, 4, 5, 6].map((n) => ({ teamId: `T${n}`, league: 'L1', w: 70, l: 70 }))],
  }));
}
const SYNTH_LEAGUE = { teams: [{ id: 'T1' }], players: [] };

test('H5-B: 目標生成は決定論で、窓状態と整合する（rebuildingに優勝/Aクラスを要求しない）', () => {
  const cfg = createConfig();
  const base = { masterSeed: SEED, yearIndex: 3, teamId: 'T1', league: SYNTH_LEAGUE, cfg };
  // rebuilding（2年連続大敗）: champion/rank 目標が出ない
  const reb = generateOwnerGoals({ ...base, teamHistory: synthHistory([50, 48]) });
  assert.ok(reb.length >= 1, 'rebuilding でも目標は出る');
  assert.ok(reb.every((g) => g.type !== 'champion' && g.type !== 'rank'), 'rebuilding に優勝/Aクラス目標が出ない');
  // contending（前年優勝級）: youthPA 単独目標にならない・優勝/Aクラス系が入りうる
  const con = generateOwnerGoals({ ...base, teamHistory: synthHistory([90, 92]) });
  assert.ok(con.every((g) => g.type !== 'youthPA'), 'contending に若手起用目標が出ない');
  // 決定論: 同一入力は同一出力・別年は変わりうる
  assert.deepEqual(reb, generateOwnerGoals({ ...base, teamHistory: synthHistory([50, 48]) }), '同一入力は同一目標');
  // yearIndex 0 は目標なし（1年目非干渉）
  assert.deepEqual(generateOwnerGoals({ ...base, yearIndex: 0, teamHistory: [] }), [], '1年目は目標なし');
});

test('H5-B: 達成判定の境界（rank/winPct/ownerLeagueRankOf）', () => {
  const cfg = createConfig();
  const st3 = synthStandings([90, 85, 80, 75, 70, 65]); // T3=3位
  assert.equal(ownerLeagueRankOf(st3, 'T3').rank, 3);
  const goalsRank = [{ type: 'rank', param: 3, label: 'A', priority: 'high' }];
  assert.equal(evaluateOwnerGoals(goalsRank, { standings: st3, teamId: 'T3', league: SYNTH_LEAGUE, careerStats: [], year: 2027, cfg })[0].achieved, true, '3位はAクラス達成');
  assert.equal(evaluateOwnerGoals(goalsRank, { standings: st3, teamId: 'T4', league: SYNTH_LEAGUE, careerStats: [], year: 2027, cfg })[0].achieved, false, '4位は未達');
  const goalsWp = [{ type: 'winPct', param: 0.5, label: 'W', priority: 'high' }];
  const stEven = synthStandings([70, 70, 70, 70, 70, 70]);
  assert.equal(evaluateOwnerGoals(goalsWp, { standings: stEven, teamId: 'T1', league: SYNTH_LEAGUE, careerStats: [], year: 2027, cfg })[0].achieved, true, '勝率ちょうどは達成（>=）');
});

test('H5-B: 解任→transfer で最低勝率球団へ移籍（介入ログ・オフ処理続行）', () => {
  const cfg = createConfig();
  cfg.game.allowFiring = true; // 既定false（headless非中断）＝実プレイ相当を明示的に有効化
  const st = newGame(SEED, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  assert.ok(advanceYear(st), '1年目（目標なし）は通常どおり完了');
  advanceTo(st, 'seasonEnd');
  // 2年目: 不可能な目標＋低信任を注入して解任を強制発火させる
  st.ownerGoals = { yearIndex: st.yearIndex, goals: [{ type: 'winPct', param: 1.01, label: '不可能', priority: 'high' }] };
  st.ownerTrust = 10;
  const r = advanceYear(st);
  assert.equal(r, null, '解任イベントで中断');
  assert.ok(st.ownerPending && st.ownerPending.canPlea, 'ownerPending が立つ（嘆願可）');
  const expected = pickTransferOffer(st.teamHistory.find((h) => h.year === st.year).standings, 'T1');
  const off = resolveOwnerDecision(st, 'transfer');
  assert.equal(st.playerTeamId, expected, '前年最低勝率の球団へ移籍');
  assert.equal(st.ownerTrust, cfg.tuning.ownerGoals.transferResetTrust, '信任リセット');
  assert.ok(st.marketInterventions.some((iv) => iv.phase === 'ownerFire' && iv.choice === 'transfer'), '介入ログに記録');
  assert.ok(off && off.rookies, 'オフ処理が最後まで続行される');
});

test('H5-B: 留任嘆願は1回だけ・allowFiring=false では解任が起きない', () => {
  const cfg = createConfig();
  cfg.game.allowFiring = true;
  const st = newGame(SEED + 1, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  advanceYear(st);
  advanceTo(st, 'seasonEnd');
  st.ownerGoals = { yearIndex: st.yearIndex, goals: [{ type: 'winPct', param: 1.01, label: '不可能', priority: 'high' }] };
  st.ownerTrust = 10;
  assert.equal(advanceYear(st), null);
  const off = resolveOwnerDecision(st, 'plea');
  assert.equal(st.playerTeamId, 'T1', '嘆願で留任');
  assert.ok(st.pleaUsed, '嘆願は使用済みになる');
  assert.ok(off && off.rookies, 'オフ処理続行');
  // allowFiring=false（既定）: 低信任でも中断しない
  const cfg2 = createConfig();
  const st2 = newGame(SEED + 2, 'T1', { cfg: cfg2 });
  advanceTo(st2, 'seasonEnd');
  advanceYear(st2);
  advanceTo(st2, 'seasonEnd');
  st2.ownerGoals = { yearIndex: st2.yearIndex, goals: [{ type: 'winPct', param: 1.01, label: '不可能', priority: 'high' }] };
  st2.ownerTrust = 0;
  const off2 = advanceYear(st2);
  assert.ok(off2 && off2.rookies, 'allowFiring=false は中断せず完了');
  assert.ok(!st2.ownerPending, 'ownerPending が立たない');
});

test('H5-B: save-load で信任が保存され、目標は決定論で再生成される（旧セーブは初期値補完）', () => {
  const cfg = createConfig();
  const st = newGame(SEED + 3, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  advanceYear(st); // 2年目開幕（目標生成済み）
  const liveGoals = JSON.parse(JSON.stringify(st.ownerGoals));
  st.ownerTrust = 77; // 変化させて保存
  const blob = JSON.parse(JSON.stringify(save(st)));
  const restored = load(blob, { cfg: createConfig() });
  assert.equal(restored.ownerTrust, 77, '信任が保存される');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.ownerGoals)), liveGoals, '目標は同式で再生成＝一致');
  // 旧セーブ（ownerフィールド無し）: 初期値補完
  delete blob.ownerTrust; delete blob.ownerEvaluatedYear; delete blob.pleaUsed; delete blob.ownerPending; delete blob.lastOwnerReport;
  const old = load(blob, { cfg: createConfig() });
  assert.equal(old.ownerTrust, cfg.tuning.ownerGoals.trustStart, '旧セーブは信任 初期値補完');
  assert.deepEqual(JSON.parse(JSON.stringify(old.ownerGoals)), liveGoals, '旧セーブでも目標は再生成で一致');
});

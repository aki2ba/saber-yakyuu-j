// ============================================================================
// Q2: 育成方針の「コーチ経過報告」（thyroxin/research/baseball_game_mechanics_research_20260723
//   Q2・OOTP Player Development Lab 2.0 の進捗バー/中間レポート翻案）のテスト。
//   coachReportPhase/coachProgressReports を合成フィクスチャ（rt.playerGameLog を直接構成）で
//   境界値・各方針の分岐（batting/pitching/convert/usageフォールバック）・決定論を検証する。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { coachReportPhase, coachProgressReports } from '../src/game/coachReports.mjs';

const cfg = createConfig();
const TOTAL_DAYS = 90; // finalDay=89 → midDay=30, lateDay=60（daysPerWeek=7）

function schedule(n) {
  return Array.from({ length: n }, (_, i) => ({ day: i }));
}
function batterRec(day, pid, o = {}) {
  return { day, box: { batters: { home: [{ pid, ab: o.ab ?? 0, h: o.h ?? 0, hr: o.hr ?? 0, bb: o.bb ?? 0, rbi: 0, k: 0, pos: o.pos ?? 'OF' }], away: [] }, pitchers: { home: [], away: [] } } };
}
function pitcherRec(day, pid, o = {}) {
  return { day, box: { batters: { home: [], away: [] }, pitchers: { home: [{ pid, outs: o.outs ?? 0, np: 0, h: o.h ?? 0, r: o.r ?? 0, bb: o.bb ?? 0, k: o.k ?? 0, hr: o.hr ?? 0 }], away: [] } } };
}
/** elapsed=cursor位置の day に到達した状態のrt（pendingDayがelapsedを返す）。 */
function rtAt(elapsed, playerGameLog) {
  return { finalDay: TOTAL_DAYS - 1, schedule: schedule(TOTAL_DAYS), cursor: elapsed, playerGameLog };
}
function fakeState(o = {}) {
  return {
    cfg, masterSeed: 12345, year: 2025, yearIndex: 0, playerTeamId: 'T1',
    league: { players: [] }, trainingPolicies: [],
    ...o,
  };
}

// ============================================================================
// coachReportPhase: 窓判定
// ============================================================================

test('Q2: coachReportPhase — 1/3地点(30)からdaysPerWeek(7)日間は"mid"、外はnull', () => {
  const mk = (elapsed) => fakeState({ rt: rtAt(elapsed, []) });
  assert.equal(coachReportPhase(mk(29)), null, '30日未満はまだ窓外');
  assert.equal(coachReportPhase(mk(30)), 'mid', '30日目ちょうどで窓に入る');
  assert.equal(coachReportPhase(mk(36)), 'mid', '窓内（30+6日目）');
  assert.equal(coachReportPhase(mk(37)), null, '窓を抜けたらnull');
});

test('Q2: coachReportPhase — 2/3地点(60)からdaysPerWeek日間は"late"', () => {
  const mk = (elapsed) => fakeState({ rt: rtAt(elapsed, []) });
  assert.equal(coachReportPhase(mk(59)), null);
  assert.equal(coachReportPhase(mk(60)), 'late');
  assert.equal(coachReportPhase(mk(66)), 'late');
  assert.equal(coachReportPhase(mk(67)), null);
});

test('Q2: coachReportPhase — rt未生成（シーズン外）はnull', () => {
  assert.equal(coachReportPhase(fakeState({ rt: null })), null);
});

// ============================================================================
// coachProgressReports: 各方針の観測トレンド分岐
// ============================================================================

const P1 = { id: 'P1', teamId: 'T1', role: 'fielder', primaryPos: 'OF' };

test('Q2: 打撃方針 — 前半→後半で打率/本塁打ペースが上向けばbucket=up', () => {
  const log = [];
  for (let d = 0; d < 10; d++) log.push(batterRec(d, 'P1', { ab: 4, h: 1, hr: 0 })); // 前半（day<15）
  for (let d = 15; d < 25; d++) log.push(batterRec(d, 'P1', { ab: 4, h: 2, hr: 1 })); // 後半
  const st = fakeState({
    rt: rtAt(30, log), // mid窓
    league: { players: [P1] },
    trainingPolicies: [{ yearIndex: 0, playerId: 'P1', policy: 'batting', special: false }],
  });
  const reports = coachProgressReports(st);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].bucket, 'up');
  assert.equal(reports[0].cls, 'good');
  assert.ok(reports[0].text.includes('打撃強化'));
  assert.ok(reports[0].text.includes('打率'));
});

test('Q2: 打撃方針 — 前半後半で変化が無ければbucket=flat（「まだ目に見える成果は出ていません」系）', () => {
  const log = [];
  for (let d = 0; d < 10; d++) log.push(batterRec(d, 'P1', { ab: 4, h: 1, hr: 0 }));
  for (let d = 15; d < 25; d++) log.push(batterRec(d, 'P1', { ab: 4, h: 1, hr: 0 }));
  const st = fakeState({
    rt: rtAt(30, log),
    league: { players: [P1] },
    trainingPolicies: [{ yearIndex: 0, playerId: 'P1', policy: 'batting', special: false }],
  });
  const reports = coachProgressReports(st);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].bucket, 'flat');
  assert.equal(reports[0].cls, 'info');
});

test('Q2: サンプル不足（半期AB<15）は報告を出さない', () => {
  const log = [batterRec(1, 'P1', { ab: 4, h: 1 }), batterRec(16, 'P1', { ab: 4, h: 2 })]; // 各半期4ABのみ
  const st = fakeState({
    rt: rtAt(30, log),
    league: { players: [P1] },
    trainingPolicies: [{ yearIndex: 0, playerId: 'P1', policy: 'batting', special: false }],
  });
  assert.deepEqual(coachProgressReports(st), [], 'AB不足の選手は報告なし');
});

test('Q2: 投手 — 目安防御率/奪三振ペースの前半後半比較（役割優先＝方針の種類によらずpitching軸）', () => {
  const P2 = { id: 'P2', teamId: 'T1', role: 'pitcher', primaryPos: 'P' };
  const log = [];
  for (let d = 0; d < 10; d++) log.push(pitcherRec(d, 'P2', { outs: 6, r: 4, k: 2, bb: 1 })); // 前半: 悪い内容
  for (let d = 15; d < 25; d++) log.push(pitcherRec(d, 'P2', { outs: 6, r: 0, k: 8, bb: 0 })); // 後半: 好投
  const st = fakeState({
    rt: rtAt(30, log),
    league: { players: [P2] },
    trainingPolicies: [{ yearIndex: 0, playerId: 'P2', policy: 'balanced', special: false }],
  });
  const reports = coachProgressReports(st);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].bucket, 'up');
  assert.ok(reports[0].text.includes('目安防御率'));
});

test('Q2: コンバート方針 — 対象ポジションでの出場比率が定着すればbucket=up', () => {
  const P3 = { id: 'P3', teamId: 'T1', role: 'fielder', primaryPos: 'OF' };
  const log = [];
  for (let d = 0; d < 5; d++) log.push(batterRec(d, 'P3', { ab: 4, h: 1, pos: 'OF' })); // 前半はOFのまま
  for (let d = 15; d < 20; d++) log.push(batterRec(d, 'P3', { ab: 4, h: 1, pos: '2B' })); // 後半はコンバート先で出場
  const st = fakeState({
    rt: rtAt(30, log),
    league: { players: [P3] },
    trainingPolicies: [{ yearIndex: 0, playerId: 'P3', policy: 'convert:2B', special: false }],
  });
  const reports = coachProgressReports(st);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].bucket, 'up');
  assert.ok(reports[0].text.includes('コンバート'));
});

test('Q2: 守備/休養方針 — 対応する打撃/投球ボックス指標が無いため出場機会のフォールバックを使う', () => {
  const P4 = { id: 'P4', teamId: 'T1', role: 'fielder', primaryPos: 'SS' };
  const log = [];
  for (let d = 0; d < 3; d++) log.push(batterRec(d, 'P4', { ab: 3, h: 1 })); // 前半3試合
  for (let d = 15; d < 20; d++) log.push(batterRec(d, 'P4', { ab: 3, h: 1 })); // 後半5試合（出場増）
  const st = fakeState({
    rt: rtAt(30, log),
    league: { players: [P4] },
    trainingPolicies: [{ yearIndex: 0, playerId: 'P4', policy: 'defense', special: false }],
  });
  const reports = coachProgressReports(st);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].bucket, 'up', '出場試合数が増えていればup');
  assert.ok(reports[0].text.includes('守備強化'));
  assert.ok(reports[0].text.includes('出場'));
});

test('Q2: 窓外（coachReportPhaseがnull）では常に空配列', () => {
  const log = [batterRec(1, 'P1', { ab: 20, h: 10, hr: 5 })];
  const st = fakeState({
    rt: rtAt(10, log), // まだ1/3地点(30)に達していない
    league: { players: [P1] },
    trainingPolicies: [{ yearIndex: 0, playerId: 'P1', policy: 'batting', special: false }],
  });
  assert.deepEqual(coachProgressReports(st), []);
});

test('Q2: 自チーム以外/存在しない選手ぶんのtrainingPoliciesは無視される', () => {
  const other = { id: 'O1', teamId: 'T2', role: 'fielder', primaryPos: 'OF' };
  const log = [];
  for (let d = 0; d < 10; d++) log.push(batterRec(d, 'O1', { ab: 4, h: 1 }));
  for (let d = 15; d < 25; d++) log.push(batterRec(d, 'O1', { ab: 4, h: 3 }));
  const st = fakeState({
    rt: rtAt(30, log),
    league: { players: [other] },
    trainingPolicies: [
      { yearIndex: 0, playerId: 'O1', policy: 'batting', special: false }, // 他球団選手
      { yearIndex: 0, playerId: 'GHOST', policy: 'batting', special: false }, // 存在しない選手
    ],
  });
  assert.deepEqual(coachProgressReports(st), [], '自チーム以外/不在の選手は報告に出ない');
});

test('Q2: special指定の選手は「（特別指導）」タグが付く', () => {
  const log = [];
  for (let d = 0; d < 10; d++) log.push(batterRec(d, 'P1', { ab: 4, h: 1 }));
  for (let d = 15; d < 25; d++) log.push(batterRec(d, 'P1', { ab: 4, h: 2, hr: 1 }));
  const st = fakeState({
    rt: rtAt(30, log),
    league: { players: [P1] },
    trainingPolicies: [{ yearIndex: 0, playerId: 'P1', policy: 'batting', special: true }],
  });
  const reports = coachProgressReports(st);
  assert.ok(reports[0].text.includes('特別指導'));
});

test('Q2: 決定論 — 同一state入力は同一出力（純関数・trainingPolicies/rtを変更しない）', () => {
  const log = [];
  for (let d = 0; d < 10; d++) log.push(batterRec(d, 'P1', { ab: 4, h: 1 }));
  for (let d = 15; d < 25; d++) log.push(batterRec(d, 'P1', { ab: 4, h: 2, hr: 1 }));
  const st = fakeState({
    rt: rtAt(30, log),
    league: { players: [P1] },
    trainingPolicies: [{ yearIndex: 0, playerId: 'P1', policy: 'batting', special: false }],
  });
  const before = JSON.stringify({ tp: st.trainingPolicies, log: st.rt.playerGameLog });
  const a = JSON.stringify(coachProgressReports(st));
  const b = JSON.stringify(coachProgressReports(st));
  assert.equal(a, b, '同一input同一output');
  const after = JSON.stringify({ tp: st.trainingPolicies, log: st.rt.playerGameLog });
  assert.equal(after, before, 'stateを変更しない');
});

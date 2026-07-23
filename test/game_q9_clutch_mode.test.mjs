// ============================================================================
// Q9（thyroxin/research…20260723 Q9・介入観戦「山場だけ」モード）のテスト。
//   - minLI を非常に高く設定すると一度も一時停止せず、全自動（managerIntervention無し）と
//     bit同一になる（「フィルタ有無でログ空なら全自動とbit同一のまま」の直接検証）。
//   - minLI=0（既定）は従来どおり最初の介入点で必ず一時停止する（回帰確認）。
//   - 一時停止した局面は必ず leverageProxy（既存の継投レバレッジ代理・§8.3 D4）で独立に
//     再計算したLIが minLI 以上（「高LIのみpause」の直接検証）。
//   - ログ形式（seq/kind/choice）は minLI の有無に関わらず不変＝同じログを別モードで
//     replay しても同じ record を再現する（「ログ互換」の検証）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, playInteractiveGame, submitGameDecision } from '../src/game/index.mjs';
import { leverageProxy } from '../src/sim/manager.mjs';

const SEED = 20260701;

function snapshotStats(rt) {
  return [...rt.stats.stats.values()].slice()
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
}
function snapshotStandings(rt) {
  return [...rt.standings.values()].slice()
    .sort((a, b) => (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
}

test('Q9-1: 非常に高いminLIは一度も一時停止せず、全自動とbit同一（ログ空）', () => {
  const base = newGame(SEED, 'T1', { cfg: createConfig() });
  advanceTo(base, 'nextPlayerGame');

  const clutch = newGame(SEED, 'T1', { cfg: createConfig({ game: { interactiveManager: true } }) });
  const result = playInteractiveGame(clutch, { auto: false, managerIntervention: { minLI: 999 } });
  assert.ok(!result.paused, '非常に高いminLIは onDecision を一度も呼ばず完走する');
  assert.equal(clutch.gameInterventions.length, 0, '介入ログは空のまま（onDecision未呼出）');

  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshotStandings(base.rt))),
    JSON.parse(JSON.stringify(snapshotStandings(clutch.rt))),
    '順位表が全自動と一致しない',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshotStats(base.rt))),
    JSON.parse(JSON.stringify(snapshotStats(clutch.rt))),
    '全playerSeasons集計が全自動と一致しない',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(base.rt.playerGameLog)),
    JSON.parse(JSON.stringify(clutch.rt.playerGameLog)),
    '自チーム試合の record が全自動と一致しない',
  );
});

test('Q9-2: minLI=0（既定）は従来どおり最初の介入点で必ず一時停止する', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig({ game: { interactiveManager: true } }) });
  let paused = null;
  for (let i = 0; i < 60 && !paused; i++) {
    const r = playInteractiveGame(st, { managerIntervention: { minLI: 0 } });
    if (r.paused) paused = r;
    if (r.seasonEnded) break;
  }
  assert.ok(paused, 'minLI=0では介入点で一時停止するはず（テスト前提の見直しが必要な場合を除く）');
});

test('Q9-3: 山場フィルタ — 一時停止した局面はすべて独立計算したLIがminLI以上（高LIのみpause）', () => {
  const cfg = createConfig({ game: { interactiveManager: true } });
  const pen = cfg.tuning.pen;
  const minLI = 1.4; // cfg.game.clutchModeMinLI相当の帯（highLevThreshold=1.6よりやや低め＝十分な発生数を確保）
  const st = newGame(SEED, 'T1', { cfg });
  const seen = [];
  for (let i = 0; i < 120 && seen.length < 6; i++) {
    const r = playInteractiveGame(st, { managerIntervention: { minLI } });
    if (r.seasonEnded) break;
    if (!r.paused) continue;
    seen.push(r.decision);
    // 次の介入点まで進めるため、候補の先頭（無ければnull=見送り/続投）を選んで即応答する。
    const { decision } = r;
    submitGameDecision(st, {
      year: decision.year, day: decision.day, seq: decision.seq, kind: decision.kind,
      choice: { pick: decision.candidates[0] ?? null },
    });
  }
  assert.ok(seen.length > 0, `${minLI}以上のLI局面が一度も発生しなかった（テスト前提の見直しが必要）`);
  for (const d of seen) {
    const bits = (d.situ.bases[0] ? 1 : 0) | (d.situ.bases[1] ? 2 : 0) | (d.situ.bases[2] ? 4 : 0);
    const li = leverageProxy(d.situ.inning, d.situ.scoreDiff, bits, d.situ.outs, pen);
    assert.ok(li >= minLI - 1e-9, `一時停止した局面のLI(${li})がminLI(${minLI})未満（kind=${d.kind}）`);
  }
});

test('Q9-4: ログ互換 — 山場モードで記録した介入ログは、minLI無し(=0)のreplayでも同じ結果を再現する', () => {
  const cfg = createConfig({ game: { interactiveManager: true } });
  const st = newGame(SEED, 'T1', { cfg });
  const minLI = 1.4;
  // フェーズ1: 最初の一時停止が起きるまで進める（介入点の無い試合は自動で通過）。
  let result = null;
  for (let i = 0; i < 80; i++) {
    result = playInteractiveGame(st, { managerIntervention: { minLI } });
    if (result.paused || result.seasonEnded) break;
  }
  assert.ok(result && result.paused, `${minLI}以上のLI局面が一度も発生しなかった（テスト前提の見直しが必要）`);
  // フェーズ2: この試合を完走させながらログを集める（同じ試合に複数回一時停止しうる）。
  const log = [];
  while (result.paused) {
    const { decision } = result;
    const choice = { pick: decision.candidates[0] ?? null };
    submitGameDecision(st, { year: decision.year, day: decision.day, seq: decision.seq, kind: decision.kind, choice });
    log.push({ year: decision.year, day: decision.day, seq: decision.seq, kind: decision.kind, choice });
    result = playInteractiveGame(st, { managerIntervention: { minLI } });
  }
  assert.ok(!result.paused, '山場モードでの完走に失敗した');
  assert.ok(log.length > 0, 'ログが空（テスト前提の見直しが必要）');

  // 同じログを「山場モードで記録した」ことを伏せ、minLI無し(既定0)のreplayで再現できるか
  // （ログのseq/kind/choiceだけを見る＝mgrInterv.minLIの値そのものはログに含まれない設計）。
  const replay = newGame(SEED, 'T1', { cfg });
  replay.gameInterventions = JSON.parse(JSON.stringify(log));
  let rr;
  for (let i = 0; i < 80; i++) {
    // ログに無い介入点は常にAI判断（minLI=0相当）＝この経路は一度も一時停止しない。
    // 対象の試合（同じday）に到達するまで、それより前の自チーム戦（ログの無い日）も
    // 同じ経路で自動消化して進める。
    rr = playInteractiveGame(replay, { auto: true });
    if (rr.seasonEnded) break;
    if (!rr.paused && rr.record && rr.record.day === result.record.day) break;
  }
  assert.ok(!rr.paused, 'replayが完走しなかった');
  assert.equal(rr.record?.day, result.record.day, 'replayが対象の試合まで到達しなかった');
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.record)),
    JSON.parse(JSON.stringify(rr.record)),
    '山場モードのログをminLI無しでreplayしても同じrecordを再現しない',
  );
});

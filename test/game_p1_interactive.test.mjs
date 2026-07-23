// ============================================================================
// P1（試合中の人間采配・介入観戦）のテスト。thyroxin/specs/p1_interactive_manager_spec.md §5。
//   1. 全おまかせ（ログ空）= 従来の全自動と bit 同一（cfg.game.interactiveManager 既定 false の
//      不変条件・§0-4）。
//   2. 決定論: 同じログで2回 playInteractiveGame → record が bit 一致。
//   3. 中断→再開: onDecision が PAUSE を返す既定動作で1回中断→submitGameDecision（AIと異なる
//      代打/継投を選択）→再開で完走。選んだ選手が実際に box に現れる。
//   4. 無効choiceのフォールバック: 存在しないpidを積んでもクラッシュせずAI判断で完走。
//   5. save/load: gameInterventions が保存・復元される（additive・旧セーブは[]）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, playInteractiveGame, submitGameDecision, save, load } from '../src/game/index.mjs';

const SEED = 20260701;

/** 比較用: rt.stats.stats（全選手season集計）を playerId 昇順の配列へ。 */
function snapshotStats(rt) {
  return [...rt.stats.stats.values()]
    .slice()
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
}

/** 比較用: rt.standings（順位表）を teamId 昇順の配列へ。 */
function snapshotStandings(rt) {
  return [...rt.standings.values()]
    .slice()
    .sort((a, b) => (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
}

/** playInteractiveGame を「中断したら見つかるまで」繰り返す（介入点の無い試合は自動で通過）。
 *  season がいずれ終わってしまうとテスト前提が崩れるので上限を設ける。 */
function untilPaused(state, maxCalls = 60) {
  for (let i = 0; i < maxCalls; i++) {
    const result = playInteractiveGame(state);
    if (result.paused) return result;
    if (result.seasonEnded) throw new Error('untilPaused: シーズン中に介入点が一度も発生しなかった（テスト前提の見直しが必要）');
  }
  throw new Error(`untilPaused: ${maxCalls}試合以内に介入点が発生しなかった`);
}

test('P1-1: 全おまかせ（ログ空）は従来の全自動と bit 同一', () => {
  const base = newGame(SEED, 'T1', { cfg: createConfig() });
  assert.equal(base.cfg.game.interactiveManager, false, '既定値はfalse（headless不変の前提）');
  advanceTo(base, 'nextPlayerGame');

  const inter = newGame(SEED, 'T1', { cfg: createConfig({ game: { interactiveManager: true } }) });
  const result = playInteractiveGame(inter, { auto: true });
  assert.ok(!result.paused, '全おまかせ（auto:true）は中断しない');
  assert.equal(inter.gameInterventions.length, 0, '「おまかせ」はログに積まない（§1）');

  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshotStandings(base.rt))),
    JSON.parse(JSON.stringify(snapshotStandings(inter.rt))),
    '順位表（勝敗/得点）が全自動と一致しない',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshotStats(base.rt))),
    JSON.parse(JSON.stringify(snapshotStats(inter.rt))),
    '全playerSeasons集計が全自動と一致しない',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(base.rt.playerGameLog)),
    JSON.parse(JSON.stringify(inter.rt.playerGameLog)),
    '自チーム試合の record が全自動と一致しない',
  );
});

test('P1-2: 決定論 — 同じログで2回 playInteractiveGame を呼ぶと record が bit 一致', () => {
  // まず1回通して「実際に発生した介入点+選択」のログを作る（介入点が無ければ空ログのまま＝それでもOK）。
  const seed = newGame(SEED, 'T1', { cfg: createConfig({ game: { interactiveManager: true } }) });
  const found = (() => {
    for (let i = 0; i < 60; i++) {
      const r = playInteractiveGame(seed);
      if (r.paused) return r;
      if (r.seasonEnded) return null;
    }
    return null;
  })();
  const log = [];
  if (found) {
    const pick = found.decision.candidates[0] ?? null;
    log.push({ year: found.decision.year, day: found.decision.day, seq: found.decision.seq, kind: found.decision.kind, choice: { pick } });
  }

  const run = () => {
    const st = newGame(SEED, 'T1', { cfg: createConfig({ game: { interactiveManager: true } }) });
    st.gameInterventions = JSON.parse(JSON.stringify(log));
    let result;
    for (let i = 0; i < 60; i++) {
      result = playInteractiveGame(st, { auto: true });
      if (!result.paused) break;
    }
    return { result, stats: snapshotStats(st.rt), standings: snapshotStandings(st.rt) };
  };
  const a = run();
  const b = run();
  assert.deepEqual(JSON.parse(JSON.stringify(a.result.record)), JSON.parse(JSON.stringify(b.result.record)));
  assert.deepEqual(JSON.parse(JSON.stringify(a.stats)), JSON.parse(JSON.stringify(b.stats)));
  assert.deepEqual(JSON.parse(JSON.stringify(a.standings)), JSON.parse(JSON.stringify(b.standings)));
});

test('P1-3: 中断→再開 — AIと異なる選択を送ると、その選手が実際に試合に出る', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig({ game: { interactiveManager: true } }) });
  const paused = untilPaused(st);
  const { decision } = paused;
  assert.ok(decision.candidates.length > 0, '候補が無い介入点が発生した（テスト前提の見直しが必要）');
  // AIの選択そのものは公開されないため、候補の中から「先頭」を選ぶ（=何らかの具体的な選択）。
  const chosen = decision.candidates[0];
  submitGameDecision(st, { year: decision.year, day: decision.day, seq: decision.seq, kind: decision.kind, choice: { pick: chosen } });
  assert.equal(st.gameInterventions.length, 1);

  // 再開（以後はauto=trueで完走まで進める。途中さらに介入点があってもテストの主眼はseq=1の反映確認）。
  let result;
  for (let i = 0; i < 10; i++) {
    result = playInteractiveGame(st, { auto: true });
    if (!result.paused) break;
  }
  assert.ok(!result.paused, '再開後に完走しなかった');
  const side = result.record.home === st.playerTeamId ? 'home' : 'away';
  if (decision.kind === 'ph') {
    const appeared = result.record.box.batters[side].some((b) => b.pid === chosen);
    assert.ok(appeared, `選択した代打(${chosen})がboxの打者に現れない`);
  } else {
    const appeared = result.record.box.pitchers[side].some((p) => p.pid === chosen);
    assert.ok(appeared, `選択した投手(${chosen})がboxの投手に現れない`);
  }
});

test('P1-4: 無効choiceのフォールバック — 存在しないpidを積んでもクラッシュせずAI判断で完走', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig({ game: { interactiveManager: true } }) });
  const paused = untilPaused(st);
  const { decision } = paused;
  submitGameDecision(st, {
    year: decision.year, day: decision.day, seq: decision.seq, kind: decision.kind,
    choice: { pick: 'NO_SUCH_PLAYER_XYZ' },
  });
  let result;
  assert.doesNotThrow(() => {
    for (let i = 0; i < 10; i++) {
      result = playInteractiveGame(st, { auto: true });
      if (!result.paused) break;
    }
  });
  assert.ok(!result.paused, '無効choiceの後、完走しなかった');
  assert.ok(result.record, 'record が無い');
});

test('P1-5: save/load — gameInterventions が保存・復元される（additive・旧セーブは[]補完）', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig({ game: { interactiveManager: true } }) });
  const paused = untilPaused(st);
  const { decision } = paused;
  submitGameDecision(st, {
    year: decision.year, day: decision.day, seq: decision.seq, kind: decision.kind,
    choice: { pick: decision.candidates[0] ?? null },
  });
  // 試合を完走（day境界）まで進めてから保存する（§0-3: シム途中状態はシリアライズしない。
  // save/load は「試合が確定した」day境界の cursor を前提に replay するため、中断中のままの
  // 保存は仕様の対象外＝ここでは完走後の通常のセーブ経路を検証する）。
  let result;
  for (let i = 0; i < 10; i++) {
    result = playInteractiveGame(st, { auto: true });
    if (!result.paused) break;
  }
  assert.ok(!result.paused, 'save前提の試合完走に失敗した');
  const blob = save(st);
  assert.deepEqual(blob.gameInterventions, st.gameInterventions);

  const loaded = load(blob, { cfg: st.cfg });
  assert.deepEqual(loaded.gameInterventions, st.gameInterventions, 'ロードで介入ログが復元されない');
  // replay が本当に人間の選択（AIと異なりうる代打/継投）を再現できているかも確認
  // （順位表がloadの検算 verifyStandings を素通りしている＝介入込みで決定論的に再現された証拠）。
  assert.equal(loaded.rt.cursor, st.rt.cursor);

  // 旧セーブ（gameInterventions フィールドが無い）は [] 補完される。
  // ★介入が実際に発生していない（＝標準の全自動replayと一致する）blobを使う必要がある
  // （介入で結果が変わった試合のblobから介入ログだけを取り除くと、保存済み順位表と
  //   「介入無しのAI判断で再現した結果」が食い違い、load の decisive verifyStandings が
  //   正しく破損検出してしまう＝これは load の不具合ではなくテストデータの作り方の問題）。
  const clean = newGame(SEED, 'T1', { cfg: createConfig({ game: { interactiveManager: true } }) });
  const cleanResult = playInteractiveGame(clean, { auto: true }); // 介入ログ0件のまま完走させる
  assert.ok(!cleanResult.paused);
  assert.equal(clean.gameInterventions.length, 0);
  const cleanBlob = save(clean);
  assert.deepEqual(cleanBlob.gameInterventions, []);
  const oldBlob = { ...cleanBlob };
  delete oldBlob.gameInterventions;
  const loadedOld = load(oldBlob, { cfg: clean.cfg });
  assert.deepEqual(loadedOld.gameInterventions, []);
});

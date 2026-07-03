// ============================================================================
// フェーズC1b: 采配介入（監督プロファイル差し替え）の決定論・save/load 再現テスト。
//   - 介入は結果を「変える」（AI委任と別の順位に分岐する＝フックが効いている）
//   - 同じ介入を同じ日に入れれば結果は不変（決定論）
//   - 介入を挟んだ後の save→load→続行が「無セーブ通し」と完全一致（interventions ログ再現）
//   - 観戦イベント収集（onEvent）を付けても付けなくても結果は bit 同一（乱数非消費）
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceDay, advanceTo, save, load, setManagerProfile } from '../src/game/index.mjs';

const cfg = createConfig();
const SEED = 20260701;

function standingsSig(table) {
  return table.map((r) => `${r.teamId}:${r.w}-${r.l}-${r.t}/${r.rs}-${r.ra}`).join('|');
}
function statsSig(playerSeasons) {
  return [...playerSeasons]
    .map((s) => {
      const b = s.batting; const p = s.pitching;
      return `${s.playerId},${b.pa},${b.h},${b.hr},${b.bb},${b.so},${b.rbi},${p.outs},${p.so},${p.bb},${p.er},${p.h}`;
    })
    .sort().join(';');
}

/** 10日進めて自チーム監督を「超積極バント×盗塁」に上書きし、シーズン終了まで進める。 */
function runWithIntervention(cfgLocal) {
  const st = newGame(SEED, 'T1', { cfg: cfgLocal });
  for (let i = 0; i < 10 && !st.rt.finished; i++) advanceDay(st);
  setManagerProfile(st, { buntTend: 80, stealTend: 80, ibbTend: 80, quickHook: 80 });
  advanceTo(st, 'seasonEnd');
  return st;
}

test('C1b: 采配介入は決定論（同じ介入→同じ結果）', () => {
  const a = runWithIntervention(cfg);
  const b = runWithIntervention(createConfig());
  assert.equal(standingsSig(a.rt.table), standingsSig(b.rt.table), '介入ありの最終順位が2回とも一致');
  assert.equal(statsSig(a.rt.stats.stats.values()), statsSig(b.rt.stats.stats.values()), '選手集計も一致');
});

test('C1b: 采配介入は結果を変える（AIフックが効いている）', () => {
  const withIv = runWithIntervention(cfg);
  const noIv = newGame(SEED, 'T1', { cfg: createConfig() });
  advanceTo(noIv, 'seasonEnd');
  // 監督方針の差し替えは犠打/盗塁の出方を変える＝自チームの集計が変わる（＝介入が実際に効く）。
  const myWith = [...withIv.rt.stats.stats.values()].filter((s) => s.teamId === 'T1');
  const myNo = [...noIv.rt.stats.stats.values()].filter((s) => s.teamId === 'T1');
  const shOf = (arr) => arr.reduce((a, s) => a + (s.batting.sh || 0), 0);
  const sbOf = (arr) => arr.reduce((a, s) => a + (s.batting.sb || 0), 0);
  assert.ok(shOf(myWith) !== shOf(myNo) || sbOf(myWith) !== sbOf(myNo), '積極バント/盗塁の介入で自チームの犠打or盗塁数が変わる');
});

test('C1b: 介入を挟んだ save→load→続行が無セーブ通しと完全一致', () => {
  // 基準（介入あり通し）
  const ref = runWithIntervention(cfg);
  const refSig = { st: standingsSig(ref.rt.table), ps: statsSig(ref.rt.stats.stats.values()), champ: ref.rt.postseason.champion };

  // 介入直後に save/load を挟んでから続行
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  for (let i = 0; i < 10 && !st.rt.finished; i++) advanceDay(st);
  setManagerProfile(st, { buntTend: 80, stealTend: 80, ibbTend: 80, quickHook: 80 });
  for (let i = 0; i < 5 && !st.rt.finished; i++) advanceDay(st);
  const blob = JSON.parse(JSON.stringify(save(st)));
  assert.ok(blob.interventions.length >= 1, 'セーブに介入ログが含まれる');
  const restored = load(blob, { cfg: createConfig() });
  advanceTo(restored, 'seasonEnd');
  assert.equal(standingsSig(restored.rt.table), refSig.st, '順位が介入あり通しと一致');
  assert.equal(statsSig(restored.rt.stats.stats.values()), refSig.ps, '集計が一致');
  assert.equal(restored.rt.postseason.champion, refSig.champ, '日本一が一致');
});

test('C1b: 観戦イベント収集の有無で結果は不変（onEvent は乱数非消費）', () => {
  const plain = newGame(SEED, 'T3', { cfg: createConfig() });
  advanceTo(plain, 'seasonEnd');
  const watched = newGame(SEED, 'T3', { cfg: createConfig() });
  advanceTo(watched, 'seasonEnd', { collectPlayerEvents: true });
  assert.equal(standingsSig(watched.rt.table), standingsSig(plain.rt.table), '観戦収集ありでも順位が不変');
  assert.equal(statsSig(watched.rt.stats.stats.values()), statsSig(plain.rt.stats.stats.values()), '観戦収集ありでも集計が不変');
});

test('C1b: 同一日に個別フィールドを重ねても合成される（最後の値だけに潰れない）', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  for (let i = 0; i < 3 && !st.rt.finished; i++) advanceDay(st);
  setManagerProfile(st, { buntTend: 80 });
  setManagerProfile(st, { stealTend: 20 });
  const m = st.rt.teamById.get('T1').manager;
  assert.equal(m.buntTend, 80, '先に入れた buntTend が保持される');
  assert.equal(m.stealTend, 20, '後から入れた stealTend も反映される');
  // 同一日の介入は1本に集約（replay一意）
  const sameDay = st.interventions.filter((iv) => iv.teamId === 'T1');
  assert.equal(sameDay.length, 1, '同一日の介入は1本に集約される');
  assert.equal(sameDay[0].manager.buntTend, 80);
  assert.equal(sameDay[0].manager.stealTend, 20);
});

test('C1b: 観戦イベントに start/pa/end が含まれ、自チーム試合を実況できる', () => {
  const st = newGame(SEED, 'T2', { cfg: createConfig() });
  let events = null;
  for (let i = 0; i < 200 && !st.rt.finished; i++) {
    const step = advanceDay(st, { collectPlayerEvents: true });
    if (step.playerEvents && step.playerEvents.length) { events = step.playerEvents; break; }
  }
  assert.ok(events, '自チーム試合の観戦イベントが得られる');
  assert.equal(events[0].type, 'start', '先頭は start');
  assert.equal(events[events.length - 1].type, 'end', '末尾は end');
  assert.ok(events.some((e) => e.type === 'pa'), 'pa イベントがある');
  const hr = events.find((e) => e.type === 'pa' && e.bb);
  if (hr) assert.ok(typeof hr.bb.evKmh === 'number' && typeof hr.bb.laDeg === 'number', '打球イベントに EV/LA が載る');
});

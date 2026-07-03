// ============================================================================
// フェーズC1a: ヘッドレス・ゲームループAPI（src/game/）の単体テスト。
//   - new→advance→save→load→advance が「無セーブ通し」と完全一致（決定論・replay復元）
//   - seasonEnd まで進めて順位表＋ポストシーズンが出る
//   - ゲームランナーの1年目レギュラーシーズンが simulateSeason（一括）と bit 同一（回帰）
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { newGame, advanceDay, advanceTo, save, load } from '../src/game/index.mjs';

const cfg = createConfig();
const SEED = 20260701;

/** 順位を比較可能な素へ（teamId→成績・table順）。 */
function standingsSig(table) {
  return table.map((r) => `${r.teamId}:${r.w}-${r.l}-${r.t}/${r.rs}-${r.ra}`).join('|');
}

/** 全選手集計の決定論チェックサム（打撃/投球の主要カウントを畳み込む）。 */
function statsSig(playerSeasons) {
  const rows = [...playerSeasons]
    .map((s) => {
      const b = s.batting;
      const p = s.pitching;
      return `${s.playerId},${b.pa},${b.h},${b.hr},${b.bb},${b.so},${b.rbi},${p.outs},${p.so},${p.bb},${p.er},${p.h}`;
    })
    .sort();
  return rows.join(';');
}

/** GameState の現行ランタイムの比較シグネチャ。 */
function runtimeSig(state) {
  const rt = state.rt;
  return {
    standings: standingsSig(rt.table ?? [...rt.standings.values()]),
    stats: statsSig(rt.stats.stats.values()),
    champion: rt.postseason ? rt.postseason.champion : null,
    cursor: rt.cursor,
    finished: rt.finished,
  };
}

test('C1a: newGame は開幕状態（year/day/自チーム/リーグ生成）を持つ', () => {
  const st = newGame(SEED, 'T3', { cfg });
  assert.equal(st.playerTeamId, 'T3');
  assert.equal(st.year, cfg.game.firstSeason);
  assert.equal(st.yearIndex, 0);
  assert.equal(st.rt.cursor, 0);
  assert.equal(st.rt.finished, false);
  assert.equal(st.league.teams.length, cfg.league.numTeams);
  assert.ok(st.rt.schedule.length > 0, '日程が生成される');
  // 不正な自チームIDは弾く
  assert.throws(() => newGame(SEED, 'ZZ', { cfg }));
});

test('C1a: advanceDay は day 境界で止まり、自チーム試合を playerGames で返す', () => {
  const st = newGame(SEED, 'T1', { cfg });
  let sawPlayerGame = false;
  let days = 0;
  while (!st.rt.finished && days < 400) {
    const step = advanceDay(st);
    days++;
    if (step.playerGames.length) {
      sawPlayerGame = true;
      for (const g of step.playerGames) assert.ok(g.home === 'T1' || g.away === 'T1');
    }
  }
  assert.ok(sawPlayerGame, '自チームの試合が発生する');
  assert.ok(st.rt.finished, 'いずれ seasonEnd に到達する');
});

test('C1a: advanceTo nextPlayerGame は自チーム試合日で止まる', () => {
  const st = newGame(SEED, 'T5', { cfg });
  const steps = advanceTo(st, 'nextPlayerGame');
  assert.ok(steps.length >= 1);
  const last = steps[steps.length - 1];
  assert.ok(last.playerGames.length >= 1 || st.rt.finished, '自チーム試合で停止 or シーズン終了');
});

test('C1a: advanceTo weekEnd / monthEnd は境界で止まり cursor が進む', () => {
  const st = newGame(SEED, 'T2', { cfg });
  const before = st.rt.cursor;
  advanceTo(st, 'weekEnd');
  assert.ok(st.rt.cursor > before, 'weekEnd で試合が進む');
  const afterWeek = st.rt.cursor;
  advanceTo(st, 'monthEnd');
  assert.ok(st.rt.cursor > afterWeek, 'monthEnd でさらに進む');
});

test('C1a: seasonEnd まで進めると順位表＋ポストシーズン（優勝）が出る', () => {
  const st = newGame(SEED, 'T7', { cfg });
  advanceTo(st, 'seasonEnd');
  assert.ok(st.rt.finished);
  assert.equal(st.rt.table.length, cfg.league.numTeams, '全球団の順位行');
  // 各球団の消化試合数が規定に一致
  for (const row of st.rt.table) assert.equal(row.w + row.l + row.t, cfg.league.gamesPerSeason);
  assert.ok(st.rt.postseason && st.rt.postseason.champion, '日本一が決まる');
  // 完了シーズンが永続領域へ退避される（§17集計値）
  assert.equal(st.teamHistory.length, 1);
  assert.equal(st.teamHistory[0].champion, st.rt.postseason.champion);
  assert.ok(st.careerStats.length > 0, 'careerStats に選手集計が積まれる');
});

test('C1a: 回帰 — ゲームランナー1年目レギュラーが simulateSeason（一括）と bit 同一', () => {
  const league = generateLeague(SEED, cfg);
  const bulk = simulateSeason(league, cfg, { season: cfg.game.firstSeason, seed: SEED });
  const st = newGame(SEED, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  // 順位（順序込み）が一致
  assert.equal(standingsSig(st.rt.table), standingsSig(bulk.standings), '順位表が一括APIと一致');
  // 全選手集計が一致
  assert.equal(statsSig(st.rt.stats.stats.values()), statsSig(bulk.playerSeasons), '選手集計が一括APIと一致');
  // ポストシーズン優勝が一致
  assert.equal(st.rt.postseason.champion, bulk.postseason.champion, '日本一が一括APIと一致');
});

test('C1a: new→advance→save→load→advance が「無セーブ通し」と完全一致（決定論）', () => {
  // 基準: 無セーブで seasonEnd まで通す
  const straight = newGame(SEED, 'T4', { cfg });
  advanceTo(straight, 'seasonEnd');
  const ref = runtimeSig(straight);

  // 途中セーブ: 30日進める → save → JSON往復 → load → seasonEnd まで継続
  const mid = newGame(SEED, 'T4', { cfg });
  for (let i = 0; i < 30 && !mid.rt.finished; i++) advanceDay(mid);
  const blob = JSON.parse(JSON.stringify(save(mid))); // IndexedDB/JSON往復を模す
  const restored = load(blob, { cfg });
  // load 直後の状態が save 時点と一致（replay 復元の門番）
  assert.equal(restored.rt.cursor, mid.rt.cursor, 'cursor が復元される');
  assert.equal(statsSig(restored.rt.stats.stats.values()), statsSig(mid.rt.stats.stats.values()), '集計が復元される');
  advanceTo(restored, 'seasonEnd');

  const got = runtimeSig(restored);
  assert.deepEqual(got, ref, 'save/load を挟んでも最終結果が無セーブ通しと完全一致');
});

test('C1a: 複数スロット/複数回セーブでも決定論が保たれる', () => {
  const straight = newGame(SEED, 'T9', { cfg });
  advanceTo(straight, 'seasonEnd');
  const ref = runtimeSig(straight);

  let st = newGame(SEED, 'T9', { cfg });
  // 何度もセーブ/ロードを挟みながら進める
  for (let round = 0; round < 5 && !st.rt.finished; round++) {
    for (let i = 0; i < 20 && !st.rt.finished; i++) advanceDay(st);
    const blob = JSON.parse(JSON.stringify(save(st)));
    st = load(blob, { cfg });
  }
  advanceTo(st, 'seasonEnd');
  assert.deepEqual(runtimeSig(st), ref, '反復セーブ/ロードでも最終結果が不変');
});

test('C1a: 完了後にセーブ/ロードしても順位・優勝が保たれる', () => {
  const st = newGame(SEED, 'T6', { cfg });
  advanceTo(st, 'seasonEnd');
  const blob = JSON.parse(JSON.stringify(save(st)));
  const restored = load(blob, { cfg });
  assert.ok(restored.rt.finished);
  assert.equal(standingsSig(restored.rt.table), standingsSig(st.rt.table));
  assert.equal(restored.rt.postseason.champion, st.rt.postseason.champion);
  assert.equal(restored.teamHistory[0].champion, st.teamHistory[0].champion);
});

// ============================================================================
// フェーズE4: 日程・結果（簡易ボックススコア）の集計・不変量・決定論テスト。
//   - 自チーム試合の rec.box が観戦オプションの有無に依らず常に付く（onEvent 常時収集）
//   - box の不変量: イニング得点の合計=最終スコア / 打者安打合計=チーム安打 /
//     投手失点合計=相手得点 / 投手アウト合計=消化アウト（在板帰属の近似でも総和は保存）
//   - 生イベント非永続（§17）: rec には box（集計行）のみが載り events は残らない
//   - save→load の replay で playerGameLog（box込み）が bit 一致（決定論）
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceDay, advanceTo, save, load } from '../src/game/index.mjs';

const SEED = 20260701;
const DAYS = 15; // 序盤2週間ぶんの自チーム試合で検証（テスト時間を抑える）

function boxInvariants(rec) {
  const b = rec.box;
  assert.ok(b, 'rec.box（簡易ボックススコア）が付く');
  assert.equal(b.home, rec.home);
  assert.equal(b.away, rec.away);
  assert.ok(b.starters.home && b.starters.away, '両軍の先発投手が記録される');
  // イニング得点の合計 = 最終スコア（暴投/捕逸の得点も batScore 同期で拾う）
  const sum = (k) => b.line.reduce((a, c) => a + (c[k] ?? 0), 0);
  assert.equal(sum('b'), rec.homeScore, 'ホームのイニング得点合計=最終スコア');
  assert.equal(sum('t'), rec.awayScore, 'ビジターのイニング得点合計=最終スコア');
  for (const side of ['home', 'away']) {
    const opp = side === 'home' ? 'away' : 'home';
    const oppScore = side === 'home' ? rec.awayScore : rec.homeScore;
    // 打者の安打合計 = チーム安打（H欄）
    const hSum = b.batters[side].reduce((a, x) => a + x.h, 0);
    assert.equal(hSum, b.hits[side], `${side} 打者の安打合計=チーム安打`);
    // 投手の失点合計 = 相手チームの得点
    const rSum = b.pitchers[side].reduce((a, x) => a + x.r, 0);
    assert.equal(rSum, oppScore, `${side} 投手の失点合計=相手得点`);
    // 被安打合計 = 相手チーム安打
    const haSum = b.pitchers[side].reduce((a, x) => a + x.h, 0);
    assert.equal(haSum, b.hits[opp], `${side} 投手の被安打合計=相手安打`);
    // 打者に打順（スタメン9人以上）と守備位置が付く
    const withOrd = b.batters[side].filter((x) => x.ord != null);
    assert.ok(withOrd.length >= 9, 'スタメン9人以上に打順が付く');
  }
  // 投手アウト合計（両軍）= 試合の総アウト（サヨナラ/裏なしぶんは自然に少ない）。
  // 厳密回数はイニング構造依存なので「妥当なレンジ」を検査（9回=51〜54アウトが典型・延長で増）。
  const outsTotal = b.pitchers.home.reduce((a, x) => a + x.outs, 0) + b.pitchers.away.reduce((a, x) => a + x.outs, 0);
  assert.ok(outsTotal >= (b.innings - 1) * 6 + 3, `総アウトが下限以上 (${outsTotal})`);
  assert.ok(outsTotal <= b.innings * 6, `総アウトが上限以下 (${outsTotal})`);
}

test('E4: 自チーム試合の rec.box が常に付き、集計の不変量を満たす', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  for (let i = 0; i < DAYS && !st.rt.finished; i++) advanceDay(st); // collectPlayerEvents なし（スキップ相当）
  assert.ok(st.rt.playerGameLog.length >= 5, '自チーム試合が消化されている');
  for (const rec of st.rt.playerGameLog) {
    boxInvariants(rec);
    assert.ok(!('events' in rec), '生イベントは rec に残らない（§17: 集計行のみ）');
  }
});

test('E4: 観戦イベント収集の有無で box も試合結果も bit 一致（onEvent 乱数非消費）', () => {
  const a = newGame(SEED, 'T2', { cfg: createConfig() });
  for (let i = 0; i < DAYS && !a.rt.finished; i++) advanceDay(a);
  const b = newGame(SEED, 'T2', { cfg: createConfig() });
  for (let i = 0; i < DAYS && !b.rt.finished; i++) advanceDay(b, { collectPlayerEvents: true });
  assert.equal(JSON.stringify(a.rt.playerGameLog), JSON.stringify(b.rt.playerGameLog),
    '観戦収集あり/なしで playerGameLog（box込み）が完全一致');
});

test('E4: save→load の replay で playerGameLog（box込み）が bit 一致', () => {
  const st = newGame(SEED, 'T3', { cfg: createConfig() });
  for (let i = 0; i < DAYS && !st.rt.finished; i++) advanceDay(st);
  const ref = JSON.stringify(st.rt.playerGameLog);
  const blob = JSON.parse(JSON.stringify(save(st))); // IndexedDB/JSON往復を模す
  assert.ok(blob.seasonState.playerGameLog.every((r) => r.box), 'セーブの playerGameLog に box（集計行のみ）が載る');
  const restored = load(blob, { cfg: createConfig() });
  assert.equal(JSON.stringify(restored.rt.playerGameLog), ref, 'load 後の replay で box が同一に再構築される');
  // ロード後の続行も破綻しない（節をまたいで box が付き続ける）
  const step = advanceTo(restored, 'nextPlayerGame');
  const last = step[step.length - 1];
  if (last.playerGames.length) boxInvariants(last.playerGames[last.playerGames.length - 1]);
});

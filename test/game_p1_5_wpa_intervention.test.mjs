// ============================================================================
// P1-5（thyroxin/reviews/game_review_20260724.md 観点6/8）:
//   wpaIsAfterIntervention(highlight, gameInterventions, box) — WPA勝因/敗因プレーが自分の
//   采配指示の直後の結果かどうかを判定する純関数（src/game/wpaSummary.mjs）のユニットテスト。
//   合成フィクスチャで境界・曖昧ケース（=false化）を直接検証する。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wpaIsAfterIntervention } from '../src/game/wpaSummary.mjs';

function highlight(o) {
  return { pid: 'A', inning: 5, half: 'bottom', desc: '適時打', wpa: 0.3, ...o };
}
function box(o) {
  return {
    starters: { home: 'H1', away: 'A1' },
    batters: { home: [], away: [] },
    pitchers: { home: [], away: [] },
    ...o,
  };
}
function iv(o) {
  return { year: 2030, day: 10, seq: 1, kind: 'ph', choice: { pick: 'A' }, ...o };
}

test('介入ログが空なら常にfalse（曖昧なら付けない）', () => {
  assert.equal(wpaIsAfterIntervention(highlight(), [], box()), false);
  assert.equal(wpaIsAfterIntervention(highlight(), null, box()), false);
});

test('highlightやboxが無ければfalse', () => {
  assert.equal(wpaIsAfterIntervention(null, [iv()], box()), false);
  assert.equal(wpaIsAfterIntervention(highlight(), [iv()], null), false);
});

test('kind=ph: 介入ログのpickと一致し、box打者行がpos=打（代打の証跡）ならtrue', () => {
  const b = box({ batters: { home: [{ pid: 'A', pos: '打', ab: 1, h: 1 }], away: [] } });
  assert.equal(wpaIsAfterIntervention(highlight({ pid: 'A' }), [iv({ choice: { pick: 'A' } })], b), true);
});

test('kind=ph: pickと一致してもbox打者行がpos=打でなければfalse（代打で入った証跡が無い＝曖昧）', () => {
  const b = box({ batters: { home: [{ pid: 'A', pos: 'ss', ab: 1, h: 1 }], away: [] } });
  assert.equal(wpaIsAfterIntervention(highlight({ pid: 'A' }), [iv({ choice: { pick: 'A' } })], b), false);
});

test('kind=ph: pickが別選手ならfalse（AIが自律判断した交代はログのpickと一致しない）', () => {
  const b = box({ batters: { home: [{ pid: 'A', pos: '打', ab: 1, h: 1 }], away: [] } });
  assert.equal(wpaIsAfterIntervention(highlight({ pid: 'A' }), [iv({ choice: { pick: 'B' } })], b), false);
});

test('kind=ph: 続投/そのまま（choice.pick=null）はhighlight.pidと一致し得ないためfalse', () => {
  const b = box({ batters: { home: [{ pid: 'A', pos: '打', ab: 1, h: 1 }], away: [] } });
  assert.equal(wpaIsAfterIntervention(highlight({ pid: 'A' }), [iv({ choice: { pick: null } })], b), false);
});

test('kind=relief: 介入ログのpickと一致し、先発投手でなければtrue（救援で入った証跡）', () => {
  const b = box({ starters: { home: 'H1', away: 'A1' } });
  assert.equal(
    wpaIsAfterIntervention(highlight({ pid: 'R9' }), [iv({ kind: 'relief', choice: { pick: 'R9' } })], b),
    true,
  );
});

test('kind=relief: pickが先発投手（試合の先発）と同じ値ならfalse（救援で入った証跡が無い＝異常系の安全側）', () => {
  const b = box({ starters: { home: 'H1', away: 'A1' } });
  assert.equal(
    wpaIsAfterIntervention(highlight({ pid: 'H1' }), [iv({ kind: 'relief', choice: { pick: 'H1' } })], b),
    false,
  );
});

test('kind=relief: pickが別投手ならfalse', () => {
  const b = box({ starters: { home: 'H1', away: 'A1' } });
  assert.equal(
    wpaIsAfterIntervention(highlight({ pid: 'R9' }), [iv({ kind: 'relief', choice: { pick: 'R1' } })], b),
    false,
  );
});

test('別試合のログ（呼び出し側でyear/dayフィルタ済みの前提が崩れるケース）は呼び出し側の責任だが、フィルタ済みなら混入しない', () => {
  // 本関数自体はyear/day比較をしない（呼び出し側が事前にフィルタする契約）。
  // フィルタを怠ると誤マッチしうることの回帰確認（=呼び出し側規約のドキュメント代わり）。
  const b = box({ batters: { home: [{ pid: 'A', pos: '打', ab: 1, h: 1 }], away: [] } });
  const otherGameIv = iv({ year: 2029, day: 3, choice: { pick: 'A' } });
  assert.equal(wpaIsAfterIntervention(highlight({ pid: 'A' }), [otherGameIv], b), true,
    '本関数はyear/dayを見ない＝呼び出し側が事前にフィルタする契約（schedule.mjs schedWpaTags参照）');
});

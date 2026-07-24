// ============================================================================
// thyroxin/reviews/game_review_20260724.md（P0-2/P0-3/P1-6/P1-8）: 表示層の情報設計改善で
// 追加した純関数群のユニットテスト。DOM(document)非依存の純関数のみを直接テストする
// （watch_label.test.mjs / ui_mgr_candidates.test.mjs と同型）。
//   - P0-3 statTable/WARリストのページングヘルパ（paginate・src/ui.mjs）
//   - P1-6 観戦「指標の変化」パネルのサンプルゲート判定（battingSampleGateMessage/
//     pitchingSampleGateMessage・src/ui/watch.mjs）
//   - P1-8 チーム選択カードの特色1行生成（parkFactorLabel/managerTypeLabel/budgetLabel/
//     teamFeatureLine・src/ui.mjs。観測可能な公開情報のみ・真値非参照）
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import {
  paginate, STAT_PAGE_SIZE, parkFactorLabel, managerTypeLabel, budgetLabel, teamFeatureLine,
} from '../src/ui.mjs';
import { battingSampleGateMessage, pitchingSampleGateMessage, METRIC_DELTA_MIN_PA, METRIC_DELTA_MIN_IP } from '../src/ui/watch.mjs';

// --- P0-3: paginate（ページング純関数） ------------------------------------
test('paginate: 既定ページサイズ(30)・1ページ目は先頭30件・続きがあればhasMore=true', () => {
  const r = paginate(100, 1);
  assert.equal(r.count, STAT_PAGE_SIZE);
  assert.equal(r.hasMore, true);
  assert.equal(r.remaining, 70);
});

test('paginate: 総数がページサイズ未満なら1ページ目で全件・hasMore=false', () => {
  const r = paginate(12, 1);
  assert.equal(r.count, 12);
  assert.equal(r.hasMore, false);
  assert.equal(r.remaining, 0);
});

test('paginate: ページを進めるとcountが+30ずつ増え、末尾ページでhasMore=falseになる', () => {
  const total = 65;
  const p1 = paginate(total, 1);
  assert.equal(p1.count, 30);
  assert.equal(p1.hasMore, true);
  const p2 = paginate(total, 2);
  assert.equal(p2.count, 60);
  assert.equal(p2.hasMore, true);
  const p3 = paginate(total, 3);
  assert.equal(p3.count, 65); // 総数でクランプ
  assert.equal(p3.hasMore, false);
  assert.equal(p3.remaining, 0);
});

test('paginate: 総数0・ページ0/負数などの防御的な入力でも例外を投げない', () => {
  assert.deepEqual(paginate(0, 1), { count: 0, hasMore: false, remaining: 0 });
  assert.equal(paginate(50, 0).count, 30); // page<1は1に丸める
  assert.equal(paginate(50, -3).count, 30);
});

test('paginate: カスタムpageSizeにも対応する', () => {
  const r = paginate(25, 1, 10);
  assert.equal(r.count, 10);
  assert.equal(r.hasMore, true);
  assert.equal(r.remaining, 15);
});

// --- P1-6: サンプルゲート判定（指標の変化パネル） ---------------------------
test('battingSampleGateMessage: 当季打席が閾値未満なら「参考値までもう少し」を返す', () => {
  assert.equal(battingSampleGateMessage(0), '参考値までもう少し（0打席）');
  assert.equal(battingSampleGateMessage(5), '参考値までもう少し（5打席）');
  assert.equal(battingSampleGateMessage(METRIC_DELTA_MIN_PA - 1), `参考値までもう少し（${METRIC_DELTA_MIN_PA - 1}打席）`);
});

test('battingSampleGateMessage: 当季打席が閾値以上ならnull（通常表示＝ゲートしない）', () => {
  assert.equal(battingSampleGateMessage(METRIC_DELTA_MIN_PA), null);
  assert.equal(battingSampleGateMessage(50), null);
});

test('pitchingSampleGateMessage: 当季投球回が閾値未満なら「参考値までもう少し」を返す（小数1桁表記）', () => {
  assert.equal(pitchingSampleGateMessage(0), '参考値までもう少し（0.0回）');
  assert.equal(pitchingSampleGateMessage(3.33333), '参考値までもう少し（3.3回）');
  assert.equal(pitchingSampleGateMessage(METRIC_DELTA_MIN_IP - 0.1), `参考値までもう少し（${(METRIC_DELTA_MIN_IP - 0.1).toFixed(1)}回）`);
});

test('pitchingSampleGateMessage: 当季投球回が閾値以上ならnull（通常表示＝ゲートしない。小サンプルのERA27.00等はバグでなく正当な値だが、閾値以上では出し惜しみしない）', () => {
  assert.equal(pitchingSampleGateMessage(METRIC_DELTA_MIN_IP), null);
  assert.equal(pitchingSampleGateMessage(120), null);
});

test('サンプルゲートの境界はカスタム閾値を渡しても正しく動く', () => {
  assert.equal(battingSampleGateMessage(4, 5), '参考値までもう少し（4打席）');
  assert.equal(battingSampleGateMessage(5, 5), null);
  assert.equal(pitchingSampleGateMessage(4.9, 5), '参考値までもう少し（4.9回）');
  assert.equal(pitchingSampleGateMessage(5, 5), null);
});

// --- P1-8: チーム選択カードの特色1行 ---------------------------------------
const cfg = createConfig();
const league = generateLeague(20260701, cfg);

test('parkFactorLabel: 中立ジオメトリ（cfg既定値そのまま）は「中立」を返す', () => {
  const P = cfg.tuning.park;
  const neutralPark = { lfLineM: P.baseLine, rfLineM: P.baseLine, centerDistM: P.baseCenter, fenceHeightM: P.baseHeight };
  assert.equal(parkFactorLabel(neutralPark, cfg), '中立');
});

test('parkFactorLabel: 距離が近くフェンスが低い球場は「打者有利」', () => {
  const P = cfg.tuning.park;
  const hitterPark = { lfLineM: P.baseLine - 5, rfLineM: P.baseLine - 5, centerDistM: P.baseCenter - 5, fenceHeightM: P.baseHeight - 2 };
  assert.equal(parkFactorLabel(hitterPark, cfg), '打者有利');
});

test('parkFactorLabel: 距離が遠くフェンスが高い球場は「投手有利」', () => {
  const P = cfg.tuning.park;
  const pitcherPark = { lfLineM: P.baseLine + 5, rfLineM: P.baseLine + 5, centerDistM: P.baseCenter + 5, fenceHeightM: P.baseHeight + 2 };
  assert.equal(parkFactorLabel(pitcherPark, cfg), '投手有利');
});

test('managerTypeLabel: buntTend/stealTendが共に平均(50)なら「標準」', () => {
  assert.equal(managerTypeLabel({ buntTend: 50, stealTend: 50 }), '標準');
});

test('managerTypeLabel: buntTend/stealTendが共に高いと「機動力重視」', () => {
  assert.equal(managerTypeLabel({ buntTend: 65, stealTend: 65 }), '機動力重視');
});

test('managerTypeLabel: buntTend/stealTendが共に低いと「強攻型」', () => {
  assert.equal(managerTypeLabel({ buntTend: 30, stealTend: 30 }), '強攻型');
});

test('budgetLabel: 平均予算(mean)は「標準」', () => {
  const B = cfg.tuning.economy.budget;
  assert.equal(budgetLabel({ budget: B.mean }, cfg), '標準');
});

test('budgetLabel: 平均+1SD超は「潤沢」・平均-1SD未満は「緊縮」', () => {
  const B = cfg.tuning.economy.budget;
  assert.equal(budgetLabel({ budget: B.mean + B.sd }, cfg), '潤沢');
  assert.equal(budgetLabel({ budget: B.mean - B.sd }, cfg), '緊縮');
});

test('teamFeatureLine: 生成リーグの全12球団で1行の特色文字列を返し、真値(trueAbility等)は一切参照しない', () => {
  assert.equal(league.teams.length, 12);
  for (const t of league.teams) {
    const line = teamFeatureLine(t, cfg);
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 0 && line.length < 60, `1行に収まる長さ (got "${line}")`);
    assert.ok(/(打者有利|投手有利|中立)/.test(line), `本拠地傾向を含む (got "${line}")`);
    assert.ok(/(機動力重視|強攻型|標準)/.test(line), `監督タイプを含む (got "${line}")`);
    assert.ok(/資金力(潤沢|標準|緊縮)/.test(line), `資金力を含む (got "${line}")`);
  }
});

test('teamFeatureLine: 引数はteam.park/team.manager/team.financeの公開フィールドのみ（trueAbility未使用の構造的保証）', () => {
  // team.playerIds すら参照しない最小オブジェクトでも動作する＝真値(選手能力)に依存しないことの構造的裏付け。
  const minimal = {
    park: { lfLineM: 100, rfLineM: 100, centerDistM: 122, fenceHeightM: 4 },
    manager: { buntTend: 50, stealTend: 50 },
    finance: { budget: cfg.tuning.economy.budget.mean },
  };
  assert.equal(teamFeatureLine(minimal, cfg), '中立の本拠地・標準の監督・資金力標準');
});

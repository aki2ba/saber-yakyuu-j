// 観戦画面の打球ラベル。アウトになった打球は「責任野手(fielderPos)」で言語化しなければならない。
//
// 回帰: EV121km/h・LA47°・飛距離33m の内野への高いポップフライ（滞空5.0秒）は、
// Statcast の打球種別では FB（25-50°）に分類される。旧実装はこれを「打球種別FB → 外野方向」と
// 解釈し、spray角が正なので「ライトフライでアウト」と表示していた。
// 一方エンジンは責任野手を一塁手（捕球確率 0.996）と正しく判定し、OAA変化も ≈0 だった。
// 表示とエンジンが食い違っていたバグ（ユーザー報告）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { neutralResponsible } from '../src/sim/fieldingGeometry.mjs';
import { battedType } from '../src/sim/battedBallResult.mjs';
import { watchPaBody, watchResShort } from '../src/ui/watch.mjs';

const cfg = createConfig();
const mkEvent = (over = {}) => ({
  outcome: 'out',
  result: 'out',
  runsOnPlay: 0,
  outsBefore: 0,
  outsAfter: 1,
  ...over,
});

test('内野への高いポップフライ（EV121/LA47/33m）は「ファーストフライ」であり「ライトフライ」ではない', () => {
  const bb = { evKmh: 121, laDeg: 47, sprayDeg: 25, distanceM: 32.2 };
  // エンジン側: 打球種別は FB だが、責任野手は一塁手
  assert.equal(battedType(bb.laDeg), 'FB', 'Statcast の境界では FB(25-50°)');
  const nr = neutralResponsible(bb, 'FB', cfg);
  assert.equal(nr.pos, '1B', `責任野手は一塁手 (got ${nr.pos})`);
  assert.ok(nr.pOut > 0.95, `捕って当然のポップフライ pOut=${nr.pOut}`);

  // UI 側: 責任野手で言語化される
  const e = mkEvent({ bb, battedType: 'FB', fielderPos: nr.pos });
  assert.equal(watchPaBody(e, null).body, 'ファーストフライでアウト');
  assert.equal(watchResShort(e), '一飛');
});

test('アウトの打球ラベルは責任野手に従う（打球種別とスプレー角から推測しない）', () => {
  const cases = [
    { battedType: 'GB', fielderPos: 'SS', body: 'ショートゴロでアウト', chip: '遊ゴ' },
    { battedType: 'LD', fielderPos: 'CF', body: 'センターライナーでアウト', chip: '中直' },
    { battedType: 'FB', fielderPos: 'LF', body: 'レフトフライでアウト', chip: '左飛' },
    { battedType: 'PU', fielderPos: 'C', body: 'キャッチャー小フライでアウト', chip: '捕飛' },
    // spray角は右方向なのに、責任野手が三塁手ならサードゴロ
    { battedType: 'GB', fielderPos: '3B', body: 'サードゴロでアウト', chip: '三ゴ', sprayDeg: 30 },
  ];
  for (const c of cases) {
    const e = mkEvent({ bb: { evKmh: 140, laDeg: 0, sprayDeg: c.sprayDeg ?? 0, distanceM: 20 }, battedType: c.battedType, fielderPos: c.fielderPos });
    assert.equal(watchPaBody(e, null).body, c.body, `${c.fielderPos}/${c.battedType}`);
    assert.equal(watchResShort(e), c.chip, `${c.fielderPos}/${c.battedType} の略記`);
  }
});

test('安打の方向表記はスプレー角のまま（責任野手ではない）', () => {
  // 三遊間を抜けたゴロの OAA 責任は遊撃手だが、打球はレフトへ抜ける＝「左前ヒット」
  const e = mkEvent({ result: '1B', bb: { evKmh: 140, laDeg: -5, sprayDeg: -25, distanceM: 20 }, battedType: 'GB', fielderPos: 'SS' });
  assert.equal(watchPaBody(e, null).body, 'レフト前へヒット');
  assert.equal(watchResShort(e), '左安');
});

test('失策は責任野手で言語化される', () => {
  const e = mkEvent({ result: 'E', bb: { evKmh: 140, laDeg: -5, sprayDeg: -10, distanceM: 20 }, battedType: 'GB', fielderPos: 'SS' });
  assert.equal(watchPaBody(e, null).body, 'ショートのエラーで出塁');
});

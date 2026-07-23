// ============================================================================
// fun_theory_research_20260720.md P5/P6 のテスト（表示層のみ・エンジン非干渉）。
//   P5: draftClassHeadlines（src/game/storylines.mjs）… ドラフト前ニュース「今年の逸材」。
//     - state.awaitingDraft が無ければ空配列
//     - 真値(trueAbility)非参照＝draftScoutView/draftPreviewHeadlines と同じ三層構造ゲート越しの
//       素材のみ使用（prospect.trueAbility には一切触れない・戻り値にtrueAbilityは含まれない）
//     - 決定論: 同一state入力は同一出力（テンプレ選択もhashSeed決定論）
//     - draftClassMax（cfg.tuning.storylines）で件数上限が効く
//   P6: 性格→ニュース文体の接続（H3積み残し）。
//     - notableHeadline（src/game/news.mjs）: personalityOf省略時は既存テキストと byte 同一
//       （後方互換）。personalityOf を渡すと PERSONALITIES 全種で文体が分岐し、決定論を保つ。
//     - rivalryGameHeadlines（src/game/storylines.mjs）: names.personalityOf を渡すと性格タグの
//       一言が付記される（base文言は不変・後方互換）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, submitDraftPick } from '../src/game/index.mjs';
import { draftClassHeadlines, rivalryGameHeadlines } from '../src/game/storylines.mjs';
import { notableHeadline } from '../src/game/news.mjs';
import { PERSONALITIES } from '../src/model/player.mjs';

const SEED = 20260701;

// --- P5: draftClassHeadlines のフィクスチャ（H2対話ドラフトを自チーム指名番まで進める） -------
/** シーズン終了→advanceYearを繰り返し、自チームの指名番で最初に中断した state を返す（H2と同型）。 */
function toFirstPause(seed, cfgOverride = {}, maxYears = 10) {
  const cfg = createConfig({ game: { interactiveDraft: true, ...cfgOverride.game }, ...cfgOverride });
  const st = newGame(seed, 'T1', { cfg });
  for (let y = 0; y < maxYears; y++) {
    advanceTo(st, 'seasonEnd');
    const off = advanceYear(st);
    if (off === null) return st;
  }
  throw new Error(`toFirstPause: ${maxYears}年以内に自チームの指名番が発生しなかった`);
}

function draftNames(aw) {
  return {
    pnameOf: (id) => { const pr = aw.pool.find((p) => p.id === id); return pr ? pr.name : id; },
    posLabelOf: (pos) => pos,
  };
}

test('P5: draftClassHeadlines — awaitingDraft が無ければ空配列', () => {
  const cfg = createConfig();
  const st = newGame(SEED, 'T1', { cfg });
  assert.deepEqual(draftClassHeadlines(st, {}), [], 'ドラフト会議室が開いていなければ空配列');
});

test('P5: draftClassHeadlines — round1の中断で「今年の逸材」見出しが生成される（真値非参照）', () => {
  const st = toFirstPause(SEED);
  assert.ok(st.awaitingDraft, 'このシードでは自チームの指名番で中断している');
  const aw = st.awaitingDraft;
  const heads = draftClassHeadlines(st, draftNames(aw));
  assert.ok(heads.length >= 1, '少なくとも1件の見出しが生成される');
  assert.ok(heads.some((h) => h.kind === 'top'), '総合トップ（今年の逸材）が含まれる');
  const topHead = heads.find((h) => h.kind === 'top');
  assert.ok(topHead.text.includes('逸材') || topHead.text.includes('目玉') || topHead.text.includes('頂点'),
    '総合トップの見出しは「今年の逸材」系のテンプレ文言を含む');
  for (const h of heads) {
    assert.ok(['text', 'cls', 'prospectId', 'kind'].every((k) => k in h), '各見出しが必要なキーを持つ');
    assert.ok(aw.pool.some((p) => p.id === h.prospectId), 'prospectId は実際のプールに存在する');
    assert.ok(!('trueAbility' in h), '戻り値に trueAbility キーが無い（真値非参照）');
    assert.ok(!JSON.stringify(h).includes('trueAbility'), '見出しオブジェクトの文字列化にも trueAbility が現れない');
  }
});

test('P5: draftClassHeadlines — 決定論（同一state入力は同一出力）', () => {
  const st = toFirstPause(SEED);
  const aw = st.awaitingDraft;
  const names = draftNames(aw);
  const a = JSON.stringify(draftClassHeadlines(st, names));
  const b = JSON.stringify(draftClassHeadlines(st, names));
  assert.equal(a, b, '同一state入力に対し同一出力（純関数・hashSeed決定論）');
});

test('P5: draftClassHeadlines — cfg.tuning.storylines.draftClassMax で件数上限が効く', () => {
  const cfgOverride = { tuning: { storylines: { draftClassMax: 1 } } };
  const st = toFirstPause(SEED, cfgOverride);
  const aw = st.awaitingDraft;
  assert.equal(st.cfg.tuning.storylines.draftClassMax, 1, 'createConfigのマージでdraftClassMaxが反映されている');
  const heads = draftClassHeadlines(st, draftNames(aw));
  assert.ok(heads.length <= 1, 'draftClassMax=1のとき最大1件までしか返らない');
});

test('P5: draftClassHeadlines — プール生成順序・乱数消費を変えない（指名を進めても既存の解決結果は不変）', () => {
  const stA = toFirstPause(SEED);
  const stB = toFirstPause(SEED);
  // draftClassHeadlines を呼んでから指名を進めた場合と、呼ばずに進めた場合で、
  // ドラフト結果（picksSoFar集合）が変わらない＝draftClassHeadlinesはプールの乱数ストリームを消費しない。
  draftClassHeadlines(stA, draftNames(stA.awaitingDraft));
  const pickOf = (aw) => {
    const types = new Set(aw.vacTypes.map((v) => `${v.role}:${v.primaryPos}`));
    const cand = aw.pool.filter((p) => types.has(`${p.role}:${p.primaryPos}`)).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    return cand[0].id;
  };
  let offA = null;
  while (offA === null) offA = submitDraftPick(stA, pickOf(stA.awaitingDraft));
  let offB = null;
  while (offB === null) offB = submitDraftPick(stB, pickOf(stB.awaitingDraft));
  assert.equal(JSON.stringify(offA.rookies), JSON.stringify(offB.rookies),
    'draftClassHeadlines呼び出しの有無でドラフト解決結果（新人一覧）が変わらない＝乱数ストリーム非干渉');
});

// --- P6: notableHeadline の性格分岐 --------------------------------------------------------

test('P6: notableHeadline — personalityOf省略時は従来と同一テキスト（後方互換）', () => {
  const pnameOf = (id) => id;
  const tnameOf = (id) => id;
  const cycle = notableHeadline({ kind: 'cycle', batterId: 'P1', teamId: 'T1' }, pnameOf, tnameOf);
  assert.equal(cycle, 'サイクル安打！ P1が単打・二塁打・三塁打・本塁打をすべて記録');
  const multi = notableHeadline({ kind: 'multiHit', batterId: 'P2', teamId: 'T1', hits: 4 }, pnameOf, tnameOf);
  assert.equal(multi, 'P2が猛打賞（4安打）の固め打ち');
});

test('P6: notableHeadline — 全PERSONALITIESで文体が分岐し、選手名を含み、決定論を保つ', () => {
  const pnameOf = (id) => id;
  const tnameOf = (id) => id;
  const baseCycle = notableHeadline({ kind: 'cycle', batterId: 'P1', teamId: 'T1' }, pnameOf, tnameOf);
  const baseMulti = notableHeadline({ kind: 'multiHit', batterId: 'P2', teamId: 'T1', hits: 4 }, pnameOf, tnameOf);
  for (const personality of PERSONALITIES) {
    const personalityOf = () => personality;
    const cycle = notableHeadline({ kind: 'cycle', batterId: 'P1', teamId: 'T1' }, pnameOf, tnameOf, personalityOf);
    const multi = notableHeadline({ kind: 'multiHit', batterId: 'P2', teamId: 'T1', hits: 4 }, pnameOf, tnameOf, personalityOf);
    assert.ok(cycle.includes('P1'), `${personality}: サイクル見出しに選手名が含まれる`);
    assert.ok(multi.includes('P2'), `${personality}: 猛打賞見出しに選手名が含まれる`);
    assert.notEqual(cycle, baseCycle, `${personality}: サイクル見出しがデフォルト文言から分岐する`);
    assert.notEqual(multi, baseMulti, `${personality}: 猛打賞見出しがデフォルト文言から分岐する`);
    // 決定論: 同一入力は同一出力
    const cycle2 = notableHeadline({ kind: 'cycle', batterId: 'P1', teamId: 'T1' }, pnameOf, tnameOf, personalityOf);
    assert.equal(cycle, cycle2, `${personality}: 同一入力で同一出力（決定論）`);
  }
});

test('P6: notableHeadline — 未知の性格文字列/null は従来テキストへフォールバック', () => {
  const pnameOf = (id) => id;
  const tnameOf = (id) => id;
  const base = notableHeadline({ kind: 'cycle', batterId: 'P1', teamId: 'T1' }, pnameOf, tnameOf);
  const withNull = notableHeadline({ kind: 'cycle', batterId: 'P1', teamId: 'T1' }, pnameOf, tnameOf, () => null);
  const withUnknown = notableHeadline({ kind: 'cycle', batterId: 'P1', teamId: 'T1' }, pnameOf, tnameOf, () => 'unknownPersonalityXYZ');
  assert.equal(withNull, base, 'personality=null は従来テキストと一致');
  assert.equal(withUnknown, base, '未知のpersonality文字列も従来テキストへフォールバック');
});

// --- P6: rivalryGameHeadlines の性格分岐 ----------------------------------------------------

function rivalryFixture() {
  const cfg = createConfig();
  return {
    cfg, masterSeed: 123, year: 2027,
    transactionLog: [
      { year: 2026, kind: 'trade', playerId: 'P1', playerId2: 'P9', from: 'T1', to: 'T2' },
    ],
    rt: {
      playerGameLog: [
        {
          day: 10, home: 'T2', away: 'T1',
          box: { batters: { home: [{ pid: 'P1', hr: 2, h: 3 }], away: [] }, pitchers: { home: [], away: [] } },
        },
      ],
    },
  };
}

test('P6: rivalryGameHeadlines — personalityOf省略時は従来と同一テキスト（後方互換）', () => {
  const st = rivalryFixture();
  const names = { pnameOf: (id) => id, tnameOf: (id) => id };
  const heads = rivalryGameHeadlines(st, names, 5);
  assert.equal(heads.length, 1, '因縁該当選手の活躍が1件検出される');
  assert.ok(!heads[0].text.includes('（'), 'personalityOf省略時は性格タグの付記が無い');
});

test('P6: rivalryGameHeadlines — personalityOf を渡すと性格タグの一言が付記され、base文言は不変', () => {
  const st = rivalryFixture();
  const baseNames = { pnameOf: (id) => id, tnameOf: (id) => id };
  const base = rivalryGameHeadlines(st, baseNames, 5)[0].text;
  for (const personality of PERSONALITIES) {
    const names = { pnameOf: (id) => id, tnameOf: (id) => id, personalityOf: (id) => (id === 'P1' ? personality : null) };
    const heads = rivalryGameHeadlines(st, names, 5);
    assert.equal(heads.length, 1);
    assert.ok(heads[0].text.startsWith(base), `${personality}: base文言が保たれる`);
    assert.notEqual(heads[0].text, base, `${personality}: 性格タグの一言が付記され base と異なる`);
  }
});

test('P6: rivalryGameHeadlines — 決定論（同一state入力・同一personalityOfは同一出力）', () => {
  const st = rivalryFixture();
  const names = { pnameOf: (id) => id, tnameOf: (id) => id, personalityOf: (id) => (id === 'P1' ? 'showboat' : null) };
  const a = JSON.stringify(rivalryGameHeadlines(st, names, 5));
  const b = JSON.stringify(rivalryGameHeadlines(st, names, 5));
  assert.equal(a, b, '同一入力は同一出力');
});

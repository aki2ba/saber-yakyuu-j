// §tactics_re（2026-07-23・ユーザー指示「得点期待値を考えて比較。プログラムでできるはず」）:
// 戦術判断（犠打/敬遠/盗塁）のRE(得点期待値)駆動化のテスト。
//   ① tuning.tactics.reTable が context.deriveTables の実測と近似一致（許容±0.15）
//   ② buntTransitionBits（ΔRE_bunt の遷移先）が resolveBunt（sim/game.mjs）の実挙動と一致
//   ③ 「一死二塁単独」「次打者投手」がRE比較（buntDecisionScore・保険ゲート抜き）で自然に負になる
//   ④ 無死一塁×弱打者×接戦でバントが正になりうる（NPB近似=npbBiasが保たれていることの確認）
//   ⑤ 盗塁breakevenの式（stealLogitAdjustの内部計算を手計算で再現し突き合わせる）
//   ⑥ 決定論（同一入力→同一出力の純関数であること）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import {
  neutralManager,
  buntAttemptProb,
  buntDecisionScore,
  ibbProb,
  stealLogitAdjust,
  tacticsBaseBits,
  buntTransitionBits,
} from '../src/sim/manager.mjs';
import { resolveBunt } from '../src/sim/game.mjs';

const cfg = createConfig();
const mgr = neutralManager();

// --- ① reTable ≈ context.deriveTables の実測（許容±0.15） -------------------
// RE表自体がバント/敬遠/盗塁の判断に使われる自己参照構造のため、単一seedでは希少状態
// （0死3塁単独等）の推定が振れる（config.mjs のコメント参照）。config導出時と同じ8seed平均で
// 実測し、近似一致（許容±0.15）を検証する（時間がかかるため timeout を明示的に緩和）。
test('tuning.tactics.reTable: context.deriveTables の実測(8seed平均)と近似一致（許容±0.15）', { timeout: 60000 }, () => {
  const SEEDS = [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033];
  const sums = new Array(24).fill(0);
  for (const seed of SEEDS) {
    const lg = generateLeague(seed, cfg);
    const res = simulateSeason(lg, cfg, { season: 2026, seed, postseason: false, context: true });
    for (let i = 0; i < 24; i++) sums[i] += res.contextTables.re[i];
  }
  const measured = sums.map((x) => x / SEEDS.length);
  const stored = cfg.tuning.tactics.reTable;
  assert.equal(stored.length, 24);
  let maxDiff = 0;
  for (let i = 0; i < 24; i++) {
    const diff = Math.abs(measured[i] - stored[i]);
    maxDiff = Math.max(maxDiff, diff);
    assert.ok(diff <= 0.15, `idx=${i}: measured=${measured[i].toFixed(3)} stored=${stored[i].toFixed(3)} diff=${diff.toFixed(3)}`);
  }
  assert.ok(maxDiff < 0.15, `最大乖離 ${maxDiff.toFixed(3)}`);
});

// --- ② buntTransitionBits が resolveBunt（sim/game.mjs）の実挙動と一致 -------
function mkResolveBuntCtx(basesInit) {
  const bases = basesInit.slice();
  const fielding = { cur: { pitches: 0, bf: 0, outs: 0 } };
  const bStat = { batting: { pitches: 0, lumpedPitches: 0, pa: 0, sh: 0, ab: 0, h: 0, b1: 0 } };
  const pStat = { pitching: { pitches: 0, lumpedPitches: 0, bf: 0, outs: 0, h: 0 } };
  return { bases, fielding, bStat, pStat };
}
function runResolveBunt(basesInit, outs, uForRng) {
  const { bases, fielding, bStat, pStat } = mkResolveBuntCtx(basesInit);
  const rng = { next: () => uForRng };
  const r = resolveBunt({}, fielding, bases, outs, cfg, rng, 'BATTER', bStat, pStat);
  return { bases, outsAfter: r.outs };
}

test('buntTransitionBits: resolveBunt の実挙動と一致（成功/失敗/内野安打 × 1B単独/2B単独/1B&2B）', () => {
  const t = cfg.tuning.bunt;
  const uSuccess = t.successProb / 2; // successProb区間内
  const uFail = t.successProb + t.failProb / 2; // failProb区間内
  const uHit = t.successProb + t.failProb + t.hitProb / 2; // hitProb区間内

  const cases = [
    { bases: ['R1', null, null], bits: 1 },
    { bases: [null, 'R2', null], bits: 2 },
    { bases: ['R1', 'R2', null], bits: 3 },
  ];
  for (const { bases, bits } of cases) {
    const outs = 0;
    const exp = buntTransitionBits(bits);

    const succRun = runResolveBunt(bases, outs, uSuccess);
    assert.equal(tacticsBaseBits(succRun.bases), exp.success, `成功遷移 bits=${bits}`);
    assert.equal(succRun.outsAfter, outs + 1, `成功はアウト+1 bits=${bits}`);

    const failRun = runResolveBunt(bases, outs, uFail);
    assert.equal(tacticsBaseBits(failRun.bases), exp.fail, `失敗遷移 bits=${bits}`);
    assert.equal(failRun.outsAfter, outs + 1, `失敗はアウト+1 bits=${bits}`);

    const hitRun = runResolveBunt(bases, outs, uHit);
    assert.equal(tacticsBaseBits(hitRun.bases), exp.hit, `内野安打遷移 bits=${bits}`);
    assert.equal(hitRun.outsAfter, outs, `内野安打はアウト不変 bits=${bits}`);
  }
});

// --- ③ 「一死二塁単独」「次打者投手」がRE比較で自然に負になる ------------------
test('buntDecisionScore: 一死二塁単独・次打者投手はRE比較（保険ゲート抜き）でも中立打者より明確に不利', () => {
  const lgWoba = cfg.tuning.mgr.wobaPrior;
  // 基準: 無死一塁・平凡打者・次打者も平凡（バントが許可される典型局面）
  const baseline = buntDecisionScore(1, 0, 0.27, lgWoba, cfg);
  // 一死二塁単独（保険ゲートが無ければ許容されてしまう局面）: 成功しても二死三塁で犠飛も使えない
  const second1out = buntDecisionScore(2, 1, 0.27, lgWoba, cfg);
  assert.ok(second1out < baseline, '一死二塁単独はbaselineより明確に不利');
  // 次打者が投手（観測wOBAが極端に低い＝典型的な投手打撃成績 .15 程度）
  const nextPitcher = buntDecisionScore(1, 0, 0.27, 0.15, cfg);
  assert.ok(nextPitcher < baseline, '次打者が投手ならbaselineより明確に不利');
  // 無死二塁（従来どおり許可される局面）はbaseline付近〜有利側であることを確認（ゲート対象外の妥当性）
  const second0out = buntDecisionScore(2, 0, 0.27, lgWoba, cfg);
  assert.ok(second0out > second1out, '無死二塁は一死二塁単独より明確に有利（犠飛が使える一死三塁へ進むため）');
});

// --- ④ 無死一塁×弱打者×接戦でバントが正になりうる（NPB近似=npbBiasが効いている） -------
test('buntAttemptProb: 無死一塁×弱打者×接戦でバントが正になりうる（NPB近似が保たれる）', () => {
  const situ = {
    manager: mgr,
    bases: ['R1', null, null],
    outs: 0,
    scoreDiff: 0,
    batterWoba: 0.24, // 弱打者
    isPitcher: false,
    nextBatterWoba: cfg.tuning.mgr.wobaPrior,
  };
  const p = buntAttemptProb(situ, cfg);
  assert.ok(p > 0 && p < 1, `無死一塁の弱打者は正の試行確率を持つ (${p})`);
});

test('buntAttemptProb: 一死二塁単独・次打者投手は保険ゲートで確実に0（RE計算に到達しない）', () => {
  const second1out = { manager: mgr, bases: [null, 'R2', null], outs: 1, scoreDiff: 0, batterWoba: 0.27, isPitcher: false };
  assert.equal(buntAttemptProb(second1out, cfg), 0);
  const beforePitcher = { manager: mgr, bases: ['R1', null, null], outs: 0, scoreDiff: 0, batterWoba: 0.27, isPitcher: false, nextIsPitcher: true };
  assert.equal(buntAttemptProb(beforePitcher, cfg), 0);
});

// --- ⑤ 盗塁breakevenの式 -----------------------------------------------------
test('stealLogitAdjust: 盗塁の損益分岐（breakeven = [RE(now)-RE(fail)]/[RE(succ)-RE(fail)]）', () => {
  const re = cfg.tuning.tactics.reTable;
  const idx = (base, outs) => outs * 8 + base;
  for (const outs of [0, 1, 2]) {
    const reNow = re[idx(1, outs)];
    const reSucc = re[idx(2, outs)];
    const reFail = outs + 1 >= 3 ? 0 : re[idx(0, outs + 1)];
    const breakeven = (reNow - reFail) / (reSucc - reFail);
    assert.ok(breakeven > 0.6 && breakeven < 0.85, `breakeven(outs=${outs})=${breakeven.toFixed(3)} は妥当域`);

    const s = cfg.tuning.steal;
    // 推定成功率がbreakevenを大きく下回る（gate超過）→ 減点が働く
    const lowSucc = breakeven - s.breakevenGapGate - 0.15;
    const adjLow = stealLogitAdjust(mgr, { scoreDiff: 0, outs, batterWoba: 0.3, estSuccessProb: lowSucc }, cfg);
    assert.ok(adjLow < -1e-9, `outs=${outs}: breakeven未満で自重（adj=${adjLow}）`);
    // gate幅以内（僅差）→ 減点なし
    const nearSucc = breakeven - s.breakevenGapGate / 2;
    const adjNear = stealLogitAdjust(mgr, { scoreDiff: 0, outs, batterWoba: 0.3, estSuccessProb: nearSucc }, cfg);
    assert.ok(Math.abs(adjNear) < 1e-9, `outs=${outs}: gate幅以内は減点なし（adj=${adjNear}）`);
    // breakevenを大きく上回る→ 減点なし
    const highSucc = Math.min(0.99, breakeven + 0.2);
    const adjHigh = stealLogitAdjust(mgr, { scoreDiff: 0, outs, batterWoba: 0.3, estSuccessProb: highSucc }, cfg);
    assert.ok(Math.abs(adjHigh) < 1e-9, `outs=${outs}: breakeven超過は減点なし（adj=${adjHigh}）`);
  }
});

// --- ⑥ 決定論（純関数） ------------------------------------------------------
test('決定論: buntDecisionScore/stealLogitAdjust/ibbProb/buntAttemptProb は同一入力→同一出力', () => {
  assert.equal(buntDecisionScore(3, 1, 0.29, 0.31, cfg), buntDecisionScore(3, 1, 0.29, 0.31, cfg));
  const situS = { scoreDiff: 1, outs: 1, batterWoba: 0.3, estSuccessProb: 0.6 };
  assert.equal(stealLogitAdjust(mgr, situS, cfg), stealLogitAdjust(mgr, situS, cfg));
  const situI = { manager: mgr, bases: [null, 'R2', 'R3'], outs: 1, inning: 8, scoreDiff: 0, batterWoba: 0.4, nextIsPitcher: false };
  assert.equal(ibbProb(situI, cfg), ibbProb(situI, cfg));
  const situB = { manager: mgr, bases: ['R1', null, null], outs: 0, scoreDiff: 0, batterWoba: 0.25, isPitcher: false, nextBatterWoba: 0.3 };
  assert.equal(buntAttemptProb(situB, cfg), buntAttemptProb(situB, cfg));
});

// --- ibb RE損益サニティゲート（§tactics_re タスク3） -------------------------
// この engine の ibbProb 成立条件（bases[0]空き×得点圏あり）では、IBBは定義上つねに
// 満塁化を伴う（1塁を歩かせて埋める）＝「満塁化」は例外ではなく通常ケース。よって
// ibbMaxReLoss は実測ΔRE（最大0.238程度）より十分高く設定した保険（通常運用では作動しない・
// config.mjsコメント参照）。ここでは①通常のreTableでは強打者IBBが従来どおり発現すること、
// ②RE損が異常に大きい局面（reTableを差し替えた合成シナリオ）では確実に禁止されることの
// 両方を検証する（ゲート機構そのものの健全性）。
test('ibbProb: 通常運用ではRE損ゲートは作動しない（従来どおりIBBが発現）', () => {
  const base = { manager: mgr, inning: 9, scoreDiff: 0, batterWoba: 0.4, nextIsPitcher: false };
  for (const outs of [1, 2]) {
    for (const bases of [[null, 'R2', null], [null, 'R2', 'R3'], [null, null, 'R3']]) {
      assert.ok(ibbProb({ ...base, outs, bases }, cfg) > 0, `outs=${outs} ${JSON.stringify(bases)}: 通常運用ではIBBが発現`);
    }
  }
});

test('ibbProb: RE損が異常に大きい局面（合成reTable）ではゲートが確実に作動する', () => {
  // 合成reTable: 一死・2B→loaded(1B&2B) の RE差を極端に大きくする（idx=outs*8+base=1*8+3=11。
  // 現実にはあり得ない値で機構のみ検証）
  const extremeCfg = createConfig({
    tuning: { tactics: { reTable: cfg.tuning.tactics.reTable.map((v, i) => (i === 11 ? 5.0 : v)) } },
  });
  const situ = { manager: mgr, inning: 9, outs: 1, scoreDiff: 0, batterWoba: 0.4, nextIsPitcher: false, bases: [null, 'R2', null] };
  assert.ok(ibbProb(situ, cfg) > 0, '通常reTableでは発現');
  assert.equal(ibbProb(situ, extremeCfg), 0, '合成reTableでRE損が閾値超過＝確実に禁止');
});

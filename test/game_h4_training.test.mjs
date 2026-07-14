// ============================================================================
// フェーズH4: 育成方針・キャンプ（phaseH_fun_spec H4・期待値保存の間接介入）のテスト。
//
//   - parsePolicy/isTargetAxis: 方針文字列の解析・軸グループ対象判定の純関数テスト。
//   - 期待値保存: 大標本で方針別の平均総成長が balanced 基準と同等（軸グループ間の再配分のみ・
//     恒久シフトなし）。rest は明示的なトレードオフ（成長減の代わり分散/衰えが緩む）を検証。
//   - AI球団の自動方針: teamEvalProfile 由来のz化差から決定論的に導出される（投手は常にbalanced）。
//   - ★安全ゲート: 既定config（aiEffectMult=0）では AI自動方針が trueAbility に一切影響しない
//     （test/game_multiyear.test.mjs の多年ERA帯[3.3,4.6]のヘッドルームが薄いことの実測知見・
//     R7と同種の「小さくしても非単調に不安定」を確認したうえでの安全側デフォルト＝config.mjs参照）。
//   - 特別指導枠の上限: setTrainingPolicy が K 人を超える special:true を拒否する。
//   - ログreplay一致: state.trainingPolicies を経由した save→load→advanceYear が
//     live の advanceYear と bit 一致する（全柱共通の鉄則1）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';
import { FIELD_POSITIONS } from '../src/model/positions.mjs';
import { hashSeed } from '../src/rng.mjs';
import { applyAging } from '../src/game/aging.mjs';
import { parsePolicy, isTargetAxis, aiAutoPolicy, resolvePlayerTraining, coachOverallScore } from '../src/game/training.mjs';
import {
  newGame, advanceTo, advanceYear, save, load,
  setTrainingPolicy, clearTrainingPolicy,
} from '../src/game/index.mjs';

const cfg = createConfig();
const SEED = 20260714;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** trueAbility の全軸（agePlayer が実際に加齢させる軸）を1つの合計値へ（velocityも同じ単位系として合算）。 */
function totalAbilitySum(t) {
  const c = t.common;
  const b = t.batting;
  const pi = t.pitching;
  const f = t.fielding;
  const br = t.baserunning;
  let s = c.speed + c.arm + c.hands + c.reaction + c.power;
  s += b.ev + b.la + b.pull + b.contact + b.eye + b.vsFastball + b.vsBreaking;
  s += pi.velocityKmh + pi.control + pi.stamina + pi.gbRate + pi.hold;
  for (const pitch of pi.pitches) s += pitch.current + pitch.whiff + pitch.hrSuppress + pitch.contactQuality;
  s += f.positioningIQ + f.framing + f.blocking;
  for (const k of Object.keys(f.positionProf)) s += f.positionProf[k];
  s += br.steal + br.baserunIQ;
  return s;
}

// ============================================================================
// 方針の意味論（純関数）
// ============================================================================

test('H4: parsePolicy — 既知の方針は解析でき、convert:<POS>は8ポジションすべて有効', () => {
  for (const kind of ['batting', 'defense', 'speed', 'rest', 'balanced']) {
    assert.deepEqual(parsePolicy(kind), { kind, pos: null }, `${kind} が解析できる`);
  }
  for (const pos of FIELD_POSITIONS) {
    assert.deepEqual(parsePolicy(`convert:${pos}`), { kind: 'convert', pos }, `convert:${pos} が解析できる`);
  }
});

test('H4: parsePolicy — 不正な文字列・不正なポジション・bareのconvertはnull', () => {
  for (const bad of ['foo', 'convert:XX', 'convert:', 'convert', '', null, undefined, 'convert:DH']) {
    assert.equal(parsePolicy(bad), null, `${bad} は不正として拒否される`);
  }
});

test('H4: isTargetAxis — batting/defense/speed/convertの対象グループが仕様どおり', () => {
  const bat = parsePolicy('batting');
  assert.ok(isTargetAxis(bat, 'batting', 'ev', null));
  assert.ok(isTargetAxis(bat, 'batting', 'eye', null));
  assert.ok(!isTargetAxis(bat, 'fielding', 'positioningIQ', null));
  assert.ok(!isTargetAxis(bat, 'common', 'power', null));

  const def = parsePolicy('defense');
  assert.ok(isTargetAxis(def, 'fielding', 'positioningIQ', null));
  assert.ok(isTargetAxis(def, 'fielding', 'positionProf', '1B'));
  assert.ok(!isTargetAxis(def, 'batting', 'ev', null));
  assert.ok(!isTargetAxis(def, 'common', 'speed', null));

  const spd = parsePolicy('speed');
  assert.ok(isTargetAxis(spd, 'common', 'speed', null));
  assert.ok(!isTargetAxis(spd, 'common', 'power', null));
  assert.ok(isTargetAxis(spd, 'baserunning', 'steal', null));
  assert.ok(isTargetAxis(spd, 'baserunning', 'baserunIQ', null));

  const conv = parsePolicy('convert:1B');
  assert.ok(isTargetAxis(conv, 'fielding', 'positionProf', '1B'));
  assert.ok(!isTargetAxis(conv, 'fielding', 'positionProf', '2B'));
  assert.ok(!isTargetAxis(conv, 'fielding', 'positioningIQ', null));

  assert.ok(!isTargetAxis(parsePolicy('rest'), 'batting', 'ev', null), 'restは対象グループを持たない');
  assert.ok(!isTargetAxis(parsePolicy('balanced'), 'batting', 'ev', null), 'balancedは対象グループを持たない');
  assert.ok(!isTargetAxis(null, 'batting', 'ev', null), 'null方針は常にfalse');
});

// ============================================================================
// 期待値保存（大標本）: 軸グループ間の再配分のみ・恒久シフトなし
// ============================================================================

/** N人ぶんの若手野手（全軸が成長フェーズ・peak=27,age=20<全profileのgrowEnd）を生成して加齢させ、
 *  加齢前後の totalAbilitySum の差（=1年ぶんの総成長量）配列を返す。 */
function growthSample(policy, N, { special = false, personality = null, seed = 'exp' } = {}) {
  const peak = 27;
  const age = 20; // speed(peakShift-3)まで含め全profileでgrowEnd(=peak+peakShift)を下回る
  const players = [];
  const policies = [];
  for (let i = 0; i < N; i++) {
    const id = `P${i}`;
    const t = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
    players.push(createPlayer({ id, age, role: 'fielder', trueAbility: t, personality }));
    if (policy && policy !== 'balanced') policies.push({ playerId: id, policy, special });
  }
  const before = players.map((p) => totalAbilitySum(p.trueAbility));
  applyAging(players, cfg, { seed: hashSeed(SEED, seed, policy ?? 'none'), yearIndex: 3, policies });
  const after = players.map((p) => totalAbilitySum(p.trueAbility));
  return players.map((_, i) => after[i] - before[i]);
}

/**
 * ペア比較: 同一seed・同一idの選手集団を「方針あり」「方針なし(balanced相当)」の2通りで加齢させ、
 * 個体ごとの総成長差（with − without）を返す。gm(若手成長係数)・drift(軸ごとの独立ノイズ)は
 * RNG消費順序が方針の有無に依らず同一（training解決はRNGを一切消費しない純関数）なので、
 * 個体ごとに厳密同一の乱数列を引く＝「対象+δ・非対象-δ·w」の代数的キャンセルだけが差になる
 * （clampRating の整数丸めに由来する±1点程度の離散化ノイズだけが残る・大標本で0へ収束）。
 */
function pairedGrowthDiff(policy, N, { special = false, personality = null, seed = 'paired' } = {}) {
  const sharedSeed = hashSeed(SEED, seed);
  const peak = 27;
  const age = 20;
  const run = (withPolicy) => {
    const players = [];
    const policies = [];
    for (let i = 0; i < N; i++) {
      const id = `X${i}`;
      const t = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
      players.push(createPlayer({ id, age, role: 'fielder', trueAbility: t, personality }));
      if (withPolicy) policies.push({ playerId: id, policy, special });
    }
    const before = players.map((p) => totalAbilitySum(p.trueAbility));
    applyAging(players, cfg, { seed: sharedSeed, yearIndex: 3, policies });
    const after = players.map((p) => totalAbilitySum(p.trueAbility));
    return players.map((_, i) => after[i] - before[i]);
  };
  const withPolicy = run(true);
  const without = run(false);
  return withPolicy.map((v, i) => v - without[i]);
}

test('H4: 期待値保存 — batting/defense/speed/convert方針の平均総成長がbalanced基準と同等（ペア比較）', () => {
  const N = 6000;
  for (const policy of ['batting', 'defense', 'speed', 'convert:1B']) {
    const diffs = pairedGrowthDiff(policy, N, { seed: `pair-${policy}` });
    const m = mean(diffs);
    assert.ok(
      Math.abs(m) < 0.6,
      `${policy}: with方針とwithout(balanced)の平均差 ${m.toFixed(3)} が0から乖離しすぎ（期待値保存の違反）`,
    );
  }
});

test('H4: 期待値保存 — 特別指導枠(special・効果2倍)や練習熱心(personality)を乗せても総成長は保たれる（ペア比較）', () => {
  const N = 6000;
  const withSpecial = mean(pairedGrowthDiff('batting', N, { special: true, seed: 'pair-special' }));
  assert.ok(Math.abs(withSpecial) < 0.6, `特別指導ONでも平均差(${withSpecial.toFixed(3)})はbalanced基準と同等`);
  const withHardworking = mean(pairedGrowthDiff('defense', N, { personality: 'hardworking', seed: 'pair-hw' }));
  assert.ok(Math.abs(withHardworking) < 0.6, `練習熱心を乗せても平均差(${withHardworking.toFixed(3)})はbalanced基準と同等`);
});

test('H4: 期待値保存 — tiltが効くと対象グループの軸は明確に伸び、非対象は明確に伸び悩む（相殺の中身の確認）', () => {
  const N = 3000;
  const peak = 27;
  const age = 20;
  const players = [];
  const policies = [];
  for (let i = 0; i < N; i++) {
    const id = `Q${i}`;
    const t = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
    players.push(createPlayer({ id, age, role: 'fielder', trueAbility: t }));
    policies.push({ playerId: id, policy: 'batting', special: false });
  }
  const beforeBat = players.map((p) => p.trueAbility.batting.ev);
  const beforeDef = players.map((p) => p.trueAbility.fielding.positioningIQ);
  applyAging(players, cfg, { seed: hashSeed(SEED, 'tiltcheck'), yearIndex: 3, policies });
  const dBat = players.map((p, i) => p.trueAbility.batting.ev - beforeBat[i]);
  const dDef = players.map((p, i) => p.trueAbility.fielding.positioningIQ - beforeDef[i]);
  assert.ok(mean(dBat) > mean(dDef) + 0.1, `対象(batting.ev平均+${mean(dBat).toFixed(3)})が非対象(fielding.positioningIQ平均+${mean(dDef).toFixed(3)})を明確に上回る`);
});

test('H4: convertはpositionProfの成長へ振替るだけ・primaryPosは変わらない', () => {
  const p = createPlayer({ id: 'CONV1', age: 22, role: 'fielder', primaryPos: 'CF', trueAbility: createTrueAbility({ career: { peakAge: 27, declineRate: 0.5 } }) });
  applyAging([p], cfg, {
    seed: hashSeed(SEED, 'convtest'), yearIndex: 3,
    policies: [{ playerId: 'CONV1', policy: 'convert:1B', special: false }],
  });
  assert.equal(p.primaryPos, 'CF', 'primaryPosはconvert方針では変わらない');
});

// ============================================================================
// rest: 成長も減る代わりに衰え・分散が緩む（期待値保存の対象外・明示的なトレードオフ）
// ============================================================================

test('H4: rest — 成長期の選手は成長がrestGrowMult倍まで下がる（総成長がbalancedより明確に少ない）', () => {
  const N = 4000;
  const base = mean(growthSample('balanced', N, { seed: 'restbase' }));
  const rest = mean(growthSample('rest', N, { seed: 'restexp' }));
  assert.ok(rest < base * 0.95, `rest(${rest.toFixed(3)})はbalanced(${base.toFixed(3)})より明確に成長が少ない`);
});

test('H4: rest — 衰え期の選手は衰えがrestDeclineMult倍まで緩む', () => {
  const N = 3000;
  const peak = 27;
  const age = peak + 8; // 多くのprofileでonsetを超え衰えフェーズに入る
  const runFor = (policy) => {
    const players = [];
    const policies = [];
    for (let i = 0; i < N; i++) {
      const id = `R${i}`;
      const t = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
      players.push(createPlayer({ id, age, role: 'fielder', trueAbility: t }));
      if (policy !== 'balanced') policies.push({ playerId: id, policy, special: false });
    }
    const before = players.map((p) => totalAbilitySum(p.trueAbility));
    applyAging(players, cfg, { seed: hashSeed(SEED, 'restdecline', policy), yearIndex: 3, policies });
    const after = players.map((p) => totalAbilitySum(p.trueAbility));
    return mean(players.map((_, i) => after[i] - before[i]));
  };
  const base = runFor('balanced');
  const rest = runFor('rest');
  assert.ok(rest > base, `rest(${rest.toFixed(3)})はbalanced(${base.toFixed(3)})より総和の下げ幅が小さい（衰えが緩む）`);
});

// ============================================================================
// AI球団の自動方針（決定論・teamEvalProfile由来）
// ============================================================================

test('H4: aiAutoPolicy — wBatが高くwDefが低い球団はbatting、逆はdefense、中庸はbalanced', () => {
  const p = createPlayer({ id: 'F1', role: 'fielder' });
  const pc = cfg.tuning.market.profile;
  const battingLean = { wBat: pc.wBatMean + 2.5 * pc.wBatSd, wDef: pc.wDefMean };
  const defenseLean = { wBat: pc.wBatMean, wDef: pc.wDefMean + 2.5 * pc.wDefSd };
  const neutral = { wBat: pc.wBatMean, wDef: pc.wDefMean };
  assert.equal(aiAutoPolicy(p, battingLean, cfg), 'batting');
  assert.equal(aiAutoPolicy(p, defenseLean, cfg), 'defense');
  assert.equal(aiAutoPolicy(p, neutral, cfg), 'balanced');
});

test('H4: aiAutoPolicy — 投手は常にbalanced（打撃/守備の方針対象外）', () => {
  const pitcher = createPlayer({ id: 'PI1', role: 'pitcher' });
  const pc = cfg.tuning.market.profile;
  const battingLean = { wBat: pc.wBatMean + 3 * pc.wBatSd, wDef: pc.wDefMean };
  assert.equal(aiAutoPolicy(pitcher, battingLean, cfg), 'balanced');
});

test('H4: aiAutoPolicy — 決定論（同一入力は常に同一出力・乱数不使用）', () => {
  const p = createPlayer({ id: 'F2', role: 'fielder' });
  const profile = { wBat: 1.3, wDef: 0.4 };
  const a = aiAutoPolicy(p, profile, cfg);
  const b = aiAutoPolicy(p, profile, cfg);
  assert.equal(a, b);
});

test('H4: resolvePlayerTraining — 人間ログ優先 > 自チーム未設定はbalanced > 他球団はAI自動方針', () => {
  const pc = cfg.tuning.market.profile;
  const battingProfile = { wBat: pc.wBatMean + 3 * pc.wBatSd, wDef: pc.wDefMean };
  const profiles = new Map([['T2', battingProfile]]);
  const myPlayer = createPlayer({ id: 'M1', role: 'fielder', teamId: 'T1' });
  const aiPlayer = createPlayer({ id: 'A1', role: 'fielder', teamId: 'T2' });
  const policyMap = new Map([['M1', { policy: 'rest', special: true }]]);

  const ctxWithHuman = { policyMap, profiles, playerTeamId: 'T1' };
  assert.deepEqual(resolvePlayerTraining(myPlayer, ctxWithHuman, cfg), { policy: 'rest', special: true, source: 'human' });

  const ctxNoHuman = { policyMap: new Map(), profiles, playerTeamId: 'T1' };
  assert.deepEqual(resolvePlayerTraining(myPlayer, ctxNoHuman, cfg), { policy: 'balanced', special: false, source: 'default' });

  assert.deepEqual(resolvePlayerTraining(aiPlayer, ctxNoHuman, cfg), { policy: 'batting', special: false, source: 'ai' });
});

test('H4: ★安全ゲート — 既定config(aiEffectMult=0)ではAI自動方針がtrueAbilityへ一切影響しない', () => {
  // AI自動方針そのものは決定論的に'batting'/'defense'へ分かれうるが、既定のaiEffectMult=0では
  // tiltMult=0=(1+0)/(1-0*w)=1固定＝curveDeltaに一切影響しない設計（config.mjs H4節コメント参照）。
  // 多年ERA帯[3.3,4.6]のヘッドルームが薄く、AI自動方針を弱めてもgrid探索で非単調に不安定だった
  // 実測知見（R7と同種）に基づく安全側デフォルト。
  assert.equal(cfg.tuning.training.aiEffectMult, 0, '既定値は0（このテストの前提）');
  const pc = cfg.tuning.market.profile;
  const battingLean = { wBat: pc.wBatMean + 3 * pc.wBatSd, wDef: pc.wDefMean };
  const profiles = new Map([['T9', battingLean]]);

  const withAi = [];
  const noAi = [];
  for (let i = 0; i < 200; i++) {
    const t1 = createTrueAbility({ career: { peakAge: 27, declineRate: 0.5 } });
    withAi.push(createPlayer({ id: `W${i}`, age: 22, role: 'fielder', teamId: 'T9', trueAbility: t1 }));
    const t2 = createTrueAbility({ career: { peakAge: 27, declineRate: 0.5 } });
    noAi.push(createPlayer({ id: `W${i}`, age: 22, role: 'fielder', teamId: 'T9', trueAbility: t2 }));
  }
  applyAging(withAi, cfg, { seed: hashSeed(SEED, 'aisafety'), yearIndex: 3, playerTeamId: 'T1', profiles });
  applyAging(noAi, cfg, { seed: hashSeed(SEED, 'aisafety'), yearIndex: 3 });
  for (let i = 0; i < withAi.length; i++) {
    assert.deepEqual(withAi[i].trueAbility, noAi[i].trueAbility, `選手${i}: AI自動方針の有無でtrueAbilityが変わってはならない（aiEffectMult=0）`);
  }
});

// ============================================================================
// 特別指導枠の上限（setTrainingPolicy・自チームのみ・K人まで）
// ============================================================================

function makeGame() {
  return newGame(SEED, 'T1', { cfg });
}

test('H4: setTrainingPolicy — 不正な方針・他球団の選手は拒否する', () => {
  const st = makeGame();
  const myPlayer = st.league.players.find((p) => p.teamId === 'T1');
  const otherPlayer = st.league.players.find((p) => p.teamId !== 'T1');
  assert.throws(() => setTrainingPolicy(st, myPlayer.id, 'not-a-policy'), /不正な policy/);
  assert.throws(() => setTrainingPolicy(st, otherPlayer.id, 'batting'), /自チームの選手のみ/);
});

test('H4: setTrainingPolicy — 特別指導枠はK人まで（K+1人目は拒否・解除で再度空く）', () => {
  const st = makeGame();
  const K = st.cfg.tuning.training.specialSlotsPerTeam;
  const mine = st.league.players.filter((p) => p.teamId === 'T1').slice(0, K + 2);
  assert.ok(mine.length >= K + 2, 'テスト前提: 自チームにK+2人以上いる');
  for (let i = 0; i < K; i++) setTrainingPolicy(st, mine[i].id, 'batting', { special: true });
  assert.throws(() => setTrainingPolicy(st, mine[K].id, 'defense', { special: true }), /特別指導枠は\d+人まで/);
  // special:falseなら枠を消費しないので通る
  assert.doesNotThrow(() => setTrainingPolicy(st, mine[K].id, 'defense', { special: false }));
  // 既存の特別指導を解除すれば枠が空く
  clearTrainingPolicy(st, mine[0].id);
  assert.doesNotThrow(() => setTrainingPolicy(st, mine[K + 1].id, 'speed', { special: true }));
  const used = st.trainingPolicies.filter((tp) => tp.yearIndex === st.yearIndex && tp.special).length;
  assert.equal(used, K, `特別指導枠の使用数はちょうどK(${K})`);
});

test('H4: setTrainingPolicy — 同一選手への再設定は上書き（重複ログを残さない）', () => {
  const st = makeGame();
  const mine = st.league.players.find((p) => p.teamId === 'T1');
  setTrainingPolicy(st, mine.id, 'batting', { special: true });
  setTrainingPolicy(st, mine.id, 'rest', { special: false });
  const rows = st.trainingPolicies.filter((tp) => tp.playerId === mine.id && tp.yearIndex === st.yearIndex);
  assert.equal(rows.length, 1, '同一選手・同一年のログは1行だけ');
  assert.equal(rows[0].policy, 'rest');
  assert.equal(rows[0].special, false);
});

// ============================================================================
// ログreplay一致（save→load→advanceYear が live と bit 一致）
// ============================================================================

test('H4: trainingPolicies は additive save field — save/load で bit 一致・旧セーブは[]補完', () => {
  const st = makeGame();
  const mine = st.league.players.find((p) => p.teamId === 'T1');
  setTrainingPolicy(st, mine.id, 'batting', { special: true });
  const blob = JSON.parse(JSON.stringify(save(st)));
  assert.ok(Array.isArray(blob.trainingPolicies), 'saveにtrainingPoliciesが含まれる');
  const restored = load(blob, { cfg });
  assert.equal(JSON.stringify(restored.trainingPolicies), JSON.stringify(st.trainingPolicies));

  const oldBlob = { ...blob };
  delete oldBlob.trainingPolicies;
  const restoredOld = load(oldBlob, { cfg });
  assert.deepEqual(restoredOld.trainingPolicies, [], '旧セーブはtrainingPolicies=[]で補完される');
});

test('H4: ログreplay一致 — 方針設定→save→load→advanceYear が live の advanceYear と同一結果', () => {
  // live: 方針を設定してそのまま advanceYear
  const live = makeGame();
  const myPlayers = live.league.players.filter((p) => p.teamId === 'T1').slice(0, 4);
  setTrainingPolicy(live, myPlayers[0].id, 'batting', { special: true });
  setTrainingPolicy(live, myPlayers[1].id, 'defense', { special: false });
  setTrainingPolicy(live, myPlayers[2].id, 'rest', { special: false });
  setTrainingPolicy(live, myPlayers[3].id, `convert:${FIELD_POSITIONS[0]}`, { special: true });
  advanceTo(live, 'seasonEnd');
  const offLive = advanceYear(live);

  // replay: 同じ方針を設定した直後（advanceYear前）にsave→load、復元した状態でadvanceYear
  const replaySrc = makeGame();
  setTrainingPolicy(replaySrc, myPlayers[0].id, 'batting', { special: true });
  setTrainingPolicy(replaySrc, myPlayers[1].id, 'defense', { special: false });
  setTrainingPolicy(replaySrc, myPlayers[2].id, 'rest', { special: false });
  setTrainingPolicy(replaySrc, myPlayers[3].id, `convert:${FIELD_POSITIONS[0]}`, { special: true });
  advanceTo(replaySrc, 'seasonEnd');
  const blob = JSON.parse(JSON.stringify(save(replaySrc)));
  const restored = load(blob, { cfg });
  const offReplay = advanceYear(restored);

  assert.equal(offLive.campResults.length, offReplay.campResults.length, 'campResults件数が一致');
  assert.deepEqual(offLive.campResults, offReplay.campResults, 'campResults(before/after/policy)が完全一致');
  for (const id of myPlayers.map((p) => p.id)) {
    const a = live.league.players.find((p) => p.id === id) ?? live.retiredPlayers.find((p) => p.id === id);
    const b = restored.league.players.find((p) => p.id === id) ?? restored.retiredPlayers.find((p) => p.id === id);
    if (a && a.trueAbility && b && b.trueAbility) {
      assert.deepEqual(a.trueAbility, b.trueAbility, `${id}: live/replay の trueAbility が一致`);
    }
  }
});

test('H4: campResults — 特別指導した選手だけが載り、見立てbefore/afterはcoachOverallScoreと整合', () => {
  const st = makeGame();
  const target = st.league.players.find((p) => p.teamId === 'T1');
  const before = coachOverallScore(target, st.cfg);
  setTrainingPolicy(st, target.id, 'batting', { special: true });
  advanceTo(st, 'seasonEnd');
  const off = advanceYear(st);
  const cr = off.campResults.find((c) => c.playerId === target.id);
  assert.ok(cr, '特別指導した選手のcampResultsが存在する');
  assert.equal(cr.policy, 'batting');
  assert.ok(Math.abs(cr.before - before) < 1e-9, 'beforeはキャンプ前のcoachOverallScoreと一致');
  const after = st.league.players.find((p) => p.id === target.id);
  if (after) assert.ok(Math.abs(cr.after - coachOverallScore(after, st.cfg)) < 1e-9, 'afterはキャンプ後のcoachOverallScoreと一致');
});

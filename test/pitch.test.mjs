// B1 一球ごとカウント状態機械（runPlateAppearance・§B1-1）の挙動テスト。
// 3ストライク=K / 4ボール=BB / 2ストライクのファウルはカウント不変 / ゾーン内見逃し=ストライク /
// 決定論（同一シード同一結果）を固定する。乱数は「台本rng」で投球ごとの分岐を強制して検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { createPlayer, createTrueAbility, createPitch } from '../src/model/player.mjs';
import { createBattingLine, createPitchingLine, createFieldingLine } from '../src/model/statline.mjs';
import { makeRng } from '../src/rng.mjs';
import { runPlateAppearance } from '../src/sim/plateAppearance.mjs';

const cfg = createConfig();

// 平均的な対戦。単一球種(fastball)にして球種選択の乱数消費を1回に固定し、
// かつ明確ボールが「変化球ワンバウンド(dirt)」判定に入らないようにする（fastballはdirtなし）。
function avgBatter() {
  return createPlayer({ role: 'fielder', bats: 'L', trueAbility: createTrueAbility() });
}
function fastballPitcher() {
  return createPlayer({
    role: 'pitcher', throws: 'R',
    trueAbility: createTrueAbility({ pitching: { velocityKmh: 146, control: 50, pitches: [createPitch('fastball', { whiff: 50 })] } }),
  });
}
function avgCatcher() {
  return createPlayer({ role: 'fielder', trueAbility: createTrueAbility({ fielding: { framing: 50, blocking: 50 } }) });
}

/** 台本rng: 与えた列を順に返し、尽きたら tail を返し続ける。next() のみ提供（normalは打球化テストで不要）。 */
function scriptRng(vals, tail = 0.5) {
  let i = 0;
  return { next: () => (i < vals.length ? vals[i++] : tail) };
}

function newEnv(rng) {
  return {
    batter: avgBatter(), pitcher: fastballPitcher(), catcher: avgCatcher(),
    cfg, rng, tto: 0,
    bLine: createBattingLine(), pLine: createPitchingLine(), cLine: createFieldingLine(),
    bases: [null, null, null], outs: 0,
  };
}

// 1球あたりの乱数消費（fastball・1球種）:
//   選択(1) → u1帯(1) → [帯2(明確ボール)ならHBP(1)] → スイング(1) → [スイング時 whiff(1) → 非空振りなら foul(1)]
// u1 の帯: u1<zone=ゾーン / <zone+border=ボーダー / それ以上=明確ボール。zoneは control50/カウントで概ね0.3〜0.6。
const ZONE = 0.03; // u1 を十分小さく＝確実にゾーン内
const CLEAR = 0.97; // u1 を十分大きく＝確実に明確ボール
const NO_SWING = 0.999; // スイング判定を必ず「見逃し」に
const SWING = 0.001; // 必ず「スイング」
const NO_HBP = 0.5; // HBP率(<0.01)を回避
const NO_WHIFF = 0.999; // 空振り率(~0.1)を回避＝接触
const FOUL = 0.001; // 接触時に必ずファウル

test('ゾーン内見逃し=ストライク → 3ストライクでK（見逃し三振）', () => {
  // 各球: 選択・u1=ゾーン・スイング=見逃し → 見逃しストライク。3球で三振。
  const perPitch = [0.5, ZONE, NO_SWING];
  const rng = scriptRng([...perPitch, ...perPitch, ...perPitch]);
  const env = newEnv(rng);
  const r = runPlateAppearance(env);
  assert.equal(r.outcome, 'K', '3見逃しストライクでK');
  assert.equal(r.pitches, 3, '3球で決着');
  assert.equal(env.pLine.calledStrikes, 3, 'ゾーン内見逃しが3つ計上');
  assert.equal(env.pLine.zonePitches, 3, 'ゾーン内3球');
  assert.equal(env.bLine.swings, 0, 'スイングなし');
});

test('明確ボール見逃し → 4ボールでBB（四球）', () => {
  // 各球: 選択・u1=明確ボール・HBP回避・スイング=見逃し → ボール。4球で四球。
  const perPitch = [0.5, CLEAR, NO_HBP, NO_SWING];
  const rng = scriptRng([...perPitch, ...perPitch, ...perPitch, ...perPitch]);
  const env = newEnv(rng);
  const r = runPlateAppearance(env);
  assert.equal(r.outcome, 'BB', '4ボールでBB');
  assert.equal(r.pitches, 4, '4球で決着');
  assert.equal(env.pLine.oZonePitches, 4, '明確ボール4球');
  assert.equal(env.pLine.calledStrikes, 0, '見逃しストライクなし');
});

test('2ストライクのファウルはカウント不変（三振にならず粘る）', () => {
  // 0-2まで見逃し2球 → その後ファウル2球（カウント維持）→ 空振りで三振。
  // ファウルがストライクを加算していれば最初のファウルで三振(pitches=3)になる。維持なら pitches=5。
  const called = [0.5, ZONE, NO_SWING]; // 見逃しストライク
  const foul = [0.5, ZONE, SWING, NO_WHIFF, FOUL]; // スイング→接触→ファウル
  const whiffK = [0.5, ZONE, SWING, 0.001]; // スイング→空振り（whiff率>0.001なので必ず空振り）
  const rng = scriptRng([...called, ...called, ...foul, ...foul, ...whiffK]);
  const env = newEnv(rng);
  const r = runPlateAppearance(env);
  assert.equal(r.outcome, 'K', '最終的に空振り三振');
  assert.equal(r.pitches, 5, '2見逃し+2ファウル(維持)+1空振り=5球（ファウルでカウントが増えていない）');
  assert.equal(env.pLine.fouls, 2, 'ファウル2球が計上');
  assert.equal(env.pLine.whiffs, 1, '空振り1球');
});

test('2ストライク未満のファウルはストライクを1つ加算する', () => {
  // 0-0 でファウル → 0-1。続けてファウル → 0-2。ここからは維持。見逃し1球で三振にはならない。
  const foul = [0.5, ZONE, SWING, NO_WHIFF, FOUL];
  const called = [0.5, ZONE, NO_SWING];
  // foul(0-1) foul(0-2) called(空振りでなく見逃し=3ストライク目→K)
  const rng = scriptRng([...foul, ...foul, ...called]);
  const env = newEnv(rng);
  const r = runPlateAppearance(env);
  assert.equal(r.outcome, 'K', '2ファウル(0-2)+見逃し=三振');
  assert.equal(r.pitches, 3, '2ファウルでカウントが進み3球目の見逃しで決着');
});

test('決定論: 同一シードで同一の打席結果列（乱数はrng経由のみ）', () => {
  const seq = (seed) => {
    const rng = makeRng(seed);
    const env = newEnv(rng);
    const out = [];
    for (let i = 0; i < 200; i++) {
      // bLine/pLine/cLine/bases は毎回リセット（打席独立）。走者なしで暴投の塁進を避ける。
      env.bLine = createBattingLine(); env.pLine = createPitchingLine(); env.cLine = createFieldingLine();
      env.bases[0] = env.bases[1] = env.bases[2] = null;
      const r = runPlateAppearance(env);
      out.push(r.outcome + ':' + r.pitches);
    }
    return out;
  };
  assert.deepEqual(seq(12345), seq(12345), '同一シードは完全一致');
  assert.notDeepEqual(seq(1).join(), seq(2).join(), '別シードは別結果');
});

test('全結果が K/BB/HBP/inPlay のいずれかで、投球数は正', () => {
  const rng = makeRng(777);
  for (let i = 0; i < 500; i++) {
    const env = newEnv(rng);
    const r = runPlateAppearance(env);
    assert.ok(['K', 'BB', 'HBP', 'inPlay'].includes(r.outcome), `outcome=${r.outcome}`);
    assert.ok(r.pitches >= 1, '1球以上');
    if (r.outcome === 'inPlay') assert.ok(r.battedBall && r.battedBall.evKmh > 0, 'インプレーは打球を返す');
  }
});

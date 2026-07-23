// ============================================================================
// Wave D（thyroxin/specs/gm_analytics_spec.md §Wave D）: トレードAI受諾のセイバー視点のテスト。
//   ①saberSavvy が独立シードで決定論・既存プロファイル値（wBat等）が従来と bit 同一
//   ②regressedValueOf の回帰方向（BABIP高→減額・低→増額・少PA→平均寄り・高齢→割引）
//   ③saberSavvy=0/1 の球団で同一選手の主観価値が定説どおり乖離
//   ④ポジション需要項の符号
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { makeRng, hashSeed } from '../src/rng.mjs';
import { clamp } from '../src/model/util.mjs';
import { teamEvalProfile } from '../src/game/market.mjs';
import {
  regressedValueOf, observedValueOf, subjectiveTradeValue, posNeedMultiplier,
} from '../src/game/transactions.mjs';
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';
import { createBattingLine, createPitchingLine } from '../src/model/statline.mjs';

const cfg = createConfig();
const SEED = 20260723;

// ============================================================================
// ① saberSavvy: 独立シード・決定論・既存プロファイル値の bit 同一性
// ============================================================================

test('WaveD ①: teamEvalProfile は同一入力で決定論（saberSavvy 込みで再現可能）', () => {
  const p1 = teamEvalProfile(SEED, 'T1', cfg);
  const p2 = teamEvalProfile(SEED, 'T1', cfg);
  assert.deepEqual(p1, p2);
});

test('WaveD ①: saberSavvy は独立シード hashSeed(masterSeed,"evalprofile",teamId,"saber") から引かれる', () => {
  const pc = cfg.tuning.market.profile;
  for (const teamId of ['T1', 'T5', 'T12']) {
    const profile = teamEvalProfile(SEED, teamId, cfg);
    const expected = clamp(
      makeRng(hashSeed(SEED, 'evalprofile', teamId, 'saber')).normal(pc.saberSavvyMean, pc.saberSavvySd),
      pc.saberSavvyMin,
      pc.saberSavvyMax,
    );
    assert.equal(profile.saberSavvy, expected, `${teamId}のsaberSavvyが独立シード座標の再計算と一致`);
  }
});

test('WaveD ①【重要】: 既存プロファイル値（wBat/wEye/wDef/ageBias/noiseSd/wReliever）が従来の6連続draw式と bit 同一 '
  + '（saberSavvyの追加が共有rへdrawを足していない＝全球団の世界引き直しになっていないことの証明）', () => {
  const pc = cfg.tuning.market.profile;
  for (const teamId of ['T1', 'T3', 'T9']) {
    const profile = teamEvalProfile(SEED, teamId, cfg);
    // 旧来どおり「r」1本から wBat→wEye→wDef→ageBias→noiseSd→wReliever の順で6連続drawする式を
    //   ここで独立に再現する。もし実装が r に saberSavvy の draw を割り込ませていれば、
    //   この再現値は（座標がずれるので）一致しなくなる＝回帰防止アサーション。
    const r = makeRng(hashSeed(SEED, 'evalprofile', teamId));
    const wBat = clamp(r.normal(pc.wBatMean, pc.wBatSd), pc.wBatMin, pc.wBatMax);
    const wEye = clamp(r.normal(pc.wEyeMean, pc.wEyeSd), pc.wEyeMin, pc.wEyeMax);
    const wDef = clamp(r.normal(pc.wDefMean, pc.wDefSd), pc.wDefMin, pc.wDefMax);
    const ageBias = clamp(r.normal(pc.ageBiasMean, pc.ageBiasSd), pc.ageBiasMin, pc.ageBiasMax);
    const noiseSd = Math.max(pc.noiseSdMin, r.normal(pc.noiseSdMean, pc.noiseSdSd));
    const wReliever = clamp(r.normal(pc.wRelieverMean, pc.wRelieverSd), pc.wRelieverMin, pc.wRelieverMax);
    assert.equal(profile.wBat, wBat, `${teamId} wBat`);
    assert.equal(profile.wEye, wEye, `${teamId} wEye`);
    assert.equal(profile.wDef, wDef, `${teamId} wDef`);
    assert.equal(profile.ageBias, ageBias, `${teamId} ageBias`);
    assert.equal(profile.noiseSd, noiseSd, `${teamId} noiseSd`);
    assert.equal(profile.wReliever, wReliever, `${teamId} wReliever`);
  }
});

test('WaveD ①: saberSavvy は 0..1 の範囲に収まる（12球団）', () => {
  for (let k = 1; k <= 12; k++) {
    const profile = teamEvalProfile(SEED, `T${k}`, cfg);
    assert.ok(profile.saberSavvy >= 0 && profile.saberSavvy <= 1, `T${k}: ${profile.saberSavvy}`);
  }
});

// ============================================================================
// ② regressedValueOf の回帰方向
// ============================================================================

/** 単打のみで hits を作る打撃ライン（BABIPをピンポイントに制御しやすい簡略化）。 */
function battingLineWithBabip(babip, { ab = 400, bb = 50, so = 80, hr = 15, pa = null } = {}) {
  const b = createBattingLine();
  b.ab = ab; b.bb = bb; b.so = so; b.hr = hr;
  b.pa = pa ?? (ab + bb);
  const bip = ab - so - hr;
  const hits = Math.round(babip * bip) + hr;
  b.h = hits;
  b.b1 = hits - hr;
  return b;
}

test('WaveD ②: 当季BABIPがリーグ平均より著しく高い（出来すぎ）打者は、回帰調整で観測値より減額される', () => {
  const sk = cfg.tuning.market.saber;
  const b = battingLineWithBabip(sk.leagueBabip + 0.09); // 平均+0.09（devThreshold 0.03 を明確に超える）
  const p = { id: 'LUCKY', role: 'fielder', age: 27 };
  const obs = new Map([['LUCKY', { batting: b }]]);
  const naive = observedValueOf(p, obs, cfg);
  const reg = regressedValueOf(p, obs, cfg);
  assert.ok(reg < naive, `regressed(${reg}) < observed(${naive}) のはず（出来すぎBABIPは下方修正）`);
});

test('WaveD ②: 当季BABIPがリーグ平均より著しく低い（不運）打者は、回帰調整で観測値より増額される', () => {
  const sk = cfg.tuning.market.saber;
  const b = battingLineWithBabip(sk.leagueBabip - 0.09); // 平均-0.09
  const p = { id: 'UNLUCKY', role: 'fielder', age: 27 };
  const obs = new Map([['UNLUCKY', { batting: b }]]);
  const naive = observedValueOf(p, obs, cfg);
  const reg = regressedValueOf(p, obs, cfg);
  assert.ok(reg > naive, `regressed(${reg}) > observed(${naive}) のはず（不運BABIPは上方修正）`);
});

test('WaveD ②: BABIPがリーグ平均近傍（乖離が閾値以内）なら回帰調整は効かない（単打換算の補正なし）', () => {
  const sk = cfg.tuning.market.saber;
  const b = battingLineWithBabip(sk.leagueBabip + 0.01); // devThreshold(0.03)以内
  const p = { id: 'AVG', role: 'fielder', age: 27 };
  const obs = new Map([['AVG', { batting: b }]]);
  // 少PA縮約だけが効く形（BABIP補正は無し）＝ rawWoba を手計算した値と一致することを確認する。
  const rawWoba = ((b.b1 * 0.7 + b.hr * 1.65 + b.bb * 0.55) / (b.ab + b.bb)) * cfg.tuning.mgr.wobaScale;
  const shrunk = (rawWoba * b.pa + cfg.tuning.mgr.wobaPrior * sk.paRegressConstant) / (b.pa + sk.paRegressConstant);
  const expected = (shrunk - cfg.tuning.market.release.replacementWoba) * b.pa;
  const reg = regressedValueOf(p, obs, cfg);
  assert.ok(Math.abs(reg - expected) < 1e-6, `BABIP補正なしの単純縮約と一致するはず（got ${reg}, expected ${expected}）`);
});

test('WaveD ②: 少PAの打者は観測wOBAが極端でも、回帰調整でリーグ平均寄りに縮約される（観測値との差が縮む）', () => {
  const b = battingLineWithBabip(0.400, { ab: 40, bb: 5, so: 8, hr: 3 }); // 極少PA・出来すぎBABIP
  const p = { id: 'SMALLPA', role: 'fielder', age: 27 };
  const obs = new Map([['SMALLPA', { batting: b }]]);
  const naive = observedValueOf(p, obs, cfg); // 少PA縮約が無い素朴版
  const reg = regressedValueOf(p, obs, cfg);
  assert.ok(reg < naive, '少PA＋出来すぎBABIPは回帰でさらに下がる方向のはず');
});

test('WaveD ②: 投手はK-BB%が良いのにFIPが悪い（HR変動）場合、regressedValueOfがobservedValueOfより高くなる', () => {
  const p = createPitchingLine();
  p.outs = 180; p.so = 70; p.bb = 15; p.hr = 25; p.hbp = 2; p.g = 12; p.gs = 12; p.bf = 260;
  const pitcher = { id: 'KBBGOOD', role: 'pitcher', age: 27 };
  const obs = new Map([['KBBGOOD', { pitching: p }]]);
  const naive = observedValueOf(pitcher, obs, cfg);
  const reg = regressedValueOf(pitcher, obs, cfg);
  assert.ok(reg > naive, `regressed(${reg}) > observed(${naive}) のはず（K-BB%由来の推定が悪いFIPを補正）`);
});

test('WaveD ②: 30歳超の打者は年齢が高いほど regressedValueOf の（同一成績での）値が小さくなる（残存価値の逓減）', () => {
  const b = battingLineWithBabip(cfg.tuning.market.saber.leagueBabip + 0.20, { ab: 400, bb: 50, so: 80, hr: 20 }); // 明確に上振れ成績
  const obs = new Map([
    ['A31', { batting: b }], ['A34', { batting: b }], ['A37', { batting: b }],
  ]);
  const v31 = regressedValueOf({ id: 'A31', role: 'fielder', age: 31 }, obs, cfg);
  const v34 = regressedValueOf({ id: 'A34', role: 'fielder', age: 34 }, obs, cfg);
  const v37 = regressedValueOf({ id: 'A37', role: 'fielder', age: 37 }, obs, cfg);
  assert.ok(v31 > v34 && v34 > v37, `年齢が上がるほど残存価値が逓減（v31=${v31}, v34=${v34}, v37=${v37}）`);
});

test('WaveD ②: obs に行が無い/出場が無い選手は observedValueOf と同様に null', () => {
  const obs = new Map();
  assert.equal(regressedValueOf({ id: 'X', role: 'fielder', age: 27 }, obs, cfg), null);
  const zeroPaObs = new Map([['Y', { batting: createBattingLine() }]]);
  assert.equal(regressedValueOf({ id: 'Y', role: 'fielder', age: 27 }, zeroPaObs, cfg), null);
});

// ============================================================================
// ③ saberSavvy=0/1 の球団で同一選手の主観価値が定説どおり乖離
// ============================================================================

function fielderWithTools(id, tools) {
  return createPlayer({
    id, teamId: 'ANY', role: 'fielder', primaryPos: '1B', age: 27,
    trueAbility: createTrueAbility({ batting: tools }),
  });
}

// ★同一 teamId（'ANYTEAM'）で profiles だけ savvy を差し替えて呼ぶ（scoutノイズはteamId座標に
//   依存するため、異なるteamId同士を比較すると savvy 以外の要因で値が割れてしまう）。
const evalTeamId = 'ANYTEAM';
function savvyProfile(savvy) {
  return new Map([[evalTeamId, { ...teamEvalProfile(SEED, 'ANY', cfg), saberSavvy: savvy }]]);
}

test('WaveD ③: 出来すぎBABIPの打者は saberSavvy が高い球団ほど主観価値が低い（表層過大評価を回避）', () => {
  const lucky = fielderWithTools('LUCKY2', { ev: 52, contact: 52, eye: 50, la: 50 });
  const b = battingLineWithBabip(cfg.tuning.market.saber.leagueBabip + 0.09);
  const obs = new Map([['LUCKY2', { batting: b }]]);
  const ctx = { masterSeed: SEED, yearIndex: 0, obs };
  const v0 = subjectiveTradeValue(savvyProfile(0), evalTeamId, lucky, cfg, ctx);
  const v1 = subjectiveTradeValue(savvyProfile(1), evalTeamId, lucky, cfg, ctx);
  assert.ok(v1 < v0, `saberSavvy=1の主観価値(${v1})はsaberSavvy=0(${v0})より低いはず`);
});

test('WaveD ③: 地味だが不運BABIPで上振れ余地がある打者は saberSavvy が高い球団ほど主観価値が高い（過小評価を回避）', () => {
  const unlucky = fielderWithTools('UNLUCKY2', { ev: 52, contact: 52, eye: 50, la: 50 });
  const b = battingLineWithBabip(cfg.tuning.market.saber.leagueBabip - 0.09);
  const obs = new Map([['UNLUCKY2', { batting: b }]]);
  const ctx = { masterSeed: SEED, yearIndex: 0, obs };
  const v0 = subjectiveTradeValue(savvyProfile(0), evalTeamId, unlucky, cfg, ctx);
  const v1 = subjectiveTradeValue(savvyProfile(1), evalTeamId, unlucky, cfg, ctx);
  assert.ok(v1 > v0, `saberSavvy=1の主観価値(${v1})はsaberSavvy=0(${v0})より高いはず`);
});

test('WaveD ③: saberSavvy=0 の球団は obs があっても従来評価（evaluateProspect）そのまま（回帰の影響を受けない）', () => {
  const profiles0 = savvyProfile(0);
  const lucky = fielderWithTools('LUCKY3', { ev: 52, contact: 52, eye: 50, la: 50 });
  const b = battingLineWithBabip(cfg.tuning.market.saber.leagueBabip + 0.09);
  const obs = new Map([['LUCKY3', { batting: b }]]);
  const withObs = subjectiveTradeValue(profiles0, evalTeamId, lucky, cfg, { masterSeed: SEED, yearIndex: 0, obs });
  const withoutObs = subjectiveTradeValue(profiles0, evalTeamId, lucky, cfg, { masterSeed: SEED, yearIndex: 0, obs: null });
  assert.equal(withObs, withoutObs, 'saberSavvy=0なら観測データの有無で主観価値が変わらない');
});

test('WaveD ③: obs が無い（新人等）選手は saberSavvy に関わらず従来評価のみ', () => {
  const rookie = fielderWithTools('ROOKIE1', { ev: 52, contact: 52, eye: 50, la: 50 });
  const ctx = { masterSeed: SEED, yearIndex: 0, obs: new Map() };
  const v0 = subjectiveTradeValue(savvyProfile(0), evalTeamId, rookie, cfg, ctx);
  const v1 = subjectiveTradeValue(savvyProfile(1), evalTeamId, rookie, cfg, ctx);
  assert.equal(v0, v1, '観測が無ければ回帰の入力が無い＝savvyに関わらず従来評価のみ');
});

// ============================================================================
// ④ ポジション需要項の符号
// ============================================================================

test('WaveD ④: 弱点(weak)位置のセルは主観価値を(1+posNeedBonus)倍に引き上げる', () => {
  const sk = cfg.tuning.market.saber;
  const mult = posNeedMultiplier({ weak: true, saturated: false }, cfg);
  assert.equal(mult, 1 + sk.posNeedBonus);
  assert.ok(mult > 1);
});

test('WaveD ④: 飽和(saturated)位置のセルは主観価値を(1-posSurplusPenalty)倍に引き下げる', () => {
  const sk = cfg.tuning.market.saber;
  const mult = posNeedMultiplier({ weak: false, saturated: true }, cfg);
  assert.equal(mult, 1 - sk.posSurplusPenalty);
  assert.ok(mult < 1);
});

test('WaveD ④: どちらでもない/セル不明なら乗数は1（中立）', () => {
  assert.equal(posNeedMultiplier({ weak: false, saturated: false }, cfg), 1);
  assert.equal(posNeedMultiplier(null, cfg), 1);
  assert.equal(posNeedMultiplier(undefined, cfg), 1);
});

test('WaveD ④: subjectiveTradeValue にposNeedMapを渡すと、弱点位置を埋める選手の主観価値が上がる', () => {
  const base = teamEvalProfile(SEED, 'ANY', cfg);
  const profiles = new Map([['T1', { ...base, saberSavvy: 0 }]]);
  const player = fielderWithTools('NEED1', { ev: 52, contact: 52, eye: 50, la: 50 });
  const noMap = subjectiveTradeValue(profiles, 'T1', player, cfg, { masterSeed: SEED, yearIndex: 0 });
  const weakMap = new Map([['T1:1B', { weak: true, saturated: false }]]);
  const withWeak = subjectiveTradeValue(profiles, 'T1', player, cfg, { masterSeed: SEED, yearIndex: 0, posNeedMap: weakMap });
  const satMap = new Map([['T1:1B', { weak: false, saturated: true }]]);
  const withSat = subjectiveTradeValue(profiles, 'T1', player, cfg, { masterSeed: SEED, yearIndex: 0, posNeedMap: satMap });
  assert.ok(withWeak > noMap, '弱点位置を埋める選手の主観価値は上がる');
  assert.ok(withSat < noMap, '飽和位置の選手の主観価値は下がる');
});

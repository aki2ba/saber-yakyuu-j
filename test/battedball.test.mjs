// 打球生成(1-2)＋結果解決(1-3)の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, createTrueAbility, createPitch } from '../src/model/player.mjs';
import { createConfig } from '../src/config.mjs';
import { makeRng } from '../src/rng.mjs';
import { generateBattedBall } from '../src/sim/battedBall.mjs';
import {
  battedType,
  computeGeometry,
  assignFielder,
  resolveBattedBall,
  decideBases,
} from '../src/sim/battedBallResult.mjs';
import { FIELD_POSITIONS } from '../src/model/positions.mjs';

const cfg = createConfig();
const avgBatter = () => createPlayer({ role: 'fielder', trueAbility: createTrueAbility() });
const avgPitcher = () =>
  createPlayer({
    role: 'pitcher',
    trueAbility: createTrueAbility({
      pitching: { velocityKmh: 146, pitches: [createPitch('fastball')] },
    }),
  });

test('battedType は角度で分類', () => {
  assert.equal(battedType(-5), 'GB');
  assert.equal(battedType(15), 'LD');
  assert.equal(battedType(35), 'FB');
  assert.equal(battedType(60), 'PU');
});

test('computeGeometry: 中程度角度の方が高すぎる角度より飛ぶ（キャリー効率の山）', () => {
  const mk = (la) => {
    const b = { evKmh: 165, laDeg: la, sprayDeg: 0 };
    computeGeometry(b, cfg);
    return b.distanceM;
  };
  assert.ok(mk(26) > mk(55), '26° > 55°');
  assert.ok(mk(26) > mk(5), '26° > 5°');
});

test('強い適角の打球はHRになりうる（フェンス越え）', () => {
  const bb = { evKmh: 185, laDeg: 27, sprayDeg: -30, result: null };
  const r = resolveBattedBall(bb, cfg, makeRng(1));
  assert.equal(r.result, 'HR');
  assert.equal(r.expOut, 0);
});

test('ポップフライ（高角度・弱め）はアウト側', () => {
  const bb = { evKmh: 120, laDeg: 70, sprayDeg: 0, result: null };
  const r = resolveBattedBall(bb, cfg, makeRng(1));
  assert.notEqual(r.result, 'HR');
});

test('assignFielder は有効なポジションを返す', () => {
  const positions = new Set([...FIELD_POSITIONS]);
  for (const [type, la] of [['GB', -3], ['LD', 15], ['FB', 35], ['PU', 60]]) {
    for (const spray of [-40, -20, 0, 20, 40]) {
      const bb = { evKmh: 150, laDeg: la, sprayDeg: spray, distanceM: 80 };
      const pos = assignFielder(bb, type);
      assert.ok(positions.has(pos), `${type}/${spray} -> ${pos}`);
    }
  }
});

test('assignFielder: 外野の担当角が±10でLF/CF/RFに分かれCF過集中が緩む（監査B6）', () => {
  const fb = (spray) => assignFielder({ evKmh: 150, laDeg: 30, sprayDeg: spray, distanceM: 95 }, 'FB');
  // 境界: |spray|<10 のみCF、それ以外は角側の外野へ
  assert.equal(fb(0), 'CF', '正面はCF');
  assert.equal(fb(-9), 'CF', '±10未満はCF');
  assert.equal(fb(9), 'CF', '±10未満はCF');
  assert.equal(fb(-10), 'LF', '-10はLF（旧±15より狭い）');
  assert.equal(fb(10), 'RF', '+10はRF（旧±15より狭い）');
  assert.equal(fb(-30), 'LF');
  assert.equal(fb(30), 'RF');
});

test('decideBases(監査B1): 浅い空中安打は単打、深い打球は二塁打、最深ギャップは脚力で三塁打化', () => {
  const g = cfg.tuning.bb;
  const rng = makeRng(2026);
  const based = (distanceM, sprayDeg, runnerSpeed) =>
    decideBases({ distanceM, sprayDeg, runnerSpeed }, 'FB', cfg, rng);
  // gapDistM 手前に前落ちする空中安打は必ず単打
  for (let i = 0; i < 50; i++) assert.equal(based(g.gapDistM - 5, 20, 50), '1B', '浅い前落ちは単打');
  // gapDistM〜tripleDistM は二塁打（三塁打条件の深さ未満）
  for (let i = 0; i < 50; i++) assert.equal(based(g.tripleDistM - 1, 20, 50), '2B', '中深度は二塁打');
  // 最深ギャップ(|spray|>18)＋俊足なら三塁打が一定割合で出る
  let triples = 0;
  for (let i = 0; i < 400; i++) if (based(g.tripleDistM + 3, 25, 80) === '3B') triples++;
  assert.ok(triples > 0, `最深ギャップ×俊足で三塁打が発生 (${triples}/400)`);
  // 正面(|spray|≤18)の最深球は俊足でも三塁打にならず二塁打
  for (let i = 0; i < 50; i++) assert.equal(based(g.tripleDistM + 3, 10, 80), '2B', '正面最深球は二塁打止まり');
  // GBは正面なら必ず単打（|spray|≤38 で二塁打分岐に入らない）
  for (let i = 0; i < 50; i++) {
    assert.equal(decideBases({ distanceM: 30, sprayDeg: 5, runnerSpeed: 50 }, 'GB', cfg, rng), '1B', 'GB正面は単打');
  }
});

test('generateBattedBall: EV/LA/方向を生成し結果は未確定', () => {
  const bb = generateBattedBall(avgBatter(), avgPitcher(), cfg, makeRng(5));
  assert.ok(bb.evKmh > 40);
  assert.equal(typeof bb.laDeg, 'number');
  assert.ok(bb.sprayDeg >= -50 && bb.sprayDeg <= 50);
  assert.equal(bb.result, null, '生成段階では結果未確定');
});

test('パワー打者は平均打者より打球速度が速い（多数平均）', () => {
  const rng = makeRng(3);
  const slugger = createPlayer({
    role: 'fielder',
    trueAbility: createTrueAbility({ common: { power: 78 }, batting: { ev: 78 } }),
  });
  const meanEV = (bat) => {
    let s = 0;
    const n = 3000;
    for (let i = 0; i < n; i++) s += generateBattedBall(bat, avgPitcher(), cfg, rng).evKmh;
    return s / n;
  };
  assert.ok(meanEV(slugger) > meanEV(avgBatter()) + 8, 'slugger EV > avg');
});

test('平均マッチアップのインプレーBABIP/HRが現実的な域（較正前サニティ）', () => {
  const rng = makeRng(2026);
  const bat = avgBatter();
  const pit = avgPitcher();
  let inPark = 0;
  let hits = 0;
  let hr = 0;
  const n = 40000;
  for (let i = 0; i < n; i++) {
    const bb = generateBattedBall(bat, pit, cfg, rng);
    const r = resolveBattedBall(bb, cfg, rng);
    if (r.result === 'HR') {
      hr++;
      continue;
    }
    inPark++;
    if (r.result !== 'out') hits++;
  }
  const babip = hits / inPark;
  const hrPerContact = hr / n;
  // 較正前でも常識域: BABIP .270-.340, HR/contact 1%-6%
  assert.ok(babip > 0.27 && babip < 0.34, `BABIP=${babip.toFixed(3)}`);
  assert.ok(hrPerContact > 0.01 && hrPerContact < 0.06, `HR/contact=${hrPerContact.toFixed(3)}`);
});

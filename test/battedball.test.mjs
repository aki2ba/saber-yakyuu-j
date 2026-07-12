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
  expectedBases,
} from '../src/sim/battedBallResult.mjs';
import { FIELD_POSITIONS } from '../src/model/positions.mjs';
import { neutralResponsible, fieldingChances, outProb, smaxOf } from '../src/sim/fieldingGeometry.mjs';

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
      const pos = assignFielder(bb, type, cfg);
      assert.ok(positions.has(pos), `${type}/${spray} -> ${pos}`);
    }
  }
});

test('assignFielder: 責任野手は幾何で決まる（正面フライはCF、ライン際はLF/RF、ゴロは内野）', () => {
  const fb = (spray) => assignFielder({ evKmh: 150, laDeg: 30, sprayDeg: spray, distanceM: 95 }, 'FB', cfg);
  assert.equal(fb(0), 'CF', '正面はCF');
  assert.equal(fb(-35), 'LF');
  assert.equal(fb(35), 'RF');
  // ゴロは必ず内野手の責任（外野へ抜けても「最も惜しかった」内野手に帰属する）
  const gb = (spray) => assignFielder({ evKmh: 140, laDeg: -5, sprayDeg: spray, distanceM: 20 }, 'GB', cfg);
  assert.ok(['3B', 'SS'].includes(gb(-30)), `三塁側ゴロ -> ${gb(-30)}`);
  assert.ok(['2B', '1B'].includes(gb(30)), `一塁側ゴロ -> ${gb(30)}`);
});

// --- Distance-Time モデルの核心的性質（正典 §2.3 / §5.4） -----------------------
test('捕球確率は両極に分布する（凡プレーは≒1、到達不能な打球は≒0）', () => {
  // センター正面の平凡なフライ: ほぼ確実にアウト
  const routine = neutralResponsible({ evKmh: 150, laDeg: 35, sprayDeg: 2, distanceM: 92.3 }, 'FB', cfg);
  assert.equal(routine.pos, 'CF');
  assert.ok(routine.pOut > 0.95, `凡フライ pOut=${routine.pOut}`);

  // 遊撃正面のゴロ: ほぼ確実にアウト
  const easyGb = neutralResponsible({ evKmh: 130, laDeg: -8, sprayDeg: -16, distanceM: 20 }, 'GB', cfg);
  assert.equal(easyGb.pos, 'SS');
  assert.ok(easyGb.pOut > 0.9, `正面ゴロ pOut=${easyGb.pOut}`);
});

test('ポテンヒット（EV120km/h・61m の浅いライナー）は誰の責任にもならない（正典§5.4）', () => {
  // 旧実装は CF に expOut 0.39 を課していた（CFは17.7m/sで走る必要があり物理的に到達不能）
  const bloop = neutralResponsible({ evKmh: 120, laDeg: 18, sprayDeg: 0, distanceM: 60.9 }, 'LD', cfg);
  assert.ok(bloop.pOut < 0.05, `ポテンヒットの減点は極小であるべき: pOut=${bloop.pOut}`);
  assert.notEqual(bloop.pos, 'CF', 'CFの責任にはならない（二遊間の方がまだ近い）');
});

test('後方への移動は前方より遅い（direction補正・Statcast 2017）', () => {
  // 同じ距離でも、外野手が「下がって」捕る打球の方が難しい
  const back = fieldingChances({ evKmh: 150, laDeg: 30, sprayDeg: 0, distanceM: 112 }, 'FB', cfg);
  const front = fieldingChances({ evKmh: 150, laDeg: 30, sprayDeg: 0, distanceM: 84 }, 'FB', cfg);
  assert.ok(back.reqSpeed.CF > front.reqSpeed.CF, `後方(${back.reqSpeed.CF}) > 前方(${front.reqSpeed.CF})`);
});

test('内野は「到達」だけでなく「送球アウト」を要する（足の速い打者に内野安打が湧く）', () => {
  const deepHole = { evKmh: 140, laDeg: -4, sprayDeg: -28, distanceM: 25, runnerSpeed: 50 };
  const slow = neutralResponsible({ ...deepHole, runnerSpeed: 20 }, 'GB', cfg);
  const fast = neutralResponsible({ ...deepHole, runnerSpeed: 80 }, 'GB', cfg);
  assert.ok(fast.pOut < slow.pOut, `速い打者ほどアウトになりにくい: fast=${fast.pOut} slow=${slow.pOut}`);
});

test('個人のRangeはSmaxに乗り、五分五分のプレーで最も効く', () => {
  const bb = { evKmh: 145, laDeg: 20, sprayDeg: -22, distanceM: 70 };
  const nr = neutralResponsible(bb, 'LD', cfg);
  const { reqSpeed, pThrow } = fieldingChances(bb, 'LD', cfg);
  const good = outProb(reqSpeed[nr.pos], pThrow[nr.pos], smaxOf(70, cfg), cfg);
  const bad = outProb(reqSpeed[nr.pos], pThrow[nr.pos], smaxOf(30, cfg), cfg);
  assert.ok(good > bad, `上手い野手ほどアウトにする: ${good} > ${bad}`);
  // 絶望的な打球では巧拙がほとんど効かない
  const hopeless = { evKmh: 120, laDeg: 18, sprayDeg: 0, distanceM: 60.9 };
  const hnr = neutralResponsible(hopeless, 'LD', cfg);
  const hc = fieldingChances(hopeless, 'LD', cfg);
  const hGood = outProb(hc.reqSpeed[hnr.pos], hc.pThrow[hnr.pos], smaxOf(70, cfg), cfg);
  const hBad = outProb(hc.reqSpeed[hnr.pos], hc.pThrow[hnr.pos], smaxOf(30, cfg), cfg);
  assert.ok(hGood - hBad < good - bad, '絶望的な打球では巧拙の差が小さい');
});

/** decideBases/expectedBasesは落下点(landingX/Y)を要求する（realism_r1 §6）。computeGeometryと同じ式で作る。 */
function mkLandedBB(distanceM, sprayDeg, runnerSpeed, evKmh = 150) {
  const rad = (sprayDeg * Math.PI) / 180;
  return {
    distanceM,
    sprayDeg,
    runnerSpeed,
    evKmh,
    landingX: distanceM * Math.sin(rad),
    landingY: distanceM * Math.cos(rad),
  };
}

test('decideBases(監査B1・realism_r1 §6): 浅い空中安打は単打、外野手到達圏を大きく越えた深い打球は二塁打', () => {
  const g = cfg.tuning.bb;
  const rng = makeRng(2026);
  const based = (distanceM, sprayDeg, runnerSpeed) =>
    decideBases(mkLandedBB(distanceM, sprayDeg, runnerSpeed), 'FB', cfg, rng);
  // gapDistM 手前に前落ちする空中安打は必ず単打
  for (let i = 0; i < 50; i++) assert.equal(based(g.gapDistM - 5, 20, 50), '1B', '浅い前落ちは単打');
  // CF正面(spray=0)を大きく越えた深い打球(dNear=32)は必ず二塁打（pStay1が0に張り付く）
  for (let i = 0; i < 50; i++) assert.equal(based(130, 0, 50), '2B', 'CFを大きく越えた深い打球は二塁打');
  // 最深ギャップ(|spray|>18)＋俊足なら三塁打が一定割合で出る
  let triples = 0;
  for (let i = 0; i < 400; i++) if (based(130, 25, 80) === '3B') triples++;
  assert.ok(triples > 0, `最深ギャップ×俊足で三塁打が発生 (${triples}/400)`);
  // 正面(|spray|≤18)の最深球は俊足でも三塁打にならず二塁打
  for (let i = 0; i < 50; i++) assert.equal(based(130, 10, 80), '2B', '正面最深球は二塁打止まり');
});

test('decideBases(realism_r1 §6・R1b改): 外野手の正面/手前のポトリはほぼ必ず単打（発端バグの回帰・CF定位置ライナー）', () => {
  // ユーザー報告の再現ケース: CF(r=98)の15.5m手前(spray=0)に落ちるライナー(EV165/LA10)。
  // 旧実装①は落下距離(gapDistM=76超)だけで無条件二塁打（100%が2B）。
  // 旧実装②(dNear判定)は「正面の手前15m」と「ギャップの横15m」を同一視し57%が2Bだった
  // （ユーザー再指摘）。ロール線モデル: 正面(dPerp=0)はボールがCFに向かって転がるため
  // どれだけ手前でも必ずカット＝ほぼ100%単打。
  const rng = makeRng(777);
  const rate = (dist, type) => {
    let singles = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) if (decideBases(mkLandedBB(dist, 0, 50), type, cfg, rng) === '1B') singles++;
    return singles / n;
  };
  assert.ok(rate(82.5, 'LD') >= 0.97, `CF手前15.5mの前落ちライナーはほぼ単打 (単打率=${rate(82.5, 'LD').toFixed(3)})`);
  assert.ok(rate(94, 'FB') >= 0.95, `CF正面手前4mのポトリもほぼ単打 (単打率=${rate(94, 'FB').toFixed(3)})`);
  assert.ok(rate(88, 'LD') >= 0.95, `CF正面手前10mもほぼ単打 (単打率=${rate(88, 'LD').toFixed(3)})`);
});

test('decideBases(realism_r1 §6): 外野手の頭上を僅かに越えた打球は単打止まりの余地がある（追いつかれる）', () => {
  const rng = makeRng(2027);
  let doubles = 0;
  const n = 1000;
  for (let i = 0; i < n; i++) {
    // CF(r=98)を2m越えた地点(dNear=2)。pStay1=clamp(0.35-0.03*2,0,0.5)=0.29 → 約71%が二塁打。
    if (decideBases(mkLandedBB(100, 0, 50), 'FB', cfg, rng) === '2B') doubles++;
  }
  const rate = doubles / n;
  assert.ok(rate > 0.5 && rate < 0.9, `僅かに越えた打球は単打止まりの余地がある (2B率=${rate.toFixed(2)})`);
});

test('decideBases(realism_r1 §6・R1b改): 真のギャップ(spray±14)へ深く落ちた打球は転がり抜けて二塁打になりやすい', () => {
  const rng = makeRng(2028);
  const rate2B = (dist, spray) => {
    let doubles = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) if (decideBases(mkLandedBB(dist, spray, 50), 'LD', cfg, rng) === '2B') doubles++;
    return doubles / n;
  };
  // 右中間ど真ん中(spray=14)・アーク際(85m): ロール線への横ズレが両翼とも21m超＝誰も遮断できない
  assert.ok(rate2B(85, 14) > 0.6, `右中間の深いギャップ球は二塁打が多数 (2B率=${rate2B(85, 14).toFixed(2)})`);
  // ライン際(spray=40)のアーク際: RFの横ズレ18m＝コーナーへ転がる
  assert.ok(rate2B(82, 40) > 0.5, `ライン際の深い打球も二塁打が多数 (2B率=${rate2B(82, 40).toFixed(2)})`);
  // 同じギャップ角でも浅い落下(76m)は野手が収束する時間があり2B率が下がる（深さ補正）
  assert.ok(rate2B(76, 14) < rate2B(85, 14), '浅いギャップ球ほど遮断されやすい（深さ補正が効く）');
});

test('decideBases(realism_r1 §6): ゴロはライン際×強い打球ほど二塁打（正面はほぼ単打・俊足のライン際は三塁打もありうる）', () => {
  const rng = makeRng(2026);
  // 正面(spray=5)はpCornerがほぼ0＝ほぼ確実に単打
  for (let i = 0; i < 100; i++) {
    assert.equal(decideBases({ evKmh: 150, sprayDeg: 5, runnerSpeed: 50 }, 'GB', cfg, rng), '1B', 'GB正面は単打');
  }
  // ライン際×強い打球×俊足は二塁打・三塁打が一定割合で出る
  let doubles = 0, triples = 0;
  const n = 1000;
  for (let i = 0; i < n; i++) {
    const r = decideBases({ evKmh: 165, sprayDeg: 45, runnerSpeed: 80 }, 'GB', cfg, rng);
    if (r === '2B') doubles++;
    else if (r === '3B') triples++;
  }
  assert.ok(doubles + triples > n * 0.3, `ライン際の強い打球は長打になりやすい (${doubles + triples}/${n})`);
  assert.ok(triples > 0, `俊足のライン際ゴロは三塁打も出る (${triples}/${n})`);
});

test('expectedBases(realism_r1 §6): decideBasesと同一分岐の確率版・モンテカルロで整合する', () => {
  const rng = makeRng(9999);
  const cases = [
    mkLandedBB(60, 20, 50), // 前落ち単打
    mkLandedBB(82.5, 0, 50), // 発端ケース(単打)
    mkLandedBB(100, 0, 50), // 僅かに越えた(混在)
    mkLandedBB(70, 20, 50), // ギャップ(混在)
    mkLandedBB(130, 0, 50), // 大きく越えた(確定2B)
    mkLandedBB(130, 25, 80), // 深いギャップ×俊足(混在3B)
  ];
  for (const bb of cases) {
    const type = 'FB';
    const eb = expectedBases(bb, type, cfg);
    assert.ok(Math.abs(eb.p1 + eb.p2 + eb.p3 - 1) < 1e-9, `確率の和は1 (${JSON.stringify(eb)})`);
    const n = 4000;
    let c1 = 0, c2 = 0, c3 = 0;
    for (let i = 0; i < n; i++) {
      const r = decideBases({ ...bb }, type, cfg, rng);
      if (r === '1B') c1++; else if (r === '2B') c2++; else c3++;
    }
    const tol = 0.05;
    assert.ok(Math.abs(c1 / n - eb.p1) < tol, `p1整合 期待${eb.p1.toFixed(3)} 実測${(c1 / n).toFixed(3)}`);
    assert.ok(Math.abs(c2 / n - eb.p2) < tol, `p2整合 期待${eb.p2.toFixed(3)} 実測${(c2 / n).toFixed(3)}`);
    assert.ok(Math.abs(c3 / n - eb.p3) < tol, `p3整合 期待${eb.p3.toFixed(3)} 実測${(c3 / n).toFixed(3)}`);
  }
});

test('expectedBases(realism_r1 §6): GBもdecideBasesと同一分岐の確率版と整合する', () => {
  const rng = makeRng(1234);
  const bb = { evKmh: 165, sprayDeg: 45, runnerSpeed: 80 };
  const eb = expectedBases(bb, 'GB', cfg);
  assert.ok(Math.abs(eb.p1 + eb.p2 + eb.p3 - 1) < 1e-9);
  const n = 4000;
  let c1 = 0, c2 = 0, c3 = 0;
  for (let i = 0; i < n; i++) {
    const r = decideBases({ ...bb }, 'GB', cfg, rng);
    if (r === '1B') c1++; else if (r === '2B') c2++; else c3++;
  }
  const tol = 0.05;
  assert.ok(Math.abs(c1 / n - eb.p1) < tol, `p1整合 期待${eb.p1.toFixed(3)} 実測${(c1 / n).toFixed(3)}`);
  assert.ok(Math.abs(c2 / n - eb.p2) < tol, `p2整合 期待${eb.p2.toFixed(3)} 実測${(c2 / n).toFixed(3)}`);
  assert.ok(Math.abs(c3 / n - eb.p3) < tol, `p3整合 期待${eb.p3.toFixed(3)} 実測${(c3 / n).toFixed(3)}`);
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

test('プラトーン: 同利きは逆利きより平均EVが低く、スイッチは常に有利側（S1・M7解消）', () => {
  const pitR = createPlayer({
    role: 'pitcher',
    throws: 'R',
    trueAbility: createTrueAbility({ pitching: { velocityKmh: 146, pitches: [createPitch('fastball')] } }),
  });
  const mkBat = (bats) => createPlayer({ role: 'fielder', bats, trueAbility: createTrueAbility() });
  const meanEV = (bat) => {
    const rng = makeRng(11); // 同一シードでノイズ列を揃え、中心シフトだけを比較
    let s = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) s += generateBattedBall(bat, pitR, cfg, rng).evKmh;
    return s / n;
  };
  const same = meanEV(mkBat('R')); // R vs R = 同利き
  const opp = meanEV(mkBat('L')); // L vs R = 逆利き
  assert.ok(
    Math.abs(opp - same - Math.abs(cfg.tuning.platoon.evKmhSame)) < 0.3,
    `同利きでEVが約${-cfg.tuning.platoon.evKmhSame}km/h低い (same=${same.toFixed(2)}, opp=${opp.toFixed(2)})`,
  );
  // スイッチは対右で左打者と同じEV分布（同一シード列で完全一致）
  assert.ok(Math.abs(meanEV(mkBat('S')) - opp) < 1e-9, 'Sは対右投手で左打者と同分布=有利側');
});

test('スイッチヒッターの引っ張り方向は実効打席サイドに従う（対右→右打席側+）', () => {
  const puller = (bats) =>
    createPlayer({ role: 'fielder', bats, trueAbility: createTrueAbility({ batting: { pull: 75 } }) });
  const mkPit = (throws) =>
    createPlayer({
      role: 'pitcher',
      throws,
      trueAbility: createTrueAbility({ pitching: { velocityKmh: 146, pitches: [createPitch('fastball')] } }),
    });
  const meanSpray = (bat, pit) => {
    const rng = makeRng(7);
    let s = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) s += generateBattedBall(bat, pit, cfg, rng).sprayDeg;
    return s / n;
  };
  assert.ok(meanSpray(puller('S'), mkPit('R')) > 3, '対右は左打席＝spray正(右方向)へ引っ張る');
  assert.ok(meanSpray(puller('S'), mkPit('L')) < -3, '対左は右打席＝spray負(左方向)へ引っ張る');
});

test('D1-1: HRは打者power/EVへ急峻に依存する（スラッガーのHR率≫非力打者）', () => {
  // 同一の投手・乱数列で、強打者(power/ev高)と非力打者(低)の生成打球を解決し、HR率を比較。
  const slugger = createPlayer({
    role: 'fielder',
    trueAbility: createTrueAbility({ common: { power: 80 }, batting: { ev: 80, la: 60, pull: 65 } }),
  });
  const weak = createPlayer({
    role: 'fielder',
    trueAbility: createTrueAbility({ common: { power: 25 }, batting: { ev: 25, la: 60, pull: 65 } }),
  });
  const pit = avgPitcher();
  const hrRate = (bat) => {
    const rng = makeRng(99); // 同一シードでノイズ列を揃える
    let hr = 0;
    const n = 30000;
    for (let i = 0; i < n; i++) {
      const bb = generateBattedBall(bat, pit, cfg, rng);
      if (resolveBattedBall(bb, cfg, rng).result === 'HR') hr++;
    }
    return hr / n;
  };
  const rS = hrRate(slugger);
  const rW = hrRate(weak);
  // 急峻依存: スラッガーは非力打者の数倍以上のHR率（v²＋HR飛距離モデルの非線形性）
  assert.ok(rS > rW * 4, `スラッガーHR率(${rS.toFixed(4)}) ≫ 非力打者(${rW.toFixed(4)})`);
  assert.ok(rS > 0.02, `スラッガーは十分なHR率 (${rS.toFixed(4)})`);
});

test('D1-1: HR判定は決定論的（同一シードで同一結果列を再現）', () => {
  const bat = createPlayer({
    role: 'fielder',
    trueAbility: createTrueAbility({ common: { power: 70 }, batting: { ev: 70 } }),
  });
  const pit = avgPitcher();
  const seq = (seed) => {
    const rng = makeRng(seed);
    const out = [];
    for (let i = 0; i < 500; i++) {
      const bb = generateBattedBall(bat, pit, cfg, rng);
      out.push(resolveBattedBall(bb, cfg, rng).result);
    }
    return out.join(',');
  };
  assert.equal(seq(7), seq(7), '同一シードは同一結果列（rng経由のみ・Date.now/Math.random不使用）');
  assert.notEqual(seq(7), seq(8), '異なるシードは異なる列');
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

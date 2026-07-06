// 監督ポリシー（S2 manager.mjs）の単体テスト。判断関数を状況→判断の純粋関数として固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';
import { createBattingLine } from '../src/model/statline.mjs';
import {
  neutralManager,
  observedWoba,
  buildPregameEval,
  stealLogitAdjust,
  buntAttemptProb,
  ibbProb,
  choosePinchHitter,
  choosePinchRunner,
  chooseDefensiveSub,
  chooseReliever,
  leverageProxy,
  starterPitchLimit,
} from '../src/sim/manager.mjs';

const cfg = createConfig();
const mgr = neutralManager();

/** テスト用の選手（bat=打撃系一括, speed, prof=守備習熟の部分上書き） */
function mkPlayer(id, { role = 'fielder', bats = 'R', throws = 'R', bat = 50, speed = 50, prof = {} } = {}) {
  return createPlayer({
    id,
    role,
    bats,
    throws,
    trueAbility: createTrueAbility({
      common: { power: bat, speed },
      batting: { ev: bat, contact: bat, eye: bat, la: bat },
      fielding: { positionProf: prof },
    }),
  });
}

test('neutralManager: 全項目50（リーグ平均の采配）', () => {
  assert.deepEqual(mgr, { buntTend: 50, stealTend: 50, ibbTend: 50, quickHook: 50 });
});

test('observedWoba: 無打席=リーグ平均prior・好成績>prior・貧打<prior（観測のみで真値を見ない）', () => {
  const empty = createBattingLine();
  assert.ok(Math.abs(observedWoba(empty, cfg) - cfg.tuning.mgr.wobaPrior) < 1e-9);
  const hot = { ...createBattingLine(), pa: 300, ab: 260, bb: 35, b1: 55, b2: 18, hr: 20, sf: 5 };
  const cold = { ...createBattingLine(), pa: 300, ab: 290, bb: 8, b1: 35, sf: 2 };
  assert.ok(observedWoba(hot, cfg) > cfg.tuning.mgr.wobaPrior, '好成績はprior超');
  assert.ok(observedWoba(cold, cfg) < cfg.tuning.mgr.wobaPrior, '貧打はprior未満');
});

test('buntAttemptProb: 投手はほぼ必ず・強打者/2死/三塁走者は0・buntTendで単調増（S2犠打）', () => {
  const base = { manager: mgr, bases: ['r1', null, null], outs: 0, scoreDiff: 0, batterWoba: 0.25, isPitcher: false };
  const p0 = buntAttemptProb(base, cfg);
  assert.ok(p0 > 0 && p0 < 1);
  assert.equal(buntAttemptProb({ ...base, isPitcher: true }, cfg), cfg.tuning.bunt.pitcherAttempt, '投手打席');
  assert.equal(buntAttemptProb({ ...base, outs: 2 }, cfg), 0, '2死では試行しない');
  assert.equal(buntAttemptProb({ ...base, bases: ['r1', null, 'r3'] }, cfg), 0, '三塁走者ありは対象外');
  assert.equal(buntAttemptProb({ ...base, bases: [null, null, null] }, cfg), 0, '走者なし');
  assert.equal(buntAttemptProb({ ...base, batterWoba: 0.36 }, cfg), 0, '強打者にはバントさせない');
  assert.equal(buntAttemptProb({ ...base, scoreDiff: 4 }, cfg), 0, '大差では試行しない');
  const hi = buntAttemptProb({ ...base, manager: { ...mgr, buntTend: 70 } }, cfg);
  const lo = buntAttemptProb({ ...base, manager: { ...mgr, buntTend: 30 } }, cfg);
  assert.ok(hi > p0 && p0 > lo, 'buntTendで単調');
});

test('ibbProb: 一塁空き×一死/二死×終盤接戦×強打者（or次打者が投手）のみ正（S2敬遠）', () => {
  const base = {
    manager: mgr,
    bases: [null, 'r2', null],
    outs: 2,
    inning: 9,
    scoreDiff: 0,
    batterWoba: 0.4,
    nextIsPitcher: false,
  };
  assert.ok(ibbProb(base, cfg) > 0);
  assert.equal(ibbProb({ ...base, inning: 6 }, cfg), 0, '序盤は敬遠しない');
  assert.equal(ibbProb({ ...base, outs: 0 }, cfg), 0, '無死は対象外');
  assert.equal(ibbProb({ ...base, bases: ['r1', 'r2', null] }, cfg), 0, '一塁が埋まっていれば対象外');
  assert.equal(ibbProb({ ...base, bases: [null, null, null] }, cfg), 0, '得点圏に走者なし');
  assert.equal(ibbProb({ ...base, scoreDiff: 3 }, cfg), 0, '大差では敬遠しない');
  assert.equal(ibbProb({ ...base, batterWoba: 0.3 }, cfg), 0, '並の打者は勝負');
  assert.ok(ibbProb({ ...base, batterWoba: 0.3, nextIsPitcher: true }, cfg) > 0, '次打者が投手なら歩かせる');
  const hi = ibbProb({ ...base, manager: { ...mgr, ibbTend: 70 } }, cfg);
  const lo = ibbProb({ ...base, manager: { ...mgr, ibbTend: 30 } }, cfg);
  assert.ok(hi > lo, 'ibbTendで単調');
});

test('stealLogitAdjust: 大差で走らない・2死×強打者で自重・stealTendで単調（S2盗塁ゲート）', () => {
  const neutral = stealLogitAdjust(mgr, { scoreDiff: 0, outs: 0, batterWoba: 0.32 }, cfg);
  assert.ok(Math.abs(neutral) < 1e-9, '中立監督×接戦=補正なし');
  assert.ok(stealLogitAdjust(mgr, { scoreDiff: 6, outs: 0, batterWoba: 0.32 }, cfg) < -1, '大差で抑制');
  assert.ok(stealLogitAdjust(mgr, { scoreDiff: -6, outs: 0, batterWoba: 0.32 }, cfg) < -1, 'ビハインド大差も抑制');
  assert.ok(stealLogitAdjust(mgr, { scoreDiff: 0, outs: 2, batterWoba: 0.4 }, cfg) < 0, '2死×強打者で自重');
  assert.ok(stealLogitAdjust({ ...mgr, stealTend: 70 }, { scoreDiff: 0, outs: 0, batterWoba: 0.32 }, cfg) > 0);
});

test('starterPitchLimit: quickHookが高いほど早く降ろす・スタミナで伸びる（S2継投）', () => {
  const p = mkPlayer('P1', { role: 'pitcher' });
  const quick = starterPitchLimit({ ...mgr, quickHook: 70 }, p, cfg);
  const slow = starterPitchLimit({ ...mgr, quickHook: 30 }, p, cfg);
  assert.ok(quick < slow);
  p.trueAbility.pitching.stamina = 70;
  assert.ok(starterPitchLimit(mgr, p, cfg) > slow - (slow - quick) / 2, 'スタミナで上限増');
});

test('choosePinchHitter: 投手へは6回以降ビハインドで・野手へは得点機×実効打力差で・リード時は出さない（S2代打）', () => {
  const weakF = mkPlayer('F9', { bat: 40 });
  const pitcherBat = mkPlayer('P0', { role: 'pitcher', bat: 30 });
  const star = mkPlayer('B1', { bat: 70 });
  const oppPitcher = mkPlayer('OP', { role: 'pitcher', throws: 'R' });
  const byId = new Map([weakF, pitcherBat, star].map((p) => [p.id, p]));
  const side = {
    score: 2,
    byId,
    bench: ['B1'],
    pregame: buildPregameEval(byId, cfg),
    bullpen: ['RP1'],
    usedPitchers: new Set(),
    retired: new Set(),
  };
  // 投手への代打: 6回以降・ビハインド
  const ctxP = { side, oppScore: 4, bases: [null, null, null], inning: 6, batterId: 'P0', isPitcher: true, oppPitcher };
  assert.equal(choosePinchHitter(ctxP, cfg), 'B1');
  // F2-5較正: phPitcherInning 6→5（29人登録でベンチが厚くなった分の代打前倒し）。境界はノブ連動に。
  assert.equal(choosePinchHitter({ ...ctxP, inning: cfg.tuning.sub.phPitcherInning - 1 }, cfg), null, 'phPitcherInning未満は投手に打たせる');
  assert.equal(choosePinchHitter({ ...ctxP, oppScore: 1 }, cfg), null, 'リード時は続投前提');
  // 救援が残っていなければ投手に代打を出せない
  const noPen = { ...side, usedPitchers: new Set(['RP1']) };
  assert.equal(choosePinchHitter({ ...ctxP, side: noPen }, cfg), null, '救援ゼロでは代打不可');
  // 野手への代打: 7回以降・同点以下・得点圏
  const ctxF = { side, oppScore: 2, bases: [null, 'rX', null], inning: 8, batterId: 'F9', isPitcher: false, oppPitcher };
  assert.equal(choosePinchHitter(ctxF, cfg), 'B1');
  assert.equal(choosePinchHitter({ ...ctxF, bases: [null, null, null] }, cfg), null, '得点機なしは温存');
  assert.equal(choosePinchHitter({ ...ctxF, inning: 6 }, cfg), null, '中盤は温存');
  assert.equal(choosePinchHitter({ ...ctxF, oppScore: 0 }, cfg), null, 'リード時は守備優先');
});

test('choosePinchHitter: プラトーン込みでベンチ最良を選ぶ（同利きは減点・スイッチは常に有利側）（S2）', () => {
  const weakF = mkPlayer('F9', { bat: 40 });
  const sameR = mkPlayer('BR', { bat: 60, bats: 'R' });
  const oppL = mkPlayer('BL', { bat: 60, bats: 'L' });
  const oppPitcher = mkPlayer('OP', { role: 'pitcher', throws: 'R' });
  const byId = new Map([weakF, sameR, oppL].map((p) => [p.id, p]));
  const side = {
    score: 0,
    byId,
    bench: ['BR', 'BL'], // 同能力: 対右投手ならL打者が有利
    pregame: buildPregameEval(byId, cfg),
    bullpen: [],
    usedPitchers: new Set(),
    retired: new Set(),
  };
  const ctx = { side, oppScore: 1, bases: [null, 'rX', null], inning: 8, batterId: 'F9', isPitcher: false, oppPitcher };
  assert.equal(choosePinchHitter(ctx, cfg), 'BL', '対右投手には左のベンチを選ぶ');
});

test('choosePinchRunner: 8回以降接戦×鈍足走者→ベンチ最速。条件外はnull（S2代走）', () => {
  const slow = mkPlayer('R1', { speed: 30 });
  const fast = mkPlayer('S1', { speed: 80 });
  const mid = mkPlayer('R2', { speed: 72 });
  const byId = new Map([slow, fast, mid].map((p) => [p.id, p]));
  const side = { score: 3, byId, bench: ['S1'], pregame: buildPregameEval(byId, cfg), curPid: 'CURP' };
  const ctx = { side, oppScore: 3, bases: [null, 'R1', null], inning: 8 };
  assert.deepEqual(choosePinchRunner(ctx, cfg), { baseIdx: 1, pid: 'S1' });
  assert.equal(choosePinchRunner({ ...ctx, inning: 7 }, cfg), null, '7回は温存');
  assert.equal(choosePinchRunner({ ...ctx, oppScore: 0 }, cfg), null, '大差リードでは温存');
  assert.equal(choosePinchRunner({ ...ctx, bases: [null, 'R2', null] }, cfg), null, '走力差が小さければ温存');
  assert.equal(choosePinchRunner({ ...ctx, bases: [null, null, null] }, cfg), null, '走者なし');
});

test('chooseDefensiveSub: 8回以降リード1-3で守備最弱ポジを上位互換と交代（S2守備固め）', () => {
  const defense = {};
  const players = [];
  const POS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
  for (const pos of POS) {
    const pid = `D${pos}`;
    players.push(mkPlayer(pid, { prof: { [pos]: pos === 'SS' ? 25 : 55 } })); // SSだけ守備が穴
    defense[pos] = pid;
  }
  const glove = mkPlayer('G1', { prof: { SS: 60 } });
  players.push(glove);
  const byId = new Map(players.map((p) => [p.id, p]));
  const side = { score: 2, byId, bench: ['G1'], pregame: buildPregameEval(byId, cfg), defense, curPid: 'CURP' };
  assert.deepEqual(chooseDefensiveSub({ side, oppScore: 1, inning: 8 }, cfg), { pos: 'SS', pid: 'G1' });
  assert.equal(chooseDefensiveSub({ side, oppScore: 1, inning: 7 }, cfg), null, '7回はまだ');
  assert.equal(chooseDefensiveSub({ side, oppScore: 2, inning: 9 }, cfg), null, '同点では守備固めしない');
  assert.equal(chooseDefensiveSub({ side, oppScore: -3, inning: 9 }, cfg), null, '大差リードは不要');
  // 上位互換がいなければ交代しない
  const noGain = { ...side, bench: [], pregame: side.pregame };
  assert.equal(chooseDefensiveSub({ side: noGain, oppScore: 1, inning: 8 }, cfg), null);
});

test('chooseReliever: 状況→役割（9回セーブ=closer/8回=setup8/7回=setup7/大差ビハインド=long/他=middle負荷分散）（S2継投v2）', () => {
  const side = {
    teamId: 'T',
    bullpen: ['c', 's8', 's7', 'm1', 'm2', 'lg'],
    usedPitchers: new Set(),
    retired: new Set(),
    roles: { closer: 'c', setup8: 's8', setup7: 's7', middle: ['m1', 'm2'], long: 'lg' },
  };
  const outsBy = { c: 0, s8: 0, s7: 20, m1: 10, m2: 5, lg: 30 };
  const statFor = (pid) => ({ pitching: { outs: outsBy[pid] } });
  assert.equal(chooseReliever(side, statFor, 9, 2, cfg), 'c', '9回セーブ機会=closer');
  assert.equal(chooseReliever(side, statFor, 10, 1, cfg), 'c', '延長のセーブ機会もcloser');
  assert.equal(chooseReliever(side, statFor, 8, 3, cfg), 's8', '8回接戦=setup8');
  assert.equal(chooseReliever(side, statFor, 7, 1, cfg), 's7', '7回接戦=setup7');
  assert.equal(chooseReliever(side, statFor, 6, -6, cfg), 'lg', '大差ビハインド=long（敗戦処理）');
  assert.equal(chooseReliever(side, statFor, 6, 0, cfg), 'm2', '同点中盤=middleの負荷最少');
  assert.equal(chooseReliever(side, statFor, 9, 7, cfg), 'm2', '大差リードでcloser/setup8は温存');
  // closer使用済みの9回セーブ機会は序列上位で代替
  const usedC = { ...side, usedPitchers: new Set(['c']) };
  assert.equal(chooseReliever(usedC, statFor, 9, 2, cfg), 's8');
  // closerしか残っていない非セーブ状況は現投手続投（null）
  const onlyC = { ...side, usedPitchers: new Set(['s8', 's7', 'm1', 'm2', 'lg']) };
  assert.equal(chooseReliever(onlyC, statFor, 5, 0, cfg), null);
  assert.equal(chooseReliever(onlyC, statFor, 9, 2, cfg), 'c', 'セーブ機会ならcloserを出す');
});

// --- D4 レバレッジ駆動継投（§8.3の完成） ---------------------------------------

test('leverageProxy: 終盤×接戦×走者ありで上昇・大差/序盤で低下（状態の純関数＝決定論）', () => {
  const pen = cfg.tuning.pen;
  const lp = (inn, lead, bb, outs) => leverageProxy(inn, lead, bb, outs, pen);
  // 回が進むほど上昇（同点・走者なし）
  assert.ok(lp(9, 0, 0, 0) > lp(8, 0, 0, 0) && lp(8, 0, 0, 0) > lp(7, 0, 0, 0), '終盤ほど高い');
  // 点差が開くほど低下
  assert.ok(lp(9, 0, 0, 0) > lp(9, 3, 0, 0) && lp(9, 3, 0, 0) > lp(9, 6, 0, 0), '接戦ほど高い');
  // 走者（得点圏）で上昇、アウトで低下
  assert.ok(lp(8, 0, 6, 0) > lp(8, 0, 0, 0), '得点圏で上昇');
  assert.ok(lp(8, 0, 7, 0) > lp(8, 0, 7, 2), 'アウトが少ないほど高い');
  // 決定論: 同一入力は同一出力
  assert.equal(lp(9, 1, 2, 1), lp(9, 1, 2, 1));
});

test('chooseReliever(D4): 高レバレッジ局面では最良セットアッパーが出る／低レバレッジは middle 温存（§8.3）', () => {
  const side = {
    teamId: 'T',
    bullpen: ['c', 's8', 's7', 'm1', 'm2', 'lg'], // relieverScore降順
    usedPitchers: new Set(),
    retired: new Set(),
    roles: { closer: 'c', setup8: 's8', setup7: 's7', middle: ['m1', 'm2'], long: 'lg' },
  };
  const statFor = (pid) => ({ pitching: { g: 0, outs: 0 } });
  // 同点9回（回頭・走者なし）は高レバレッジ → 最良セットアッパー s8（closerは温存）
  assert.equal(chooseReliever(side, statFor, 9, 0, cfg), 's8', '同点終盤の高LIは最良setup（closer温存）');
  // s8 使用済みなら次善 s7
  const usedS8 = { ...side, usedPitchers: new Set(['s8']) };
  assert.equal(chooseReliever(usedS8, statFor, 9, 0, cfg), 's7', '最良払底時は次善setup');
  // セットアッパー払底 → middle(B級)へフォールスルー（薄いブルペンが高LIにB級を晒す構造）
  const noSetup = { ...side, usedPitchers: new Set(['s8', 's7']) };
  assert.ok(['m1', 'm2'].includes(chooseReliever(noSetup, statFor, 9, 0, cfg)), 'setup払底で middle(B級)に晒す');
  // 同点8回に走者を背負った火消し（得点圏2走者1死＝高LI）は middle でなく最良s8を投入（LI駆動）
  const jam = { baseBits: 6, outs: 1 };
  assert.equal(chooseReliever(side, statFor, 8, 0, cfg, jam), 's8', '高LI火消しは最良setup（LI駆動）');
  // 走者なしの通常7回セーブ機会（回頭）は回固定 setup7（HLD分布維持）
  assert.equal(chooseReliever(side, statFor, 7, 1, cfg, { baseBits: 0, outs: 0 }), 's7', '通常セーブ機会は回固定');
  // 中盤同点（7回・走者なし＝低LI）は従来通り middle 負荷分散（setup温存）
  assert.ok(['m1', 'm2'].includes(chooseReliever(side, statFor, 7, 0, cfg)), '低LI同点は middle');
});

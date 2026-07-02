// WAR算出（2-9）のテスト。集計の妥当性と構成要素の整合。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { hitterWAR, pitcherWAR, posAdjRuns } from '../src/sim/war.mjs';
import { mainPosition, totalFieldInnings } from '../src/sim/fielding.mjs';
import { createPlayerSeason } from '../src/model/statline.mjs';

const cfg = createConfig();
const lg = generateLeague(2026, cfg);
const res = simulateSeason(lg, cfg, { seed: 2026 });
const lc = deriveLeagueConstants(res);
const byId = new Map(lg.players.map((p) => [p.id, p]));

test('総WARがリーグ規模相応・野手比が~55%', () => {
  let hit = 0, pit = 0;
  for (const s of res.playerSeasons) {
    const p = byId.get(s.playerId);
    if (p.role === 'pitcher') pit += pitcherWAR(s, cfg, lc).war;
    else hit += hitterWAR(s, cfg, lc).war;
  }
  const total = hit + pit;
  // 総WAR ≈ teams×games×0.224（代替水準較正）。単一シードなので広めに許容。
  const exp = cfg.league.numTeams * cfg.league.gamesPerSeason * 0.224;
  assert.ok(total > exp * 0.8 && total < exp * 1.25, `総WAR ${total.toFixed(0)} (期待~${exp.toFixed(0)})`);
  const share = hit / total;
  assert.ok(share > 0.5 && share < 0.6, `野手比 ${(share * 100).toFixed(0)}%`);
});

test('hitterWAR = (wRAA+BsR+UZR+posAdj+repl)/RPW（構成の整合）', () => {
  const s = res.playerSeasons.find((x) => x.batting.pa >= 400 && byId.get(x.playerId).role === 'fielder');
  const w = hitterWAR(s, cfg, lc);
  const recomputed = (w.wraa + w.bsr + w.uzr + w.posAdj + w.repl) / lc.rpw;
  assert.ok(Math.abs(w.war - recomputed) < 1e-9);
  assert.ok(w.repl > 0, 'replは正（代替水準ボーナス）');
});

test('DHに守備位置ペナルティ(-17.5/1350)が適用され、mainPositionがDHを正しく返す（監査A1/C2）', () => {
  // S2: DH有はL2主催試合のみ＝フルタイムDHでも~100試合分。最多DHアウトの選手（L2球団の正DH）で検証する。
  const dh = res.playerSeasons.reduce(
    (a, s) => ((s.fielding.positionOuts.DH || 0) > (a ? a.fielding.positionOuts.DH || 0 : 0) ? s : a),
    null,
  );
  assert.ok(dh && (dh.fielding.positionOuts.DH || 0) > 1000, 'DHが存在（positionOuts.DHが計上される）');
  // S3日次起用（休養・プラトーン・見直し）でDH出場が複数選手に分散するため、閾値は-4へ緩和
  // TODO(S5較正): DH固定度が上がる較正後は -10 へ戻すことを検討
  assert.ok(posAdjRuns(dh) < -4, `DHのposAdjは大きな負 (got ${posAdjRuns(dh).toFixed(1)})`);
  assert.equal(mainPosition(dh.fielding), 'DH', 'DHのmainPositionはDH（Cと誤判定しない）');
  // 守備イニング0の野手がCと誤ラベルされない（C2回帰: DHは今やDHイニングを持つ）
  const zeroInnC = res.playerSeasons.filter(
    (s) => totalFieldInnings(s.fielding) === 0 && byId.get(s.playerId).role === 'fielder' && mainPosition(s.fielding) === 'C',
  );
  assert.equal(zeroInnC.length, 0, '守備イニング0の野手をCと誤判定しない');
});

test('posAdjRuns: 難ポジ(SS)は+、易ポジ(1B)は−', () => {
  const ss = { fielding: { positionOuts: { SS: 3861, C: 0, '1B': 0, '2B': 0, '3B': 0, LF: 0, CF: 0, RF: 0 } } };
  const fb = { fielding: { positionOuts: { '1B': 3861, C: 0, SS: 0, '2B': 0, '3B': 0, LF: 0, CF: 0, RF: 0 } } };
  assert.ok(posAdjRuns(ss) > 0, 'SSは+');
  assert.ok(posAdjRuns(fb) < 0, '1Bは−');
});

test('役割別代替水準（S3）: 同一FIP/IPでも先発の代替加算 > 救援・GS/Gで按分', () => {
  const mk = (g, gs) => {
    const s = createPlayerSeason('x', 2026);
    Object.assign(s.pitching, { outs: 540, g, gs, so: 150, bb: 50, ibb: 0, hbp: 5, hr: 18, er: 70, r: 75 });
    return s;
  };
  const sp = pitcherWAR(mk(20, 20), cfg, lc); // 純先発
  const rp = pitcherWAR(mk(60, 0), cfg, lc); // 純救援
  assert.ok(Math.abs(sp.fip - rp.fip) < 1e-9, '同一FIP');
  assert.ok(sp.war > rp.war, '先発の代替水準が高い（向き）');
  const ip = 540 / 3;
  const expDiff = (ip / 9) * (cfg.tuning.replStarterPer9 - cfg.tuning.replRelieverPer9);
  assert.ok(Math.abs(sp.war - rp.war - expDiff) < 1e-9, '差 = IP/9×(先発repl−救援repl)');
  assert.ok(Math.abs(sp.replPer9 - cfg.tuning.replStarterPer9) < 1e-9, '先発は0.12 wins/9IP');
  assert.ok(Math.abs(rp.replPer9 - cfg.tuning.replRelieverPer9) < 1e-9, '救援は0.03 wins/9IP');
  const sw = pitcherWAR(mk(40, 20), cfg, lc); // スイングマン（GS/G=0.5）
  assert.ok(sw.war > rp.war && sw.war < sp.war, 'GS/Gで中間に按分');
  assert.equal(cfg.tuning.replFipMult, undefined, '旧replFipMultは廃止');
});

test('好投手ほど投手WARが高い（FIP低→WAR高）', () => {
  const qp = res.playerSeasons
    .filter((s) => s.pitching.outs / 3 >= 100)
    .map((s) => ({ war: pitcherWAR(s, cfg, lc).war, fip: pitcherWAR(s, cfg, lc).fip }));
  qp.sort((a, b) => a.fip - b.fip);
  assert.ok(qp[0].war > qp[qp.length - 1].war, 'FIP最良投手のWAR > FIP最悪投手');
});

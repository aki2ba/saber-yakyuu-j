// WAR算出（2-9）のテスト。集計の妥当性と構成要素の整合。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { hitterWAR, pitcherWAR, posAdjRuns } from '../src/sim/war.mjs';
import { mainPosition, totalFieldInnings } from '../src/sim/fielding.mjs';

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
  const dh = res.playerSeasons.find((s) => (s.fielding.positionOuts.DH || 0) > 1000); // フル出場DH（アウト単位）
  assert.ok(dh, 'DHが存在（positionOuts.DHが計上される）');
  assert.ok(posAdjRuns(dh) < -10, `DHのposAdjは大きな負 (got ${posAdjRuns(dh).toFixed(1)})`);
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

test('好投手ほど投手WARが高い（FIP低→WAR高）', () => {
  const qp = res.playerSeasons
    .filter((s) => s.pitching.outs / 3 >= 100)
    .map((s) => ({ war: pitcherWAR(s, cfg, lc).war, fip: pitcherWAR(s, cfg, lc).fip }));
  qp.sort((a, b) => a.fip - b.fip);
  assert.ok(qp[0].war > qp[qp.length - 1].war, 'FIP最良投手のWAR > FIP最悪投手');
});

// リーグ定数(1-6)＋選手別指標(1-7)の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants, fillLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { playerBatting, playerPitching, playerBaserunning } from '../src/sim/metrics.mjs';
import { leagueBatting } from '../src/sim/leagueStats.mjs';

const cfg = createConfig();
const res = simulateSeason(generateLeague(2026, cfg), cfg, { season: 2026, seed: 2026 });
const lc = deriveLeagueConstants(res);

test('リーグ定数: lgwOBA=lgOBP・wobaScale>0・fipConstant有限・rpwが妥当', () => {
  const lb = leagueBatting(res.playerSeasons);
  assert.ok(Math.abs(lc.lgwOBA - lb.obp) < 1e-9, 'lgwOBA=lgOBP');
  assert.ok(lc.wobaScale > 0.5 && lc.wobaScale < 3, `wobaScale=${lc.wobaScale}`);
  assert.ok(Number.isFinite(lc.fipConstant), 'fipConstant finite');
  assert.ok(lc.rpw > 7 && lc.rpw < 12, `rpw=${lc.rpw}`);
});

test('リーグ平均打者の wRC+ は ~100', () => {
  // リーグ全体を1人の打者に見立てて wRC+ を出すと 100 付近
  const lb = leagueBatting(res.playerSeasons);
  const fake = { batting: { ...lb } };
  const m = playerBatting(fake, lc);
  assert.ok(Math.abs(m.wrcPlus - 100) < 5, `league wRC+ = ${m.wrcPlus}`);
});

test('リーグ平均打者の wOBA は lgwOBA(=lgOBP) 付近', () => {
  const lb = leagueBatting(res.playerSeasons);
  const m = playerBatting({ batting: lb }, lc);
  assert.ok(Math.abs(m.woba - lc.lgwOBA) < 0.01, `woba ${m.woba} ~ lgwOBA ${lc.lgwOBA}`);
});

test('好打者は wRC+ > 100、凡打者 < 100', () => {
  const qual = res.playerSeasons.filter((s) => s.batting.pa >= 443);
  const metrics = qual.map((s) => playerBatting(s, lc)).sort((a, b) => b.wrcPlus - a.wrcPlus);
  assert.ok(metrics[0].wrcPlus > 120, `トップ wRC+ ${metrics[0].wrcPlus}`);
  assert.ok(metrics[metrics.length - 1].wrcPlus < 100, `最下位 wRC+ ${metrics[metrics.length - 1].wrcPlus}`);
  // AVG/OBP/SLG/OPS の整合
  const t = metrics[0];
  assert.ok(t.ops > 0.001 && Math.abs(t.ops - (t.obp + t.slg)) < 1e-9);
});

test('投手指標: 規定投手の ERA/FIP が妥当域・整合', () => {
  const qp = res.playerSeasons.filter((s) => s.pitching.outs / 3 >= 143);
  assert.ok(qp.length > 0, '規定投球回の投手が存在');
  for (const s of qp) {
    const m = playerPitching(s, lc);
    assert.ok(m.era >= 0 && m.era < 8, `ERA ${m.era}`);
    assert.ok(m.fip > 0 && m.fip < 8, `FIP ${m.fip}`);
    assert.ok(Math.abs(m.ip - s.pitching.outs / 3) < 1e-9);
  }
});

test('fillLeagueConstants は cfg.leagueConstants を埋める（2パスの糊）', () => {
  const c = createConfig();
  assert.equal(c.leagueConstants.wobaScale, null);
  fillLeagueConstants(c, res);
  assert.ok(c.leagueConstants.wobaScale > 0);
  assert.ok(Number.isFinite(c.leagueConstants.fipConstant));
});

test('wSB はリーグ基準で中心化され、リーグ総和 ≈ 0（監査C1）', () => {
  // lc に wSB 基準(lgSB/lgCS/lgSBOpp)が導出されている
  assert.ok(lc.lgSBOpp > 0, 'lgSBOpp(一塁到達機会)が導出されている');
  assert.ok(lc.lgSB > 0, 'lgSB が集計されている');
  // 走者ごとの wSB を合計すると、基準控除により ≈ 0 に収束する
  let sumWSB = 0;
  for (const ps of res.playerSeasons) sumWSB += playerBaserunning(ps, cfg, lc).wSB;
  // リーグ総SB得点価値が小さい(数十run)ので、中心化後の残差は数run以内に収まる
  assert.ok(Math.abs(sumWSB) < 5, `リーグwSB総和が中心化されている (Σ=${sumWSB.toFixed(2)})`);
  // 中心化前(素点)は正なので、控除が効いている
  let raw = 0;
  for (const ps of res.playerSeasons) {
    const b = ps.batting;
    raw += b.sb * cfg.tuning.run.runSB + b.cs * cfg.tuning.run.runCS;
  }
  assert.ok(Math.abs(sumWSB) < Math.abs(raw), '中心化で素点より0へ寄っている');
});

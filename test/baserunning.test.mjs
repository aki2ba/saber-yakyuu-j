// 走塁（2-4 wSB）のテスト。盗塁生成・成功率・能力相関・wSB。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { playerBaserunning } from '../src/sim/metrics.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';

const cfg = createConfig();
const lg = generateLeague(2026, cfg);
const res = simulateSeason(lg, cfg, { seed: 2026 });

test('盗塁・盗塁死が生成され、リーグ成功率が損益分岐付近(65-78%)', () => {
  let sb = 0, cs = 0;
  for (const s of res.playerSeasons) { sb += s.batting.sb; cs += s.batting.cs; }
  assert.ok(sb > 200, `盗塁が発生する (got ${sb})`);
  const pct = sb / (sb + cs);
  assert.ok(pct > 0.65 && pct < 0.78, `成功率が損益分岐付近 (got ${(pct * 100).toFixed(1)}%)`);
});

test('盗塁数が走者のSteal/Speedと正の相関', () => {
  const byId = new Map(lg.players.map((p) => [p.id, p]));
  const runners = res.playerSeasons
    .filter((s) => s.batting.pa >= 300)
    .map((s) => ({ sb: s.batting.sb, tool: (byId.get(s.playerId).trueAbility.baserunning.steal + byId.get(s.playerId).trueAbility.common.speed) / 2 }));
  const n = runners.length;
  const ms = runners.reduce((a, b) => a + b.sb, 0) / n;
  const mt = runners.reduce((a, b) => a + b.tool, 0) / n;
  let cov = 0, vs = 0, vt = 0;
  for (const p of runners) { cov += (p.sb - ms) * (p.tool - mt); vs += (p.sb - ms) ** 2; vt += (p.tool - mt) ** 2; }
  const r = cov / Math.sqrt(vs * vt);
  assert.ok(r > 0.3, `盗塁↔(Steal+Speed) 相関 > 0.3 (got ${r.toFixed(2)})`);
});

test('併殺が生成され、併殺率が打者の足(speed)と負相関（wGDPの結線）', () => {
  let gdp = 0, opp = 0;
  for (const s of res.playerSeasons) { gdp += s.batting.gdp; opp += s.baserunning.gdpOpp; }
  assert.ok(gdp > 500, `併殺が発生する (got ${gdp})`);
  const byId = new Map(lg.players.map((p) => [p.id, p]));
  const reg = res.playerSeasons
    .filter((s) => s.baserunning.gdpOpp >= 15)
    .map((s) => ({ rate: s.batting.gdp / s.baserunning.gdpOpp, speed: byId.get(s.playerId).trueAbility.common.speed }));
  const n = reg.length;
  const mr = reg.reduce((a, b) => a + b.rate, 0) / n;
  const ms = reg.reduce((a, b) => a + b.speed, 0) / n;
  let cov = 0, vr = 0, vs = 0;
  for (const p of reg) { cov += (p.rate - mr) * (p.speed - ms); vr += (p.rate - mr) ** 2; vs += (p.speed - ms) ** 2; }
  assert.ok(cov / Math.sqrt(vr * vs) < -0.2, '足が速いほど併殺率が低い');
});

test('playerBaserunning: wSB = SB×runSB + CS×runCS、BsRに集約', () => {
  const ps = { batting: { sb: 30, cs: 8 } };
  const m = playerBaserunning(ps, cfg);
  const expected = 30 * cfg.tuning.run.runSB + 8 * cfg.tuning.run.runCS;
  assert.ok(Math.abs(m.wSB - expected) < 1e-9);
  assert.equal(m.bsr, m.wSB + m.ubr + m.wGDP);
  assert.ok(Math.abs(m.sbPct - 30 / 38) < 1e-9);
});

test('UBRが走者の足+走塁IQと正の相関、BsR=wSB+UBR+wGDP', () => {
  const lc = deriveLeagueConstants(res);
  const byId = new Map(lg.players.map((p) => [p.id, p]));
  const reg = res.playerSeasons
    .filter((s) => s.baserunning.advOpp >= 15)
    .map((s) => {
      const m = playerBaserunning(s, cfg, lc);
      const t = byId.get(s.playerId).trueAbility;
      // 内訳がBsRに一致
      assert.ok(Math.abs(m.bsr - (m.wSB + m.ubr + m.wGDP)) < 1e-9);
      return { ubr: m.ubr, tool: (t.common.speed + t.baserunning.baserunIQ) / 2 };
    });
  const n = reg.length;
  const mu = reg.reduce((a, b) => a + b.ubr, 0) / n;
  const mt = reg.reduce((a, b) => a + b.tool, 0) / n;
  let cov = 0, vu = 0, vt = 0;
  for (const p of reg) { cov += (p.ubr - mu) * (p.tool - mt); vu += (p.ubr - mu) ** 2; vt += (p.tool - mt) ** 2; }
  assert.ok(cov / Math.sqrt(vu * vt) > 0.3, 'UBR↔走者ツール 相関 > 0.3');
});

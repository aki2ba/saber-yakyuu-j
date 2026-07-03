// フェーズB B3b（守備成分分解・走塁・スプリット・一球データ不要）の単体テスト。
// UZR分解(RngR+ErrR+ARM+DPR+rSB+framing)の整合・WAR不変・ARM上位=強肩外野・
// rSB/DPRの対平均0中心・対左右スプリットのPA恒等・XBT%/Spdの俊足相関を検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import {
  uzrComponents,
  uzrRuns,
  armRunsAboveAvg,
  dprRunsAboveAvg,
  catcherRsbRuns,
  mainPosition,
  totalFieldInnings,
} from '../src/sim/fielding.mjs';
import { playerBaserunning, battingSplits, playerFielding } from '../src/sim/metrics.mjs';

const cfg = createConfig();
const lg = generateLeague(2026, cfg);
const res = simulateSeason(lg, cfg, { season: 2026, seed: 2026, postseason: false });
const lc = deriveLeagueConstants(res);
const byId = new Map(lg.players.map((p) => [p.id, p]));
const OF = new Set(['LF', 'CF', 'RF']);

function corr(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

test('UZR分解: total = RngR+ErrR+framing+ARM+DPR+rSB／classic(RngR+ErrR+framing)=uzrRuns（WAR不変）', () => {
  let checked = 0;
  let maxTotalErr = 0;
  let maxClassicErr = 0;
  for (const s of res.playerSeasons) {
    if (totalFieldInnings(s.fielding) < 50) continue;
    const c = uzrComponents(s, cfg, lc);
    // 成分の和が total に一致
    maxTotalErr = Math.max(maxTotalErr, Math.abs(c.total - (c.rngR + c.errR + c.framing + c.arm + c.dpr + c.rSB)));
    // classic部分（＝WAR用 uzrRuns）は ARM/DPR/rSB を含まない＝uzrRuns と厳密一致
    maxClassicErr = Math.max(maxClassicErr, Math.abs(c.total - c.arm - c.dpr - c.rSB - uzrRuns(s, cfg, lc)));
    checked++;
  }
  assert.ok(checked > 100, `十分な守備者 (${checked})`);
  assert.ok(maxTotalErr < 1e-9, `total=Σ成分 (max err ${maxTotalErr})`);
  assert.ok(maxClassicErr < 1e-9, `classic=uzrRuns＝ARM/DPR/rSBはWARに漏れない (max err ${maxClassicErr})`);
});

test('ARM: 上位は強肩の外野手・肩と強く相関・リーグΣARM≈0（対平均）', () => {
  const ofs = res.playerSeasons
    .filter((s) => OF.has(mainPosition(s.fielding)) && totalFieldInnings(s.fielding) >= 400)
    .map((s) => ({ arm: byId.get(s.playerId).trueAbility.common.arm, val: armRunsAboveAvg(s, lc), pos: mainPosition(s.fielding) }))
    .sort((a, b) => b.val - a.val);
  assert.ok(ofs.length >= 20, `規定守備の外野手が十分いる (${ofs.length})`);
  // ARM と肩レーティングが正相関
  assert.ok(corr(ofs.map((x) => x.val), ofs.map((x) => x.arm)) > 0.5, 'corr(ARM,肩)>0.5');
  // 上位5人は全員 外野手 かつ 平均以上の肩
  const top5 = ofs.slice(0, 5);
  assert.ok(top5.every((x) => OF.has(x.pos)), 'ARM上位5は全員外野手');
  const meanArmTop = top5.reduce((a, x) => a + x.arm, 0) / 5;
  assert.ok(meanArmTop > 55, `ARM上位5の平均肩>55 (${meanArmTop.toFixed(1)})`);
  // 上位ARMがsaber的に妥当な run量（正・過大でない）
  assert.ok(ofs[0].val > 3 && ofs[0].val < 15, `ARMリーダー ${ofs[0].val.toFixed(2)}run`);
  // リーグΣ ARM ≈ 0（外野手平均の肩に対する中心化）
  let sumArm = 0;
  for (const s of res.playerSeasons) sumArm += armRunsAboveAvg(s, lc);
  assert.ok(Math.abs(sumArm) < 1e-6, `ΣARM≈0 (${sumArm})`);
});

test('rSB: 捕手の盗塁阻止runが肩と正相関・リーグΣrSB≈0（既存SB/CSから）', () => {
  const catchers = res.playerSeasons
    .filter((s) => mainPosition(s.fielding) === 'C' && totalFieldInnings(s.fielding) >= 300)
    .map((s) => ({
      arm: byId.get(s.playerId).trueAbility.common.arm,
      rSB: catcherRsbRuns(s, cfg, lc),
      att: (s.fielding.sbAllowed || 0) + (s.fielding.csMade || 0),
    }));
  assert.ok(catchers.length >= 8, `規定捕手が十分いる (${catchers.length})`);
  // 盗塁企図（許SB＋刺CS）が実際に捕手へ計上されている
  assert.ok(catchers.every((c) => c.att > 0), '全捕手が盗塁企図に相対している');
  assert.ok(corr(catchers.map((c) => c.rSB), catchers.map((c) => c.arm)) > 0.4, 'corr(rSB,肩)>0.4');
  // リーグΣ rSB ≈ 0（対リーグ平均・Σ許SB=lgSB, Σ刺CS=lgCS）
  let sumRsb = 0;
  for (const s of res.playerSeasons) sumRsb += catcherRsbRuns(s, cfg, lc);
  assert.ok(Math.abs(sumRsb) < 1e-6, `ΣrSB≈0 (${sumRsb})`);
});

test('DPR: 二遊間の併殺転換が計上され、リーグΣDPR≈0（対平均転換率）', () => {
  // 二遊間に併殺機会/成立が計上されている
  const mi = res.playerSeasons.filter((s) => ['2B', 'SS'].includes(mainPosition(s.fielding)) && totalFieldInnings(s.fielding) >= 400);
  assert.ok(mi.length >= 8, `規定守備の二遊間が十分いる (${mi.length})`);
  assert.ok(mi.some((s) => (s.fielding.dpOpp || 0) > 0 && (s.fielding.dpTurned || 0) > 0), '併殺機会/成立が二遊間に計上');
  // リーグΣ DPR ≈ 0
  let sumDpr = 0;
  for (const s of res.playerSeasons) sumDpr += dprRunsAboveAvg(s, cfg, lc);
  assert.ok(Math.abs(sumDpr) < 1e-6, `ΣDPR≈0 (${sumDpr})`);
});

test('スプリット: vsL.pa+vsR.pa=総PA／home.pa+away.pa=総PA／RISP⊆PA（打者ごと厳密恒等）', () => {
  let checked = 0;
  for (const s of res.playerSeasons) {
    const b = s.batting;
    if (b.pa === 0) continue;
    const sp = b.splits;
    assert.equal(sp.vsL.pa + sp.vsR.pa, b.pa, `対左右のPA和=総PA (${s.playerId})`);
    assert.equal(sp.home.pa + sp.away.pa, b.pa, `ホーム/ビジターのPA和=総PA (${s.playerId})`);
    assert.ok(sp.risp.pa <= b.pa, 'RISP打席は総打席以下');
    // 各スプリットの内訳が整合（H≤AB≤PA）
    for (const k of ['vsL', 'vsR', 'risp', 'home', 'away']) {
      assert.ok(sp[k].h <= sp[k].ab && sp[k].ab <= sp[k].pa, `${k} H≤AB≤PA`);
    }
    checked++;
  }
  assert.ok(checked > 200, `十分な打者 (${checked})`);
  // リーグ全体で左右いずれの投手ともまとまった打席がある（利き手が実際に分岐している）
  let vsL = 0, vsR = 0;
  for (const s of res.playerSeasons) { vsL += s.batting.splits.vsL.pa; vsR += s.batting.splits.vsR.pa; }
  assert.ok(vsL > 5000 && vsR > vsL, `対左/対右の打席が妥当 (L=${vsL}, R=${vsR})`);
});

test('battingSplits: スラッシュ器が算出される（対右で多打席・有限のAVG/OBP/SLG）', () => {
  const reg = res.playerSeasons.filter((s) => s.batting.pa >= 400).sort((a, b) => b.batting.hr - a.batting.hr)[0];
  const sp = battingSplits(reg);
  for (const k of ['vsL', 'vsR', 'risp', 'home', 'away']) {
    assert.ok(sp[k].avg >= 0 && sp[k].avg <= 1, `${k} AVG域`);
    assert.ok(Math.abs(sp[k].ops - (sp[k].obp + sp[k].slg)) < 1e-12, `${k} OPS=OBP+SLG`);
  }
  assert.ok(sp.vsR.pa > sp.vsL.pa, '右投手との対戦が多い（左投手28%以下）');
});

test('走塁: XBT%が俊足で高い・Spdが俊足で高い（能力→結果の結線）', () => {
  const runners = res.playerSeasons
    .filter((s) => (s.baserunning.advOpp || 0) >= 15)
    .map((s) => {
      const t = byId.get(s.playerId).trueAbility;
      const m = playerBaserunning(s, cfg, lc);
      // XBT% = advTaken/advOpp の定義一致
      assert.ok(Math.abs(m.xbt - (s.baserunning.advTaken || 0) / s.baserunning.advOpp) < 1e-12, 'XBT%定義');
      return { xbt: m.xbt, spd: m.spd, tool: (t.common.speed + t.baserunning.baserunIQ) / 2, speed: t.common.speed };
    });
  assert.ok(runners.length >= 40, `進塁機会のある走者が十分いる (${runners.length})`);
  assert.ok(corr(runners.map((r) => r.xbt), runners.map((r) => r.tool)) > 0.3, 'corr(XBT%,走塁ツール)>0.3');
  assert.ok(corr(runners.map((r) => r.spd), runners.map((r) => r.speed)) > 0.4, 'corr(Spd,走力)>0.4');
  // Spd は 0-10 域
  for (const r of runners) assert.ok(r.spd >= 0 && r.spd <= 10, `Spd域 ${r.spd}`);
});

test('playerFielding: 守備成分の表示（内訳＋素カウント）が一貫', () => {
  const s = res.playerSeasons.find((x) => OF.has(mainPosition(x.fielding)) && (x.fielding.armOpp || 0) > 0);
  const pf = playerFielding(s, cfg, lc);
  assert.ok(Math.abs(pf.total - (pf.rngR + pf.errR + pf.framing + pf.arm + pf.dpr + pf.rSB)) < 1e-9, 'total=Σ成分');
  assert.equal(pf.armOpp, s.fielding.armOpp, 'armOpp素カウントが露出');
});

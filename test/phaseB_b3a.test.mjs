// フェーズB B3a（追加系指標・一球データ不要）の単体テスト。
// xBA/xSLG/xwOBA（恒等 リーグ xwOBA≈wOBA）・Barrel%/HardHit%・SIERA/xFIP相関・LOB%・
// 被打球分類の不変量・リーグ=100基準（ERA-/FIP-/OPS+）を検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, qualifiedPA } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { playerBatting, playerPitching } from '../src/sim/metrics.mjs';
import { createBattingLine, createPitchingLine, addBattingLine, addPitchingLine } from '../src/model/statline.mjs';
import { isBarrel } from '../src/sim/battedBallStats.mjs';

const cfg = createConfig();
const res = simulateSeason(generateLeague(2026, cfg), cfg, { season: 2026, seed: 2026, postseason: false });
const lc = deriveLeagueConstants(res);

// リーグ集計の打撃/投手ライン（addBattingLine が新フィールドも含めて合算・evMaxは最大）
const lgBat = createBattingLine();
const lgPit = createPitchingLine();
for (const ps of res.playerSeasons) {
  addBattingLine(lgBat, ps.batting);
  addPitchingLine(lgPit, ps.pitching);
}
const lgBm = playerBatting({ batting: lgBat }, lc);
const lgPm = playerPitching({ pitching: lgPit }, lc, cfg);

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

test('xwOBA≈wOBA（モデル=シムの恒等・リーグ集計で ±.005 以内）', () => {
  assert.ok(Math.abs(lgBm.xwoba - lgBm.woba) < 0.005, `xwOBA ${lgBm.xwoba.toFixed(4)} ~ wOBA ${lgBm.woba.toFixed(4)}`);
  // xBA/xSLG も現行打球モデルの実測に恒等的に近い
  assert.ok(Math.abs(lgBm.xba - lgBm.avg) < 0.005, `xBA ${lgBm.xba.toFixed(4)} ~ AVG ${lgBm.avg.toFixed(4)}`);
  assert.ok(Math.abs(lgBm.xslg - lgBm.slg) < 0.006, `xSLG ${lgBm.xslg.toFixed(4)} ~ SLG ${lgBm.slg.toFixed(4)}`);
});

test('被打球分類の不変量: GB+LD+FB+PU=bbEvents=Pull+Cent+Oppo（打者）／打者=投手 総数', () => {
  assert.equal(lgBat.bbGB + lgBat.bbLD + lgBat.bbFB + lgBat.bbPU, lgBat.bbEvents);
  assert.equal(lgBat.bbPull + lgBat.bbCent + lgBat.bbOppo, lgBat.bbEvents);
  assert.equal(lgPit.bbGB + lgPit.bbLD + lgPit.bbFB + lgPit.bbPU, lgPit.bbEvents);
  // 全打球はちょうど一度、打者側と投手側に対称計上される
  assert.equal(lgBat.bbEvents, lgPit.bbEvents);
  assert.ok(lgBat.bbEvents > 10000, `十分な打球数 ${lgBat.bbEvents}`);
});

test('リーグ=100基準: OPS+=100・ERA-=FIP-=xFIP-=100・xFIP=FIP・HR/FB=lgHR/FB（恒等）', () => {
  assert.ok(Math.abs(lgBm.opsPlus - 100) < 0.5, `league OPS+ ${lgBm.opsPlus.toFixed(2)}`);
  assert.ok(Math.abs(lgPm.eraMinus - 100) < 0.5, `league ERA- ${lgPm.eraMinus.toFixed(2)}`);
  assert.ok(Math.abs(lgPm.fipMinus - 100) < 0.5, `league FIP- ${lgPm.fipMinus.toFixed(2)}`);
  assert.ok(Math.abs(lgPm.xfipMinus - 100) < 0.5, `league xFIP- ${lgPm.xfipMinus.toFixed(2)}`);
  // xFIPは被HRを lgHR/FB×被FB に置換。リーグ集計では Σ(被FB×lgHRFB)=ΣHR ゆえ xFIP=FIP。
  assert.ok(Math.abs(lgPm.xfip - lgPm.fip) < 1e-6, `league xFIP ${lgPm.xfip.toFixed(4)} = FIP ${lgPm.fip.toFixed(4)}`);
  assert.ok(Math.abs(lgPm.hrFbPct - lc.lgHRFB) < 1e-9, `league HR/FB=lgHRFB`);
});

test('リーグ LOB% は 70-75% 域（残塁率）', () => {
  assert.ok(lgPm.lobPct >= 0.7 && lgPm.lobPct <= 0.76, `LOB% ${(lgPm.lobPct * 100).toFixed(1)}%`);
});

test('Barrel%/HardHit% は長距離打者で高い', () => {
  const qualPA = qualifiedPA(cfg.league.gamesPerSeason);
  const qual = res.playerSeasons
    .filter((s) => s.batting.pa >= qualPA && s.batting.bbEvents >= 100)
    .map((s) => ({ hr: s.batting.hr, m: playerBatting(s, lc) }))
    .sort((a, b) => b.hr - a.hr);
  assert.ok(qual.length >= 20, `規定到達打者が十分いる (${qual.length})`);
  const top = qual.slice(0, 10);
  const low = qual.slice(-10);
  const mean = (arr, f) => arr.reduce((a, x) => a + f(x), 0) / arr.length;
  const topBarrel = mean(top, (x) => x.m.barrelPct);
  const lowBarrel = mean(low, (x) => x.m.barrelPct);
  const topHard = mean(top, (x) => x.m.hardHitPct);
  const lowHard = mean(low, (x) => x.m.hardHitPct);
  assert.ok(topBarrel > lowBarrel * 1.5, `長距離砲のBarrel% ${(topBarrel * 100).toFixed(1)} > 非長距離 ${(lowBarrel * 100).toFixed(1)}`);
  assert.ok(topHard > lowHard, `長距離砲のHardHit% ${(topHard * 100).toFixed(1)} > 非長距離 ${(lowHard * 100).toFixed(1)}`);
  // evMax・SweetSpot% も算出される（有限値・0<率<1）
  for (const x of top) {
    assert.ok(x.m.evMax > 140 && x.m.evMax < 220, `evMax妥当 ${x.m.evMax}`);
    assert.ok(x.m.sweetSpotPct >= 0 && x.m.sweetSpotPct <= 1);
    assert.ok(x.m.evAvg > 100 && x.m.evAvg < 180, `evAvg妥当 ${x.m.evAvg}`);
  }
});

test('SIERA・xFIP は FIP と正の相関（FGの skill系ERA推定）', () => {
  const qp = res.playerSeasons.filter((s) => s.pitching.outs / 3 >= 100 && s.pitching.bf > 0);
  assert.ok(qp.length >= 20, `規定投球回級が十分いる (${qp.length})`);
  const pm = qp.map((s) => playerPitching(s, lc, cfg));
  const fips = pm.map((x) => x.fip);
  assert.ok(corr(pm.map((x) => x.siera), fips) > 0.4, 'corr(SIERA,FIP)>0.4');
  assert.ok(corr(pm.map((x) => x.xfip), fips) > 0.4, 'corr(xFIP,FIP)>0.4');
  assert.ok(corr(pm.map((x) => x.kwera), fips) > 0.4, 'corr(kwERA,FIP)>0.4');
  // SIERAはERAスケール（極端でない）
  for (const x of pm) assert.ok(x.siera > 1.5 && x.siera < 6.5, `SIERA妥当 ${x.siera.toFixed(2)}`);
});

test('kwERA = 5.40 − 12×(K% − BB%)（定義式）', () => {
  const p = { ...createPitchingLine(), outs: 300, bf: 400, so: 100, bb: 30, h: 90, hr: 10, r: 40, er: 38, hbp: 5, bbFB: 40, bbGB: 90, bbLD: 40, bbPU: 10, bbEvents: 180 };
  const m = playerPitching({ pitching: p }, lc, cfg);
  const expected = 5.4 - 12 * (100 / 400 - 30 / 400);
  assert.ok(Math.abs(m.kwera - expected) < 1e-9, `kwERA ${m.kwera} = ${expected}`);
  // K-BB%
  assert.ok(Math.abs(m.kbbPct - (100 / 400 - 30 / 400)) < 1e-12);
  // LOB% = (H+BB+HBP−R)/(H+BB+HBP−1.4HR)
  const lob = (90 + 30 + 5 - 40) / (90 + 30 + 5 - 1.4 * 10);
  assert.ok(Math.abs(m.lobPct - lob) < 1e-12, `LOB% ${m.lobPct} = ${lob}`);
});

test('isBarrel: 98mph未満は不成立・強い適角は成立・角度外は不成立', () => {
  const m = cfg.tuning.metrics;
  assert.equal(isBarrel(150, 28, m), false, '150km/h(<98mph)はBarrelでない');
  assert.equal(isBarrel(170, 28, m), true, '170km/h・28°はBarrel');
  assert.equal(isBarrel(170, 5, m), false, '170km/h・5°(低すぎ)はBarrelでない');
  assert.equal(isBarrel(170, 60, m), false, '170km/h・60°(高すぎ)はBarrelでない');
});

test('QS: 集計が健全（QS≤GS・リーダー>0・QS率が妥当域）', () => {
  let totQS = 0, totGS = 0;
  for (const s of res.playerSeasons) {
    assert.ok(s.pitching.qs <= s.pitching.gs, 'QS はその投手の先発数以下');
    totQS += s.pitching.qs;
    totGS += s.pitching.gs;
  }
  assert.ok(Math.max(...res.playerSeasons.map((s) => s.pitching.qs)) > 0, 'QSリーダーが存在');
  const rate = totQS / totGS;
  assert.ok(rate > 0.3 && rate < 0.8, `QS率 ${(rate * 100).toFixed(1)}%`); // sim由来の実測域（B3全体較正で45-60へ寄せる）
});

// フェーズD2 パークファクター（§11.2「文脈で化ける」）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { makeRng, hashSeed } from '../src/rng.mjs';
import { createBallpark, fenceDistanceAt, NEUTRAL_PARK } from '../src/model/battedball.mjs';
import { resolveBattedBall } from '../src/sim/battedBallResult.mjs';
import { generateLeague, generatePark } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { deriveParkFactors, parkFactorSpread } from '../src/sim/parkFactor.mjs';
import { playerBatting } from '../src/sim/metrics.mjs';

const cfg = createConfig();

test('fenceDistanceAt: 左右非対称球場は方向角の符号で翼線を選ぶ', () => {
  const asym = createBallpark({ lfLineM: 90, rfLineM: 110, centerDistM: 122 });
  // 左翼線(spray=-45)は90、右翼線(+45)は110、中堅(0)は122
  assert.ok(Math.abs(fenceDistanceAt(-45, asym) - 90) < 1e-9, `左翼線=${fenceDistanceAt(-45, asym)}`);
  assert.ok(Math.abs(fenceDistanceAt(45, asym) - 110) < 1e-9, `右翼線=${fenceDistanceAt(45, asym)}`);
  assert.ok(Math.abs(fenceDistanceAt(0, asym) - 122) < 1e-9, '中堅=122');
  // 中立球場は左右対称（従来と完全一致）
  assert.equal(fenceDistanceAt(-45, NEUTRAL_PARK), fenceDistanceAt(45, NEUTRAL_PARK));
});

test('generatePark: 決定論（同一シードで同一偏差）', () => {
  const a = generatePark(makeRng(hashSeed(42, 'park', 3)), cfg);
  const b = generatePark(makeRng(hashSeed(42, 'park', 3)), cfg);
  assert.deepEqual(a, b, '同一シードは同一偏差');
  const c = generatePark(makeRng(hashSeed(42, 'park', 4)), cfg);
  assert.notDeepEqual(a, c, '別球団は別偏差');
});

test('generateLeague: 球団ごとに球場が異なり、リーグ平均ジオメトリ≈中立（ゼロサム）', () => {
  const lg = generateLeague(7, cfg);
  assert.equal(lg.teams.length, 12);
  // すべての球団に park が付与され、名前は完全架空（実在球場名を含まない）
  for (const t of lg.teams) {
    assert.ok(t.park && typeof t.park.centerDistM === 'number', `${t.id} park`);
    assert.ok(!/甲子園|東京ドーム|マツダ|ナゴヤ|神宮|札幌/.test(t.park.name), '実在球場名を含まない');
  }
  // 球場は球団ごとに異なる（全球団同一ではない）
  const centers = lg.teams.map((t) => t.park.centerDistM);
  assert.ok(new Set(centers.map((c) => c.toFixed(3))).size > 6, '中堅距離が球団ごとに散る');
  // ゼロサム中心化: リーグ平均が中立球場（100/122/4）に一致（クランプ前の中心化＝ほぼ厳密）
  const mean = (f) => lg.teams.reduce((a, t) => a + f(t.park), 0) / lg.teams.length;
  assert.ok(Math.abs(mean((p) => (p.lfLineM + p.rfLineM) / 2) - 100) < 0.6, '両翼平均≈100');
  assert.ok(Math.abs(mean((p) => p.centerDistM) - 122) < 0.6, '中堅平均≈122');
  assert.ok(Math.abs(mean((p) => p.fenceHeightM) - 4) < 0.4, 'フェンス高平均≈4');
});

test('狭い球場でHR増: 同じ打球がHRにも凡フライにもなる（原則1・§11.2）', () => {
  // 中堅122・両翼100の中立に対し、狭い球場(両翼88/中堅112/低い壁)と広い球場(両翼112/中堅134/高い壁)。
  const narrow = createBallpark({ lfLineM: 88, rfLineM: 88, centerDistM: 112, fenceHeightM: 1.5 });
  const wide = createBallpark({ lfLineM: 112, rfLineM: 112, centerDistM: 134, fenceHeightM: 8 });
  // 中間的な飛距離の適角打球（狭い球場は越え、広い球場は越えない帯: 実効フェンス 97.6m vs 130.2m）
  const mk = () => ({ evKmh: 158, laDeg: 27, sprayDeg: -20, result: null });
  const rN = resolveBattedBall(mk(), cfg, makeRng(1), narrow);
  const rW = resolveBattedBall(mk(), cfg, makeRng(1), wide);
  assert.equal(rN.result, 'HR', '狭い球場ではHR');
  assert.notEqual(rW.result, 'HR', '広い球場では同じ打球がHRにならない');

  // 多数の生成打球で、狭い球場のHR率 > 広い球場のHR率
  const hrRate = (park) => {
    const rng = makeRng(2026);
    let hr = 0;
    const n = 6000;
    for (let i = 0; i < n; i++) {
      const bb = { evKmh: 150 + rng.next() * 40, laDeg: 20 + rng.next() * 20, sprayDeg: -40 + rng.next() * 80, result: null };
      if (resolveBattedBall(bb, cfg, rng, park).result === 'HR') hr++;
    }
    return hr / n;
  };
  assert.ok(hrRate(narrow) > hrRate(wide) * 1.5, '狭い球場のHR率 ≫ 広い球場');
});

test('resolveBattedBall: park省略時はNEUTRAL_PARK（後方互換）', () => {
  const bb = { evKmh: 185, laDeg: 27, sprayDeg: -30, result: null };
  const a = resolveBattedBall({ ...bb }, cfg, makeRng(3));
  const b = resolveBattedBall({ ...bb }, cfg, makeRng(3), NEUTRAL_PARK);
  assert.equal(a.result, b.result, 'park省略＝NEUTRAL_PARK');
});

// --- シーズン統合: PF導出・本拠地routing・決定論・wRC+補正 -----------------------
const lg = generateLeague(5, cfg);
const res = simulateSeason(lg, cfg, { season: 2026, seed: 5, postseason: false });

test('球団ごとにパークファクターが異なる・リーグ平均≈1（ゼロサム）', () => {
  const pf = deriveParkFactors(res.standings, cfg);
  const vals = [...pf.pfRunsByTeam.values()];
  assert.equal(vals.length, 12);
  assert.ok(new Set(vals.map((v) => v.toFixed(3))).size >= 10, 'PFが球団ごとに散る');
  const sp = parkFactorSpread(pf.pfRunsByTeam);
  assert.ok(Math.abs(sp.mean - 1) < 1e-9, `PF平均=1（ゼロサム）: ${sp.mean}`);
  assert.ok(sp.spread > 0.1, `PFに有意な散らばり: ${sp.spread}`);
});

test('パークファクター導出は決定論（同一シードで同一PF）', () => {
  const res2 = simulateSeason(generateLeague(5, cfg), cfg, { season: 2026, seed: 5, postseason: false });
  const a = deriveParkFactors(res.standings, cfg).pfRunsByTeam;
  const b = deriveParkFactors(res2.standings, cfg).pfRunsByTeam;
  for (const [k, v] of a) assert.ok(Math.abs(v - b.get(k)) < 1e-12, `${k} PF一致`);
});

test('本拠地/ビジターで正しいpark: 極端な本拠地は自軍の得点スプリットに現れる', () => {
  // 1球団に極端な狭い球場、1球団に極端な広い球場を与えて season を回し、
  // 本拠地(home)得点/試合 と 敵地(road)得点/試合 の差から「本拠地でその park が使われた」ことを検証。
  const lg2 = generateLeague(9, cfg);
  const narrow = createBallpark({ lfLineM: 88, rfLineM: 88, centerDistM: 112, fenceHeightM: 1.5 });
  const wide = createBallpark({ lfLineM: 112, rfLineM: 112, centerDistM: 134, fenceHeightM: 8 });
  lg2.teams[0].park = narrow; // T? = 狭い
  lg2.teams[1].park = wide; // 広い
  const r = simulateSeason(lg2, cfg, { season: 2026, seed: 9, postseason: false });
  const byId = new Map(r.standings.map((t) => [t.teamId, t]));
  const nRow = byId.get(lg2.teams[0].id);
  const wRow = byId.get(lg2.teams[1].id);
  const rpg = (row, side) => (side === 'h' ? row.hpRuns / row.hpG : row.rpRuns / row.rpG);
  // 狭い球場の球団: 本拠地の得点/試合 > 敵地の得点/試合（自軍攻守は両方に効くので差=球場効果）
  assert.ok(rpg(nRow, 'h') > rpg(nRow, 'r'), `狭い本拠地: home ${rpg(nRow, 'h').toFixed(2)} > road ${rpg(nRow, 'r').toFixed(2)}`);
  // 広い球場の球団: 本拠地の得点/試合 < 敵地の得点/試合
  assert.ok(rpg(wRow, 'h') < rpg(wRow, 'r'), `広い本拠地: home ${rpg(wRow, 'h').toFixed(2)} < road ${rpg(wRow, 'r').toFixed(2)}`);
});

test('PF補正後の wRC+ はリーグ100中心（補正がゼロサム）', () => {
  const lc = deriveLeagueConstants(res, cfg);
  let sum = 0;
  let pa = 0;
  for (const s of res.playerSeasons) {
    if (s.batting.pa < 1) continue;
    sum += playerBatting(s, lc).wrcPlusPF * s.batting.pa;
    pa += s.batting.pa;
  }
  const center = sum / pa;
  assert.ok(Math.abs(center - 100) < 3, `park補正wRC+ PA加重平均=${center.toFixed(2)}（≈100）`);
});

test('打者のPFで wRC+ が化ける: 打高球場の打者は park補正で割り引かれる', () => {
  const lc = deriveLeagueConstants(res, cfg);
  // PF>1（打高）の球団の規定打者は wrcPlusPF < wrcPlus（割り引き）、PF<1 は逆
  let checkedHi = false;
  let checkedLo = false;
  for (const s of res.playerSeasons) {
    if (s.batting.pa < 300) continue;
    const m = playerBatting(s, lc);
    if (m.pf > 1.01) {
      assert.ok(m.wrcPlusPF < m.wrcPlus, `打高球場は補正で割引: pf=${m.pf.toFixed(3)}`);
      checkedHi = true;
    } else if (m.pf < 0.99) {
      assert.ok(m.wrcPlusPF > m.wrcPlus, `投高球場は補正で加算: pf=${m.pf.toFixed(3)}`);
      checkedLo = true;
    }
    if (checkedHi && checkedLo) break;
  }
  assert.ok(checkedHi && checkedLo, '打高/投高 双方の球団で補正方向を確認');
});

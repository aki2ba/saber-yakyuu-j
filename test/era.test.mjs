// ============================================================================
// フェーズD3: 時代トレンドと王朝均衡（§11.3・多年運用・1年目は完全不変）
//
// 検証（phaseD_spec D3）:
//   - 1年目（yearIndex=0）は現行と完全同一＝ゲーム年0の順位表が simulateSeason 直呼びと byte 一致。
//     era-on と era-off でも年0は同一（ドリフトは2年目以降のみ）。
//   - 得点環境が緩やかに揺れる（evBaseDelta が正弦で上下・year0=0／eraSeasonConfig で 打高>投高）。
//   - 平均球速の経年上昇（多年でリーグ平均球速が上がる）。
//   - 黄金世代が稀に出る（多年で golden 年は少数・golden 年の新人は能力が高い）。
//   - 王朝が数年で崩れる（20年で単一球団が全制覇せず優勝が散る）。
//   - 20年でリーグ人口が恒常（各球団 投手13/野手20）。
//   - 決定論（era は (masterSeed,yearIndex) の純関数／多年運用が2回で一致）。
//   - 記録の文脈（時代補正 +指標）: 同一成績でも投高時代ほど wRC+ が高く評価される。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, advanceTo, advanceYear, computeEra, eraSeasonConfig, teamBalanceBoost, careerEraPlus,
} from '../src/game/index.mjs';
import { createConfig } from '../src/config.mjs';
import { generateLeague, generateRookie } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { hitterWAR, pitcherWAR } from '../src/sim/war.mjs';
import { overallRating } from '../src/game/market.mjs';
import { createBattingLine, createPitchingLine, createBaserunningLine, createFieldingLine } from '../src/model/statline.mjs';

const cfg = createConfig();
const SEED = 20260701;

// --- 20年運用を1回だけ回して各テストで使い回す（node:test はモジュールを1度だけ評価する）。----
const YEARS = 20;
function run20(seed, teamId = 'T1') {
  const st = newGame(seed, teamId, { cfg });
  const veloByYear = [];
  const champs = new Map();
  for (let y = 0; y < YEARS; y++) {
    advanceTo(st, 'seasonEnd');
    const pit = st.league.players.filter((p) => p.role === 'pitcher');
    veloByYear.push(pit.reduce((a, p) => a + p.trueAbility.pitching.velocityKmh, 0) / pit.length);
    advanceYear(st);
    const c = st.teamHistory[st.teamHistory.length - 1].champion;
    if (c) champs.set(c, (champs.get(c) || 0) + 1);
  }
  return { st, veloByYear, champs };
}
const RUN = run20(SEED);

// ---------------------------------------------------------------------------
test('D3: 1年目（yearIndex=0）は完全に不変 — era成分ゼロ＋シーズン中は真値/年齢が動かない', () => {
  // 旧テストは「ゲーム年0 == simulateSeason 直呼び（byte一致）」で D3 の主旨（1年目に多年要素を
  // 混ぜない）を間接検証していたが、R2（src/game/index.mjs の startYear: 1年目からも出場登録
  // 入替=F2-3 を作動させる）により、farm（二軍）を持たない simulateSeason とはもはや bit 一致
  // しない（意図的な仕様変更・バグではない）。D3 の主旨は「era（時代トレンド）が1年目に効かない」
  // ことなので、それを直接検証する：(1) 1年目の era 成分が全てゼロ、(2) 1年目シーズン中は
  // 選手の真値・年齢が一切動かない（test/game_multiyear.test.mjs の同種テストと同じ方式）。
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  const e0 = st.era;
  assert.equal(e0.evBaseDelta, 0, '1年目は得点環境の揺れがゼロ');
  assert.equal(e0.veloBump, 0, '1年目は球速上昇ボーナスがゼロ');
  assert.equal(e0.cohortQuality, 0, '1年目は世代品質補正がゼロ');
  assert.equal(e0.isGolden, false, '1年目は黄金世代フラグが立たない');
  const before = new Map(
    st.league.players.map((p) => [p.id, {
      age: p.age,
      eye: p.trueAbility.batting.eye,
      velo: p.trueAbility.pitching.velocityKmh,
    }]),
  );
  advanceTo(st, 'seasonEnd');
  for (const p of st.league.players) {
    const b = before.get(p.id);
    if (!b) continue; // 育成→支配下の季節中昇格（R2）で新たに支配下入りした選手＝加齢/era とは無関係
    assert.equal(p.age, b.age, `${p.id}: 1年目シーズン中に age は動かない`);
    assert.equal(p.trueAbility.batting.eye, b.eye, `${p.id}: 1年目シーズン中に真値(eye)は動かない`);
    assert.equal(p.trueAbility.pitching.velocityKmh, b.velo, `${p.id}: 1年目シーズン中に真値(velocityKmh)は動かない`);
  }
  assert.ok(st.rt.postseason && st.rt.postseason.champion, '1年目シーズンは正常に完結する');
});

test('D3: computeEra(yearIndex=0) は identity（全成分ゼロ）／eraSeasonConfig は同一参照', () => {
  const e0 = computeEra(SEED, 0, cfg);
  assert.equal(e0.evBaseDelta, 0);
  assert.equal(e0.veloBump, 0);
  assert.equal(e0.cohortQuality, 0);
  assert.equal(e0.isGolden, false);
  const base = createConfig();
  assert.equal(eraSeasonConfig(base, e0), base, 'year0 は baseCfg を同一参照で返す（byte一致の担保）');
  // enabled=false でも全年 identity。
  const off = createConfig({ tuning: { era: { enabled: false } } });
  assert.equal(computeEra(SEED, 5, off).evBaseDelta, 0, 'era 無効時は evBaseDelta=0');
  assert.equal(computeEra(SEED, 5, off).veloBump, 0, 'era 無効時は veloBump=0');
});

test('D3: era-on と era-off で年0の結果は一致（ドリフトは2年目以降のみ）', () => {
  const on = newGame(SEED, 'T1', { cfg: createConfig() });
  advanceTo(on, 'seasonEnd');
  const off = newGame(SEED, 'T1', { cfg: createConfig({ tuning: { era: { enabled: false } } }) });
  advanceTo(off, 'seasonEnd');
  const key = (st) => st.rt.table.map((r) => `${r.teamId}:${r.w}-${r.l}-${r.t}:${r.rs}`).sort().join('|');
  assert.equal(key(on), key(off), '年0は era 有無で不変');
});

test('D3: 得点環境が緩やかに揺れる — evBaseDelta が正弦で上下（year0=0・両符号）', () => {
  const deltas = Array.from({ length: 24 }, (_, y) => computeEra(SEED, y, cfg).evBaseDelta);
  assert.equal(deltas[0], 0, 'year0 の揺れは 0');
  assert.ok(deltas.some((d) => d > 0.1), '打高（正）方向の年がある');
  assert.ok(deltas.some((d) => d < -0.1), '投高（負）方向の年がある');
  const amp = cfg.tuning.era.offenseAmpKmh;
  assert.ok(Math.max(...deltas.map(Math.abs)) <= amp + 1e-9, '振幅は offenseAmpKmh 以内');
});

test('D3: 時代の揺れが得点環境を動かす — 打高(evBase+) > 中立 > 投高(evBase−)', () => {
  // 1シードの得点環境はロスター生成の当たり外れで ±0.15 R/G 揺れる（evBaseDelta±0.8 の効果と同オーダー）。
  // 順序を主張するなら複数シードの平均を見なければならない（単一シードだと符号が反転しうる）。
  const seeds = [42, 7, 101];
  const rpg = (delta) => {
    let rs = 0;
    let g = 0;
    for (const seed of seeds) {
      const c = eraSeasonConfig(createConfig(), { evBaseDelta: delta });
      const lg = generateLeague(seed, c);
      const res = simulateSeason(lg, c, { season: 2026, seed, postseason: false });
      for (const r of res.standings.values()) { rs += r.rs; g += r.g; }
    }
    return rs / g;
  };
  const hi = rpg(+0.8);
  const mid = rpg(0);
  const lo = rpg(-0.8);
  assert.ok(hi > mid && mid > lo, `打高${hi.toFixed(3)} > 中立${mid.toFixed(3)} > 投高${lo.toFixed(3)}`);
});

test('D3: 平均球速の経年上昇 — 多年でリーグ平均球速が上がる', () => {
  const v = RUN.veloByYear;
  assert.ok(v[15] > v[0] + 1.5, `平均球速が経年で上昇（y0=${v[0].toFixed(2)} → y15=${v[15].toFixed(2)}）`);
  assert.ok(v[YEARS - 1] > v[5], '後半も上昇基調を保つ');
});

test('D3: 黄金世代が稀に出る — 40年で golden 年は少数（0<count<半分）', () => {
  let golden = 0;
  for (let y = 1; y <= 40; y++) if (computeEra(SEED, y, cfg).isGolden) golden++;
  assert.ok(golden >= 1, '長期には黄金世代が出る');
  assert.ok(golden < 20, '黄金世代は稀（毎年ではない）');
});

test('D3: 黄金世代の新人は能力が高い（同一枠で golden > lean）', () => {
  // golden/lean の era を人工的に作り、同一 (seed,id,枠) で新人生成→総合力を比較。
  const golden = { veloBump: 0, cohortQuality: cfg.tuning.era.goldenBoost };
  const lean = { veloBump: 0, cohortQuality: -cfg.tuning.era.leanPenalty };
  const mk = (era) => generateRookie(999, 'DXn0', { role: 'fielder', primaryPos: 'SS', ageMin: 20, ageMax: 20, debutYear: 2030, era });
  assert.ok(overallRating(mk(golden)) > overallRating(mk(lean)) + 3, '黄金世代の新人は外れ年より明確に上');
});

test('D3: 王朝が数年で崩れる — 20年で単一球団が全制覇せず優勝が散る', () => {
  const champs = RUN.champs;
  const maxWins = Math.max(...champs.values());
  assert.ok(maxWins < YEARS, '単一球団が20連覇しない');
  assert.ok(maxWins <= YEARS / 2, `王朝は数年で崩れる（最多優勝 ${maxWins} ≤ ${YEARS / 2}）`);
  assert.ok(champs.size >= 5, `優勝が複数球団に散る（${champs.size} 球団）`);
});

test('D3: 20年でリーグ人口が恒常（各球団 支配下70人・投手33-36）', () => {
  const R = cfg.tuning.roster;
  for (const t of RUN.st.league.teams) {
    const roster = RUN.st.league.players.filter((p) => p.teamId === t.id);
    const nPit = roster.filter((p) => p.role === 'pitcher').length;
    assert.equal(roster.length, R.controlledPerTeam, `${t.id} は支配下70人`);
    assert.ok(nPit >= R.pitchersMin && nPit <= R.pitchersMax, `${t.id} は投手33-36（${nPit}）`);
  }
  assert.equal(RUN.st.league.players.length, cfg.league.numTeams * R.controlledPerTeam, 'リーグ人口=12×70で恒常');
});

test('D3: 決定論 — computeEra は純関数／多年運用が2回で一致', () => {
  for (const y of [0, 1, 3, 7, 12, 19]) {
    const a = computeEra(SEED, y, cfg);
    const b = computeEra(SEED, y, cfg);
    assert.deepEqual(a, b, `computeEra(${y}) は決定論`);
  }
  // 2年運用を2回：優勝・球速が一致（era 込みで多年が決定論）。
  const two = (seed) => {
    const st = newGame(seed, 'T1', { cfg });
    const out = [];
    for (let y = 0; y < 2; y++) {
      advanceTo(st, 'seasonEnd');
      const pit = st.league.players.filter((p) => p.role === 'pitcher');
      out.push(pit.reduce((a, p) => a + p.trueAbility.pitching.velocityKmh, 0));
      advanceYear(st);
      out.push(st.teamHistory[st.teamHistory.length - 1].champion);
    }
    return out;
  };
  assert.deepEqual(two(777), two(777), '同一シードの2年運用は bit 一致');
  assert.notDeepEqual(two(777), two(778), '別シードは別運命');
});

test('D3: 王朝均衡 boost — 負け越し球団ほど新人再分配が厚い（teamBalanceBoost）', () => {
  const standings = [
    { teamId: 'T1', w: 90, l: 53 }, // 強い→boost 0
    { teamId: 'T2', w: 72, l: 71 }, // ほぼ五分
    { teamId: 'T3', w: 50, l: 93 }, // 弱い→boost 大
  ];
  const boost = teamBalanceBoost(standings, cfg);
  assert.equal(boost.get('T1'), 0, '勝ち越し球団は再分配 boost なし');
  assert.ok(boost.get('T3') > boost.get('T2'), '弱い球団ほど厚い');
  assert.ok(boost.get('T3') > 0, '最下位は正の boost');
});

// --- 記録の文脈（時代補正 +指標・§11.3）--------------------------------------------
// 同一の生成績でも「投高時代」ほど wRC+ が高く評価される（記録が文脈で化けるのを補正）。
function fullBat(playerId, season, teamId, line) {
  const batting = createBattingLine();
  Object.assign(batting, line);
  return {
    playerId, season, teamId,
    batting,
    pitching: createPitchingLine(),
    baserunning: createBaserunningLine(),
    fielding: createFieldingLine(),
  };
}
// リーグ環境を N人の「平均打者」で定義する（弱い平均=投高時代／強い平均=打高時代）。
function leaguePop(season, avgLine, n = 16) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push(fullBat(`AVG${i}`, season, i < n / 2 ? 'T1' : 'T2', avgLine));
  }
  return arr;
}

test('D3: 記録の時代補正 +指標 — 同一成績でも投高時代ほど wRC+ が高い', () => {
  // HERO は両年まったく同じ生成績（AB500 H150 HR20 BB50 …＝.300）。
  const heroLine = { pa: 560, ab: 500, h: 150, b1: 100, b2: 25, b3: 5, hr: 20, bb: 50, hbp: 5, so: 90, sf: 5 };
  // 2026=投高時代（平均打者が弱い .230）／2027=打高時代（平均打者が強い .300）。
  const weak = { pa: 550, ab: 500, h: 115, b1: 85, b2: 20, b3: 2, hr: 8, bb: 40, hbp: 5, so: 110, sf: 5 };
  const strong = { pa: 560, ab: 500, h: 150, b1: 100, b2: 28, b3: 2, hr: 20, bb: 55, hbp: 5, so: 85, sf: 5 };
  const careerStats = [
    fullBat('HERO', 2026, 'T1', heroLine),
    ...leaguePop(2026, weak),
    fullBat('HERO', 2027, 'T1', heroLine),
    ...leaguePop(2027, strong),
  ];
  // 順位表（rs は lgRunsPerPA の素・両年同程度に置く＝差は打者質＝lgRawPerPA から出る）。
  const stand = (season) => [
    { teamId: 'T1', league: 'L1', g: 143, w: 72, l: 71, t: 0, rs: 620, ra: 620 },
    { teamId: 'T2', league: 'L2', g: 143, w: 71, l: 72, t: 0, rs: 620, ra: 620 },
  ];
  const teamHistory = [
    { year: 2026, standings: stand(2026) },
    { year: 2027, standings: stand(2027) },
  ];
  const playersById = new Map([['HERO', { id: 'HERO', name: '英雄', role: 'fielder', primaryPos: 'CF' }]]);
  const ep = careerEraPlus('HERO', { careerStats, teamHistory, playersById, cfg });
  assert.equal(ep.role, 'fielder');
  assert.equal(ep.seasons, 2, '2シーズンぶん集計');
  const by = new Map(ep.byYear.map((r) => [r.year, r.wrcPlus]));
  assert.ok(by.get(2026) > by.get(2027) + 5, `同一成績でも投高時代(2026)の wRC+ が高い（${by.get(2026).toFixed(0)} vs ${by.get(2027).toFixed(0)}）`);
  // 加重通算はその中間（PA加重）に収まる。
  assert.ok(ep.wrcPlus > by.get(2027) && ep.wrcPlus < by.get(2026), '通算 +指標は両年の間');
});

// ============================================================================
// 総WAR は時代（得点環境）に対して不変でなければならない。
// 代替水準は「勝率.294のチームが何勝するか」で定義される概念なので、得点環境が変わっても
// 代替 *勝利* は動かない。FanGraphs はこれを
//   Replacement Runs = (570 × Games/2430) × (RPW / lgPA) × PA
// と定義する（RPW が掛かっているので、RPW で割ると勝利は不変）。
//
// 旧実装は野手の代替水準だけを run 単位 (PA/600)×定数 で持ち、rpw で割っていた。
// 投手は wins 単位 (IP/9)×replPer9 だったため単位が食い違い、
// 投高の年ほど野手の代替勝利が膨らんで総WARが 11 WAR も動いていた（9年周期の時代トレンド）。
// 正典: sabermetrics_glossary.md §7.1 / §7.3 / §10.5
// ============================================================================
test('D3: 野手の代替勝利は時代（得点環境）に対して厳密に不変', () => {
  const seed = 11;
  const measure = (delta) => {
    const c = eraSeasonConfig(createConfig(), { evBaseDelta: delta });
    const lg = generateLeague(seed, c);
    const res = simulateSeason(lg, c, { season: 2026, seed, postseason: false });
    const lc = deriveLeagueConstants(res, c);
    let war = 0;
    let replWins = 0; // 野手の代替勝利の総量（= repl[run] / rpw）
    for (const ps of res.playerSeasons) {
      if (ps.batting.pa > 0) {
        const w = hitterWAR(ps, c, lc);
        war += w.war;
        replWins += w.repl / lc.rpw;
      }
      if (ps.pitching.outs > 0) war += pitcherWAR(ps, c, lc).war;
    }
    return { war, replWins, rpw: lc.rpw, replTotal: lc.replHitterWinsTotal };
  };
  const hi = measure(+0.8); // 打高
  const lo = measure(-0.8); // 投高

  // 得点環境は実際に動いている（テストが空振りしていないことの確認）
  assert.ok(hi.rpw - lo.rpw > 0.2, `rpw が時代で動いている (${hi.rpw.toFixed(3)} vs ${lo.rpw.toFixed(3)})`);

  // 【厳密な不変量】野手の代替勝利の総量は得点環境に依存しない。
  // 旧実装は repl を run 固定で持ち rpw で割っていたため、投高の年ほど代替勝利が膨らんでいた
  // （2.037 → 2.146 wins/600PA）。
  assert.ok(Math.abs(hi.replWins - lo.replWins) < 1e-9, `野手の代替勝利が時代で動く (${hi.replWins} vs ${lo.replWins})`);
  assert.ok(Math.abs(hi.replTotal - lo.replTotal) < 1e-9, 'lc.replHitterWinsTotal は得点環境に依存しない');

  // 総WARの時代ドリフトも小さい（旧実装は打高↔投高で約11 WAR 動いていた。単一シードのノイズを見込む）
  const drift = Math.abs(hi.war - lo.war);
  assert.ok(drift < 6, `総WARの時代ドリフト ${drift.toFixed(2)} WAR < 6（旧実装は約11）`);
});

// ============================================================================
// 多年運用の得点環境ドリフト回帰テスト（Bug1・§11.3）
//
//   多年運用（newGame→[for年: advanceTo(seasonEnd); advanceYear]）でリーグの得点環境が
//   一方向にインフレしない（SLG/HR/ERA/AVG が各年ずっと NPB 目標帯付近に留まる）ことを守る。
//
// 背景（監査で確認した重大欠陥）:
//   旧加齢プロファイルは生涯ネットドリフトが正で、生存バイアス（弱個体淘汰）＋ドラフト選抜
//   （プールの上澄み獲得）と相まって能動ロスター能力平均が rookie 生成中心から +5〜6 上振れし、
//   20年で SLG .395→.478(+21%) / HR/PA +71% / ERA 3.77→4.99(+32%) と単調インフレしていた。
//   §11.3 の意図は投高打低↔打高投低の“揺れ”（オシレーション）であって単調上昇ではない。
//   → config.tuning.aging.profiles を net drift≈0 へ再較正（src/config.mjs の★Bug1コメント参照）。
//
// 本テストの主張:
//   1) 多seed平均の各年 SLG/ERA/HR/PA/AVG が NPB 帯付近に留まる（全年 in-band）。
//   2) SLG は単調増加でない（＝インフレの単調トレンドでなく、D3 era 波の有界な揺れ）。
//   3) 序盤→終盤の絶対ドリフトが有界（旧欠陥の +16〜71% を弾き、再較正後の数%を通す）。
//   4) 決定論: 同一 masterSeed の多年運用は再実行で各年リーグ指標が bit 一致。
//   5) 1年目（yearIndex0）は加齢非適用ゆえ不変（single simulateSeason と一致）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { newGame, advanceTo, advanceYear } from '../src/game/index.mjs';
import { leagueSummary } from '../src/sim/leagueStats.mjs';

const SEEDS = [1, 2, 3]; // 多seed平均で単seedの当たり年ノイズをならす（決定論）
const YEARS = 20;

/** 1世界を YEARS 年運用し、各年の完了シーズンのリーグサマリを返す（決定論）。 */
function runYears(seed, years = YEARS) {
  const cfg = createConfig();
  const league = generateLeague(seed, cfg);
  const st = newGame(seed, league.teams[0].id, { cfg });
  const perYear = [];
  for (let y = 0; y < years; y++) {
    advanceTo(st, 'seasonEnd');
    const year = st.year;
    const playerSeasons = st.careerStats.filter((s) => s.season === year);
    const standings = st.teamHistory.find((h) => h.year === year).standings;
    perYear.push(leagueSummary({ playerSeasons, standings }, standings.length));
    advanceYear(st);
  }
  return perYear;
}

/** SEEDS を運用し、各年の [SLG,ERA,HR/PA,AVG] を seed 平均した配列を返す。 */
function multiSeedAverages() {
  const runs = SEEDS.map((s) => runYears(s));
  const out = [];
  for (let y = 0; y < YEARS; y++) {
    let slg = 0, era = 0, hrpa = 0, avg = 0;
    for (const r of runs) {
      slg += r[y].batting.slg;
      era += r[y].pitching.era;
      hrpa += r[y].batting.hr / r[y].batting.pa;
      avg += r[y].batting.avg;
    }
    const n = runs.length;
    out.push({ slg: slg / n, era: era / n, hrpa: hrpa / n, avg: avg / n });
  }
  return out;
}

const AVGS = multiSeedAverages(); // 20年ぶんを一度だけ回して各主張で使い回す

test('多年運用: リーグ得点環境が各年ずっと NPB 帯付近に留まる（単調インフレしない・§11.3）', () => {
  for (let y = 0; y < YEARS; y++) {
    const a = AVGS[y];
    // NPB 目標帯（多seed平均・再較正後の実測レンジ SLG[.39,.43]/ERA[3.8,4.2]/HR/PA≤.029 に余裕を持たせた帯）。
    //   旧欠陥（20年で SLG≈.48・ERA≈5.0・HR/PA≈.037）はこの帯を必ず突き破る＝確実に検知できる。
    assert.ok(a.slg >= 0.37 && a.slg <= 0.44, `yi${y}: 平均SLG=${a.slg.toFixed(3)} が帯[.37,.44]内`);
    assert.ok(a.era >= 3.3 && a.era <= 4.4, `yi${y}: 平均ERA=${a.era.toFixed(2)} が帯[3.3,4.4]内`);
    assert.ok(a.hrpa <= 0.031, `yi${y}: 平均HR/PA=${a.hrpa.toFixed(4)} ≤ .031`);
    assert.ok(a.avg >= 0.24 && a.avg <= 0.27, `yi${y}: 平均AVG=${a.avg.toFixed(3)} が帯[.24,.27]内`);
  }
});

test('多年運用: SLG は単調増加でない（インフレのトレンドでなく D3 era 波の有界な揺れ）', () => {
  const slg = AVGS.map((a) => a.slg);
  // 単調増加＝毎年前年以上、なら単方向インフレ（旧欠陥）。少なくとも1回は下振れる（揺れる）こと。
  const strictlyRising = slg.every((v, i) => i === 0 || v >= slg[i - 1]);
  assert.ok(!strictlyRising, `SLG系列が単調非減少になっている（揺れが無い）: ${slg.map((v) => v.toFixed(3)).join(',')}`);
});

test('多年運用: 序盤→終盤の絶対ドリフトが有界（旧+16〜71%インフレを弾く）', () => {
  const band = (sel, a, b) => {
    let e = 0, l = 0;
    for (let y = a; y < a + 3; y++) e += sel(AVGS[y]);
    for (let y = b; y < YEARS; y++) l += sel(AVGS[y]);
    return { early: e / 3, late: l / (YEARS - b) };
  };
  const slg = band((a) => a.slg, 0, YEARS - 3);
  const era = band((a) => a.era, 0, YEARS - 3);
  const hr = band((a) => a.hrpa, 0, YEARS - 3);
  const slgDrift = (slg.late - slg.early) / slg.early;
  const eraDrift = (era.late - era.early) / era.early;
  const hrDrift = (hr.late - hr.early) / hr.early;
  // 再較正後は SLG≈+6% / ERA≈+8% / HR≈+18%（構造的テール由来の残差）。旧欠陥は +16〜71%。
  assert.ok(slgDrift < 0.10, `SLG絶対ドリフト ${(slgDrift * 100).toFixed(1)}% < 10%（旧+16%を弾く）`);
  assert.ok(eraDrift < 0.13, `ERA絶対ドリフト ${(eraDrift * 100).toFixed(1)}% < 13%（旧+32%を弾く）`);
  assert.ok(hrDrift < 0.28, `HR/PA絶対ドリフト ${(hrDrift * 100).toFixed(1)}% < 28%（旧+71%を弾く）`);
});

test('多年運用: 決定論 — 同一 masterSeed の運用は各年リーグ指標が bit 一致', () => {
  const a = runYears(7, 5);
  const b = runYears(7, 5);
  for (let y = 0; y < 5; y++) {
    assert.equal(a[y].batting.slg, b[y].batting.slg, `yi${y} SLG が一致`);
    assert.equal(a[y].pitching.era, b[y].pitching.era, `yi${y} ERA が一致`);
    assert.equal(a[y].batting.hr, b[y].batting.hr, `yi${y} 総HR が一致`);
  }
});

test('多年運用: 1年目（yearIndex0）は不変 — single simulateSeason と一致（加齢の混入なし）', () => {
  const cfg = createConfig();
  const SEED = 424242;
  const league = generateLeague(SEED, cfg);
  const bulk = simulateSeason(league, cfg, { season: cfg.game.firstSeason, seed: SEED });
  const bulkSum = leagueSummary(bulk, cfg.league.numTeams);
  const y0 = runYears(SEED, 1)[0];
  assert.equal(y0.batting.slg, bulkSum.batting.slg, '1年目 SLG が一括シムと一致');
  assert.equal(y0.pitching.era, bulkSum.pitching.era, '1年目 ERA が一括シムと一致');
  assert.equal(y0.batting.hr, bulkSum.batting.hr, '1年目 総HR が一括シムと一致');
});

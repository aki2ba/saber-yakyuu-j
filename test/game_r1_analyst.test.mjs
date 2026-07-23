// ============================================================================
// R1+R7+R8:「アナリストコラム」(src/game/analystColumn.mjs) のテスト。
//   合成フィクスチャ（rt.standings/rt.stats.stats/rt.playerGameLog/careerStats/retiredPlayers を
//   直接構成）で、極端値/意外性/比較型の検出分岐・最低サンプルゲート・同週同一選手の重複排除・
//   決定論（同一input同一output・stateを変更しない）を検証する。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { createBattingLine, createPitchingLine, createBaserunningLine, createFieldingLine } from '../src/model/statline.mjs';
import { analystColumnOf } from '../src/game/analystColumn.mjs';

const cfg = createConfig();
const names = { pnameOf: (id) => id };

// --- 合成フィクスチャ ---------------------------------------------------------

/** 打撃ライン。既定は「規定到達・平均的」で、xB*は実際の内訳と一致させ意外性型を誤検出しない。 */
function batLine(o = {}) {
  const b = createBattingLine();
  b.b1 = o.b1 ?? 100; b.b2 = o.b2 ?? 20; b.b3 = o.b3 ?? 2; b.hr = o.hr ?? 15;
  b.h = b.b1 + b.b2 + b.b3 + b.hr;
  b.bb = o.bb ?? 30; b.hbp = o.hbp ?? 2; b.so = o.so ?? 90; b.sf = o.sf ?? 3; b.ibb = o.ibb ?? 0;
  b.ab = o.ab ?? 460;
  b.pa = o.pa ?? (b.ab + b.bb + b.hbp + b.sf);
  b.rbi = o.rbi ?? 60; b.sb = o.sb ?? 5; b.cs = o.cs ?? 2; b.gdp = o.gdp ?? 8;
  b.xB1 = o.xB1 ?? b.b1; b.xB2 = o.xB2 ?? b.b2; b.xB3 = o.xB3 ?? b.b3; b.xHR = o.xHR ?? b.hr;
  b.bbEvents = o.bbEvents ?? 300; b.bbGB = o.bbGB ?? 150; b.bbLD = o.bbLD ?? 60; b.bbFB = o.bbFB ?? 70; b.bbPU = o.bbPU ?? 20;
  b.bbPull = o.bbPull ?? 100; b.bbCent = o.bbCent ?? 100; b.bbOppo = o.bbOppo ?? 100;
  b.barrels = o.barrels ?? 20; b.hardHits = o.hardHits ?? 100; b.sweetSpots = o.sweetSpots ?? 80;
  b.evSum = o.evSum ?? 2500; b.evMax = o.evMax ?? 110;
  b.pitches = o.pitches ?? 0; b.swings = o.swings ?? 0; b.whiffs = o.whiffs ?? 0; b.fouls = o.fouls ?? 0;
  b.calledStrikes = o.calledStrikes ?? 0; b.lumpedPitches = o.lumpedPitches ?? 0;
  b.zonePitches = o.zonePitches ?? 0; b.zSwings = o.zSwings ?? 0; b.zWhiffs = o.zWhiffs ?? 0;
  b.oZonePitches = o.oZonePitches ?? 0; b.oSwings = o.oSwings ?? 0; b.oWhiffs = o.oWhiffs ?? 0;
  b.ballsInDirt = o.ballsInDirt ?? 0; b.firstPitchStrikes = o.firstPitchStrikes ?? 0;
  b.re24 = o.re24 ?? 0; b.wpa = o.wpa ?? 0; b.liSum = o.liSum ?? b.pa; b.wpaLiSum = o.wpaLiSum ?? 0;
  return b;
}

/** 投球ライン。既定は「規定到達・平均的」な先発。 */
function pitLine(o = {}) {
  const p = createPitchingLine();
  p.outs = o.outs ?? 480; p.so = o.so ?? 150; p.bb = o.bb ?? 50; p.hr = o.hr ?? 15; p.h = o.h ?? 140;
  p.r = o.r ?? 70; p.er = o.er ?? 65; p.ibb = o.ibb ?? 0; p.hbp = o.hbp ?? 5;
  p.bf = o.bf ?? (p.outs + p.h + p.bb);
  p.w = o.w ?? 10; p.l = o.l ?? 8; p.sv = o.sv ?? 0; p.hld = o.hld ?? 0;
  p.g = o.g ?? 26; p.gs = o.gs ?? 26; p.qs = o.qs ?? 15;
  p.bbEvents = o.bbEvents ?? 300; p.bbGB = o.bbGB ?? 140; p.bbLD = o.bbLD ?? 60; p.bbFB = o.bbFB ?? 80; p.bbPU = o.bbPU ?? 20;
  p.pitches = o.pitches ?? 0; p.swings = o.swings ?? 0; p.whiffs = o.whiffs ?? 0; p.fouls = o.fouls ?? 0;
  p.calledStrikes = o.calledStrikes ?? 0; p.lumpedPitches = o.lumpedPitches ?? 0;
  p.zonePitches = o.zonePitches ?? 0; p.zSwings = o.zSwings ?? 0; p.zWhiffs = o.zWhiffs ?? 0;
  p.oZonePitches = o.oZonePitches ?? 0; p.oSwings = o.oSwings ?? 0; p.oWhiffs = o.oWhiffs ?? 0;
  p.ballsInDirt = o.ballsInDirt ?? 0; p.firstPitchStrikes = o.firstPitchStrikes ?? 0;
  p.re24 = o.re24 ?? 0; p.wpa = o.wpa ?? 0; p.liSum = o.liSum ?? p.bf; p.wpaLiSum = o.wpaLiSum ?? 0;
  p.gmLiSum = o.gmLiSum ?? 0; p.gmLiN = o.gmLiN ?? 0; p.sd = o.sd ?? 0; p.md = o.md ?? 0;
  return p;
}

function statRow(playerId, teamId, o = {}) {
  // 実際の PlayerSeason（statline.mjs createPlayerSeason）は batting/pitching を常に非nullの
  // ゼロ埋めラインで持つ（leagueBatting/leaguePitching が前提とする形）。ここでも同じ形にする。
  return {
    playerId, teamId, season: o.season ?? 2029,
    batting: o.batting ?? batLine(),
    pitching: o.pitching ?? pitLine({ outs: 0, bf: 0, h: 0, hr: 0, bb: 0, so: 0, r: 0, er: 0, w: 0, l: 0, g: 0, gs: 0, qs: 0, bbEvents: 0, bbGB: 0, bbLD: 0, bbFB: 0, bbPU: 0 }),
    baserunning: createBaserunningLine(), fielding: createFieldingLine(),
  };
}
function standRow(teamId, league, g) {
  return { teamId, league, g, w: Math.round(g / 2), l: g - Math.round(g / 2), t: 0, rs: Math.round(g * 4.3), ra: Math.round(g * 4.3) };
}
function schedule(n) {
  return Array.from({ length: n }, (_, i) => ({ day: i }));
}
/** rt: pendingDay(rt)===elapsed になるよう cursor を合わせる（coachReports.mjsテストと同型）。 */
function rtAt(elapsed, standRows, statRows, playerGameLog = [], totalDays = 200) {
  return {
    finalDay: totalDays - 1,
    schedule: schedule(totalDays),
    cursor: elapsed,
    standings: new Map(standRows.map((r) => [r.teamId, r])),
    stats: { stats: new Map(statRows.map((s) => [s.playerId, s])) },
    playerGameLog,
  };
}
function fakeState(o = {}) {
  return {
    cfg, masterSeed: 999, year: 2030, playerTeamId: 'T1',
    careerStats: [], retiredPlayers: [], awardsHistory: [], teamHistory: [],
    league: { players: [], farm: [] },
    ...o,
  };
}

/** 規定到達（g=150→qPA=465超）の平均的な打者N人を生成（barrelPctだけ差をつけて他は横並び）。 */
function mkBatterPool(n, teamId, barrelsList) {
  return Array.from({ length: n }, (_, i) => statRow(`B${i}`, teamId, { batting: batLine({ barrels: barrelsList[i] }) }));
}

const G_QUALIFY = 150; // qualifiedPA(150)=465, qualifiedIP(150)=150

// ============================================================================
// 極端値型（R1-1）
// ============================================================================

test('R1: 極端値型 — 規定到達者6人中の最高Barrel%をリーグ1位として検出し、最下位もextremeTrailerで拾う', () => {
  const rows = mkBatterPool(6, 'T1', [10, 20, 30, 40, 50, 5]); // B4=50が最高、B5=5が最低
  const st = fakeState({
    rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY)], rows),
  });
  const out = analystColumnOf(st, names);
  const leaderText = out.find((h) => h.playerId === 'B4' && h.kind === 'extremeLeader');
  const trailerText = out.find((h) => h.playerId === 'B5' && h.kind === 'extremeTrailer');
  assert.ok(leaderText, 'Barrel%最高の選手がextremeLeaderとして検出される');
  assert.ok(leaderText.text.includes('Barrel%'));
  assert.equal(leaderText.cls, 'good');
  assert.ok(trailerText, 'Barrel%最低の選手がextremeTrailerとして検出される');
  assert.ok(trailerText.text.includes('最下位'));
  assert.equal(trailerText.cls, 'info');
});

test('R1: 極端値型 — 最低サンプル(extremeMinPool=5)未満の母集団では検出しない（規定到達4人）', () => {
  const rows = mkBatterPool(4, 'T1', [10, 20, 30, 40]);
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY)], rows) });
  const out = analystColumnOf(st, names);
  assert.equal(out.filter((h) => h.text.includes('Barrel%')).length, 0, '母集団5人未満はBarrel%ネタを出さない');
});

test('R1: 極端値型 — 規定未到達の選手（少PA）は母集団から除外される', () => {
  const rows = mkBatterPool(5, 'T1', [10, 20, 30, 40, 50]);
  rows.push(statRow('UNQ', 'T1', { batting: batLine({ ab: 50, pa: 55, barrels: 999, bbEvents: 40 }) })); // 極端に高いが規定未到達
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY)], rows) });
  const out = analystColumnOf(st, names);
  assert.ok(!out.some((h) => h.playerId === 'UNQ'), '規定未到達選手はネタに出ない');
});

// ============================================================================
// 意外性型（R1-2）: xwOBA-wOBA / ERA-SIERA 乖離
// ============================================================================

test('R1: 意外性型 — 打率は平凡だがxwOBAが上位（不運型）を検出する', () => {
  const unlucky = statRow('U1', 'T1', {
    batting: batLine({ b1: 70, b2: 10, b3: 1, hr: 8, xB1: 110, xB2: 25, xB3: 3, xHR: 20 }), // 実際は控えめ、期待値は高い
  });
  const filler = mkBatterPool(6, 'T2', [10, 15, 20, 25, 30, 35]);
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY), standRow('T2', 'L1', G_QUALIFY)], [unlucky, ...filler]) });
  const out = analystColumnOf(st, names);
  const hit = out.find((h) => h.playerId === 'U1');
  assert.ok(hit, '不運型（xwOBA上位）が検出される');
  assert.equal(hit.kind, 'divergenceUnlucky');
  assert.ok(hit.text.includes('xwOBA'));
  assert.equal(hit.cls, 'good');
});

test('R1: 意外性型 — 打率は良いがxwOBAが伴わない（出来すぎ警報）を検出する', () => {
  const lucky = statRow('L1P', 'T1', {
    batting: batLine({ b1: 140, b2: 30, b3: 3, hr: 25, xB1: 90, xB2: 15, xB3: 1, xHR: 10 }), // 実際は好調、期待値は控えめ
  });
  const filler = mkBatterPool(6, 'T2', [10, 15, 20, 25, 30, 35]);
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY), standRow('T2', 'L1', G_QUALIFY)], [lucky, ...filler]) });
  const out = analystColumnOf(st, names);
  const hit = out.find((h) => h.playerId === 'L1P');
  assert.ok(hit, '出来すぎ警報型が検出される');
  assert.equal(hit.kind, 'divergenceLucky');
  assert.ok(hit.text.includes('xwOBA'));
  assert.equal(hit.cls, 'info');
});

test('R1: 意外性型 — 投手のERA-SIERA乖離（不運型: 防御率は悪いが内容は良い）', () => {
  const unlucky = statRow('PU1', 'T1', { pitching: pitLine({ er: 90, r: 95, so: 180, bb: 35 }) }); // ER高いがK多くBB少ない
  const fillerPitchers = Array.from({ length: 5 }, (_, i) => statRow(`P${i}`, 'T2', { pitching: pitLine({ er: 65, r: 68, so: 150, bb: 50 }) }));
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY), standRow('T2', 'L1', G_QUALIFY)], [unlucky, ...fillerPitchers]) });
  const out = analystColumnOf(st, names);
  const hit = out.find((h) => h.playerId === 'PU1' && h.kind === 'divergenceUnlucky');
  assert.ok(hit, '投手の不運型（ERA>>SIERA）が検出される');
  assert.ok(hit.text.includes('SIERA'));
});

// ============================================================================
// 比較型（R1-3）: 若手ペース vs 殿堂の同年目実績
// ============================================================================

test('R1: 比較型 — 若手（プロ1年目）の本塁打ペースが殿堂選手の1年目実績と同水準なら検出する', () => {
  const retired = { id: 'HOF1', name: 'ベテラン', role: 'fielder', primaryPos: 'OF', finalAge: 40, retiredAfterYear: 2029 };
  // 通算4シーズン、各hr60本（合計240本≧HOF_THRESHOLDS.homeRuns=200）。1年目=hr60。
  const careerStats = [2020, 2021, 2022, 2023].map((yr) => statRow('HOF1', 'T9', { season: yr, batting: batLine({ hr: 60, b1: 100, b2: 20, b3: 2, xB1: 100, xB2: 20, xB3: 2, xHR: 60 }) }));
  const young = statRow('Y1', 'T1', { batting: batLine({ hr: 20, ab: 200, pa: 210 }) }); // 進捗50/143で20本→ペース≒57本
  const filler = mkBatterPool(5, 'T2', [10, 15, 20, 25, 30]);
  const st = fakeState({
    rt: rtAt(21, [standRow('T1', 'L1', 50), standRow('T2', 'L1', G_QUALIFY)], [young, ...filler]),
    careerStats,
    retiredPlayers: [retired],
  });
  const out = analystColumnOf(st, names);
  const hit = out.find((h) => h.playerId === 'Y1' && h.kind === 'comparison');
  assert.ok(hit, '若手のペースが殿堂1年目と同水準なら比較型が検出される');
  assert.ok(hit.text.includes('HOF1') && hit.text.includes('1年目'));
});

test('R1: 比較型 — プロ4年目（comparisonMaxCareerYear=3超）の選手は「若手」扱いされない', () => {
  const retired = { id: 'HOF2', name: 'ベテラン2', role: 'fielder', primaryPos: 'OF', finalAge: 40, retiredAfterYear: 2029 };
  const careerStats = [
    ...[2020, 2021, 2022, 2023].map((yr) => statRow('HOF2', 'T9', { season: yr, batting: batLine({ hr: 60 }) })),
    // NOTVET: 直近3年ぶんの実績を積んでいる（4年目シーズンが今年）
    ...[2027, 2028, 2029].map((yr) => statRow('NOTVET', 'T1', { season: yr, batting: batLine({ hr: 20 }) })),
  ];
  const notYoung = statRow('NOTVET', 'T1', { batting: batLine({ hr: 60, ab: 200, pa: 210 }) });
  const st = fakeState({
    rt: rtAt(21, [standRow('T1', 'L1', 50)], [notYoung]),
    careerStats,
    retiredPlayers: [retired],
  });
  const out = analystColumnOf(st, names);
  assert.ok(!out.some((h) => h.playerId === 'NOTVET' && h.kind === 'comparison'), 'プロ4年目は比較型の対象外');
});

// ============================================================================
// R7: 試合ハイライト（直近の自チーム試合）
// ============================================================================

function pitchBox(pid, o = {}) {
  return { pid, outs: o.outs ?? 0, np: o.np ?? 0, h: o.h ?? 0, r: o.r ?? 0, bb: o.bb ?? 0, k: o.k ?? 0, hr: o.hr ?? 0 };
}
function batBox(pid, o = {}) {
  return { pid, ord: o.ord ?? 1, pos: o.pos ?? 'OF', ab: o.ab ?? 4, h: o.h ?? 1, hr: o.hr ?? 0, rbi: o.rbi ?? 0, bb: o.bb ?? 0, k: o.k ?? 0 };
}
function gameRec(day, home, away, box) {
  return { day, home, away, box };
}

// R7は rt.stats（規定到達者の母集団）とは独立の判定だが、analystColumnOf 自体は
// rt.stats.stats が空だと全体ゲートで早期returnする（規定到達者0人=シーズン外started扱い）ため、
// テストでは無関係のfillerを1件だけ rt.stats に積んでおく。
const R7_FILLER = [statRow('FILLER', 'T1', {})];

test('R7: 好投登板（アウト15以上・K-BB5以上）を直近試合から検出する', () => {
  const box = {
    batters: { home: [], away: [] },
    pitchers: { home: [pitchBox('SP1', { outs: 21, k: 10, bb: 1, h: 3, r: 1, np: 95 })], away: [] },
  };
  const log = [gameRec(10, 'T1', 'T2', box)];
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY), standRow('T2', 'L1', G_QUALIFY)], R7_FILLER, log) });
  const out = analystColumnOf(st, names);
  const hit = out.find((h) => h.playerId === 'SP1' && h.kind === 'gameHighlightPitch');
  assert.ok(hit, '好投登板がgameHighlightPitchとして検出される');
  assert.ok(hit.text.includes('7.0回') || hit.text.includes('7回'));
});

test('R7: アウト数不足の登板は好投登板として検出しない', () => {
  const box = {
    batters: { home: [], away: [] },
    pitchers: { home: [pitchBox('SP2', { outs: 9, k: 6, bb: 0, h: 1, r: 0 })], away: [] }, // 3回のみ=閾値未満
  };
  const log = [gameRec(10, 'T1', 'T2', box)];
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY), standRow('T2', 'L1', G_QUALIFY)], R7_FILLER, log) });
  const out = analystColumnOf(st, names);
  assert.ok(!out.some((h) => h.playerId === 'SP2'), 'アウト数不足はゲート対象外');
});

test('R7: 1試合複数本塁打（快音）を検出する', () => {
  const box = {
    batters: { home: [batBox('H1', { hr: 2, h: 3 })], away: [] },
    pitchers: { home: [], away: [] },
  };
  const log = [gameRec(10, 'T1', 'T2', box)];
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY), standRow('T2', 'L1', G_QUALIFY)], R7_FILLER, log) });
  const out = analystColumnOf(st, names);
  const hit = out.find((h) => h.playerId === 'H1' && h.kind === 'gameHighlightBat');
  assert.ok(hit, '複数本塁打の打者がgameHighlightBatとして検出される');
  assert.ok(hit.text.includes('2本塁打'));
});

// ============================================================================
// R8: 隠れWPAリーダー（月境界の週のみ）
// ============================================================================

test('R8: 月境界の週のみ、打撃成績が地味(wRC+<100)なのにWPA上位の選手を検出する', () => {
  // wRC+を下げるため打率.190程度の平凡打者に、高WPAを持たせる。
  const hidden = statRow('WPA1', 'T1', { batting: batLine({ b1: 60, b2: 5, b3: 0, hr: 3, xB1: 60, xB2: 5, xB3: 0, xHR: 3, wpa: 2.5 }) });
  const filler = mkBatterPool(5, 'T2', [10, 15, 20, 25, 30]);
  const standRows = [standRow('T1', 'L1', G_QUALIFY), standRow('T2', 'L1', G_QUALIFY)];
  const rows = [hidden, ...filler];
  // elapsed=21 → week=3 (start21,end28) daysPerMonth=26 → 28>=26 → 月境界の週
  const stBoundary = fakeState({ rt: rtAt(21, standRows, rows) });
  const outBoundary = analystColumnOf(stBoundary, names);
  const hitBoundary = outBoundary.find((h) => h.playerId === 'WPA1' && h.kind === 'wpaHidden');
  assert.ok(hitBoundary, '月境界の週では隠れWPAリーダーが検出される');
  assert.ok(hitBoundary.text.includes('WPA'));

  // elapsed=7 → week=1 (start7,end14) → 14>=26 は false → 月境界の週ではない
  const stMid = fakeState({ rt: rtAt(7, standRows, rows) });
  const outMid = analystColumnOf(stMid, names);
  assert.ok(!outMid.some((h) => h.kind === 'wpaHidden'), '月境界でない週では隠れWPAリーダーを出さない');
});

// ============================================================================
// 選抜: 同週同一選手の重複排除・上限件数
// ============================================================================

test('R1: 同一選手が複数の型に該当しても、同週の出力には1本しか載らない（重複排除）', () => {
  // U1は「Barrel%最高」かつ「xwOBA乖離(不運型)」の両方に該当させる。
  const dual = statRow('DUAL', 'T1', {
    batting: batLine({
      b1: 70, b2: 10, b3: 1, hr: 8, xB1: 110, xB2: 25, xB3: 3, xHR: 20, // 意外性型（不運）を誘発
      barrels: 90, bbEvents: 100, // Barrel%を突出させて極端値型（リーグ1位）も誘発
    }),
  });
  const filler = mkBatterPool(6, 'T2', [10, 15, 20, 25, 30, 35]);
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY), standRow('T2', 'L1', G_QUALIFY)], [dual, ...filler]) });
  const out = analystColumnOf(st, names);
  const mine = out.filter((h) => h.playerId === 'DUAL');
  assert.equal(mine.length, 1, '同一選手は同週の出力に1本のみ');
});

test('R1: 出力は tuning.storylines.analyst.maxItems（既定4）を超えない', () => {
  const rows = mkBatterPool(8, 'T1', [10, 20, 30, 40, 50, 60, 70, 80]);
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY)], rows) });
  const out = analystColumnOf(st, names);
  assert.ok(out.length <= cfg.tuning.storylines.analyst.maxItems);
});

// ============================================================================
// ガード・決定論
// ============================================================================

test('R1: rt未生成（シーズン外）は空配列', () => {
  assert.deepEqual(analystColumnOf(fakeState({ rt: null }), names), []);
});

test('R1: シーズン消化が浅い（規定打席が小さすぎる=全員未達）うちは検出しない', () => {
  const rows = mkBatterPool(6, 'T1', [10, 20, 30, 40, 50, 60]).map((s) => ({ ...s, batting: { ...s.batting, ab: 30, pa: 33 } }));
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', 10)], rows) }); // g=10→qPA=31だが各人pa=33ギリギリ規定内…
  const out1 = analystColumnOf(st, names);
  // 規定を明確に下回るケース（pa=20）で確実にゲートされることを確認
  const rowsLow = mkBatterPool(6, 'T1', [10, 20, 30, 40, 50, 60]).map((s) => ({ ...s, batting: { ...s.batting, ab: 18, pa: 20 } }));
  const stLow = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', 10)], rowsLow) });
  const outLow = analystColumnOf(stLow, names);
  assert.equal(outLow.length, 0, '規定打席に遠く及ばない序盤は検出しない');
  void out1;
});

test('R1: 決定論 — 同一state入力は同一output（純関数・stateを変更しない）', () => {
  const rows = mkBatterPool(6, 'T1', [10, 20, 30, 40, 50, 60]);
  const st = fakeState({ rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY)], rows) });
  const before = JSON.stringify([...st.rt.stats.stats.values()]);
  const a = JSON.stringify(analystColumnOf(st, names));
  const b = JSON.stringify(analystColumnOf(st, names));
  assert.equal(a, b, '同一input同一output');
  const after = JSON.stringify([...st.rt.stats.stats.values()]);
  assert.equal(after, before, 'stateを変更しない');
});

test('R1: 決定論 — masterSeedが異なれば抽選（テンプレ/選抜)が変化しうるが、候補集合は同じ規則で決まる', () => {
  const rows = mkBatterPool(6, 'T1', [10, 20, 30, 40, 50, 60]);
  const stA = fakeState({ masterSeed: 111, rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY)], rows) });
  const stB = fakeState({ masterSeed: 222, rt: rtAt(21, [standRow('T1', 'L1', G_QUALIFY)], rows) });
  const outA = analystColumnOf(stA, names);
  const outB = analystColumnOf(stB, names);
  // 同じ極端値リーダー(barrels最大=B5)は両方で検出されるはず（候補集合は乱数非依存）。
  assert.ok(outA.some((h) => h.playerId === 'B5'));
  assert.ok(outB.some((h) => h.playerId === 'B5'));
});

// ============================================================================
// Q4/Q8: 殿堂/球団史ギャラリー・二つ名/記録の「アルバム」（gallery.mjs）のテスト。
//   thyroxin/research/baseball_game_mechanics_research_20260723 Q4・Q8。
//   - hallOfFamers: 引退済み＋通算成績閾値(hits/homeRuns/wins/saves/strikeouts)いずれか、または
//     受賞数閾値(5)を満たす引退選手だけを集計する（境界値・現役除外・ソート順）
//   - nicknameAlbum: nicknameFor を現役/引退選手へ適用し「未知数」を除外して集計
//   - recordAlbum: 既存leagueRecords/teamRecordsの見せ方の再編集（新規集計ロジック無し）
//   すべて純関数・新規保存フィールド無し・真値非参照であることを合成フィクスチャで検証する。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { hallOfFamers, nicknameAlbum, recordAlbum } from '../src/game/gallery.mjs';

const cfg = createConfig();

function batLine(o) {
  return { pa: 0, ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, so: 0, sf: 0, sb: 0, cs: 0, rbi: 0, ibb: 0, ...o };
}
function pitLine(o) {
  return { outs: 0, bf: 0, h: 0, hr: 0, bb: 0, ibb: 0, hbp: 0, so: 0, er: 0, r: 0, w: 0, l: 0, sv: 0, hld: 0, g: 0, gs: 0, ...o };
}
function statRow(playerId, teamId, season, o = {}) {
  return { playerId, teamId, season, batting: o.batting ?? null, pitching: o.pitching ?? null, baserunning: {}, fielding: { positionOuts: {} } };
}
function fakeState(o = {}) {
  return {
    cfg, careerStats: [], teamHistory: [], awardsHistory: [], retiredPlayers: [],
    league: { players: [], farm: [], teams: [] },
    ...o,
  };
}

// ============================================================================
// Q4: hallOfFamers
// ============================================================================

test('Q4: hallOfFamers — 通算安打2000到達（境界ちょうど）の引退野手は殿堂入り', () => {
  const retiredBig = { id: 'R1', name: 'Retired One', role: 'fielder', primaryPos: 'OF', finalAge: 40, retiredAfterYear: 2030 };
  const retiredSmall = { id: 'R2', name: 'Retired Two', role: 'fielder', primaryPos: '1B', finalAge: 38, retiredAfterYear: 2028 };
  const careerStats = [
    statRow('R1', 'T1', 2020, { batting: batLine({ pa: 2200, ab: 2000, h: 2000 }) }), // ちょうど閾値
    statRow('R2', 'T1', 2020, { batting: batLine({ pa: 1700, ab: 1600, h: 1999 }) }), // 1本足りない
  ];
  const st = fakeState({ careerStats, retiredPlayers: [retiredBig, retiredSmall] });
  const hof = hallOfFamers(st);
  assert.ok(hof.some((h) => h.playerId === 'R1'), '通算2000安打ちょうどは殿堂入り（>=判定）');
  assert.ok(!hof.some((h) => h.playerId === 'R2'), '1本未達・受賞0は殿堂入りしない');
  const r1 = hof.find((h) => h.playerId === 'R1');
  assert.equal(r1.career.h, 2000, '通算成績がcareerBattingと一致');
});

test('Q4: hallOfFamers — 投手は通算勝利150/セーブ150/奪三振1500のいずれかで殿堂入り', () => {
  const ace = { id: 'P1', name: 'Ace', role: 'pitcher', primaryPos: 'P', finalAge: 42, retiredAfterYear: 2031 };
  const mopup = { id: 'P2', name: 'Mopup', role: 'pitcher', primaryPos: 'P', finalAge: 35, retiredAfterYear: 2029 };
  const careerStats = [
    statRow('P1', 'T1', 2020, { pitching: pitLine({ outs: 6000, bf: 8000, w: 150, l: 100 }) }),
    statRow('P2', 'T1', 2020, { pitching: pitLine({ outs: 1000, bf: 1400, w: 40, l: 40 }) }),
  ];
  const st = fakeState({ careerStats, retiredPlayers: [ace, mopup] });
  const hof = hallOfFamers(st);
  assert.ok(hof.some((h) => h.playerId === 'P1'), '通算150勝は殿堂入り');
  assert.ok(!hof.some((h) => h.playerId === 'P2'), '基準未達の投手は殿堂入りしない');
});

test('Q4: hallOfFamers — 通算成績が基準未満でも受賞数5以上なら殿堂入り', () => {
  const decorated = { id: 'R3', name: 'Decorated', role: 'fielder', primaryPos: 'OF', finalAge: 36, retiredAfterYear: 2025 };
  const careerStats = [statRow('R3', 'T1', 2020, { batting: batLine({ pa: 500, ab: 450, h: 130 }) })]; // 通算成績は基準未満
  const awardsHistory = [2020, 2021, 2022, 2023, 2024].map((year) => ({
    year,
    awards: { leagues: [{ leagueId: 'L1', mvp: { playerId: 'R3', war: 6 }, roty: null, titles: {}, bestNine: [], gloves: [] }] },
  }));
  const st = fakeState({ careerStats, awardsHistory, retiredPlayers: [decorated] });
  const hof = hallOfFamers(st);
  const r3 = hof.find((h) => h.playerId === 'R3');
  assert.ok(r3, '受賞数5以上（MVP5回）は通算成績未達でも殿堂入り');
  assert.equal(r3.awardsCount, 5);
});

test('Q4: hallOfFamers — 現役選手（retiredPlayersに居ない）は対象外', () => {
  const careerStats = [statRow('ACTIVE1', 'T1', 2020, { batting: batLine({ pa: 3000, ab: 2800, h: 2500 }) })];
  const st = fakeState({ careerStats, retiredPlayers: [] });
  assert.equal(hallOfFamers(st).length, 0, 'retiredPlayersに居ない選手は現役扱いで対象外');
});

test('Q4: hallOfFamers — 引退年降順でソートされる（決定論）', () => {
  const a = { id: 'A', name: 'A', role: 'fielder', primaryPos: 'OF', finalAge: 40, retiredAfterYear: 2025 };
  const b = { id: 'B', name: 'B', role: 'fielder', primaryPos: 'OF', finalAge: 40, retiredAfterYear: 2028 };
  const careerStats = [
    statRow('A', 'T1', 2020, { batting: batLine({ pa: 2200, ab: 2000, h: 2100 }) }),
    statRow('B', 'T1', 2020, { batting: batLine({ pa: 2200, ab: 2000, h: 2100 }) }),
  ];
  const st = fakeState({ careerStats, retiredPlayers: [a, b] });
  const hof = hallOfFamers(st);
  assert.deepEqual(hof.map((h) => h.playerId), ['B', 'A'], '引退年が新しい方が先頭');
});

// ============================================================================
// Q8: nicknameAlbum / recordAlbum
// ============================================================================

test('Q8: nicknameAlbum — 現役/引退選手にnicknameForを適用し「未知数」は除外する', () => {
  const N = cfg.tuning.awards.nickname;
  const speedy = { id: 'S1', name: 'Speedy', role: 'fielder', primaryPos: 'CF', age: 28, teamId: 'T1' };
  const rookie = { id: 'S2', name: 'Rookie', role: 'fielder', primaryPos: '2B', age: 20, teamId: 'T1' };
  const retiredNick = { id: 'S3', name: 'OldSlugger', role: 'fielder', primaryPos: '1B', finalAge: 40, retiredAfterYear: 2020 };
  const careerStats = [
    statRow('S1', 'T1', 2020, { batting: batLine({ pa: N.paGate + 10, ab: N.paGate, sb: N.speedSb }) }), // 韋駄天
    statRow('S2', 'T1', 2020, { batting: batLine({ pa: 10, ab: 9, h: 5 }) }), // サンプル不足→未知数
    statRow('S3', 'T1', 2015, { batting: batLine({ pa: N.paGate + 10, ab: N.paGate, hr: N.bigSluggerHr }) }), // 巨砲
  ];
  const st = fakeState({ careerStats, league: { players: [speedy, rookie], farm: [], teams: [] }, retiredPlayers: [retiredNick] });
  const album = nicknameAlbum(st);
  const ids = album.map((a) => a.playerId);
  assert.ok(ids.includes('S1') && ids.includes('S3'), '二つ名が付いた現役/引退選手が載る');
  assert.ok(!ids.includes('S2'), 'サンプル不足（未知数）は除外される');
  const s1 = album.find((a) => a.playerId === 'S1');
  assert.equal(s1.nickname, '韋駄天');
  assert.equal(s1.status, 'active');
  const s3 = album.find((a) => a.playerId === 'S3');
  assert.equal(s3.status, 'retired');
});

test('Q8: recordAlbum — leagueTopは既存leagueRecordsのトップ1と一致する', () => {
  const p1 = { id: 'HR1', name: 'Slugger', role: 'fielder', primaryPos: 'LF', age: 30, teamId: 'T1' };
  const careerStats = [statRow('HR1', 'T1', 2022, { batting: batLine({ pa: 600, ab: 560, hr: 55 }) })];
  const st = fakeState({ careerStats, league: { players: [p1], farm: [], teams: [{ id: 'T1' }] } });
  const album = recordAlbum(st);
  const hrCareer = album.leagueTop.find((x) => x.key === 'careerHR');
  assert.ok(hrCareer, '通算本塁打記録が載る');
  assert.equal(hrCareer.row.playerId, 'HR1');
  assert.equal(hrCareer.row.value, 55);
  const hrSeason = album.leagueTop.find((x) => x.key === 'seasonHR');
  assert.equal(hrSeason.row.year, 2022, 'シーズン記録には年が付く');
});

test('Q8: recordAlbum — teamTitlesは日本一の年をteamId別に集計し件数降順で並ぶ', () => {
  const teamHistory = [
    { year: 2020, standings: [{ teamId: 'T1', league: 'L1', w: 80, l: 60, rs: 1, ra: 1 }, { teamId: 'T2', league: 'L1', w: 60, l: 80, rs: 1, ra: 1 }], champion: 'T1' },
    { year: 2021, standings: [{ teamId: 'T1', league: 'L1', w: 70, l: 70, rs: 1, ra: 1 }, { teamId: 'T2', league: 'L1', w: 90, l: 50, rs: 1, ra: 1 }], champion: 'T2' },
    { year: 2022, standings: [{ teamId: 'T1', league: 'L1', w: 90, l: 50, rs: 1, ra: 1 }, { teamId: 'T2', league: 'L1', w: 60, l: 80, rs: 1, ra: 1 }], champion: 'T1' },
  ];
  const st = fakeState({ teamHistory, league: { players: [], farm: [], teams: [{ id: 'T1' }, { id: 'T2' }] } });
  const album = recordAlbum(st);
  assert.deepEqual(album.teamTitles.map((t) => t.teamId), ['T1', 'T2'], 'T1(2回)がT2(1回)より先頭');
  const t1 = album.teamTitles.find((t) => t.teamId === 'T1');
  assert.deepEqual(t1.years, [2020, 2022]);
});

test('Q4/Q8: 決定論 — 同一state入力は同一出力（純関数）', () => {
  const p1 = { id: 'HR1', name: 'Slugger', role: 'fielder', primaryPos: 'LF', age: 30, teamId: 'T1' };
  const retired = { id: 'R1', name: 'Retired One', role: 'fielder', primaryPos: 'OF', finalAge: 40, retiredAfterYear: 2030 };
  const careerStats = [
    statRow('HR1', 'T1', 2022, { batting: batLine({ pa: 600, ab: 560, hr: 55 }) }),
    statRow('R1', 'T1', 2020, { batting: batLine({ pa: 2200, ab: 2000, h: 2000 }) }),
  ];
  const st = fakeState({ careerStats, league: { players: [p1], farm: [], teams: [{ id: 'T1' }] }, retiredPlayers: [retired] });
  assert.equal(JSON.stringify(hallOfFamers(st)), JSON.stringify(hallOfFamers(st)));
  assert.equal(JSON.stringify(nicknameAlbum(st)), JSON.stringify(nicknameAlbum(st)));
  assert.equal(JSON.stringify(recordAlbum(st)), JSON.stringify(recordAlbum(st)));
});

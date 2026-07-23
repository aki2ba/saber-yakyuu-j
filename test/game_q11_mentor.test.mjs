// ============================================================================
// Q11: 師弟継承の物語化（thyroxin/research/baseball_game_mechanics_research_20260723 Q11・
//   ダビスタ配合ロマンの翻案・数値非関与版）のテスト。
//   playerStoryOf のタイムラインに「◯◯の背中を見て育った」（kind='mentor'）が追加される条件
//   （同一球団5年以上共存・年齢差8歳以上・通算成績（career行数）が本人より大きい側）を
//   境界値で検証する。逆方向（ベテラン側）には追加されないことも確認する。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { playerStoryOf, STORY_KIND_LABELS } from '../src/game/storylines.mjs';

const cfg = createConfig();

function batLine(o) {
  return { pa: 0, ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, so: 0, sf: 0, sb: 0, cs: 0, rbi: 0, ibb: 0, ...o };
}
function statRow(playerId, teamId, season, o = {}) {
  return { playerId, teamId, season, batting: o.batting ?? batLine(), pitching: o.pitching ?? null, baserunning: {}, fielding: { positionOuts: {} } };
}
/** playerId が seasons年ぶん teamId に在籍した careerStats 行列（既定は打者・空ラインで十分＝mentor判定はcareerStats行の存在のみ見る）。 */
function tenureRows(playerId, teamId, seasons) {
  return seasons.map((y) => statRow(playerId, teamId, y));
}
function fakeState(careerStats, players, extra = {}) {
  return {
    cfg, masterSeed: 999, year: 2025, careerStats, teamHistory: [], awardsHistory: [], transactionLog: [],
    league: { players, farm: [] }, retiredPlayers: [],
    ...extra,
  };
}
function player(id, teamId, age, role = 'fielder') {
  return { id, teamId, role, primaryPos: role === 'pitcher' ? 'P' : 'OF', age, rosterStatus: 'active' };
}

test('Q11: 同一球団5年共存＋年齢差8歳以上＋通算成績（career行数）が大きいベテランがいれば「背中を見て育った」が出る', () => {
  const young = player('YOUNG', 'T1', 27); // state.year=2025 → 2024時点で26歳
  const vet = player('VET', 'T1', 45); // 同時点で44歳（差18）
  const careerStats = [
    ...tenureRows('VET', 'T1', [2015, 2016, 2017, 2018, 2019]), // VETだけの在籍（磁力の差を作る）
    ...tenureRows('VET', 'T1', [2020, 2021, 2022, 2023, 2024]), // 共存5年
    ...tenureRows('YOUNG', 'T1', [2020, 2021, 2022, 2023, 2024]),
  ];
  const st = fakeState(careerStats, [young, vet]);
  const story = playerStoryOf(st, 'YOUNG');
  const mentorEv = story.find((e) => e.kind === 'mentor');
  assert.ok(mentorEv, 'mentorイベントが生成される');
  assert.ok(mentorEv.text.includes('VET') && mentorEv.text.includes('背中を見て育った'));
  assert.equal(mentorEv.year, 2024, 'lastYear=直近の共存シーズン');
  assert.equal(STORY_KIND_LABELS.mentor, '師弟', 'STORY_KIND_LABELSにmentorラベルが定義されている');
});

test('Q11: 年齢差が8歳未満なら出ない（境界: 差7）', () => {
  const young = player('Y2', 'T1', 30);
  const vet = player('V2', 'T1', 37); // 差7
  const careerStats = [
    ...tenureRows('V2', 'T1', [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]),
    ...tenureRows('Y2', 'T1', [2020, 2021, 2022, 2023, 2024]),
  ];
  const st = fakeState(careerStats, [young, vet]);
  const story = playerStoryOf(st, 'Y2');
  assert.ok(!story.some((e) => e.kind === 'mentor'), '年齢差8歳未満はmentorイベントを出さない');
});

test('Q11: 年齢差ちょうど8歳は境界として成立する', () => {
  const young = player('Y3', 'T1', 30);
  const vet = player('V3', 'T1', 38); // 差ちょうど8
  const careerStats = [
    ...tenureRows('V3', 'T1', [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]),
    ...tenureRows('Y3', 'T1', [2020, 2021, 2022, 2023, 2024]),
  ];
  const st = fakeState(careerStats, [young, vet]);
  const story = playerStoryOf(st, 'Y3');
  assert.ok(story.some((e) => e.kind === 'mentor'), '年齢差ちょうど8歳はmentorイベントが出る（>=判定）');
});

test('Q11: 共存年数が5年未満なら出ない（境界: 4年）', () => {
  const young = player('Y4', 'T1', 27);
  const vet = player('V4', 'T1', 45);
  const careerStats = [
    ...tenureRows('V4', 'T1', [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]),
    ...tenureRows('Y4', 'T1', [2021, 2022, 2023, 2024]), // 共存4年のみ
  ];
  const st = fakeState(careerStats, [young, vet]);
  const story = playerStoryOf(st, 'Y4');
  assert.ok(!story.some((e) => e.kind === 'mentor'), '共存5年未満はmentorイベントを出さない');
});

test('Q11: 候補の通算成績（career行数）が本人以下なら出ない', () => {
  const young = player('Y5', 'T1', 27);
  const oldButSmall = player('V5', 'T1', 45); // 年齢差は満たすが通算成績が本人以下
  const careerStats = [
    // V5はYOUNGと同じ5年ぶんしか記録が無い（=career行数が同じ・「本人より大きい」を満たさない）
    ...tenureRows('V5', 'T1', [2020, 2021, 2022, 2023, 2024]),
    ...tenureRows('Y5', 'T1', [2020, 2021, 2022, 2023, 2024]),
  ];
  const st = fakeState(careerStats, [young, oldButSmall]);
  const story = playerStoryOf(st, 'Y5');
  assert.ok(!story.some((e) => e.kind === 'mentor'), '候補の通算成績が本人を上回らない場合は出ない');
});

test('Q11: 1方向のみ — ベテラン側の物語には若手を指す逆方向のmentorイベントは出ない', () => {
  const young = player('Y6', 'T1', 27);
  const vet = player('V6', 'T1', 45);
  const careerStats = [
    ...tenureRows('V6', 'T1', [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]),
    ...tenureRows('Y6', 'T1', [2020, 2021, 2022, 2023, 2024]),
  ];
  const st = fakeState(careerStats, [young, vet]);
  const youngStory = playerStoryOf(st, 'Y6');
  assert.ok(youngStory.some((e) => e.kind === 'mentor'), '若手側にはmentorイベントが出る');
  const vetStory = playerStoryOf(st, 'V6');
  assert.ok(!vetStory.some((e) => e.kind === 'mentor'), 'ベテラン側には逆方向のmentorイベントは出ない');
});

test('Q11: 複数候補がいれば通算成績（career行数）最大の候補を選ぶ（同点はplayerId昇順）', () => {
  const young = player('Y7', 'T1', 27);
  const vetSmall = player('VA', 'T1', 45); // 8年分
  const vetBig = player('VB', 'T1', 45); // 12年分（最大）
  const careerStats = [
    ...tenureRows('VA', 'T1', [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024].slice(-8)),
    ...tenureRows('VB', 'T1', [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]),
    ...tenureRows('Y7', 'T1', [2020, 2021, 2022, 2023, 2024]),
  ];
  const st = fakeState(careerStats, [young, vetSmall, vetBig]);
  const story = playerStoryOf(st, 'Y7');
  const mentorEv = story.find((e) => e.kind === 'mentor');
  assert.ok(mentorEv);
  assert.ok(mentorEv.text.includes('VB'), '通算成績（career行数）最大のVBが選ばれる');
});

test('Q11: 決定論 — 同一state入力は同一出力', () => {
  const young = player('Y8', 'T1', 27);
  const vet = player('V8', 'T1', 45);
  const careerStats = [
    ...tenureRows('V8', 'T1', [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]),
    ...tenureRows('Y8', 'T1', [2020, 2021, 2022, 2023, 2024]),
  ];
  const st = fakeState(careerStats, [young, vet]);
  const a = JSON.stringify(playerStoryOf(st, 'Y8'));
  const b = JSON.stringify(playerStoryOf(st, 'Y8'));
  assert.equal(a, b, '同一state入力は同一出力（純関数）');
});

// ============================================================================
// Q3（thyroxin/research…20260723 Q3・「記憶に残る一日」特別デー）のテスト。
//   specialDaysOf(state, names) — 自チームの未消化日程から4種の特別デーを検出する純関数。
//   合成フィクスチャで各種別の境界・決定論・低頻度設計を直接検証する
//   （game_h1_storylines.test.mjsと同じ「rt.standings/rt.stats.statsを直接構成する」流儀）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { specialDaysOf } from '../src/game/storylines.mjs';

const cfg = createConfig();
const names = { pnameOf: (id) => id, tnameOf: (id) => id };

function batLine(o) {
  return { pa: 0, ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, so: 0, sf: 0, sb: 0, cs: 0, rbi: 0, ibb: 0, gdp: 0, ...o };
}
function pitLine(o) {
  return { outs: 0, bf: 0, h: 0, hr: 0, bb: 0, ibb: 0, hbp: 0, so: 0, er: 0, r: 0, w: 0, l: 0, sv: 0, hld: 0, g: 0, gs: 0, ...o };
}
function careerRow(playerId, teamId, season, o = {}) {
  return { playerId, teamId, season, batting: o.batting ?? null, pitching: o.pitching ?? null };
}
function player(id, teamId, role, o = {}) {
  return { id, teamId, role, rosterStatus: 'active', age: 30, ...o };
}
function standRow(teamId, league, w, l, g) {
  return { teamId, league, g: g ?? w + l, w, l, t: 0, rs: w * 4, ra: l * 4 };
}
function fakeState(o) {
  const schedule = o.schedule ?? [];
  return {
    cfg, masterSeed: o.masterSeed ?? 999, year: o.year ?? 2030,
    careerStats: o.careerStats ?? [],
    transactionLog: o.transactionLog ?? [],
    league: { players: o.players ?? [], farm: [] },
    playerTeamId: o.playerTeamId ?? 'T1',
    rt: {
      cursor: o.cursor ?? 0,
      finalDay: o.finalDay ?? (schedule.length ? schedule[schedule.length - 1].day : 0),
      schedule,
      standings: new Map((o.standRows ?? []).map((r) => [r.teamId, r])),
      stats: { stats: new Map((o.statRows ?? []).map((s) => [s.playerId, s])) },
    },
  };
}

test('Q3: state.rt が無ければ空配列（シーズン外は何も検出しない）', () => {
  assert.deepEqual(specialDaysOf({ rt: null, playerTeamId: 'T1' }), []);
});

test('Q3-節目リーチ: 通算があと僅かで次のマイルストーンに届く選手がいれば、次の未消化試合が特別デー', () => {
  // hits の閾値は既定 [1000,1500,2000]。1996本 → 次の未消化試合まであと4本＝milestoneReach.hits(5)以内。
  const st = fakeState({
    players: [player('A', 'T1', 'fielder')],
    careerStats: [careerRow('A', 'T1', 2029, { batting: batLine({ ab: 5000, h: 1996 }) })],
    schedule: [
      { day: 0, home: 'T1', away: 'T2' }, // 消化済み
      { day: 1, home: 'T1', away: 'T2' }, // 次の未消化試合
      { day: 2, home: 'T2', away: 'T1' },
    ],
    cursor: 1,
    standRows: [standRow('T1', 'L1', 0, 0), standRow('T2', 'L1', 0, 0)],
  });
  const out = specialDaysOf(st, names);
  const hit = out.find((d) => d.kind === 'milestone');
  assert.ok(hit, '節目リーチが検出されない');
  assert.equal(hit.day, 1, '次の未消化試合の日に紐づく');
  assert.ok(hit.label.includes('2000本安打'), `ラベルに次の閾値が出ない: ${hit.label}`);
});

test('Q3-節目リーチ: ギャップが閾値を超えると検出されない（低頻度設計の境界）', () => {
  const st = fakeState({
    players: [player('A', 'T1', 'fielder')],
    careerStats: [careerRow('A', 'T1', 2029, { batting: batLine({ ab: 5000, h: 1990 }) })], // あと10本＝reach(5)超過
    schedule: [{ day: 0, home: 'T1', away: 'T2' }],
    cursor: 0,
    standRows: [standRow('T1', 'L1', 0, 0), standRow('T2', 'L1', 0, 0)],
  });
  const out = specialDaysOf(st, names);
  assert.equal(out.filter((d) => d.kind === 'milestone').length, 0, 'ギャップが大きい選手は検出されないはず');
});

test('Q3-節目リーチ: 当季進行中の観測（rt.stats）も通算に合算される', () => {
  const st = fakeState({
    players: [player('A', 'T1', 'fielder')],
    careerStats: [careerRow('A', 'T1', 2029, { batting: batLine({ ab: 5000, h: 1993 }) })], // 前年末点であと7本
    statRows: [{ playerId: 'A', teamId: 'T1', season: 2030, batting: batLine({ ab: 20, h: 4 }) }], // 当季+4 → 1997本・あと3本
    schedule: [{ day: 0, home: 'T1', away: 'T2' }],
    cursor: 0,
    standRows: [standRow('T1', 'L1', 0, 0), standRow('T2', 'L1', 0, 0)],
  });
  const out = specialDaysOf(st, names);
  const hit = out.find((d) => d.kind === 'milestone');
  assert.ok(hit, '当季進行中の観測を合算した節目リーチが検出されない');
});

test('Q3-同期対決: rivalriesOf の因縁チーム（trade由来）が相手のカード初戦を検出する', () => {
  const schedule = [
    { day: 0, home: 'T1', away: 'T3' }, // 消化済み・別カード
    { day: 1, home: 'T1', away: 'T2' }, // カード初戦（未消化）＝因縁チーム
    { day: 2, home: 'T2', away: 'T1' }, // 同一カード2戦目（初戦ではない）
  ];
  const st = fakeState({
    players: [player('B', 'T1', 'fielder')],
    // B は T2 からのトレードで T1 に来た（rivalriesOfのoldTeamId='T2'）。
    transactionLog: [{ year: 2028, kind: 'trade', playerId: 'B', playerId2: 'X', from: 'T2', to: 'T1' }],
    schedule,
    cursor: 1,
    standRows: [standRow('T1', 'L1', 0, 0), standRow('T2', 'L1', 0, 0), standRow('T3', 'L1', 0, 0)],
  });
  const out = specialDaysOf(st, names);
  const hits = out.filter((d) => d.kind === 'rivalry');
  assert.equal(hits.length, 1, 'カード初戦(day1)のみ1件検出されるはず');
  assert.equal(hits[0].day, 1);
  assert.equal(hits[0].oppId, 'T2');
});

test('Q3-同期対決: カード2戦目（初戦でない）は検出されない', () => {
  const schedule = [
    { day: 0, home: 'T1', away: 'T2' }, // カード初戦（消化済み）
    { day: 1, home: 'T2', away: 'T1' }, // 2戦目（未消化・初戦ではない）
  ];
  const st = fakeState({
    players: [player('B', 'T1', 'fielder')],
    transactionLog: [{ year: 2028, kind: 'trade', playerId: 'B', playerId2: 'X', from: 'T2', to: 'T1' }],
    schedule,
    cursor: 1,
    standRows: [standRow('T1', 'L1', 0, 0), standRow('T2', 'L1', 0, 0)],
  });
  const out = specialDaysOf(st, names);
  assert.equal(out.filter((d) => d.kind === 'rivalry').length, 0, '初戦(day0)は既に消化済みなので検出されない');
});

test('Q3-首位攻防戦(P1-4): 自チームが首位そのもの（首位差0）なら検出される', () => {
  const st = fakeState({
    schedule: [{ day: 0, home: 'T1', away: 'T2' }],
    cursor: 0,
    // T1が首位（w-l=5 > T2のw-l=3）。gamesBehind(T1,T1)=0 <= 1.5 ＝自チームが首位。
    standRows: [standRow('T1', 'L1', 50, 45), standRow('T2', 'L1', 49, 46)],
  });
  const out = specialDaysOf(st, names);
  const hit = out.find((d) => d.kind === 'pennant');
  assert.ok(hit, '首位攻防戦が検出されない');
  assert.equal(hit.day, 0);
});

test('Q3-首位攻防戦(P1-4): 相手が首位と僅差なら、自チームが首位から遠くても検出される', () => {
  const st = fakeState({
    schedule: [{ day: 0, home: 'T1', away: 'T2' }],
    cursor: 0,
    // T3が首位（別カードの相手・今日の対戦相手ではない）。T2は首位差0.5（pennantMaxGb=0.5の帯内・
    // 12seed sweepで月2.8回に較正した最終値）・T1は首位差20（遠い）。
    standRows: [
      standRow('T3', 'L1', 70, 25),
      standRow('T1', 'L1', 50, 45),
      standRow('T2', 'L1', 69, 25),
    ],
  });
  const out = specialDaysOf(st, names);
  const hit = out.find((d) => d.kind === 'pennant');
  assert.ok(hit, '相手（T2）が首位と僅差なら、自チーム視点で遠くても首位攻防戦になる');
});

test('Q3-首位攻防戦(P1-4・希少化の核心): 自分も相手も首位から遠い凡戦は検出されない', () => {
  // レビュー実測（30.8%発火）の原因: 旧定義は「相手との直接ゲーム差」のみを見ていたため、
  // 下位同士（T1 vs T2）が互いに接近しているだけで「首位攻防」になっていた。
  // T3が独走首位、T1・T2はともにT3から20ゲーム差＝どちらも首位攻防の当事者ではない。
  const st = fakeState({
    schedule: [{ day: 0, home: 'T1', away: 'T2' }],
    cursor: 0,
    standRows: [
      standRow('T3', 'L1', 70, 25),
      standRow('T1', 'L1', 50, 45), // T3から20差
      standRow('T2', 'L1', 49, 46), // T3から19.5差（互いには僅少差だが両者とも首位から遠い）
    ],
  });
  assert.equal(specialDaysOf(st, names).filter((d) => d.kind === 'pennant').length, 0,
    '自分・相手とも首位と僅差でない凡戦は「首位攻防戦」から除外されるべき（P1-4の核心）');
});

test('Q3-首位攻防戦: 別リーグの相手は対象外', () => {
  const otherLeague = fakeState({
    schedule: [{ day: 0, home: 'T1', away: 'T4' }],
    cursor: 0,
    standRows: [standRow('T1', 'L1', 50, 45), standRow('T4', 'L2', 49, 46)], // ゲーム差は僅少だが別リーグ
  });
  assert.equal(specialDaysOf(otherLeague, names).filter((d) => d.kind === 'pennant').length, 0, '別リーグは首位攻防戦の対象外');
});

test('Q3-首位攻防戦(P1-4): シーズン1/3未消化のうちは（首位差0でも）検出されない', () => {
  const st = fakeState({
    schedule: [{ day: 0, home: 'T1', away: 'T2' }],
    cursor: 0,
    // 既定 gamesPerSeason=143 の1/3=約47.7試合未満はガード対象（T1が首位でも発火させない）。
    standRows: [standRow('T1', 'L1', 25, 20, 45), standRow('T2', 'L1', 20, 25, 45)],
  });
  assert.equal(specialDaysOf(st, names).filter((d) => d.kind === 'pennant').length, 0,
    'シーズン序盤（1/3消化未満）は首位差0でも誤発火しないはず');
});

test('Q3-首位攻防戦: 開幕直後（g=0）は誤発火しない（進捗ガードの境界）', () => {
  const st = fakeState({
    schedule: [{ day: 0, home: 'T1', away: 'T2' }],
    cursor: 0,
    standRows: [standRow('T1', 'L1', 0, 0), standRow('T2', 'L1', 0, 0)], // g=0（全球団横並び）
  });
  assert.equal(specialDaysOf(st, names).filter((d) => d.kind === 'pennant').length, 0);
});

test('Q3-球団創設記念日: 未消化の全日程からhashSeed独立座標で1件・決定論（同一入力は同一出力）', () => {
  const schedule = Array.from({ length: 20 }, (_, i) => ({ day: i, home: i % 2 === 0 ? 'T1' : 'T2', away: i % 2 === 0 ? 'T2' : 'T1' }));
  const st = fakeState({ schedule, cursor: 0, standRows: [standRow('T1', 'L1', 0, 0), standRow('T2', 'L1', 0, 0)] });
  const out1 = specialDaysOf(st, names).filter((d) => d.kind === 'anniversary');
  const out2 = specialDaysOf(st, names).filter((d) => d.kind === 'anniversary');
  assert.equal(out1.length, 1, '記念日は年1回だけ検出される');
  assert.deepEqual(out1, out2, '同一入力に対し決定論的に同じ結果');
  assert.ok(schedule.some((g) => g.day === out1[0].day), '記念日は実在の自チーム試合日に必ず一致する');
});

test('Q3-球団創設記念日: masterSeedが違えば選ばれる日が変わりうる（ハードコードでないことの確認）', () => {
  const schedule = Array.from({ length: 40 }, (_, i) => ({ day: i, home: i % 2 === 0 ? 'T1' : 'T2', away: i % 2 === 0 ? 'T2' : 'T1' }));
  const days = new Set();
  for (let seed = 0; seed < 8; seed++) {
    const st = fakeState({ schedule, cursor: 0, masterSeed: seed, standRows: [standRow('T1', 'L1', 0, 0), standRow('T2', 'L1', 0, 0)] });
    const out = specialDaysOf(st, names).filter((d) => d.kind === 'anniversary');
    if (out.length) days.add(out[0].day);
  }
  assert.ok(days.size > 1, 'masterSeedを変えても常に同じ日が選ばれる（実質ハードコード）ようでは低頻度設計として不適切');
});

test('Q3-低頻度: 節目リーチは常に「次の未消化試合」1日にしか付かない（複数該当選手がいても日は分散しない）', () => {
  const st = fakeState({
    players: [player('A', 'T1', 'fielder'), player('B', 'T1', 'pitcher'), player('C', 'T1', 'fielder')],
    careerStats: [
      careerRow('A', 'T1', 2029, { batting: batLine({ ab: 5000, h: 1997 }) }), // あと3本
      careerRow('B', 'T1', 2029, { pitching: pitLine({ outs: 3000, w: 149 }) }), // あと1勝
      careerRow('C', 'T1', 2029, { batting: batLine({ ab: 5000, hr: 298 }) }), // あと2本塁打
    ],
    schedule: [{ day: 5, home: 'T1', away: 'T2' }, { day: 6, home: 'T1', away: 'T2' }],
    cursor: 0,
    standRows: [standRow('T1', 'L1', 0, 0), standRow('T2', 'L1', 0, 0)],
  });
  const out = specialDaysOf(st, names).filter((d) => d.kind === 'milestone');
  assert.ok(out.length >= 3, '3選手ぶんの節目リーチが検出されるはず');
  assert.ok(out.every((d) => d.day === 5), '節目リーチは常に「次の未消化試合」1日に集約される（低頻度設計）');
});

test('Q3-低頻度: 同期対決/首位攻防戦は「カード初戦」以外の日には付かない（総試合数よりずっと少ない）', () => {
  // 12球団総当たりに近い規模の日程（同一相手との複数連戦を模す）を組み、カード初戦以外では
  // rivalry/pennantが一切付かないことを確認する（1試合ごとに検出されると総試合数と同数になってしまう）。
  const teams = ['T2', 'T3', 'T4', 'T5'];
  const schedule = [];
  let day = 0;
  for (const opp of teams) {
    for (let g = 0; g < 3; g++) { schedule.push({ day, home: 'T1', away: opp }); day++; }
  }
  const st = fakeState({
    players: [player('B', 'T1', 'fielder')],
    transactionLog: teams.map((opp, i) => ({ year: 2020 + i, kind: 'trade', playerId: 'B', playerId2: `X${i}`, from: opp, to: 'T1' })),
    schedule,
    cursor: 0,
    standRows: [
      standRow('T1', 'L1', 50, 45),
      ...teams.map((t) => standRow(t, 'L1', 50, 45)), // 全チーム僅差＝pennantも同時に該当させる
    ],
  });
  const out = specialDaysOf(st, names);
  const rivalryOrPennant = out.filter((d) => d.kind === 'rivalry' || d.kind === 'pennant');
  // 各対戦相手ごとにカード初戦は1日だけ（4カード=最大8件=rivalry1+pennant1が同日に重複しうる想定でも
  // 高々 teams.length*2 件）。schedule.length(12試合)よりずっと少ない集約になっているはず。
  assert.ok(rivalryOrPennant.length <= teams.length * 2, `カード初戦以外にも付いている可能性: ${JSON.stringify(rivalryOrPennant)}`);
  const daysUsed = new Set(rivalryOrPennant.map((d) => d.day));
  const cardFirstDays = new Set([0, 3, 6, 9]); // 3連戦×4カードの初戦day
  for (const d of daysUsed) assert.ok(cardFirstDays.has(d), `カード初戦以外の日(${d})に付いている`);
});

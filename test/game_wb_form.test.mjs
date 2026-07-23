// ============================================================================
// Wave B（thyroxin/specs/gm_analytics_spec.md）: フォーム判定（好調▲/不調▼・src/game/form.mjs）
// のテスト。合成フィクスチャ（rt.standings/rt.stats.stats/rt.playerGameLog を直接構成）で、
// hot/cold/normal/nullの分岐・窓BABIP出来すぎ/出来なさすぎガード・最低サンプルゲート・
// 他球団null・直近N登板の集計境界・決定論を検証する。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { createBattingLine, createPitchingLine, createBaserunningLine, createFieldingLine } from '../src/model/statline.mjs';
import { playerFormOf, teamFormMap } from '../src/game/form.mjs';

const cfg = createConfig();

// --- 合成フィクスチャ ---------------------------------------------------------

/** シーズン打撃ライン（既定は非本塁打安打=単打のみ・窓の近似式と同じ基準に揃えてテストしやすくする）。 */
function batLine(o = {}) {
  const b = createBattingLine();
  b.hr = o.hr ?? 10;
  b.b1 = o.b1 ?? ((o.h ?? 115) - b.hr);
  b.h = b.b1 + b.hr;
  b.bb = o.bb ?? 40; b.hbp = 0; b.so = o.so ?? 90; b.sf = 0; b.ibb = 0;
  b.ab = o.ab ?? 450;
  b.pa = b.ab + b.bb;
  return b;
}
/** シーズン投球ライン。 */
function pitLine(o = {}) {
  const p = createPitchingLine();
  p.outs = o.outs ?? 600; p.so = o.so ?? 150; p.bb = o.bb ?? 50; p.hr = o.hr ?? 15; p.h = o.h ?? 150;
  p.r = o.r ?? 90; p.er = o.er ?? 80;
  p.bf = o.bf ?? (p.outs + p.h + p.bb);
  p.g = o.g ?? 26; p.gs = o.gs ?? 26;
  return p;
}
function statRow(playerId, teamId, o = {}) {
  return {
    playerId, teamId, season: 2030,
    batting: o.batting ?? batLine(),
    pitching: o.pitching ?? pitLine({ outs: 0, bf: 0, h: 0, hr: 0, bb: 0, so: 0, r: 0, er: 0, g: 0, gs: 0 }),
    baserunning: createBaserunningLine(), fielding: createFieldingLine(),
  };
}
function standRow(teamId, league, g) {
  return { teamId, league, g, w: Math.round(g / 2), l: g - Math.round(g / 2), t: 0, rs: Math.round(g * 4.3), ra: Math.round(g * 4.3) };
}
function batBox(pid, o = {}) {
  return { pid, ord: o.ord ?? 1, pos: o.pos ?? 'OF', ab: o.ab ?? 4, h: o.h ?? 1, hr: o.hr ?? 0, rbi: o.rbi ?? 0, bb: o.bb ?? 0, k: o.k ?? 0 };
}
function pitBox(pid, o = {}) {
  return { pid, outs: o.outs ?? 18, np: o.np ?? 0, h: o.h ?? 5, r: o.r ?? 2, bb: o.bb ?? 1, k: o.k ?? 6, hr: o.hr ?? 0 };
}
function gameRec(day, home, away, box) {
  return { day, home, away, box };
}
function boxOf({ bat = [], pit = [] } = {}) {
  return { batters: { home: bat, away: [] }, pitchers: { home: pit, away: [] } };
}

function rtOf({ standRows, statRows, playerGameLog = [] }) {
  return {
    finalDay: 200,
    schedule: [],
    cursor: 0,
    standings: new Map(standRows.map((r) => [r.teamId, r])),
    stats: { stats: new Map(statRows.map((s) => [s.playerId, s])) },
    playerGameLog,
  };
}
function fakeState(o = {}) {
  return {
    cfg, playerTeamId: 'T1',
    league: { players: [], farm: [] },
    ...o,
  };
}
function withPlayers(state, players) {
  return { ...state, league: { ...state.league, players } };
}
const T1 = [standRow('T1', 'L1', 143), standRow('T2', 'L1', 143)];

// ============================================================================
// 野手: hot / cold / normal / null（サンプル不足）
// ============================================================================

test('Wave B 野手: 窓wOBA近似がシーズンwOBAを大きく上回れば hot（BABIP出来すぎでない場合はreasons1本）', () => {
  const rows = [statRow('B1', 'T1', { batting: batLine() })]; // 季: ab450,h115,hr10,bb40 → woba≈.316
  const log = [gameRec(50, 'T1', 'T2', boxOf({ bat: [batBox('B1', { ab: 30, h: 10, hr: 6, bb: 6, k: 8 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'B1', teamId: 'T1', role: 'fielder' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'B1');
  assert.equal(tier, 'hot');
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].kind, 'wobaGap');
  assert.ok(reasons[0].text.includes('wOBA'));
});

test('Wave B 野手: hot判定時に窓BABIPが.400超なら「出来すぎ」ガードのreasonsが追加される', () => {
  const rows = [statRow('B2', 'T1', { batting: batLine() })];
  // ab32,h14,hr3,k5 → bip=32-5-3=24, babip=(14-3)/24=.458 > babipHotGuard(.400)
  const log = [gameRec(50, 'T1', 'T2', boxOf({ bat: [batBox('B2', { ab: 32, h: 14, hr: 3, bb: 8, k: 5 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'B2', teamId: 'T1', role: 'fielder' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'B2');
  assert.equal(tier, 'hot');
  assert.equal(reasons.length, 2);
  assert.equal(reasons[1].kind, 'babipGuard');
  assert.ok(reasons[1].text.includes('出来すぎ'));
});

test('Wave B 野手: 窓wOBA近似がシーズンwOBAを大きく下回れば cold（BABIPが正常域ならreasons1本）', () => {
  const rows = [statRow('B3', 'T1', { batting: batLine() })];
  // ab30,h6,hr0,k10 → bip=20, babip=6/20=.300（正常域）
  const log = [gameRec(50, 'T1', 'T2', boxOf({ bat: [batBox('B3', { ab: 30, h: 6, hr: 0, bb: 3, k: 10 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'B3', teamId: 'T1', role: 'fielder' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'B3');
  assert.equal(tier, 'cold');
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].kind, 'wobaGap');
});

test('Wave B 野手: cold判定時に窓BABIPが低すぎるなら「出来なさすぎ」ガードのreasonsが追加される', () => {
  const rows = [statRow('B4', 'T1', { batting: batLine() })];
  // ab34,h3,hr0,k16 → bip=18, babip=3/18=.167 < babipColdGuard(.230)
  const log = [gameRec(50, 'T1', 'T2', boxOf({ bat: [batBox('B4', { ab: 34, h: 3, hr: 0, bb: 1, k: 16 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'B4', teamId: 'T1', role: 'fielder' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'B4');
  assert.equal(tier, 'cold');
  assert.equal(reasons.length, 2);
  assert.equal(reasons[1].kind, 'babipGuard');
  assert.ok(reasons[1].text.includes('出来なさすぎ') || reasons[1].text.includes('低すぎる'));
});

test('Wave B 野手: 窓wOBAがシーズンwOBAに近ければ normal（reasons空）', () => {
  const rows = [statRow('B5', 'T1', { batting: batLine() })];
  const log = [gameRec(50, 'T1', 'T2', boxOf({ bat: [batBox('B5', { ab: 36, h: 10, hr: 1, bb: 4, k: 8 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'B5', teamId: 'T1', role: 'fielder' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'B5');
  assert.equal(tier, 'normal');
  assert.equal(reasons.length, 0);
});

test('Wave B 野手: 最低サンプルゲート（窓20打席未満）は tier=null', () => {
  const rows = [statRow('B6', 'T1', { batting: batLine() })];
  const log = [gameRec(50, 'T1', 'T2', boxOf({ bat: [batBox('B6', { ab: 10, h: 5, hr: 3, bb: 2, k: 1 })] }))]; // pa=12<20
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'B6', teamId: 'T1', role: 'fielder' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'B6');
  assert.equal(tier, null);
  assert.deepEqual(reasons, []);
});

test('Wave B 野手: 窓集計は直近batWindowGames試合ぶんの複数レコードを合算する（出場が無い試合はスキップ）', () => {
  const rows = [statRow('B7', 'T1', { batting: batLine() })];
  const log = [
    gameRec(40, 'T1', 'T2', boxOf({ bat: [batBox('B7', { ab: 15, h: 5, hr: 3, bb: 3, k: 4 })] })),
    gameRec(41, 'T1', 'T2', boxOf({ bat: [] })), // この試合は出場なし（スキップされる）
    gameRec(42, 'T1', 'T2', boxOf({ bat: [batBox('B7', { ab: 15, h: 5, hr: 3, bb: 3, k: 4 })] })),
  ];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'B7', teamId: 'T1', role: 'fielder' },
  ]);
  // 合算: ab30,h10,hr6,bb6,k8 → 1本目のhotテストと同じ合計値になり hot が検出される
  const { tier } = playerFormOf(st, 'B7');
  assert.equal(tier, 'hot');
});

// ============================================================================
// 投手: hot / cold / normal(矛盾シグナル) / null（サンプル不足）
// ============================================================================

test('Wave B 投手: 窓K-BB%がシーズンK-BB%を大きく上回れば hot', () => {
  const rows = [statRow('P1', 'T1', { pitching: pitLine() })]; // 季: K-BB%=(150-50)/800=12.5%, 目安防御率=90*9/200=4.05
  const log = [gameRec(50, 'T1', 'T2', boxOf({ pit: [pitBox('P1', { outs: 54, k: 60, bb: 5, h: 30, hr: 2, r: 6 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'P1', teamId: 'T1', role: 'pitcher' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'P1');
  assert.equal(tier, 'hot');
  assert.ok(reasons.some((r) => r.kind === 'kbbGap'));
});

test('Wave B 投手: 窓K-BB%・目安防御率がともにシーズンを大きく下回れば cold（reasons2本）', () => {
  const rows = [statRow('P2', 'T1', { pitching: pitLine() })];
  const log = [gameRec(50, 'T1', 'T2', boxOf({ pit: [pitBox('P2', { outs: 54, k: 10, bb: 20, h: 50, hr: 8, r: 30 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'P2', teamId: 'T1', role: 'pitcher' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'P2');
  assert.equal(tier, 'cold');
  assert.equal(reasons.length, 2);
  assert.ok(reasons.some((r) => r.kind === 'kbbGap'));
  assert.ok(reasons.some((r) => r.kind === 'runsGap'));
});

test('Wave B 投手: K-BB%とERAのシグナルが逆方向を指すときは判定を割らず normal（憶測を書かない）', () => {
  const rows = [statRow('P3', 'T1', { pitching: pitLine() })];
  // K-BB%は好調シグナル・目安防御率は不調シグナル（矛盾）
  const log = [gameRec(50, 'T1', 'T2', boxOf({ pit: [pitBox('P3', { outs: 54, k: 40, bb: 5, h: 60, hr: 10, r: 25 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'P3', teamId: 'T1', role: 'pitcher' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'P3');
  assert.equal(tier, 'normal');
  assert.deepEqual(reasons, []);
});

test('Wave B 投手: 最低サンプルゲート（窓6イニング=18アウト未満）は tier=null', () => {
  const rows = [statRow('P4', 'T1', { pitching: pitLine() })];
  const log = [gameRec(50, 'T1', 'T2', boxOf({ pit: [pitBox('P4', { outs: 9, k: 6, bb: 0, h: 1, r: 0 })] }))]; // 3回のみ
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'P4', teamId: 'T1', role: 'pitcher' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'P4');
  assert.equal(tier, null);
  assert.deepEqual(reasons, []);
});

test('Wave B 投手: 直近pitLookbackApps(3)登板だけを集計し、それより古い登板は含めない', () => {
  const rows = [statRow('P5', 'T1', { pitching: pitLine() })];
  const log = [
    // 4試合前（含めてはいけない・含めると極端な不調に化けるはずの登板）
    gameRec(10, 'T1', 'T2', boxOf({ pit: [pitBox('P5', { outs: 18, k: 0, bb: 30, h: 80, hr: 20, r: 60 })] })),
    gameRec(20, 'T1', 'T2', boxOf({ pit: [pitBox('P5', { outs: 18, k: 20, bb: 3, h: 12, hr: 1, r: 2 })] })),
    gameRec(30, 'T1', 'T2', boxOf({ pit: [pitBox('P5', { outs: 18, k: 20, bb: 3, h: 12, hr: 1, r: 2 })] })),
    gameRec(40, 'T1', 'T2', boxOf({ pit: [pitBox('P5', { outs: 18, k: 20, bb: 3, h: 12, hr: 1, r: 2 })] })),
  ];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'P5', teamId: 'T1', role: 'pitcher' },
  ]);
  const { tier } = playerFormOf(st, 'P5');
  // 直近3登板のみなら好投（K-BB%高・失点少）で hot。4登板前の大炎上を含めると normal/cold に化ける想定。
  assert.equal(tier, 'hot');
});

// ============================================================================
// 他球団はtier=null（窓データが無いものは語らない）・league.players不在
// ============================================================================

test('Wave B: 他球団選手はtier=null（playerGameLogは自チーム試合のみのため語れない）', () => {
  const rows = [statRow('OPP1', 'T2', { batting: batLine() })];
  const log = [gameRec(50, 'T1', 'T2', boxOf({ bat: [batBox('OPP1', { ab: 30, h: 10, hr: 6, bb: 6, k: 8 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'OPP1', teamId: 'T2', role: 'fielder' },
  ]);
  const { tier, reasons } = playerFormOf(st, 'OPP1');
  assert.equal(tier, null);
  assert.deepEqual(reasons, []);
});

test('Wave B: rt未生成/playerTeamId未設定は tier=null', () => {
  assert.equal(playerFormOf(fakeState({ rt: null }), 'X').tier, null);
  assert.equal(playerFormOf(fakeState({ rt: {}, playerTeamId: null }), 'X').tier, null);
});

// ============================================================================
// teamFormMap: バルクAPI（自チームぶんだけ・軽量）
// ============================================================================

test('Wave B: teamFormMapは自チーム選手ぶんのtierだけを返す（他球団選手は含まれない）', () => {
  const rows = [
    statRow('B1', 'T1', { batting: batLine() }),
    statRow('P2', 'T1', { pitching: pitLine() }),
    statRow('OPP1', 'T2', { batting: batLine() }),
  ];
  const log = [gameRec(50, 'T1', 'T2', boxOf({
    bat: [batBox('B1', { ab: 30, h: 10, hr: 6, bb: 6, k: 8 }), batBox('OPP1', { ab: 30, h: 10, hr: 6, bb: 6, k: 8 })],
    pit: [pitBox('P2', { outs: 54, k: 10, bb: 20, h: 50, hr: 8, r: 30 })],
  }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'B1', teamId: 'T1', role: 'fielder' },
    { id: 'P2', teamId: 'T1', role: 'pitcher' },
    { id: 'OPP1', teamId: 'T2', role: 'fielder' },
  ]);
  const map = teamFormMap(st);
  assert.equal(map.get('B1'), 'hot');
  assert.equal(map.get('P2'), 'cold');
  assert.equal(map.has('OPP1'), false);
});

test('Wave B: rt未生成のteamFormMapは空Map', () => {
  const map = teamFormMap(fakeState({ rt: null }));
  assert.equal(map.size, 0);
});

// ============================================================================
// 決定論
// ============================================================================

test('Wave B: 決定論 — 同一input同一output・stateを変更しない', () => {
  const rows = [statRow('B1', 'T1', { batting: batLine() })];
  const log = [gameRec(50, 'T1', 'T2', boxOf({ bat: [batBox('B1', { ab: 30, h: 10, hr: 6, bb: 6, k: 8 })] }))];
  const st = withPlayers(fakeState({ rt: rtOf({ standRows: T1, statRows: rows, playerGameLog: log }) }), [
    { id: 'B1', teamId: 'T1', role: 'fielder' },
  ]);
  const before = JSON.stringify([...st.rt.stats.stats.values()]);
  const a = JSON.stringify(playerFormOf(st, 'B1'));
  const b = JSON.stringify(playerFormOf(st, 'B1'));
  assert.equal(a, b, '同一input同一output');
  const after = JSON.stringify([...st.rt.stats.stats.values()]);
  assert.equal(after, before, 'stateを変更しない');
});

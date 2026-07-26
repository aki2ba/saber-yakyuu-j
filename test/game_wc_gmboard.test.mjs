// ============================================================================
// Wave C（thyroxin/specs/gm_analytics_spec.md）: GMボード（src/game/gmBoard.mjs）のテスト。
// 合成フィクスチャ（rt.stats/rt.standings/rt.farm/league.players/league.teams を直接構成）で、
// 弱点(下位20%)/真のサプラス(saturated)/起用のねじれ(misallocated)判定の分岐・多重カウント排除・
// 救援の役割別分母・prospectWatchの「塞がれ」判定・ownDepthSolutions（自軍の格上げ候補）・
// トレード相手マッチングの妥当性・決定論を検証する。
//
// ★2026-07-24 監査修正に伴う全面改訂: satMinPctl 0.6→0.8・misallocated分離・多重カウント排除・
//   救援役割別分母・ownDepthSolutions新設に追随（旧テストのうち新仕様と矛盾するものは意味を
//   入れ替えて残置＝「逆転」フィクスチャは今は misallocated を検証する）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { FIELD_POSITIONS } from '../src/model/positions.mjs';
import { createBattingLine, createPitchingLine, createBaserunningLine, createFieldingLine } from '../src/model/statline.mjs';
import { positionStrengthMap, prospectWatch, tradeTargetSuggestions, ownDepthSolutions, GB_POSITIONS, gbTeamDisplayOrder } from '../src/game/gmBoard.mjs';

const cfg = createConfig();
const gb = cfg.tuning.storylines.gmBoard;

// --- 合成フィクスチャ ---------------------------------------------------------

/** 指数iが大きいほど明確に高い観測wOBAになる打撃ライン（非本塁打安打=単打のみの簡略化）。
 *  カウントはすべて ab に比例させる（率固定・h<=ab等の内的整合性を保つ）。
 *  ab=第2引数（実PA=ab+bbになる点に注意・bbもiに連動する率でabに比例）。 */
function batLineIdx(i, ab = 400) {
  const b = createBattingLine();
  b.ab = ab;
  const hrRate = 0.010 + i * 0.008;
  const hitRate = 0.230 + i * 0.020; // 本塁打込みの総安打率
  const bbRate = 0.050 + i * 0.010;
  b.hr = Math.round(ab * hrRate);
  const totalHits = Math.round(ab * hitRate);
  b.b1 = Math.max(0, totalHits - b.hr);
  b.h = b.b1 + b.hr;
  b.bb = Math.round(ab * bbRate);
  b.so = Math.round(ab * 0.2);
  b.pa = b.ab + b.bb;
  return b;
}
/** 指数iが大きいほど明確に良い(=FIP低い/K-BB%高い)投球ライン。救援=gs:0・先発=gs:g。
 *  g は監査修正c（救援の役割別分母）のテスト用に上書き可能（既定26＝旧来のテストと同値）。 */
function pitLineIdx(i, { outs = 400, starter = false, g = 26 } = {}) {
  const p = createPitchingLine();
  p.outs = outs;
  p.so = 100 + i * 20;
  p.bb = 60 - i * 4;
  p.hr = 15;
  p.h = 150;
  p.r = 80 - i * 3;
  p.er = p.r - 5;
  p.bf = p.outs + p.h + p.bb;
  p.g = g;
  p.gs = starter ? g : 0;
  return p;
}
function statRow(playerId, teamId, o = {}) {
  const fielding = createFieldingLine();
  if (o.pos && o.posOuts) fielding.positionOuts[o.pos] = o.posOuts;
  return {
    playerId, teamId, season: 2030,
    batting: o.batting ?? createBattingLine(),
    pitching: o.pitching ?? createPitchingLine(),
    fielding, baserunning: createBaserunningLine(),
  };
}
function standRow(teamId, g = 143) {
  return { teamId, league: 'L1', g, w: 70, l: 70, t: 0, rs: 600, ra: 600 };
}

/** N球団の3塁手フィクスチャ（各球団のレギュラーが指数0..N-1で単調に強くなる。T1がindex mineIdx）。
 *  オプションで T1 に控え(BK1)を追加できる（saturated/misallocated判定用・backupIdxで控えの指数を
 *  個別指定できる。未指定時は既定 mineIdx+5＝レギュラーを明確に上回る「逆転」型）。 */
function build3bFixture({ n = 8, mineIdx = 5, g = 143, backupPa = null, backupIdx = null } = {}) {
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  let nextIdx = 0;
  for (let k = 0; k < n; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, g));
    const idx = tid === 'T1' ? mineIdx : (nextIdx === mineIdx ? ++nextIdx : nextIdx++);
    const pid = `P_${tid}`;
    players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: `選手${tid}`, primaryPos: '3B' });
    seasons.push(statRow(pid, tid, { batting: batLineIdx(idx), pos: '3B', posOuts: 400 }));
  }
  if (backupPa != null) {
    const bIdx = backupIdx != null ? backupIdx : mineIdx + 5;
    players.push({ id: 'BK1', teamId: 'T1', role: 'fielder', age: 24, name: '控え1', primaryPos: '3B' });
    seasons.push(statRow('BK1', 'T1', { batting: batLineIdx(bIdx, backupPa), pos: '3B', posOuts: 200 }));
  }
  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };
  return { cfg, masterSeed: 777, playerTeamId: 'T1', rt, league: { teams, players, farm: [] } };
}

// ============================================================================
// positionStrengthMap: 弱点(下位20%)
// ============================================================================

test('Wave C positionStrengthMap: 母集団の最下位（百分位0）は弱点フラグが立つ', () => {
  const state = build3bFixture({ n: 8, mineIdx: 5 });
  // T8 だけ意図的に最下位にする: mineIdx=5 の割当ロジックで T2 が index0 になる
  const { cells } = positionStrengthMap(state);
  const t2 = cells.find((c) => c.teamId === 'T2' && c.pos === '3B');
  assert.equal(t2.pctl, 0);
  assert.equal(t2.weak, true);
});

test('Wave C positionStrengthMap: 上位の球団は弱点フラグが立たない', () => {
  const state = build3bFixture({ n: 8, mineIdx: 5 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(mine.weak, false);
});

// ============================================================================
// positionStrengthMap: 真のサプラス(saturated) vs 起用のねじれ(misallocated)
//   ★2026-07-24 監査修正a/c/d: 「控え百分位＞レギュラー百分位+margin」の逆転は misallocated へ分離
// ============================================================================

test('Wave C positionStrengthMap: 控えがレギュラーを大きく上回る（逆転）場合は misallocated（起用のねじれ）で saturated ではない', () => {
  // 監査が指摘した「飽和の79%が逆転由来」の典型パターンを再現: 下位寄りレギュラー(idx2)に対し
  // 控えが最上位級(idx11)＝控えの方が明らかに強い＝真の余剰ではなく起用のねじれ。
  const state = build3bFixture({ n: 12, mineIdx: 2, backupPa: 250, backupIdx: 11 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(mine.saturated, false, '逆転はトレード材料にできる真の余剰ではない');
  assert.equal(mine.backupId, null);
  assert.equal(mine.misallocated, true);
  assert.equal(mine.misallocBackupId, 'BK1');
  assert.ok(mine.misallocBackupPctl >= gb.satMinPctl);
});

test('Wave C positionStrengthMap: レギュラーが上位で控えも僅差で強い（真の余剰）は saturated', () => {
  // レギュラー・控えとも最上位級(idx11)＝控えがレギュラーを大きく上回らない素直な余剰。
  const state = build3bFixture({ n: 12, mineIdx: 11, backupPa: 250, backupIdx: 11 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(mine.saturated, true);
  assert.equal(mine.backupId, 'BK1');
  assert.ok(mine.backupPctl >= gb.satMinPctl);
  assert.equal(mine.misallocated, false);
});

test('Wave C positionStrengthMap: 控えの打席が規定30%未満なら飽和にもねじれにもならない', () => {
  // backupPa(ab)=10 → 実PA=10+bb=90。規定打席443の30%=133を明確に下回る。
  const state = build3bFixture({ n: 8, mineIdx: 5, backupPa: 10 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(mine.saturated, false);
  assert.equal(mine.backupId, null);
  assert.equal(mine.misallocated, false);
});

test('Wave C positionStrengthMap: 控えがいなければ飽和にもねじれにもならない（レギュラーのみ）', () => {
  const state = build3bFixture({ n: 8, mineIdx: 5 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(mine.saturated, false);
  assert.equal(mine.misallocated, false);
});

// ============================================================================
// positionStrengthMap: 多重カウント排除（監査修正b）
// ============================================================================

/** T1の3塁手レギュラー(idx6)に加え、T1にユーティリティ(UTIL)を配置する:
 *  UTILはSSのレギュラー(最多出場・打撃idx11＝トップ級)だが、3Bにも一定出場(playTime閾値超)がある。
 *  多重カウント排除が効いていれば、UTILは「他ポジ(SS)のregular」として3Bの控え候補から除外される。 */
function buildMultiCountFixture({ n = 12, threeBidx = 6 } = {}) {
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  let nextIdx = 0;
  for (let k = 0; k < n; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, 143));
    const idx = tid === 'T1' ? threeBidx : (nextIdx === threeBidx ? ++nextIdx : nextIdx++);
    const pid = `P3B_${tid}`;
    players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: `三塁${tid}`, primaryPos: '3B' });
    seasons.push(statRow(pid, tid, { batting: batLineIdx(idx), pos: '3B', posOuts: 400 }));
    if (tid !== 'T1') {
      const sid = `PSS_${tid}`;
      players.push({ id: sid, teamId: tid, role: 'fielder', age: 30, name: `遊撃${tid}`, primaryPos: 'SS' });
      seasons.push(statRow(sid, tid, { batting: batLineIdx(4), pos: 'SS', posOuts: 400 }));
    }
  }
  players.push({ id: 'UTIL', teamId: 'T1', role: 'fielder', age: 26, name: 'ユーティリティ', primaryPos: 'SS' });
  const utilFielding = createFieldingLine();
  utilFielding.positionOuts.SS = 400; // SSが最多出場（bestPos＝SS）
  utilFielding.positionOuts['3B'] = 200; // 3Bにも一定出場（飽和frac閾値は超える量）
  seasons.push({
    playerId: 'UTIL', teamId: 'T1', season: 2030,
    batting: batLineIdx(11, 300), pitching: createPitchingLine(), fielding: utilFielding, baserunning: createBaserunningLine(),
  });
  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };
  return { cfg, masterSeed: 55, playerTeamId: 'T1', rt, league: { teams, players, farm: [] } };
}

test('Wave C positionStrengthMap: 他ポジションでregularの選手は控え候補から除外される（監査b・多重カウント排除）', () => {
  const state = buildMultiCountFixture({ threeBidx: 6 });
  const { cells } = positionStrengthMap(state);
  const t1ss = cells.find((c) => c.teamId === 'T1' && c.pos === 'SS');
  assert.equal(t1ss.regularId, 'UTIL', '前提: UTILがSSのregularになっている');
  const t1_3b = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(t1_3b.saturated, false, 'UTILはSSのregularなので3Bの控え候補から除外される');
  assert.equal(t1_3b.misallocated, false);
  assert.notEqual(t1_3b.backupId, 'UTIL');
  assert.notEqual(t1_3b.misallocBackupId, 'UTIL');
});

test('Wave C positionStrengthMap: 控え候補は最多出場の1ポジションのみで数える（監査b・多重カウント排除）', () => {
  // 真のサプラス(saturated)フィクスチャを作った後、BK1のbestPosを2Bへ強制的にずらす
  // （2Bの出場を3Bより多くする）→3Bの控え候補から外れるはず。
  const state = build3bFixture({ n: 12, mineIdx: 11, backupPa: 250, backupIdx: 11 });
  const bk = state.rt.stats.stats.get('BK1');
  bk.fielding.positionOuts['2B'] = 500; // 3B(200)より多い→mainPosition(bestPos)が2Bになる
  const { cells } = positionStrengthMap(state);
  const t1 = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(t1.saturated, false, 'BK1のbestPosが2Bに変わったため3Bの控え候補から除外される');
  assert.equal(t1.backupId, null);
});

// ============================================================================
// positionStrengthMap: 母集団最低数・シーズン消化率ガード
// ============================================================================

test('Wave C positionStrengthMap: 母集団が最低数(minPositionPopulation)未満なら弱点/飽和とも出さない', () => {
  const state = build3bFixture({ n: 3, mineIdx: 1, backupPa: 250 });
  const { cells } = positionStrengthMap(state);
  const rows = cells.filter((c) => c.pos === '3B');
  for (const c of rows) {
    assert.equal(c.pctl, null);
    assert.equal(c.weak, false);
    assert.equal(c.saturated, false);
    assert.equal(c.misallocated, false);
  }
});

test('Wave C positionStrengthMap: シーズン消化率が閾値(minSeasonProgress)未満なら弱点/飽和とも出さない', () => {
  // gamesPerSeason=143・minSeasonProgress=0.2 → g<28.6 でガード
  const state = build3bFixture({ n: 8, mineIdx: 5, g: 10, backupPa: 250 });
  const { cells } = positionStrengthMap(state);
  const rows = cells.filter((c) => c.pos === '3B');
  for (const c of rows) {
    assert.equal(c.weak, false);
    assert.equal(c.saturated, false);
    assert.equal(c.misallocated, false);
  }
});

// ============================================================================
// positionStrengthMap: 投手2枠（先発=K-BB%平均/救援=FIP平均・FIPは低いほど良い方向で百分位化）
// ============================================================================

function buildRpFixture(n = 8) {
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  for (let k = 0; k < n; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, 143));
    const pid = `RP_${tid}`;
    players.push({ id: pid, teamId: tid, role: 'pitcher', age: 30, name: `救援${tid}`, primaryPos: 'P' });
    // pitLineIdx(i) は i が大きいほど良い内容（K多い/BB少ない/失点少ない）→ FIPが低くなる。
    // k=0(T1) が最も悪いFIP（高い）・k=n-1(T8) が最も良いFIP（低い）になる。
    seasons.push(statRow(pid, tid, { pitching: pitLineIdx(k, { outs: 400, starter: false }) }));
  }
  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };
  return { cfg, masterSeed: 42, playerTeamId: 'T1', rt, league: { teams, players, farm: [] } };
}

test('Wave C positionStrengthMap: 救援(RP)はFIPが低いほど良い方向で百分位化される（高FIPの球団が弱点）', () => {
  const state = buildRpFixture(8);
  const { cells } = positionStrengthMap(state);
  const t1 = cells.find((c) => c.teamId === 'T1' && c.pos === 'RP'); // 最も高いFIP(悪い)
  const t8 = cells.find((c) => c.teamId === 'T8' && c.pos === 'RP'); // 最も低いFIP(良い)
  assert.ok(t1.value > t8.value, 'T1のFIPはT8より高い（悪い）はず');
  assert.equal(t1.pctl, 0);
  assert.equal(t1.weak, true);
  assert.equal(t8.pctl, 1);
  assert.equal(t8.weak, false);
});

// ============================================================================
// prospectWatch: 「塞がれている」有望若手
// ============================================================================

/** N球団の1塁手ベースライン（全員フルタイム出場・中位wOBA）を作り、他球団に薄い出場機会の
 *  若手(YOUNG1)を1人追加する共通フィクスチャ。youngPa=nullでYOUNG1追加を省略できる。 */
function buildProspectFixture({ youngTeam = 'T2', youngAge = 22, youngPa = 60, youngIdx = 12, farm = null } = {}) {
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  for (let k = 0; k < 8; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, 143));
    const pid = `P_${tid}`;
    players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: `選手${tid}`, primaryPos: '1B' });
    seasons.push(statRow(pid, tid, { batting: batLineIdx(3, 400), pos: '1B', posOuts: 400 }));
  }
  if (youngPa != null) {
    players.push({ id: 'YOUNG1', teamId: youngTeam, role: 'fielder', age: youngAge, name: '若手1', primaryPos: '1B' });
    seasons.push(statRow('YOUNG1', youngTeam, { batting: batLineIdx(youngIdx, youngPa), pos: '1B', posOuts: youngPa > 0 ? 30 : 0 }));
  }
  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };
  if (farm) rt.farm = farm;
  return { cfg, masterSeed: 123, playerTeamId: 'T1', rt, league: { teams, players, farm: [] } };
}

test('Wave C prospectWatch: 一軍出場が薄い（規定の50%未満）高百分位の若手を「塞がれた有望株」として検出', () => {
  const state = buildProspectFixture({ youngTeam: 'T2', youngAge: 22, youngPa: 60, youngIdx: 12 });
  const list = prospectWatch(state);
  assert.equal(list.length, 1);
  assert.equal(list[0].playerId, 'YOUNG1');
  assert.equal(list[0].source, 'majorThin');
  assert.ok(list[0].pctl >= gb.prospectMinPctl);
  assert.ok(list[0].text.includes('塞がれた有望株'));
});

test('Wave C prospectWatch: 出場機会が十分（規定の50%以上）なら対象外', () => {
  // 規定打席=round(143*3.1)=443・50%=221.5 → PA=350(ab)+bb で十分な出場
  const state = buildProspectFixture({ youngTeam: 'T2', youngAge: 22, youngPa: 350, youngIdx: 12 });
  const list = prospectWatch(state);
  assert.equal(list.find((x) => x.playerId === 'YOUNG1'), undefined);
});

test('Wave C prospectWatch: 26歳以上は対象外（年齢上限プロスペクトMaxAge=25）', () => {
  const state = buildProspectFixture({ youngTeam: 'T2', youngAge: 26, youngPa: 60, youngIdx: 12 });
  const list = prospectWatch(state);
  assert.equal(list.find((x) => x.playerId === 'YOUNG1'), undefined);
});

test('Wave C prospectWatch: 自チームの選手は対象外', () => {
  const state = buildProspectFixture({ youngTeam: 'T1', youngAge: 22, youngPa: 60, youngIdx: 12 });
  const list = prospectWatch(state);
  assert.equal(list.find((x) => x.playerId === 'YOUNG1'), undefined);
});

test('Wave C prospectWatch: 百分位が閾値未満（有望とは言えない）なら対象外', () => {
  // youngIdx=3 はベースライン(idx3)と同水準＝百分位は高くない
  const state = buildProspectFixture({ youngTeam: 'T2', youngAge: 22, youngPa: 60, youngIdx: 3 });
  const list = prospectWatch(state);
  assert.equal(list.find((x) => x.playerId === 'YOUNG1'), undefined);
});

test('Wave C prospectWatch: 二軍在籍の高百分位若手は source=farm で検出される（出場機会なし＝自動的に塞がれ扱い）', () => {
  const farmSeasons = [];
  const farmStand = [];
  for (let k = 0; k < 8; k++) {
    const tid = `T${k + 1}`;
    farmStand.push(standRow(tid, 90));
    farmSeasons.push(statRow(`F_${tid}`, tid, { batting: batLineIdx(3, 250) }));
  }
  farmSeasons.push(statRow('YOUNG2', 'T3', { batting: batLineIdx(12, 100) }));
  const farm = {
    stats: { stats: new Map(farmSeasons.map((s) => [s.playerId, s])) },
    standings: new Map(farmStand.map((r) => [r.teamId, r])),
  };
  const state = buildProspectFixture({ youngTeam: 'T2', youngPa: null, farm });
  state.league.players.push({ id: 'YOUNG2', teamId: 'T3', role: 'fielder', age: 21, name: '若手2', primaryPos: '1B' });
  const list = prospectWatch(state);
  assert.equal(list.length, 1);
  assert.equal(list[0].playerId, 'YOUNG2');
  assert.equal(list[0].source, 'farm');
  assert.ok(list[0].text.includes('二軍'));
});

// ============================================================================
// prospectWatch: 救援の役割別分母（監査修正c）
// ============================================================================

/** 8球団の先発ベースライン（population用・idx3・低品質＝若手のK-BB%が明確に上回る）＋
 *  他球団(T2)に指定の投球ラインを持つ若手救援(YOUNGP)を1人追加する。 */
function buildPitcherProspectFixture({ youngTeam = 'T2', youngAge = 24, youngLine, teamGames = 130 } = {}) {
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  for (let k = 0; k < 8; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, teamGames));
    const pid = `SP_${tid}`;
    players.push({ id: pid, teamId: tid, role: 'pitcher', age: 30, name: `投手${tid}`, primaryPos: 'P' });
    seasons.push(statRow(pid, tid, { pitching: pitLineIdx(3, { outs: 500, starter: true, g: teamGames > 26 ? 26 : teamGames }) }));
  }
  players.push({ id: 'YOUNGP', teamId: youngTeam, role: 'pitcher', age: youngAge, name: '若手投手', primaryPos: 'P' });
  seasons.push(statRow('YOUNGP', youngTeam, { pitching: youngLine }));
  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };
  return { cfg, masterSeed: 321, playerTeamId: 'T1', rt, league: { teams, players, farm: [] } };
}

test('Wave C prospectWatch: 救援は役割別分母を使う（監査c）— g=20/IP40の救援を「塞がれ」扱いしない', () => {
  // 旧分母(qualifiedIP=試合数×1=130)だとfrac=40/130=31%で「塞がれ」誤判定になっていたケース。
  // 新分母(試合数×relieverIpGamesFrac=130×0.45=58.5)だとfrac=40/58.5=68%＝十分な出場機会。
  const youngLine = pitLineIdx(9, { outs: 120, starter: false, g: 20 }); // IP=40・g=20(<relieverEstablishedG)
  const state = buildPitcherProspectFixture({ youngTeam: 'T2', youngAge: 24, youngLine, teamGames: 130 });
  const list = prospectWatch(state);
  assert.equal(list.find((x) => x.playerId === 'YOUNGP'), undefined);
});

test('Wave C prospectWatch: 救援でも新分母基準で本当に出場機会が薄いものは検出され、テンプレ文言は「規定のX%」を使わない', () => {
  const youngLine = pitLineIdx(9, { outs: 51, starter: false, g: 10 }); // IP=17（prospectMinIP=15超）・g=10（新分母でも明確に薄い）
  const state = buildPitcherProspectFixture({ youngTeam: 'T2', youngAge: 24, youngLine, teamGames: 130 });
  const list = prospectWatch(state);
  const hit = list.find((x) => x.playerId === 'YOUNGP');
  assert.ok(hit, 'IP17/58.5=29%は明確に薄い＝検出されるはず');
  assert.equal(hit.source, 'majorThin');
  assert.ok(!hit.text.includes('規定の'), '救援のテンプレ文言は先発基準の「規定のX%」を使わない');
  assert.ok(hit.text.includes('試合'), '救援は登板数/チーム試合数の自然な表現を使う');
});

test('Wave C prospectWatch: 登板数25以上の救援は「塞がれ」対象外（監査c・既に役割を得ている）', () => {
  // IP比率だけ見れば薄い(IP10)が、g=26(≥relieverEstablishedG)は既に相応の役割を得ているとみなす。
  const youngLine = pitLineIdx(9, { outs: 30, starter: false, g: 26 });
  const state = buildPitcherProspectFixture({ youngTeam: 'T2', youngAge: 24, youngLine, teamGames: 130 });
  const list = prospectWatch(state);
  assert.equal(list.find((x) => x.playerId === 'YOUNGP'), undefined);
});

// ============================================================================
// prospectWatch: 上限件数超過時の truncated フラグ（小修正5）
// ============================================================================

function buildManyProspectsFixture(count) {
  const state = buildProspectFixture({ youngPa: null });
  // 母集団を厚くする低評価フィラー（百分位計算で「若手集団」が下位に沈まないための土台。
  // population中の「若手idx12」ブロックの最下位でもpctl>=0.6を満たすよう十分な数を積む）。
  const fillerCount = Math.max(40, count * 2);
  for (let i = 0; i < fillerCount; i++) {
    const tid = `T${(i % 7) + 2}`;
    const pid = `FILLER_${i}`;
    state.league.players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: `控え${i}`, primaryPos: '1B' });
    state.rt.stats.stats.set(pid, statRow(pid, tid, { batting: batLineIdx(3, 60) }));
  }
  for (let i = 0; i < count; i++) {
    const tid = `T${(i % 7) + 2}`; // T2..T8を巡回（自チームT1は除外される仕様のため使わない）
    const pid = `MANY_${i}`;
    state.league.players.push({ id: pid, teamId: tid, role: 'fielder', age: 22, name: `量産${i}`, primaryPos: '1B' });
    state.rt.stats.stats.set(pid, statRow(pid, tid, { batting: batLineIdx(12, 60), pos: '1B', posOuts: 30 }));
  }
  return state;
}

test('Wave C prospectWatch: 上限(prospectMaxItems)超過時は truncated=true を返す（小修正5）', () => {
  const state = buildManyProspectsFixture(25);
  const list = prospectWatch(state);
  assert.equal(list.length, gb.prospectMaxItems);
  assert.equal(list.truncated, true);
});

test('Wave C prospectWatch: 上限未満なら truncated=false', () => {
  const state = buildProspectFixture({ youngTeam: 'T2', youngAge: 22, youngPa: 60, youngIdx: 12 });
  const list = prospectWatch(state);
  assert.equal(list.truncated, false);
});

// ============================================================================
// ownDepthSolutions: 自軍限定「格上げ候補」（監査修正・新設）
// ============================================================================

/** 自軍(T1)の弱点位置(2B/SS/LF)×自軍控え/二軍のマッチングを検証するフィクスチャ。
 *  - T1: 2B/SS/LFが弱点(idx0)・3B(REG3B_UTIL)/CFはsolidなregular(idx5)。
 *  - 他球団(T2..T8): 各位置とも idx4 の中位regularのみ（母集団のベースライン）。
 *  - T1の一軍控え: BENCH_UTIL（bestPos=2B・出場量はregularより少ない・打撃idx12＝トップ級）
 *      → SS/2Bへの内野中枢隣接マッチ候補。
 *    REG3B_UTIL（3Bのregular本人・SSにも薄く出場）→「他ポジのregular」として除外される対照群。
 *  - T1の二軍: F2B（2B観測・29歳＝年齢上限なしの実例）・FCF（CF観測・LFへの外野隣接マッチ候補）。 */
function buildOwnDepthFixture() {
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  const positions = ['2B', 'SS', 'LF', 'CF'];
  for (let k = 0; k < 8; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, 143));
  }
  for (const pos of positions) {
    for (let k = 0; k < 8; k++) {
      const tid = `T${k + 1}`;
      const idx = tid === 'T1' ? (pos === 'CF' ? 5 : 0) : 4;
      const pid = `P_${tid}_${pos}`;
      players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: pid, primaryPos: pos });
      seasons.push(statRow(pid, tid, { batting: batLineIdx(idx, 400), pos, posOuts: 400 }));
    }
  }
  // T1の一軍控え: BENCH_UTIL（bestPos=2B・regularより出場少ない・高打撃）
  players.push({ id: 'BENCH_UTIL', teamId: 'T1', role: 'fielder', age: 26, name: 'ユーティリティ控え', primaryPos: '2B' });
  seasons.push(statRow('BENCH_UTIL', 'T1', { batting: batLineIdx(12, 250), pos: '2B', posOuts: 150 }));
  // T1: REG3B_UTIL＝3Bのregular本人（SSにも薄く出場するが「他ポジのregular」として除外される対照群）
  const reg3bFielding = createFieldingLine();
  reg3bFielding['positionOuts']['3B'] = 400;
  reg3bFielding.positionOuts.SS = 50;
  players.push({ id: 'REG3B_UTIL', teamId: 'T1', role: 'fielder', age: 29, name: '三塁控え兼任', primaryPos: '3B' });
  seasons.push({
    playerId: 'REG3B_UTIL', teamId: 'T1', season: 2030,
    batting: batLineIdx(12, 250), pitching: createPitchingLine(), fielding: reg3bFielding, baserunning: createBaserunningLine(),
  });

  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };

  // 二軍: フィラー8人(idx3・T1以外に配置) + F2B(2B観測・29歳) + FCF(CF観測)
  const farmSeasons = [];
  const farmStand = [];
  for (let k = 0; k < 8; k++) {
    const tid = `T${k + 1}`;
    farmStand.push(standRow(tid, 90));
    farmSeasons.push(statRow(`FILL_${tid}`, tid, { batting: batLineIdx(3, 250) }));
  }
  farmSeasons.push(statRow('F2B', 'T1', { batting: batLineIdx(12, 200), pos: '2B', posOuts: 100 }));
  farmSeasons.push(statRow('FCF', 'T1', { batting: batLineIdx(12, 200), pos: 'CF', posOuts: 100 }));
  rt.farm = {
    stats: { stats: new Map(farmSeasons.map((s) => [s.playerId, s])) },
    standings: new Map(farmStand.map((r) => [r.teamId, r])),
  };

  const farmPlayers = [
    { id: 'F2B', teamId: 'T1', role: 'fielder', age: 29, name: '二軍二塁手', primaryPos: '2B' },
    { id: 'FCF', teamId: 'T1', role: 'fielder', age: 22, name: '二軍中堅手', primaryPos: 'CF' },
  ];

  return { cfg, masterSeed: 999, playerTeamId: 'T1', rt, league: { teams, players, farm: farmPlayers } };
}

test('Wave C ownDepthSolutions: 自軍二軍の同位置一致・年齢上限なし（監査実例=二軍2B(29歳)×一軍弱点2B）', () => {
  const state = buildOwnDepthFixture();
  const list = ownDepthSolutions(state);
  const hit = list.find((x) => x.playerId === 'F2B');
  assert.ok(hit, '二軍2B(29歳)が一軍弱点2Bの格上げ候補として検出される');
  assert.equal(hit.weakPos, '2B');
  assert.equal(hit.source, 'farm');
  assert.equal(hit.age, 29, '年齢上限なし（29歳でも検出される）');
  assert.ok(hit.text.includes('二軍'), '二軍水準の観測である留保を文言に含む');
});

test('Wave C ownDepthSolutions: 外野相互隣接（監査実例=二軍CF×一軍弱点LF）', () => {
  const state = buildOwnDepthFixture();
  const list = ownDepthSolutions(state);
  const hit = list.find((x) => x.playerId === 'FCF');
  assert.ok(hit, '二軍CFが一軍弱点LFの格上げ候補として（外野相互隣接で）検出される');
  assert.equal(hit.weakPos, 'LF');
  assert.equal(hit.pos, 'CF');
  assert.ok(hit.text.includes('二軍'));
});

test('Wave C ownDepthSolutions: 一軍控えの内野中枢隣接（2B控え→弱点2B/SSの格上げ候補）', () => {
  const state = buildOwnDepthFixture();
  const list = ownDepthSolutions(state);
  const hit = list.find((x) => x.playerId === 'BENCH_UTIL');
  assert.ok(hit, '2B控え(bestPos=2B)が内野中枢隣接のマッチで検出される');
  assert.equal(hit.source, 'major');
});

test('Wave C ownDepthSolutions: 他ポジションのregularは控え候補から除外される（多重カウント排除と同じ考え方）', () => {
  const state = buildOwnDepthFixture();
  const list = ownDepthSolutions(state);
  assert.equal(list.find((x) => x.playerId === 'REG3B_UTIL'), undefined,
    'REG3B_UTILは3Bのregular本人＝SSへの候補化から除外されるはず');
});

test('Wave C ownDepthSolutions: 自チーム未設定なら空配列', () => {
  const state = buildOwnDepthFixture();
  state.playerTeamId = null;
  assert.deepEqual(ownDepthSolutions(state), []);
});

test('Wave C ownDepthSolutions: 弱点位置が無ければ空配列', () => {
  const state = build3bFixture({ n: 8, mineIdx: 5 }); // 3B以外のFIELD_POSITIONSは母集団不足で弱点判定されない
  assert.deepEqual(ownDepthSolutions(state), []);
});

// ============================================================================
// ownDepthSolutions: DH特例（2026-07-25 監査f）— 弱点がDHのとき隣接縛りを外し、守備出場が無くても
//   打撃百分位だけで候補化する。
// ============================================================================

/** T1のDHが弱点(idx0・他7球団はidx4)。T1には (a) 1Bのregular(REG1B・高打撃だが他ポジregularなので
 *  DH特例でも除外される対照群) と (b) 守備出場ゼロの代打専任(PINCH1・高打撃)を配置する。 */
function buildDhOwnDepthFixture() {
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  for (let k = 0; k < 8; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, 143));
    const idx = tid === 'T1' ? 0 : 4;
    const pid = `DHREG_${tid}`;
    players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: pid, primaryPos: 'DH' });
    seasons.push(statRow(pid, tid, { batting: batLineIdx(idx, 400), pos: 'DH', posOuts: 400 }));
  }
  players.push({ id: 'REG1B', teamId: 'T1', role: 'fielder', age: 28, name: '一塁手', primaryPos: '1B' });
  seasons.push(statRow('REG1B', 'T1', { batting: batLineIdx(12, 400), pos: '1B', posOuts: 400 }));
  const pinchFielding = createFieldingLine(); // 全ポジション0出場（代打専任）
  players.push({ id: 'PINCH1', teamId: 'T1', role: 'fielder', age: 27, name: '代打1', primaryPos: 'RF' });
  seasons.push({
    playerId: 'PINCH1', teamId: 'T1', season: 2030,
    batting: batLineIdx(12, 200), pitching: createPitchingLine(), fielding: pinchFielding, baserunning: createBaserunningLine(),
  });
  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };
  return { cfg, masterSeed: 4242, playerTeamId: 'T1', rt, league: { teams, players, farm: [] } };
}

test('Wave C ownDepthSolutions: DHが弱点のとき、守備出場ゼロでも打撃百分位が高ければ候補になる（監査f・DH特例）', () => {
  const state = buildDhOwnDepthFixture();
  const list = ownDepthSolutions(state);
  const hit = list.find((x) => x.playerId === 'PINCH1');
  assert.ok(hit, '代打専任(守備出場ゼロ)でもDH特例では隣接縛り無しで候補になるはず');
  assert.equal(hit.weakPos, 'DH');
  assert.equal(hit.source, 'major');
});

test('Wave C ownDepthSolutions: DHが弱点でも他ポジのregularはDH特例でも除外される（多重カウント排除は維持）', () => {
  const state = buildDhOwnDepthFixture();
  const list = ownDepthSolutions(state);
  assert.equal(list.find((x) => x.playerId === 'REG1B'), undefined,
    'REG1Bは1Bのregular本人＝守備不問のDH特例でも自ポジを空けられないので除外されるはず');
});

// ============================================================================
// tradeTargetSuggestions: 自球団の飽和位置×他球団の弱点位置のマッチング
// ============================================================================

test('Wave C tradeTargetSuggestions: 自球団の真の余剰(saturated)位置と他球団の弱点位置が一致すればサジェストされる', () => {
  const state = build3bFixture({ n: 12, mineIdx: 11, backupPa: 250, backupIdx: 11 }); // T1=saturated(3B)・T2=最弱(3B)
  const list = tradeTargetSuggestions(state);
  assert.ok(list.length >= 1);
  const hit = list.find((x) => x.oppTeamId === 'T2');
  assert.ok(hit, 'T2への3B窓サジェストが含まれるはず');
  assert.equal(hit.myPos, '3B');
  assert.equal(hit.oppPos, '3B');
  assert.equal(hit.myBackupId, 'BK1');
  assert.ok(hit.text.includes('3B'));
});

test('Wave C tradeTargetSuggestions: 起用のねじれ(misallocated)はトレード材料に使われない', () => {
  const state = build3bFixture({ n: 12, mineIdx: 2, backupPa: 250, backupIdx: 11 }); // T1=misallocated・saturatedではない
  const list = tradeTargetSuggestions(state);
  assert.deepEqual(list, [], 'misallocatedは真の余剰ではないのでトレードの窓に出ない');
});

test('Wave C tradeTargetSuggestions: 飽和位置が無ければ空配列', () => {
  const state = build3bFixture({ n: 8, mineIdx: 5 }); // 控え無し＝飽和なし
  const list = tradeTargetSuggestions(state);
  assert.deepEqual(list, []);
});

test('Wave C tradeTargetSuggestions: 同一backup選手由来の提案は最良マッチ1件に統合される（監査b）', () => {
  // FIELD_POSITIONS全8位置でT1=飽和・他7球団=最弱にする（位置ごとに別のbackup選手＝8人の
  // 一意なbackupがいる状態）。1backupにつき最良の対戦相手1件だけ残るので、8件からtradeSuggestMax
  // (5件)に絞られることを確認する（3位置だけだと3backup分しか出ずキャップ検証にならないため8位置使う）。
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  for (let k = 0; k < 8; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, 143));
    for (const pos of FIELD_POSITIONS) {
      const idx = tid === 'T1' ? 5 : 0; // T1以外は全員最弱
      const pid = `P_${tid}_${pos}`;
      players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: pid, primaryPos: pos });
      seasons.push(statRow(pid, tid, { batting: batLineIdx(idx, 400), pos, posOuts: 400 }));
    }
  }
  for (const pos of FIELD_POSITIONS) {
    players.push({ id: `BK_${pos}`, teamId: 'T1', role: 'fielder', age: 24, name: `控え${pos}`, primaryPos: pos });
    seasons.push(statRow(`BK_${pos}`, 'T1', { batting: batLineIdx(5, 250), pos, posOuts: 200 }));
  }
  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };
  const state = { cfg, masterSeed: 5, playerTeamId: 'T1', rt, league: { teams, players, farm: [] } };
  const list = tradeTargetSuggestions(state);
  const backupIds = new Set(list.map((x) => x.myBackupId));
  assert.equal(backupIds.size, list.length, '同一backupからの提案は1件のみのはず');
  assert.ok(list.length <= gb.tradeSuggestMax);
  assert.equal(list.length, gb.tradeSuggestMax);
});

// ============================================================================
// 決定論
// ============================================================================

test('Wave C: 決定論 — 同一input同一output・stateを変更しない（4関数すべて）', () => {
  const state = build3bFixture({ n: 12, mineIdx: 11, backupPa: 250, backupIdx: 11 });
  const before = JSON.stringify([...state.rt.stats.stats.values()]);
  const a1 = JSON.stringify(positionStrengthMap(state));
  const a2 = JSON.stringify(positionStrengthMap(state));
  assert.equal(a1, a2);
  const b1 = JSON.stringify(prospectWatch(state));
  const b2 = JSON.stringify(prospectWatch(state));
  assert.equal(b1, b2);
  const c1 = JSON.stringify(tradeTargetSuggestions(state));
  const c2 = JSON.stringify(tradeTargetSuggestions(state));
  assert.equal(c1, c2);
  const d1 = JSON.stringify(ownDepthSolutions(state));
  const d2 = JSON.stringify(ownDepthSolutions(state));
  assert.equal(d1, d2);
  const after = JSON.stringify([...state.rt.stats.stats.values()]);
  assert.equal(after, before, 'stateを変更しない');
});

test('Wave C: GB_POSITIONS は野手8位置+DH+SP+RPの11枠（2026-07-25 DH可視化）', () => {
  assert.equal(GB_POSITIONS.length, 11);
  assert.ok(GB_POSITIONS.includes('DH'));
  assert.ok(GB_POSITIONS.includes('SP'));
  assert.ok(GB_POSITIONS.includes('RP'));
});

// ============================================================================
// positionStrengthMap: DH列（2026-07-25 全リーグDH制統一に伴うGMボードのDH可視化）
//   DHは守備アウトを持たないが、sim/game.mjs がDHスロット出場を positionOuts.DH として記録するため、
//   他の野手位置と同型（wOBA百分位のみ）で弱点/飽和/起用のねじれを判定できる。
// ============================================================================

/** N球団のDHフィクスチャ（build3bFixtureと同型・pos='DH'）。 */
function buildDhFixture({ n = 8, mineIdx = 5, g = 143, backupPa = null, backupIdx = null } = {}) {
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  let nextIdx = 0;
  for (let k = 0; k < n; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, g));
    const idx = tid === 'T1' ? mineIdx : (nextIdx === mineIdx ? ++nextIdx : nextIdx++);
    const pid = `DH_${tid}`;
    players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: `指名${tid}`, primaryPos: 'DH' });
    seasons.push(statRow(pid, tid, { batting: batLineIdx(idx), pos: 'DH', posOuts: 400 }));
  }
  if (backupPa != null) {
    const bIdx = backupIdx != null ? backupIdx : mineIdx + 5;
    players.push({ id: 'DHBK1', teamId: 'T1', role: 'fielder', age: 24, name: 'DH控え', primaryPos: 'DH' });
    seasons.push(statRow('DHBK1', 'T1', { batting: batLineIdx(bIdx, backupPa), pos: 'DH', posOuts: 200 }));
  }
  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };
  return { cfg, masterSeed: 888, playerTeamId: 'T1', rt, league: { teams, players, farm: [] } };
}

test('Wave C positionStrengthMap: DH列が存在し、守備アウトゼロの選手でもpositionOuts.DHで弱点判定される', () => {
  const state = buildDhFixture({ n: 8, mineIdx: 5 });
  const { cells } = positionStrengthMap(state);
  const t2 = cells.find((c) => c.teamId === 'T2' && c.pos === 'DH');
  assert.ok(t2, 'DH列のセルが存在する');
  assert.equal(t2.pctl, 0);
  assert.equal(t2.weak, true);
});

test('Wave C positionStrengthMap: DHの飽和判定はwOBA百分位のみで通常の野手位置と同型に動く（真の余剰=saturated）', () => {
  const state = buildDhFixture({ n: 12, mineIdx: 11, backupPa: 250, backupIdx: 11 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === 'DH');
  assert.equal(mine.saturated, true);
  assert.equal(mine.backupId, 'DHBK1');
  assert.equal(mine.misallocated, false);
});

test('Wave C positionStrengthMap: DHの控えがレギュラーを大きく上回れば misallocated（起用のねじれ）', () => {
  const state = buildDhFixture({ n: 12, mineIdx: 2, backupPa: 250, backupIdx: 11 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === 'DH');
  assert.equal(mine.saturated, false);
  assert.equal(mine.misallocated, true);
  assert.equal(mine.misallocBackupId, 'DHBK1');
});

// ============================================================================
// gbTeamDisplayOrder: 球団の表示順（2026-07-25 監査g）
//   「自チーム先頭→自リーグを勝率順→他リーグを勝率順」。観測rt.standingsのみ参照。
// ============================================================================

test('Wave C gbTeamDisplayOrder: 自チーム先頭→自リーグ勝率順→他リーグ勝率順', () => {
  const teams = [
    { id: 'T1', name: '球団T1', league: 'L1' },
    { id: 'T2', name: '球団T2', league: 'L1' },
    { id: 'T3', name: '球団T3', league: 'L1' },
    { id: 'T4', name: '球団T4', league: 'L2' },
    { id: 'T5', name: '球団T5', league: 'L2' },
    { id: 'T6', name: '球団T6', league: 'L2' },
  ];
  const standings = new Map([
    ['T1', { teamId: 'T1', league: 'L1', w: 50, l: 50 }], // .500（自チーム＝勝率に関わらず先頭）
    ['T2', { teamId: 'T2', league: 'L1', w: 70, l: 30 }], // .700（自リーグ1位）
    ['T3', { teamId: 'T3', league: 'L1', w: 30, l: 70 }], // .300（自リーグ最下位）
    ['T4', { teamId: 'T4', league: 'L2', w: 80, l: 20 }], // .800（他リーグ1位・全体最強でも自チームより後）
    ['T5', { teamId: 'T5', league: 'L2', w: 20, l: 80 }], // .200（他リーグ最下位）
    ['T6', { teamId: 'T6', league: 'L2', w: 50, l: 50 }], // .500（他リーグ中位）
  ]);
  const state = { league: { teams }, playerTeamId: 'T1', rt: { standings } };
  assert.deepEqual(gbTeamDisplayOrder(state), ['T1', 'T2', 'T3', 'T4', 'T6', 'T5']);
});

test('Wave C gbTeamDisplayOrder: 勝率同率はteamId昇順の決定論タイブレーク', () => {
  const teams = [
    { id: 'T2', name: '球団T2', league: 'L1' },
    { id: 'T1', name: '球団T1', league: 'L1' },
  ];
  const standings = new Map([
    ['T1', { teamId: 'T1', league: 'L1', w: 50, l: 50 }],
    ['T2', { teamId: 'T2', league: 'L1', w: 50, l: 50 }],
  ]);
  const state = { league: { teams }, playerTeamId: null, rt: { standings } };
  assert.deepEqual(gbTeamDisplayOrder(state), ['T1', 'T2']);
});

test('Wave C gbTeamDisplayOrder: standings未成立でもクラッシュせず全球団を返す（開幕前ガード）', () => {
  const teams = [{ id: 'T2', name: '球団T2' }, { id: 'T1', name: '球団T1' }];
  const state1 = { league: { teams }, playerTeamId: null, rt: null };
  assert.deepEqual(gbTeamDisplayOrder(state1), ['T1', 'T2']);
  const state2 = { league: { teams }, playerTeamId: 'T2', rt: { standings: new Map() } };
  assert.deepEqual(gbTeamDisplayOrder(state2), ['T2', 'T1']);
});

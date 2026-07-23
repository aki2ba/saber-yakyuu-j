// ============================================================================
// Wave C（thyroxin/specs/gm_analytics_spec.md）: GMボード（src/game/gmBoard.mjs）のテスト。
// 合成フィクスチャ（rt.stats/rt.standings/rt.farm/league.players/league.teams を直接構成）で、
// 弱点(下位20%)/飽和(規定30%以上×百分位60%以上の控え)判定の分岐・prospectWatchの「塞がれ」判定・
// トレード相手マッチングの妥当性・決定論を検証する。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { createBattingLine, createPitchingLine, createBaserunningLine, createFieldingLine } from '../src/model/statline.mjs';
import { positionStrengthMap, prospectWatch, tradeTargetSuggestions, GB_POSITIONS } from '../src/game/gmBoard.mjs';

const cfg = createConfig();

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
/** 指数iが大きいほど明確に良い(=FIP低い/K-BB%高い)投球ライン。救援=gs:0・先発=gs:g。 */
function pitLineIdx(i, { outs = 400, starter = false } = {}) {
  const p = createPitchingLine();
  p.outs = outs;
  p.so = 100 + i * 20;
  p.bb = 60 - i * 4;
  p.hr = 15;
  p.h = 150;
  p.r = 80 - i * 3;
  p.er = p.r - 5;
  p.bf = p.outs + p.h + p.bb;
  p.g = 26;
  p.gs = starter ? 26 : 0;
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
 *  オプションで T1 に控え(BK1)を追加できる（飽和判定用）。 */
function build3bFixture({ n = 8, mineIdx = 5, g = 143, backupPa = null } = {}) {
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  const idxOf = new Map(); // teamId -> index（T1だけ mineIdx、他は残りの指数を順に割当）
  let nextIdx = 0;
  for (let k = 0; k < n; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, g));
    const idx = tid === 'T1' ? mineIdx : (nextIdx === mineIdx ? ++nextIdx : nextIdx++);
    idxOf.set(tid, idx);
    const pid = `P_${tid}`;
    players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: `選手${tid}`, primaryPos: '3B' });
    seasons.push(statRow(pid, tid, { batting: batLineIdx(idx), pos: '3B', posOuts: 400 }));
  }
  if (backupPa != null) {
    players.push({ id: 'BK1', teamId: 'T1', role: 'fielder', age: 24, name: '控え1', primaryPos: '3B' });
    seasons.push(statRow('BK1', 'T1', { batting: batLineIdx(mineIdx + 5, backupPa), pos: '3B', posOuts: 200 }));
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
// positionStrengthMap: 飽和（規定30%以上×百分位60%以上の控え）
// ============================================================================

test('Wave C positionStrengthMap: 規定30%以上の打席×百分位60%以上の控えがいれば飽和', () => {
  // 規定打席=round(143*3.1)=443・30%=133 → backupPa=250(>133) で条件を満たす
  const state = build3bFixture({ n: 8, mineIdx: 5, backupPa: 250 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(mine.saturated, true);
  assert.equal(mine.backupId, 'BK1');
  assert.ok(mine.backupPctl >= cfg.tuning.storylines.gmBoard.satMinPctl);
});

test('Wave C positionStrengthMap: 控えの打席が規定30%未満なら飽和にならない', () => {
  // backupPa(ab)=10 → 実PA=10+bb=90。規定打席443の30%=133を明確に下回る。
  const state = build3bFixture({ n: 8, mineIdx: 5, backupPa: 10 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(mine.saturated, false);
  assert.equal(mine.backupId, null);
});

test('Wave C positionStrengthMap: 控えがいなければ飽和にならない（レギュラーのみ）', () => {
  const state = build3bFixture({ n: 8, mineIdx: 5 });
  const { cells } = positionStrengthMap(state);
  const mine = cells.find((c) => c.teamId === 'T1' && c.pos === '3B');
  assert.equal(mine.saturated, false);
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
 *  若手(YOUNG1)を1人追加する共通フィクスチャ。 */
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
  assert.ok(list[0].pctl >= cfg.tuning.storylines.gmBoard.prospectMinPctl);
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
// tradeTargetSuggestions: 自球団の飽和位置×他球団の弱点位置のマッチング
// ============================================================================

test('Wave C tradeTargetSuggestions: 自球団の飽和位置と他球団の弱点位置が一致すればサジェストされる', () => {
  const state = build3bFixture({ n: 8, mineIdx: 5, backupPa: 250 }); // T1=飽和(3B)・T2=最弱(3B)
  const list = tradeTargetSuggestions(state);
  assert.ok(list.length >= 1);
  const hit = list.find((x) => x.oppTeamId === 'T2');
  assert.ok(hit, 'T2への3B窓サジェストが含まれるはず');
  assert.equal(hit.myPos, '3B');
  assert.equal(hit.oppPos, '3B');
  assert.equal(hit.myBackupId, 'BK1');
  assert.ok(hit.text.includes('3B'));
});

test('Wave C tradeTargetSuggestions: 飽和位置が無ければ空配列', () => {
  const state = build3bFixture({ n: 8, mineIdx: 5 }); // 控え無し＝飽和なし
  const list = tradeTargetSuggestions(state);
  assert.deepEqual(list, []);
});

test('Wave C tradeTargetSuggestions: 上位tradeSuggestMax(5)件までに絞られる', () => {
  // 8球団すべてに3B/SS/2B の3ポジションで T1 を飽和・他球団を弱点にする（15件以上の組合せが出るはず）
  const teams = [];
  const players = [];
  const seasons = [];
  const standRows = [];
  const positions = ['3B', 'SS', '2B'];
  for (let k = 0; k < 8; k++) {
    const tid = `T${k + 1}`;
    teams.push({ id: tid, name: `球団${tid}` });
    standRows.push(standRow(tid, 143));
    for (const pos of positions) {
      const idx = tid === 'T1' ? 5 : 0; // T1以外は全員最弱
      const pid = `P_${tid}_${pos}`;
      players.push({ id: pid, teamId: tid, role: 'fielder', age: 30, name: pid, primaryPos: pos });
      seasons.push(statRow(pid, tid, { batting: batLineIdx(idx, 400), pos, posOuts: 400 }));
    }
  }
  for (const pos of positions) {
    players.push({ id: `BK_${pos}`, teamId: 'T1', role: 'fielder', age: 24, name: `控え${pos}`, primaryPos: pos });
    seasons.push(statRow(`BK_${pos}`, 'T1', { batting: batLineIdx(10, 250), pos, posOuts: 200 }));
  }
  const rt = {
    stats: { stats: new Map(seasons.map((s) => [s.playerId, s])) },
    standings: new Map(standRows.map((r) => [r.teamId, r])),
  };
  const state = { cfg, masterSeed: 5, playerTeamId: 'T1', rt, league: { teams, players, farm: [] } };
  const list = tradeTargetSuggestions(state);
  assert.ok(list.length <= cfg.tuning.storylines.gmBoard.tradeSuggestMax);
  assert.equal(list.length, cfg.tuning.storylines.gmBoard.tradeSuggestMax);
});

// ============================================================================
// 決定論
// ============================================================================

test('Wave C: 決定論 — 同一input同一output・stateを変更しない（positionStrengthMap/prospectWatch/tradeTargetSuggestions）', () => {
  const state = build3bFixture({ n: 8, mineIdx: 5, backupPa: 250 });
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
  const after = JSON.stringify([...state.rt.stats.stats.values()]);
  assert.equal(after, before, 'stateを変更しない');
});

test('Wave C: GB_POSITIONS は野手8位置+SP+RPの10枠', () => {
  assert.equal(GB_POSITIONS.length, 10);
  assert.ok(GB_POSITIONS.includes('SP'));
  assert.ok(GB_POSITIONS.includes('RP'));
});

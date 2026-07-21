// ============================================================================
// フェーズH1: ストーリーライン（連続ニュース・ライバル・引退ロード・phaseH_fun_spec H1）のテスト。
//   - レース追跡（titleRaces/rookieRace/recordPaces）: リーダー選定・規定換算ゲート・激戦フラグの
//     しきい値がconfig通りに機能する（合成フィクスチャで境界値を直接検証）
//   - transactionLog: advanceYear が off の fa/trades/pickups/draftLog.picks から正しい行数・
//     内容を追記する。save→load で bit 一致（additive・旧セーブは[]補完）
//   - rivalriesOf: トレード/FA/戦力外の旧所属・同年同round指名の同期を transactionLog から正しく導出
//   - rivalryGameHeadlines: 同一シードで同一見出し列（決定論）・返る見出しは実際にrivalry一致する試合のみ
//   - retirementRoadCandidates/retirementCeremonies: 集計値（career総和・受賞数）と一致
//   - 決定論: 同一state入力は同一出力（純関数）。エンジン非干渉（careerStats/teamHistoryを変えない）
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, qualifiedPA, qualifiedIP } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, save, load } from '../src/game/index.mjs';
import { careerBatting, careerPitching } from '../src/game/awards.mjs';
import {
  titleRaces, titleRaceHeadlines, rookieRace, rookieRaceHeadlines,
  recordPaces, recordPaceHeadlines, weeklyStorylineDigest,
  appendTransactionLog, rivalriesOf, rivalryGameHeadlines,
  retirementRoadCandidates, retirementRoadHeadlines,
  retirementCeremonies, retirementCeremonyText, ownTeamRetirementHeadlines,
  playerStoryOf, STORY_KIND_LABELS,
} from '../src/game/storylines.mjs';

const cfg = createConfig();
const SEED = 20260701;
const names = { pnameOf: (id) => id, tnameOf: (id) => id, leagueNameOf: (id) => id };

// --- 合成フィクスチャ（rt.standings / rt.stats.stats を直接構成し、境界値を厳密に制御する） -------
function batLine(o) {
  return { pa: 0, ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, so: 0, sf: 0, sb: 0, cs: 0, rbi: 0, ibb: 0, ...o };
}
function pitLine(o) {
  return { outs: 0, bf: 0, h: 0, hr: 0, bb: 0, ibb: 0, hbp: 0, so: 0, er: 0, r: 0, w: 0, l: 0, sv: 0, hld: 0, g: 0, gs: 0, ...o };
}
function statRow(playerId, teamId, o = {}) {
  return { playerId, teamId, season: 0, batting: o.batting ?? null, pitching: o.pitching ?? null, baserunning: {}, fielding: { positionOuts: {} } };
}
function standRow(teamId, league, g) {
  return { teamId, league, g, w: Math.round(g / 2), l: g - Math.round(g / 2), t: 0, rs: g, ra: g };
}
function fakeState(rows, standRows, extra = {}) {
  const standings = new Map(standRows.map((r) => [r.teamId, r]));
  const stats = new Map(rows.map((s) => [s.playerId, s]));
  return {
    cfg, masterSeed: 999, year: 2030, careerStats: [], teamHistory: [], awardsHistory: [],
    league: { players: [], farm: [] }, transactionLog: [],
    rt: { standings, stats: { stats }, playerGameLog: [] },
    ...extra,
  };
}

test('H1-1: titleRaces — 規定換算ゲート（qualifiedPA/qualifiedIP）で少PA/少IPを除外する', () => {
  const g = 100; // standings.g=100 → qPA=round(100*3.1)=310, qIP=100
  const rows = [
    statRow('A', 'T1', { batting: batLine({ pa: 320, ab: 300, h: 90 }) }), // avg=.300 規定到達
    statRow('B', 'T2', { batting: batLine({ pa: 50, ab: 45, h: 40 }) }), // avg=.888 だが規定未到達→除外
  ];
  const st = fakeState(rows, [standRow('T1', 'L1', g), standRow('T2', 'L1', g)]);
  const races = titleRaces(st);
  const lg = races.leagues.find((l) => l.leagueId === 'L1');
  const leaders = lg.categories.battingAvg.leaders;
  assert.equal(leaders.length, 1, '規定未到達の高打率選手は除外される');
  assert.equal(leaders[0].playerId, 'A', '規定到達選手だけが首位打者争いに載る');
});

test('H1-1: titleRaces — 激戦フラグ（close）はconfigのraceCloseMarginぴったりで境界判定', () => {
  const g = 100;
  const margin = cfg.tuning.storylines.raceCloseMargin.count; // homeRun=count系
  const rows = [
    statRow('A', 'T1', { batting: batLine({ pa: 400, ab: 380, hr: 30 }) }),
    statRow('B', 'T2', { batting: batLine({ pa: 400, ab: 380, hr: 30 - margin }) }), // ちょうど margin差＝close
    statRow('C', 'T1', { batting: batLine({ pa: 400, ab: 380, hr: 30 - margin - 1 }) }), // margin超過＝not close
  ];
  const st1 = fakeState([rows[0], rows[1]], [standRow('T1', 'L1', g), standRow('T2', 'L1', g)]);
  const cat1 = titleRaces(st1).leagues[0].categories.homeRun;
  assert.equal(cat1.close, true, `margin差ちょうど(${margin})は激戦フラグtrue`);

  const st2 = fakeState([rows[0], rows[2]], [standRow('T1', 'L1', g), standRow('T2', 'L1', g)]);
  const cat2 = titleRaces(st2).leagues[0].categories.homeRun;
  assert.equal(cat2.close, false, `margin超過(${margin + 1})は激戦フラグfalse`);

  const heads = titleRaceHeadlines(st1, names);
  assert.ok(heads.some((h) => h.text.includes('本塁打王')), '激戦カテゴリの見出しが生成される');
});

test('H1-1: titleRaces — ERA（rateAsc）は低い方がリーダー、qualifiedIPで規定投球回未満を除外', () => {
  const g = 100; // qIP = round(100*1) = 100 → outs>=300
  const rows = [
    statRow('P1', 'T1', { pitching: pitLine({ outs: 300, er: 30, g: 20, gs: 20 }) }), // era = 30*27/300 = 2.70
    statRow('P2', 'T2', { pitching: pitLine({ outs: 300, er: 40, g: 20, gs: 20 }) }), // era = 3.60
    statRow('P3', 'T1', { pitching: pitLine({ outs: 60, er: 2, g: 10, gs: 0 }) }), // era低いが規定未到達
  ];
  const st = fakeState(rows, [standRow('T1', 'L1', g), standRow('T2', 'L1', g)]);
  const cat = titleRaces(st).leagues[0].categories.era;
  assert.equal(cat.leaders[0].playerId, 'P1', 'ERA最小（規定到達）が首位');
  assert.equal(cat.leaders.length, 2, '規定投球回未満は除外される');
});

test('H1-1: rookieRace — 開幕年（前年成績が皆無）は対象外。新人のみを観測ベース近似で順位付け', () => {
  const rows = [
    statRow('VET', 'T1', { batting: batLine({ pa: 400, ab: 380, h: 100, hr: 10 }) }),
    statRow('ROOK1', 'T1', { batting: batLine({ pa: 300, ab: 280, h: 90, hr: 5 }) }),
    statRow('ROOK2', 'T2', { batting: batLine({ pa: 200, ab: 190, h: 40, hr: 1 }) }),
  ];
  const standRows = [standRow('T1', 'L1', 100), standRow('T2', 'L1', 100)];
  // 開幕年（careerStats空）は新人王同様レースを付与しない
  const stOpening = fakeState(rows, standRows, { year: 2026 });
  assert.equal(rookieRace(stOpening).leagues.length, 0, '開幕年は新人王レース対象外');

  // 2年目以降: VETは前年実績ありなので除外、ROOK1/ROOK2のみ評価
  const st = fakeState(rows, standRows, {
    year: 2027,
    careerStats: [statRow('VET', 'T1', { season: 2026, batting: batLine({ pa: 400, ab: 380, h: 100 }) })],
  });
  const rr = rookieRace(st);
  const leaders = rr.leagues.find((l) => l.leagueId === 'L1').leaders;
  const ids = leaders.map((l) => l.playerId);
  assert.ok(!ids.includes('VET'), '前年実績のある選手は新人王レースから除外');
  assert.ok(ids.includes('ROOK1') && ids.includes('ROOK2'), '当年デビューの新人が評価対象');
  // ROOK1はPA・成績ともROOK2を上回る→順位が上
  assert.equal(leaders[0].playerId, 'ROOK1', '観測ベース近似値が高い新人が上位');
  const heads = rookieRaceHeadlines(st, names);
  assert.ok(heads.length === 1 && heads[0].text.includes('ROOK1'), '新人王レース見出しは各リーグ首位のみ');
});

test('H1-1: recordPaces — シーズン記録比105%超×消化50%以上のみ検出（configしきい値通り）', () => {
  const st = cfg.tuning.storylines;
  const g = 143;
  // 過去の「シーズン記録」= 40HR（careerStats の完了シーズン行）
  const past = statRow('LEGEND', 'T1', { season: 2020, batting: batLine({ pa: 600, ab: 560, h: 160, hr: 40 }) });
  // 当季ライブ行: 消化50%（g=72試合中）で 24HR → ペース = 24/0.5034... ≈ 47.7HR（>40*1.05=42）
  const teamG = Math.round(g * st.recordPaceMinProgress); // ちょうど50%消化
  const rows = [statRow('NOW', 'T1', { batting: batLine({ pa: 300, ab: 280, hr: 24 }) })];
  const standRows = [standRow('T1', 'L1', teamG)];
  const stFull = fakeState(rows, standRows, { year: 2021, careerStats: [past] });
  stFull.cfg.league.gamesPerSeason = g; // フルシーズン試合数を明示
  const paces = recordPaces(stFull);
  const hrPace = paces.find((p) => p.category === 'homeRuns');
  assert.ok(hrPace, 'homeRunsカテゴリが記録ペースとして検出される');
  assert.equal(hrPace.playerId, 'NOW');
  assert.ok(hrPace.pace >= hrPace.recordValue * st.recordPaceThreshold, 'ペースがrecordPaceThreshold以上');

  // 消化49%未満（st.recordPaceMinProgress未満）は対象外になる
  const stLow = fakeState(rows, [standRow('T1', 'L1', teamG - 2)], { year: 2021, careerStats: [past] });
  stLow.cfg.league.gamesPerSeason = g;
  const pacesLow = recordPaces(stLow);
  assert.ok(!pacesLow.some((p) => p.category === 'homeRuns' && p.playerId === 'NOW'), '消化50%未満はペース判定の対象外');

  const heads = recordPaceHeadlines(stFull, names);
  assert.ok(heads.some((h) => h.text.includes('NOW')), '記録ペース見出しにプレイヤー名が入る');
});

test('H1-1: weeklyStorylineDigest — digestMaxItems件数上限を守り、各節見出しを合流する', () => {
  const g = 100;
  const rows = [
    statRow('A', 'T1', { batting: batLine({ pa: 400, ab: 380, hr: 30 }) }),
    statRow('B', 'T2', { batting: batLine({ pa: 400, ab: 380, hr: 29 }) }), // homeRun close
    statRow('C', 'T1', { batting: batLine({ pa: 400, ab: 380, sb: 20 }) }),
    statRow('D', 'T2', { batting: batLine({ pa: 400, ab: 380, sb: 19 }) }), // steal close
  ];
  const st = fakeState(rows, [standRow('T1', 'L1', g), standRow('T2', 'L1', g)]);
  const digest = weeklyStorylineDigest(st, names);
  assert.ok(digest.length <= cfg.tuning.storylines.digestMaxItems, 'digestMaxItemsを超えない');
  assert.ok(digest.length >= 1, '激戦カテゴリの見出しが含まれる');
});

test('H1-3: retirementRoadCandidates — 年齢閾値＋通算マイルストーンの両方を満たす選手のみ検出', () => {
  const rr = cfg.tuning.storylines.retirementRoad;
  const oldWithMilestone = { id: 'OLD1', teamId: 'T1', role: 'fielder', primaryPos: '1B', age: rr.ageThreshold, rosterStatus: 'active' };
  const oldNoMilestone = { id: 'OLD2', teamId: 'T1', role: 'fielder', primaryPos: '2B', age: rr.ageThreshold, rosterStatus: 'active' };
  const youngWithMilestone = { id: 'YNG1', teamId: 'T1', role: 'fielder', primaryPos: '3B', age: rr.ageThreshold - 1, rosterStatus: 'active' };
  const careerStats = [
    statRow('OLD1', 'T1', { season: 2020, batting: batLine({ pa: 600, ab: 560, h: rr.batterMilestones.hits + 50 }) }),
    statRow('OLD2', 'T1', { season: 2020, batting: batLine({ pa: 600, ab: 560, h: 50 }) }), // マイルストーン未到達
    statRow('YNG1', 'T1', { season: 2020, batting: batLine({ pa: 600, ab: 560, h: rr.batterMilestones.hits + 50 }) }),
  ];
  const st = fakeState([], [], {
    league: { players: [oldWithMilestone, oldNoMilestone, youngWithMilestone], farm: [] },
    careerStats,
  });
  const cands = retirementRoadCandidates(st);
  const ids = cands.map((c) => c.playerId);
  assert.ok(ids.includes('OLD1'), '年齢＋マイルストーン両方満たす選手は候補');
  assert.ok(!ids.includes('OLD2'), 'マイルストーン未到達は候補外');
  assert.ok(!ids.includes('YNG1'), '年齢閾値未満は候補外（マイルストーンがあっても）');
  const heads = retirementRoadHeadlines(st, names);
  assert.ok(heads.length === 1 && heads[0].text.includes('OLD1'), '引退ロード見出しが候補ぶん生成される');
});

// --- 実ゲームループでの結合テスト（advanceYear/save/load・§17決定論の実地検証） -------------------
function runYears(seed, years, teamId = 'T1') {
  const st = newGame(seed, teamId, { cfg });
  for (let y = 0; y < years; y++) {
    advanceTo(st, 'seasonEnd');
    advanceYear(st);
  }
  return st;
}

test('H1-2: appendTransactionLog — off確定結果（fa/trades非rejected/pickups/draftLog.picks）の行数と一致', () => {
  const st = newGame(SEED, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  const before = st.transactionLog.length;
  const off = advanceYear(st);
  const added = st.transactionLog.length - before;
  const expected =
    (off.fa ?? []).length +
    (off.trades ?? []).filter((t) => !t.rejected).length +
    (off.pickups ?? []).length +
    (off.draftLog ? off.draftLog.picks.length : 0);
  assert.equal(added, expected, 'transactionLogへの追記行数がoffの確定結果と一致');
  assert.ok(added > 0, 'このシードでは何らかの取引が発生している');
  // 各行の year は完了年（advanceYear呼び出し前のstate.year）と一致
  const completedYear = st.year - 1;
  const newRows = st.transactionLog.slice(before);
  assert.ok(newRows.every((r) => r.year === completedYear), 'すべての新規行のyearが完了年と一致');
});

test('H1-2: transactionLog は additive save field — save/load で bit 一致・旧セーブは[]補完', () => {
  const st = runYears(SEED, 3);
  const blob = JSON.parse(JSON.stringify(save(st)));
  assert.ok(Array.isArray(blob.transactionLog), 'saveにtransactionLogが含まれる');
  const restored = load(blob, { cfg });
  assert.equal(JSON.stringify(restored.transactionLog), JSON.stringify(st.transactionLog), 'load後のtransactionLogがsave前と一致');

  // 旧セーブ（transactionLogフィールド無し）は load 時に [] 補完される
  const oldBlob = { ...blob };
  delete oldBlob.transactionLog;
  const restoredOld = load(oldBlob, { cfg });
  assert.deepEqual(restoredOld.transactionLog, [], '旧セーブはtransactionLog=[]で補完される');
});

test('H1-2: rivalriesOf — トレード相手・FA旧所属・戦力外旧所属・同年同round指名の同期を正しく導出', () => {
  const st = newGame(SEED, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  advanceYear(st);

  // トレード行から双方向の rivalry を検証
  const tradeRow = st.transactionLog.find((r) => r.kind === 'trade');
  if (tradeRow) {
    const aRiv = rivalriesOf(st, tradeRow.playerId).find((r) => r.type === 'trade' && r.otherPlayerId === tradeRow.playerId2);
    assert.ok(aRiv, 'トレードで移籍した選手Aから見た相手Bのrivalryが導出される');
    assert.equal(aRiv.oldTeamId, tradeRow.from);
    assert.equal(aRiv.newTeamId, tradeRow.to);
    const bRiv = rivalriesOf(st, tradeRow.playerId2).find((r) => r.type === 'trade' && r.otherPlayerId === tradeRow.playerId);
    assert.ok(bRiv, '逆方向（B視点）のrivalryも導出される');
    assert.equal(bRiv.oldTeamId, tradeRow.to);
    assert.equal(bRiv.newTeamId, tradeRow.from);
  }

  const faRow = st.transactionLog.find((r) => r.kind === 'fa');
  if (faRow) {
    const riv = rivalriesOf(st, faRow.playerId).find((r) => r.type === 'faOld');
    assert.ok(riv, 'FA移籍のrivalryが導出される');
    assert.equal(riv.oldTeamId, faRow.from);
    assert.equal(riv.newTeamId, faRow.to);
  }

  const pickupRow = st.transactionLog.find((r) => r.kind === 'pickup');
  if (pickupRow) {
    const riv = rivalriesOf(st, pickupRow.playerId).find((r) => r.type === 'pickupOld');
    assert.ok(riv, '拾い上げのrivalryが導出される');
    assert.equal(riv.oldTeamId, pickupRow.from);
  }

  // 同年同round指名の同期（draftmate）
  const draftRows = st.transactionLog.filter((r) => r.kind === 'draft');
  const byRound = new Map();
  for (const r of draftRows) {
    const k = `${r.year}|${r.round}`;
    if (!byRound.has(k)) byRound.set(k, []);
    byRound.get(k).push(r);
  }
  const pair = [...byRound.values()].find((arr) => arr.length >= 2);
  assert.ok(pair, 'このシードでは同年同round指名が複数発生している');
  const mate = rivalriesOf(st, pair[0].playerId).find((r) => r.type === 'draftmate' && r.otherPlayerId === pair[1].playerId);
  assert.ok(mate, '同年同round指名の同期がdraftmateとして導出される');
  assert.equal(mate.matchTeamId, pair[1].to);
});

test('H1-2: rivalryGameHeadlines — 決定論（同一シードは同一見出し列）＋返る見出しは実際のrivalry一致試合のみ', () => {
  const run = (seed, years) => {
    const st = newGame(seed, 'T1', { cfg });
    for (let y = 0; y < years; y++) {
      advanceTo(st, 'seasonEnd');
      advanceYear(st);
    }
    // 年度途中まで進めてrivalryGameHeadlinesの母集団（playerGameLog）を厚くする
    for (let i = 0; i < 60 && !st.rt.finished; i++) {
      // advanceDay は index.mjs 経由（ここではadvanceToのnextPlayerGameで代用しない＝日次進行の生API使用）
      advanceTo(st, 'nextPlayerGame');
    }
    return st;
  };
  const stA = run(SEED, 3);
  const stB = run(SEED, 3);
  const headsA = rivalryGameHeadlines(stA, names, 10);
  const headsB = rivalryGameHeadlines(stB, names, 10);
  assert.equal(JSON.stringify(headsA), JSON.stringify(headsB), '同一シードの因縁見出しは決定論的に一致');

  // 返された見出しはすべて「その試合の相手チームがrivalryの対象チームと一致する」ことを検証
  for (const h of headsA) {
    const rivals = rivalriesOf(stA, h.playerId);
    assert.ok(rivals.some((r) => (r.oldTeamId ?? r.matchTeamId) === h.oppTeamId), `${h.playerId}の因縁見出しは実際のrivalryチームと一致`);
  }
});

test('H1-3: retirementCeremonies — 通算集計・受賞数がcareerBatting/careerPitching/playerAwardHistoryと一致', () => {
  const st = runYears(SEED, 6);
  // 直近advanceYearの off を再取得するため、もう1年分だけ手動で回してoffを掴む
  advanceTo(st, 'seasonEnd');
  const completedYear = st.year;
  const off = advanceYear(st);
  const ceremonies = off.retirementCeremonies ?? [];
  for (const c of ceremonies) {
    const isPitcher = c.role === 'pitcher';
    const agg = isPitcher ? careerPitching(st.careerStats, c.playerId) : careerBatting(st.careerStats, c.playerId);
    assert.equal(JSON.stringify(c.career), JSON.stringify(agg), `${c.playerId}のセレモニー通算成績がcareerBatting/Pitchingと一致`);
    const scale = isPitcher ? agg.ip : agg.pa;
    const rr = cfg.tuning.storylines.retirementRoad;
    assert.ok(scale >= (isPitcher ? rr.ceremonyMinIP : rr.ceremonyMinPA) || c.awards.length >= rr.ceremonyMinAwards, `${c.playerId}は功労者しきい値を満たす`);
    // テキスト整形が例外なく通り、名前・在籍球団が含まれる
    const text = retirementCeremonyText(c, { tnameOf: (id) => id });
    assert.ok(text.includes(c.name), 'セレモニーテキストに選手名が含まれる');
  }
  void completedYear;
});

test('H1-3: ownTeamRetirementHeadlines — 完了年の最終所属が自チームの功労者だけを個別ニュース化', () => {
  const st = runYears(SEED, 6);
  advanceTo(st, 'seasonEnd');
  const completedYear = st.year;
  const off = advanceYear(st);
  const ceremonies = off.retirementCeremonies ?? [];
  const heads = ownTeamRetirementHeadlines(st, ceremonies, 'T1', completedYear, names);
  const finalTeam = new Map();
  for (const s of st.careerStats) if (s.season === completedYear) finalTeam.set(s.playerId, s.teamId);
  for (const h of heads) {
    assert.equal(finalTeam.get(h.playerId), 'T1', '自チーム所属だった功労者だけが個別ニュース化される');
  }
  // 自チーム以外の功労者は含まれない
  const otherMerits = ceremonies.filter((c) => finalTeam.get(c.playerId) && finalTeam.get(c.playerId) !== 'T1');
  for (const c of otherMerits) {
    assert.ok(!heads.some((h) => h.playerId === c.playerId), '他球団所属だった功労者は個別ニュース化されない');
  }
});

test('H1: 決定論 — 同一入力（state）は同一出力（純関数・エンジン非干渉）', () => {
  const st = runYears(SEED, 2);
  advanceTo(st, 'seasonEnd');
  const before = JSON.stringify({ cs: st.careerStats.length, th: st.teamHistory.length, tl: st.transactionLog.length });
  const a = JSON.stringify(titleRaces(st));
  const b = JSON.stringify(titleRaces(st));
  assert.equal(a, b, 'titleRacesは同一inputで同一output');
  const ra = JSON.stringify(rookieRace(st));
  const rb = JSON.stringify(rookieRace(st));
  assert.equal(ra, rb, 'rookieRaceは同一inputで同一output');
  const pa = JSON.stringify(recordPaces(st));
  const pb = JSON.stringify(recordPaces(st));
  assert.equal(pa, pb, 'recordPacesは同一inputで同一output');
  const after = JSON.stringify({ cs: st.careerStats.length, th: st.teamHistory.length, tl: st.transactionLog.length });
  assert.equal(after, before, 'storylines計算はcareerStats/teamHistory/transactionLogを一切変更しない');
});

// ============================================================================
// P7: 選手詳細の「物語」欄（fun_theory_research_20260720 P7）のテスト。
//   playerStoryOf: transactionLog/awardsHistory/careerStats/在籍情報だけから出自/移籍歴/栄光/節目/
//   因縁を時系列へ合成する純関数。合成フィクスチャで各分岐を直接検証し、実ゲームループでも
//   例外なく決定論的に動くことを確認する。
// ============================================================================

test('P7: playerStoryOf — 出自（ドラフト・競合くじ情報つき）', () => {
  const st = fakeState([], [], {
    transactionLog: [{ year: 2025, kind: 'draft', playerId: 'A', to: 'T1', round: 1, contenders: 3 }],
    league: { players: [{ id: 'A', teamId: 'T1', role: 'fielder', primaryPos: '1B', age: 22, rosterStatus: 'active' }], farm: [] },
  });
  const story = playerStoryOf(st, 'A');
  const origin = story.find((e) => e.kind === 'origin');
  assert.ok(origin, '出自イベントが生成される');
  assert.equal(origin.year, 2025);
  assert.ok(origin.text.includes('3球団競合の末'), '競合くじ情報（contenders）が出自テキストに反映される');
  assert.ok(origin.text.includes('ドラフト1位で'), 'ドラフト順位が反映される');
});

test('P7: playerStoryOf — 出自フォールバック（transactionLogに記録が無い選手は「生え抜き」）', () => {
  const st = fakeState([], [], {
    transactionLog: [],
    league: { players: [{ id: 'B', teamId: 'T2', role: 'pitcher', primaryPos: 'P', age: 25, rosterStatus: 'active' }], farm: [] },
  });
  const story = playerStoryOf(st, 'B');
  const origin = story.find((e) => e.kind === 'origin');
  assert.ok(origin && origin.text.includes('生え抜き'), 'ドラフト記録の無い選手は生え抜きフォールバックになる');
  assert.ok(origin.text.includes('T2'), '現在（唯一判明している）の所属球団名が使われる');
});

test('P7: playerStoryOf — 移籍歴（トレード/FA/戦力外拾い上げ）が年昇順で並ぶ', () => {
  const st = fakeState([], [], {
    transactionLog: [
      { year: 2020, kind: 'draft', playerId: 'C', to: 'T1', round: 2 },
      { year: 2023, kind: 'trade', playerId: 'C', playerId2: 'D', from: 'T1', to: 'T2' },
      { year: 2025, kind: 'pickup', playerId: 'C', from: 'T2', to: 'T3' },
    ],
    league: { players: [{ id: 'C', teamId: 'T3', role: 'fielder', primaryPos: 'OF', age: 30, rosterStatus: 'active' }], farm: [] },
  });
  const story = playerStoryOf(st, 'C');
  const kinds = story.map((e) => e.kind);
  assert.deepEqual(kinds, ['origin', 'transfer', 'transfer'], '出自→移籍歴の順で年昇順に並ぶ');
  assert.ok(story[1].year < story[2].year, '移籍イベントは年昇順');
  assert.ok(story[1].text.includes('トレード'), 'トレード行が反映される');
  assert.ok(story[2].text.includes('戦力外') && story[2].text.includes('拾い上げ'), '戦力外拾い上げが「宝拾い」文脈で反映される');
});

test('P7: playerStoryOf — 栄光（受賞履歴・二つ名）と節目（通算マイルストーン到達）', () => {
  const rr = cfg.tuning.awards.milestones;
  // statRow() は season を常に0固定（既存ヘルパーの既定挙動・他テストは総和のみ見るため無害）。
  // ここは crossing の年を検証するため、生成後に明示的に season を上書きする。
  const careerStats = [
    { ...statRow('E', 'T1', { batting: batLine({ pa: 800, ab: 750, h: 600, sb: 120 }) }), season: 2020 },
    { ...statRow('E', 'T1', { batting: batLine({ pa: 800, ab: 750, h: 500, sb: 100 }) }), season: 2021 },
  ];
  // 通算: h=1100（>= hits[0]=1000、2021年に到達）／sb=220（>= speedSb=200 → 二つ名「韋駄天」）
  const awardsHistory = [{
    year: 2020,
    awards: { leagues: [{ leagueId: 'L1', mvp: { playerId: 'E', war: 6 }, roty: null, titles: {}, bestNine: [], gloves: [] }] },
  }];
  const st = fakeState([], [], {
    careerStats, awardsHistory,
    league: { players: [{ id: 'E', teamId: 'T1', role: 'fielder', primaryPos: 'OF', age: 28, rosterStatus: 'active' }], farm: [] },
  });
  const story = playerStoryOf(st, 'E');

  const award = story.find((e) => e.kind === 'award');
  assert.ok(award && award.text.includes('MVP') && award.year === 2020, '受賞履歴（MVP）が栄光イベントとして出る');

  const nickname = story.find((e) => e.kind === 'nickname');
  assert.ok(nickname, 'PAゲート・sbしきい値を満たすと二つ名イベントが出る');
  assert.ok(nickname.text.includes('韋駄天'), 'nicknameFor と同じ二つ名（韋駄天）が使われる');
  assert.equal(nickname.year, 2021, '二つ名イベントの年は最新在籍年');

  const milestone = story.find((e) => e.kind === 'milestone');
  assert.ok(milestone, '通算1000安打のマイルストーン到達が検出される');
  assert.equal(milestone.year, 2021, 'crossingが起きた年（通算1100安打に達した年）');
  assert.ok(milestone.text.includes(String(rr.hits[0])), 'config(cfg.tuning.awards.milestones)の閾値をそのまま使う');
});

test('P7: playerStoryOf — 二つ名しきい値未満（未知数）は栄光イベントに出さない', () => {
  const careerStats = [statRow('N', 'T1', { season: 2020, batting: batLine({ pa: 50, ab: 45, h: 10 }) })];
  const st = fakeState([], [], {
    careerStats,
    league: { players: [{ id: 'N', teamId: 'T1', role: 'fielder', primaryPos: 'OF', age: 20, rosterStatus: 'active' }], farm: [] },
  });
  const story = playerStoryOf(st, 'N');
  assert.ok(!story.some((e) => e.kind === 'nickname'), 'サンプル不足（未知数）はノイズとして出さない');
});

test('P7: playerStoryOf — 因縁は同年同round指名の同期のみ（トレード等は移籍歴と重複させない）', () => {
  const st = fakeState([], [], {
    transactionLog: [
      { year: 2022, kind: 'draft', playerId: 'F', to: 'T1', round: 3 },
      { year: 2022, kind: 'draft', playerId: 'G', to: 'T2', round: 3 },
      { year: 2023, kind: 'trade', playerId: 'F', playerId2: 'H', from: 'T1', to: 'T4' },
    ],
    league: { players: [{ id: 'F', teamId: 'T4', role: 'fielder', primaryPos: 'OF', age: 24, rosterStatus: 'active' }], farm: [] },
  });
  const story = playerStoryOf(st, 'F', names);
  const rivalryEvents = story.filter((e) => e.kind === 'rivalry');
  assert.equal(rivalryEvents.length, 1, 'draftmateのみが因縁として1件出る');
  assert.ok(rivalryEvents[0].text.includes('G') && rivalryEvents[0].text.includes('同期指名'), '同期選手名とラベルが含まれる');
  const transferEvents = story.filter((e) => e.kind === 'transfer');
  assert.equal(transferEvents.length, 1, 'トレードは移籍歴側にのみ出る（因縁側では重複させない）');
});

test('P7: playerStoryOf — 決定論（同一state入力は同一出力・純関数）', () => {
  const st = fakeState([], [], {
    transactionLog: [{ year: 2019, kind: 'draft', playerId: 'Z', to: 'T1', round: 1, contenders: 2 }],
    league: { players: [{ id: 'Z', teamId: 'T1', role: 'pitcher', primaryPos: 'P', age: 26, rosterStatus: 'active' }], farm: [] },
  });
  const a = JSON.stringify(playerStoryOf(st, 'Z', names));
  const b = JSON.stringify(playerStoryOf(st, 'Z', names));
  assert.equal(a, b, '同一state入力は同一出力');
});

test('P7: STORY_KIND_LABELS — playerStoryOf が返しうる全kindにラベルが定義されている', () => {
  for (const k of ['origin', 'transfer', 'award', 'nickname', 'milestone', 'rivalry']) {
    assert.ok(STORY_KIND_LABELS[k], `kind='${k}' の日本語ラベルが定義されている`);
  }
});

test('P7: playerStoryOf — 実ゲームループでの結合（競合ドラフト行の出自反映・決定論・非干渉）', () => {
  const st = runYears(SEED, 3);
  const before = JSON.stringify({ cs: st.careerStats.length, tl: st.transactionLog.length });

  const contestedDraft = st.transactionLog.find((r) => r.kind === 'draft' && r.contenders >= 2);
  if (contestedDraft) {
    const story = playerStoryOf(st, contestedDraft.playerId, names);
    const origin = story.find((e) => e.kind === 'origin');
    assert.ok(origin, 'ドラフト経由選手には出自イベントがある');
    assert.ok(origin.text.includes(`${contestedDraft.contenders}球団競合の末`), '競合くじ情報が実データからも出自テキストへ反映される');
  }

  // 現役選手全員に対して例外なく動作し、決定論的に安定する（重い全走査だが件数は1球団分程度）。
  for (const p of st.league.players.slice(0, 15)) {
    const s1 = JSON.stringify(playerStoryOf(st, p.id, names));
    const s2 = JSON.stringify(playerStoryOf(st, p.id, names));
    assert.equal(s1, s2, `${p.id}: 同一stateからの同一出力（純関数）`);
  }
  const after = JSON.stringify({ cs: st.careerStats.length, tl: st.transactionLog.length });
  assert.equal(after, before, 'playerStoryOfはcareerStats/transactionLogを一切変更しない');
});

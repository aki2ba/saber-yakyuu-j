// ============================================================================
// フェーズC4: 表彰・ニュース・記録・二つ名のテスト。
//   - タイトル9種が観測成績の正しいリーダーに付く（各リーグ・規定到達で絞る）
//   - MVP=リーグ最高WAR／ベストナイン=各ポジションのWAR最良／守備の栄誉賞=defScore最良
//   - ノーヒットノーラン・完全試合・サイクル安打・猛打賞の検出（イベント列の純関数）
//   - 通算マイルストーンの crossing 検出（跨いだ年だけ通知）
//   - 二つ名が通算 "観測" パターンに対応（大砲/韋駄天/精密機械/ドクターK…）
//   - 週次ダイジェスト（連勝/首位/完封）／連勝連敗カウント
//   - 決定論（同一入力は同一表彰）／advanceYear が off.awards を決定論で返す
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, qualifiedPA, qualifiedIP } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, allPlayersById } from '../src/game/index.mjs';
import {
  computeSeasonAwards, evalSeason, seasonLeagueConstants, nicknameFor,
  milestones, leagueRecords, teamRecords, playerAwardHistory,
} from '../src/game/awards.mjs';
import { detectGameNotables, streakOf, weeklyDigest } from '../src/game/news.mjs';
import { createPlayer } from '../src/model/player.mjs';

const cfg = createConfig();
const SEED = 20260701;

// --- 実シーズンを1年通し、表彰計算の素（playerSeasons/standings/byId）を作る ------------
function realSeason(seed = SEED, teamId = 'T1') {
  const st = newGame(seed, teamId, { cfg });
  advanceTo(st, 'seasonEnd');
  const year = st.year;
  const playerSeasons = st.careerStats.filter((s) => s.season === year);
  const standings = st.teamHistory.find((h) => h.year === year).standings;
  const byId = new Map(st.league.players.map((p) => [p.id, p]));
  return { st, year, playerSeasons, standings, byId };
}
const R = realSeason();
const AW = computeSeasonAwards({ playerSeasons: R.playerSeasons, standings: R.standings, playersById: R.byId, cfg, allCareerStats: R.st.careerStats, year: R.year });

/** teamId→league */
const lgOf = new Map(R.standings.map((r) => [r.teamId, r.league]));

test('C4: 各タイトルが観測成績の正しいリーグ・リーダーに付く（規定到達で絞る）', () => {
  const qPA = qualifiedPA(cfg.league.gamesPerSeason);
  const qIP = qualifiedIP(cfg.league.gamesPerSeason);
  const lc = seasonLeagueConstants(R.playerSeasons, R.standings);
  for (const lg of AW.leagues) {
    const inLg = R.playerSeasons.filter((s) => lgOf.get(s.teamId) === lg.leagueId);
    const bats = inLg.filter((s) => R.byId.get(s.playerId).role === 'fielder');
    const pits = inLg.filter((s) => R.byId.get(s.playerId).role === 'pitcher');
    // 本塁打王＝当リーグ最多HR
    const maxHr = Math.max(...bats.map((s) => s.batting.hr));
    assert.equal(R.playerSeasons.find((s) => s.playerId === lg.titles.homeRun.playerId).batting.hr, maxHr, `HR王(${lg.leagueId})`);
    // 打点王・盗塁王
    assert.equal(R.byId.get(lg.titles.rbi.playerId) && R.playerSeasons.find((s) => s.playerId === lg.titles.rbi.playerId).batting.rbi, Math.max(...bats.map((s) => s.batting.rbi)), `打点王(${lg.leagueId})`);
    assert.equal(R.playerSeasons.find((s) => s.playerId === lg.titles.steal.playerId).batting.sb, Math.max(...bats.map((s) => s.batting.sb)), `盗塁王(${lg.leagueId})`);
    // 首位打者＝規定打席到達者の最高打率
    const qbats = bats.filter((s) => s.batting.pa >= qPA);
    const maxAvg = Math.max(...qbats.map((s) => (s.batting.ab ? s.batting.h / s.batting.ab : 0)));
    const champ = R.playerSeasons.find((s) => s.playerId === lg.titles.battingAvg.playerId);
    assert.ok(Math.abs((champ.batting.h / champ.batting.ab) - maxAvg) < 1e-9, `首位打者(${lg.leagueId})は規定到達の最高打率`);
    assert.ok(champ.batting.pa >= qPA, '首位打者は規定打席を満たす');
    // 最多勝・最多奪三振・最多セーブ
    assert.equal(R.playerSeasons.find((s) => s.playerId === lg.titles.wins.playerId).pitching.w, Math.max(...pits.map((s) => s.pitching.w)), `最多勝(${lg.leagueId})`);
    assert.equal(R.playerSeasons.find((s) => s.playerId === lg.titles.strikeoutsP.playerId).pitching.so, Math.max(...pits.map((s) => s.pitching.so)), `最多奪三振(${lg.leagueId})`);
    if (lg.titles.save) assert.equal(R.playerSeasons.find((s) => s.playerId === lg.titles.save.playerId).pitching.sv, Math.max(...pits.map((s) => s.pitching.sv)), `最多セーブ(${lg.leagueId})`);
    // 最優秀防御率＝規定投球回到達者の最小ERA
    const qpits = pits.filter((s) => s.pitching.outs / 3 >= qIP);
    if (lg.titles.era) {
      const minEra = Math.min(...qpits.map((s) => evalSeason(s, R.byId.get(s.playerId), cfg, lc).era));
      const eraChamp = evalSeason(R.playerSeasons.find((s) => s.playerId === lg.titles.era.playerId), R.byId.get(lg.titles.era.playerId), cfg, lc);
      assert.ok(Math.abs(eraChamp.era - minEra) < 1e-9, `最優秀防御率(${lg.leagueId})`);
    }
  }
});

test('C4: MVPはリーグ最高WAR／ベストナインは各ポジションWAR最良／守備の栄誉賞はdefScore最良', () => {
  const lc = seasonLeagueConstants(R.playerSeasons, R.standings);
  const evOf = (id) => evalSeason(R.playerSeasons.find((s) => s.playerId === id), R.byId.get(id), cfg, lc);
  for (const lg of AW.leagues) {
    const inLg = R.playerSeasons.filter((s) => lgOf.get(s.teamId) === lg.leagueId);
    // MVP = リーグ最高WAR
    const maxWar = Math.max(...inLg.map((s) => evalSeason(s, R.byId.get(s.playerId), cfg, lc).war));
    assert.ok(Math.abs(evOf(lg.mvp.playerId).war - maxWar) < 1e-9, `MVP(${lg.leagueId})はWAR最高`);
    // ベストナイン: 各ポジションで、そのポジションの選手中WAR最良
    for (const b of lg.bestNine) {
      if (b.pos === 'P') continue; // Pは先発格ゲートありなので別途
      const atPos = inLg.filter((s) => R.byId.get(s.playerId).primaryPos === b.pos);
      const maxPosWar = Math.max(...atPos.map((s) => evalSeason(s, R.byId.get(s.playerId), cfg, lc).war));
      assert.ok(Math.abs(evOf(b.playerId).war - maxPosWar) < 1e-9, `ベストナイン ${b.pos}(${lg.leagueId})`);
      assert.equal(R.byId.get(b.playerId).primaryPos, b.pos, 'ベストナインは該当ポジション');
    }
    // 守備の栄誉賞: defScore が当ポジション最良（イニングゲート済み集合で）
    const A = cfg.tuning.awards;
    for (const g of lg.gloves) {
      const atPos = inLg.filter((s) => R.byId.get(s.playerId).primaryPos === g.pos && R.byId.get(s.playerId).role === 'fielder')
        .map((s) => ({ id: s.playerId, ev: evalSeason(s, R.byId.get(s.playerId), cfg, lc) }))
        .filter((x) => x.ev.innings >= A.gloveMinInnings);
      const best = Math.max(...atPos.map((x) => x.ev.defScore));
      assert.ok(Math.abs(g.defScore - best) < 1e-9, `守備の栄誉賞 ${g.pos}(${lg.leagueId})はdefScore最良`);
    }
  }
});

test('C4: ノーヒットノーラン／完全試合／サイクル安打／猛打賞の検出（イベント列の純関数）', () => {
  const start = { type: 'start', home: 'A', away: 'B' };
  const end = { type: 'end', home: 'A', away: 'B', homeScore: 3, awayScore: 0, innings: 9 };
  const pa = (pitTeam, batTeam, batterId, result) => ({ type: 'pa', pitTeam, batTeam, batterId, result, outcome: result === 'out' ? 'inPlay' : result });
  // A投手が B打線を無安打・無走者 → 完全試合。B投手は A打線に多数の安打を許す（普通の試合）。
  const perfectEvents = [start];
  for (let i = 0; i < 27; i++) perfectEvents.push(pa('A', 'B', 'B' + (i % 9), 'out'));
  for (let i = 0; i < 20; i++) perfectEvents.push(pa('B', 'A', 'A' + (i % 9), i % 3 === 0 ? '1B' : 'out'));
  perfectEvents.push(end);
  const pg = detectGameNotables(perfectEvents).notables;
  assert.ok(pg.some((n) => n.kind === 'perfectGame' && n.teamId === 'A'), '完全試合を検出');
  assert.ok(!pg.some((n) => n.kind === 'noHitter' && n.kind !== 'perfectGame' ? false : n.kind === 'noHitter'), '完全試合は noHitter と二重計上しない');

  // ノーヒッター（無安打だが四球で走者は出る＝完全ではない）。
  const nhEvents = [start];
  for (let i = 0; i < 26; i++) nhEvents.push(pa('A', 'B', 'B' + (i % 9), 'out'));
  nhEvents.push(pa('A', 'B', 'B0', 'BB')); // 四球で出塁
  for (let i = 0; i < 5; i++) nhEvents.push(pa('B', 'A', 'A0', '1B'));
  nhEvents.push(end);
  const nh = detectGameNotables(nhEvents).notables;
  assert.ok(nh.some((n) => n.kind === 'noHitter' && n.teamId === 'A'), 'ノーヒットノーランを検出');
  assert.ok(!nh.some((n) => n.kind === 'perfectGame'), '四球ありは完全試合でない');

  // サイクル安打＋猛打賞（同一打者が単/二/三/本を1試合で）。
  const cyEvents = [start,
    pa('B', 'A', 'HERO', '1B'), pa('B', 'A', 'HERO', '2B'), pa('B', 'A', 'HERO', '3B'), pa('B', 'A', 'HERO', 'HR'),
    pa('A', 'B', 'X', 'out'), end];
  const cy = detectGameNotables(cyEvents).notables;
  assert.ok(cy.some((n) => n.kind === 'cycle' && n.batterId === 'HERO'), 'サイクル安打を検出');
  assert.ok(cy.some((n) => n.kind === 'multiHit' && n.batterId === 'HERO' && n.hits === 4), '猛打賞（4安打）を検出');

  // 3安打の別打者は cycle ではなく multiHit のみ。
  const mhEvents = [start, pa('B', 'A', 'M', '1B'), pa('B', 'A', 'M', '1B'), pa('B', 'A', 'M', '2B'), pa('A', 'B', 'x', 'out'), end];
  const mh = detectGameNotables(mhEvents).notables;
  assert.ok(mh.some((n) => n.kind === 'multiHit' && n.batterId === 'M'), '3安打で猛打賞');
  assert.ok(!mh.some((n) => n.kind === 'cycle'), '4種未満はサイクルでない');
});

// --- 合成 careerStats（二つ名/マイルストーン用） --------------------------------
function batSeason(playerId, season, o) {
  const b = { pa: 0, ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, so: 0, sf: 0, sb: 0, cs: 0, rbi: 0, ibb: 0, ...o };
  return { playerId, season, teamId: 'T1', batting: b, pitching: null, baserunning: {}, fielding: { positionOuts: {} } };
}
function pitSeason(playerId, season, o) {
  const p = { outs: 0, bf: 0, h: 0, hr: 0, bb: 0, ibb: 0, hbp: 0, so: 0, er: 0, r: 0, w: 0, l: 0, sv: 0, hld: 0, g: 0, gs: 0, ...o };
  return { playerId, season, teamId: 'T1', batting: null, pitching: p, baserunning: {}, fielding: { positionOuts: {} } };
}

test('C4: 二つ名が通算観測パターンに対応（大砲/韋駄天/精密機械/ドクターK/守護神）', () => {
  const bat = createPlayer({ id: 'SL', role: 'fielder', primaryPos: 'LF' });
  const pit = createPlayer({ id: 'PC', role: 'pitcher', primaryPos: 'P' });
  const mk = (player, mkSeason, per) => Array.from({ length: 12 }, (_, i) => mkSeason(player.id, 2026 + i, per));

  // 巨砲: 12季 × 45HR = 540 → 巨砲（>=350）
  assert.equal(nicknameFor(bat, mk(bat, batSeason, { pa: 600, ab: 540, h: 150, hr: 45, b1: 80, b2: 25, sb: 2 }), cfg), '巨砲');
  // 韋駄天: 12季 × 40SB = 480（HRは低い）→ 韋駄天（SB優先）
  assert.equal(nicknameFor(bat, mk(bat, batSeason, { pa: 600, ab: 550, h: 150, hr: 5, b1: 130, sb: 40 }), cfg), '韋駄天');
  // 大砲: 12季 × 22HR = 264 → 大砲（200〜350）
  assert.equal(nicknameFor(bat, mk(bat, batSeason, { pa: 600, ab: 550, h: 145, hr: 22, b1: 100, b2: 20, sb: 3 }), cfg), '大砲');
  // 精密機械: 12季 × (200IP=600outs, bb30) → bbPer9=1.35 → 精密機械
  assert.equal(nicknameFor(pit, mk(pit, pitSeason, { outs: 600, bf: 800, so: 120, bb: 30, gs: 28, g: 28 }), cfg), '精密機械');
  // ドクターK: 12季 × (150IP=450outs, bb60, so180) → kPer9=10.8, bbPer9=3.6 → ドクターK
  assert.equal(nicknameFor(pit, mk(pit, pitSeason, { outs: 450, bf: 650, so: 180, bb: 60, gs: 26, g: 26 }), cfg), 'ドクターK');
  // 守護神: 12季 × (60IP=180outs, sv30) → 通算S=360 → 守護神（SV最優先）
  assert.equal(nicknameFor(pit, mk(pit, pitSeason, { outs: 180, bf: 240, so: 70, bb: 20, sv: 30, g: 60 }), cfg), '守護神');
  // サンプル薄い（PA/IPゲート未満）は「未知数」
  assert.equal(nicknameFor(bat, [batSeason('SL', 2026, { pa: 200, ab: 180, h: 60, hr: 30 })], cfg), '未知数');
});

test('C4: 通算マイルストーンは跨いだ年だけ通知（crossing検出）', () => {
  const p = createPlayer({ id: 'HIT', role: 'fielder', primaryPos: 'CF' });
  const byId = new Map([['HIT', p]]);
  const cs = [];
  for (let i = 0; i < 10; i++) cs.push(batSeason('HIT', 2026 + i, { pa: 620, ab: 560, h: 199, b1: 150, b2: 30, hr: 15 })); // 1990本
  cs.push(batSeason('HIT', 2036, { pa: 620, ab: 560, h: 20, b1: 18, hr: 1 })); // 通算2010 → 2000本跨ぐ
  const cross = milestones({ careerStats: cs, playersById: byId, cfg, year: 2036 });
  assert.ok(cross.some((m) => m.category === '通算安打' && m.threshold === 2000), '2000本安打を跨いだ年に通知');
  // 前年（2035・通算1990）には 2000 通知は出ない
  const before = milestones({ careerStats: cs, playersById: byId, cfg, year: 2035 });
  assert.ok(!before.some((m) => m.threshold === 2000), '未到達年は通知しない');
  // 同じ2000本を翌年に再通知しない（crossing のみ）
  cs.push(batSeason('HIT', 2037, { pa: 620, ab: 560, h: 180, b1: 150, hr: 10 }));
  const after = milestones({ careerStats: cs, playersById: byId, cfg, year: 2037 });
  assert.ok(!after.some((m) => m.threshold === 2000 && m.category === '通算安打'), '一度跨いだ記録は再通知しない');
});

test('C4: 連勝連敗カウント／週次ダイジェスト見出し（実データ差し込み）', () => {
  const g = (home, away, hs, as) => ({ home, away, homeScore: hs, awayScore: as, tie: false });
  const log = [g('T1', 'T2', 5, 1), g('T1', 'T2', 3, 2), g('T3', 'T1', 0, 4)]; // T1: 3連勝(最後は完封勝ち)
  assert.deepEqual(streakOf(log, 'T1'), { type: 'W', len: 3 }, 'T1は3連勝');
  const nameOf = (id) => ({ T1: 'タイガース', T2: 'ドラゴンズ', T3: 'カープ' }[id] || id);
  const standings = [
    { teamId: 'T1', league: 'C', w: 80, l: 40, t: 0, rs: 500, ra: 400 },
    { teamId: 'T2', league: 'C', w: 60, l: 60, t: 0, rs: 450, ra: 460 },
    { teamId: 'T3', league: 'C', w: 55, l: 65, t: 0, rs: 430, ra: 470 },
  ];
  const heads = weeklyDigest({ gameLog: log, standings, teamId: 'T1', nameOf });
  const txt = heads.map((h) => h.text).join(' | ');
  assert.ok(/3連勝/.test(txt), `連勝見出し（${txt}）`);
  assert.ok(/首位/.test(txt), `首位見出し（${txt}）`);
  assert.ok(/完封/.test(txt), `完封見出し（${txt}）`);
});

test('C4: 記録（リーグ記録トップN・球団史）が観測集計から出る', () => {
  const rec = leagueRecords({ careerStats: R.st.careerStats, playersById: R.byId, cfg });
  assert.equal(rec.seasonHR.length, Math.min(cfg.tuning.awards.topN, rec.seasonHR.length), 'シーズンHRトップN');
  // 降順ソート
  for (let i = 1; i < rec.seasonHR.length; i++) assert.ok(rec.seasonHR[i - 1].value >= rec.seasonHR[i].value, 'HR記録は降順');
  const th = teamRecords(R.st.teamHistory, 'T1');
  assert.equal(th.length, R.st.teamHistory.length, '球団史は年数ぶん');
  assert.ok(th[0].rank >= 1 && th[0].rank <= 6, '順位は自リーグ内1〜6位');
});

test('C4: 決定論 — 同一入力の表彰は一致／別シードは別の表彰', () => {
  const aw2 = computeSeasonAwards({ playerSeasons: R.playerSeasons, standings: R.standings, playersById: R.byId, cfg, allCareerStats: R.st.careerStats, year: R.year });
  assert.equal(JSON.stringify(aw2), JSON.stringify(AW), '同一入力は bit 一致');
  const B = realSeason(SEED + 11);
  const awB = computeSeasonAwards({ playerSeasons: B.playerSeasons, standings: B.standings, playersById: B.byId, cfg, allCareerStats: B.st.careerStats, year: B.year });
  assert.notEqual(JSON.stringify(awB.leagues.map((l) => l.mvp.playerId)), JSON.stringify(AW.leagues.map((l) => l.mvp.playerId)), '別シードは別MVP');
});

test('C4: advanceYear が off.awards / off.milestones を決定論で返す（2年目以降・1年目は表彰=集計表示のみ）', () => {
  const run = (seed) => {
    const st = newGame(seed, 'T1', { cfg });
    advanceTo(st, 'seasonEnd');
    const off = advanceYear(st);
    return off;
  };
  const o1 = run(SEED);
  const o2 = run(SEED);
  assert.ok(o1.awards && o1.awards.leagues.length === 2, 'off.awards が2リーグぶん付く');
  assert.equal(JSON.stringify(o1.awards), JSON.stringify(o2.awards), 'off.awards は決定論');
  assert.ok(Array.isArray(o1.milestones), 'off.milestones が配列');
  // 開幕年（1年目完了時）は新人王を付与しない（全員デビュー）
  for (const lg of o1.awards.leagues) assert.equal(lg.roty, null, '開幕年は新人王なし');
});

test('C4: 引退選手が通算記録・受賞履歴から脱落しない（allPlayersById・検証修正の回帰）', () => {
  // 複数年運用して引退選手を出し、記録/受賞履歴が「現役のみ」byId では脱落するが
  // allPlayersById（現役＋引退者サマリ）では保持されることを不変量として検証。
  const st = newGame(SEED, 'T1', { cfg });
  for (let y = 0; y < 6; y++) {
    advanceTo(st, 'seasonEnd');
    if (y < 5) advanceYear(st);
  }
  assert.ok(st.retiredPlayers.length > 0, `引退選手が発生している（${st.retiredPlayers.length}）`);

  const activeById = new Map(st.league.players.map((p) => [p.id, p]));
  const allById = allPlayersById(st);
  assert.ok(allById.size > activeById.size, '全時代byIdは現役byIdより大きい（引退者を含む）');

  // careerStats には引退選手のシーズンが残っており、その id は活動byIdには無いが全時代byIdにはある
  const retiredIdInStats = st.careerStats
    .map((s) => s.playerId)
    .find((id) => !activeById.has(id) && allById.has(id));
  assert.ok(retiredIdInStats, 'careerStatsに現役外(引退)選手のシーズンが残っている');

  // リーグ記録: 現役のみbyIdだと引退選手の通算/シーズン記録が落ちる。全時代byIdなら残る。
  const recActive = leagueRecords({ careerStats: st.careerStats, playersById: activeById, cfg });
  const recAll = leagueRecords({ careerStats: st.careerStats, playersById: allById, cfg });
  const idsIn = (rec) => new Set(Object.values(rec).flat().map((r) => r.playerId ?? r.id).filter(Boolean));
  const retiredInAll = [...idsIn(recAll)].some((id) => !activeById.has(id));
  assert.ok(retiredInAll, '全時代byIdのリーグ記録に引退選手が含まれる');
  assert.ok(idsIn(recAll).size >= idsIn(recActive).size, '全時代byIdの記録は現役のみより脱落が少ない');

  // 受賞履歴: 引退選手のIDでも過去年の受賞が全時代byIdなら再計算で拾える（純関数・例外なし）
  const hist = playerAwardHistory(retiredIdInStats, {
    careerStats: st.careerStats, teamHistory: st.teamHistory, playersById: allById, cfg,
  });
  assert.ok(Array.isArray(hist), '引退選手の受賞履歴が例外なく計算できる');
});

test('C4: 表彰は 1年目レギュラーシーズンのシムを一切変えない（集計/表示のみ・エンジン不変）', () => {
  // 表彰計算はセーブ/状態を変えない純関数。計算前後で careerStats/teamHistory が不変。
  const before = JSON.stringify({ cs: R.st.careerStats.length, th: R.st.teamHistory.length });
  computeSeasonAwards({ playerSeasons: R.playerSeasons, standings: R.standings, playersById: R.byId, cfg, allCareerStats: R.st.careerStats, year: R.year });
  const after = JSON.stringify({ cs: R.st.careerStats.length, th: R.st.teamHistory.length });
  assert.equal(after, before, '表彰計算は状態を変えない');
});

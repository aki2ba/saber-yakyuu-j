// ============================================================================
// F2-2: 出場登録29人＋二軍リーグ（phaseF_spec F2-2）
//
// 主張:
//   1) 出場登録: 各球団29人（投手14/野手15）が支配下70人から選抜され、一軍デプスチャートは
//      登録者のみから編成される。登録外の支配下＋育成＝二軍ロスター（人数整合）。
//   2) 二軍リーグ: 12球団のファームが2リーグ（完全架空名・一軍と同分割）で110試合を
//      一軍と同じ day カレンダーで並走し、一軍シーズン終了までに全消化される（順位表も確定）。
//   3) 二軍平均年齢 < 一軍平均年齢（二軍=一軍に及ばない選手＋成長曲線途中の若手）。
//   4) farmStats は一軍 stats と完全分離（同一選手が両方に出場記録を持たない・§17集計値のみ）。
//   5) 決定論: 同一シードの再実行で二軍順位/集計が bit 一致。
//   6) セーブ/ロード: 途中セーブ→ロードで二軍の進行位置/順位が復元され、続行結果が
//      無セーブ通しと完全一致（schemaVersion v3・旧版セーブは明示拒否）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, save, load, advanceYear, SCHEMA_VERSION } from '../src/game/index.mjs';

const SEED = 20260702;

/** 二軍順位のシグネチャ（決定論/復元の突合用） */
function farmSig(st) {
  return JSON.stringify(
    [...st.rt.farm.standings.values()].map((r) => [r.teamId, r.w, r.l, r.t, r.rs, r.ra]),
  );
}

/** 集計器の全選手ラインのシグネチャ */
function statsSig(statsMap) {
  return JSON.stringify([...statsMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

// 1世界を1年通しで回して各主張で使い回す（テスト時間の節約）
const cfg = createConfig();
const ST = newGame(SEED, 'T1', { cfg });
const FARM_ROSTERS = new Map(
  ST.league.teams.map((t) => [t.id, ST.rt.farm.rosterByTeam.get(t.id).slice()]),
);
advanceTo(ST, 'seasonEnd');

test('F2-2: 出場登録29人（投手14/野手15）＝一軍デプスチャートは登録者のみ', () => {
  for (const t of ST.league.teams) {
    const reg = ST.rt.registeredByTeam.get(t.id);
    assert.equal(reg.size, cfg.league.rosterActive, `${t.id}: 登録${cfg.league.rosterActive}人`);
    const regPlayers = ST.league.players.filter((p) => reg.has(p.id));
    const nP = regPlayers.filter((p) => p.role === 'pitcher').length;
    assert.equal(nP, cfg.tuning.roster.activePitchers, `${t.id}: 登録投手14人`);
    // デプスチャート（DH有/無とも）は登録者のみから編成される
    const charts = ST.rt.chartsByTeam.get(t.id);
    for (const chart of [charts.dh, charts.noDh]) {
      assert.equal(chart.byId.size, reg.size);
      for (const pid of chart.byId.keys()) assert.ok(reg.has(pid), `${t.id}: ${pid} は登録者`);
    }
    // 捕手2人体制（守備8ポジ＋控え捕手の保証）
    const nC = regPlayers.filter((p) => p.primaryPos === 'C').length;
    assert.ok(nC >= 2, `${t.id}: 登録捕手${nC}>=2`);
  }
});

test('F2-2: 二軍ロスター＝登録外の支配下＋育成（人数整合・各ポジ残置・シーズン終了後も不変）', () => {
  // 旧テストは開幕直後に固定した FARM_ROSTERS（season-start snapshot）を、シーズン終了後の
  // registeredByTeam と突き合わせていたため、R2（1年目からのF2-3出場登録入替）でシーズン中に
  // 選手が昇格/降格すると必然的に食い違っていた（検証方法の誤りであり、バグではない）。
  // roster_moves.mjs の swapRegistration を読むと、rt.registeredByTeam と rt.farm.rosterByTeam は
  // 常に1:1で同期して書き換えられる（昇格1名を registeredByTeam に足すたび、降格1名を
  // farm.rosterByTeam に足す）。つまり「"現在の"二軍ロスターと"現在の"登録が互いに素」という
  // 不変条件は、開幕直後だけでなくシーズンを通じて（入替が起きた後も）常に成立する。
  // これをシーズン終了時点の"現在の"状態同士で直接検証する（比較時点を揃えることが本質）。
  for (const t of ST.league.teams) {
    const reg = ST.rt.registeredByTeam.get(t.id);
    const controlled = ST.league.players.filter((p) => p.teamId === t.id);
    const dev = ST.league.farm.filter((p) => p.teamId === t.id);
    const farmRoster = ST.rt.farm.rosterByTeam.get(t.id); // シーズン終了時点の"現在の"二軍ロスター
    assert.equal(farmRoster.length, controlled.length - reg.size + dev.length, `${t.id}: 人数整合`);
    for (const p of farmRoster) assert.ok(!reg.has(p.id), `${t.id}: 二軍に登録者が混ざらない`);
    // 選抜が各主ポジションに野手を残す（farmKeepPerPos）＝二軍のデプスチャート成立
    const byPos = new Map();
    for (const p of farmRoster) {
      if (p.role === 'fielder') byPos.set(p.primaryPos, (byPos.get(p.primaryPos) ?? 0) + 1);
    }
    for (const pos of ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']) {
      assert.ok((byPos.get(pos) ?? 0) >= cfg.tuning.roster.farmKeepPerPos, `${t.id}: 二軍${pos}が${cfg.tuning.roster.farmKeepPerPos}人以上`);
    }
  }
});

test('F2-2: 二軍リーグ110試合が全消化され順位表が確定する（2リーグ・一軍と同分割）', () => {
  const f = ST.rt.farm;
  assert.ok(f.finished, '一軍シーズン終了時点で二軍も全消化');
  assert.equal(f.cursor, f.schedule.length);
  assert.equal(f.schedule.length, (cfg.league.farm.gamesPerSeason * 12) / 2, '総試合660');
  assert.equal(f.table.length, 12);
  for (const row of f.table) {
    assert.equal(row.w + row.l + row.t, cfg.league.farm.gamesPerSeason, `${row.teamId}: 110試合`);
  }
  // 2リーグ×6球団・一軍と同分割（親リーグL1→F1 / L2→F2）
  const ids = cfg.league.farm.leagues.map((l) => l.id);
  for (const lid of ids) assert.equal(f.standingsByLeague[lid].length, 6);
  const parentIds = cfg.league.leagues.map((l) => l.id);
  for (const t of ST.league.teams) {
    const ft = f.teamById.get(t.id);
    assert.equal(ft.league, ids[parentIds.indexOf(t.league)], `${t.id}: 親と同分割`);
  }
});

test('F2-2: 二軍平均年齢 < 一軍平均年齢（若手＋一軍に及ばない選手の置き場）', () => {
  const regIds = new Set([...ST.rt.registeredByTeam.values()].flatMap((s) => [...s]));
  const majors = ST.league.players.filter((p) => regIds.has(p.id));
  const farm = [...FARM_ROSTERS.values()].flat();
  const avg = (xs) => xs.reduce((a, p) => a + p.age, 0) / xs.length;
  assert.ok(avg(farm) < avg(majors), `二軍${avg(farm).toFixed(2)} < 一軍${avg(majors).toFixed(2)}`);
});

test('F2-2: 集計器の分離 — rt.stats と rt.farm.stats は別オブジェクトで記録が混線しない', () => {
  // 旧テストは「同一選手が一軍/二軍の両方に出場記録を持たない」ことを不変条件としていたが、
  // これ自体が非現実的だった。現実のNPBでも、シーズン中に昇格/降格した選手（R2のF2-3入替や
  // 育成→支配下の季節中昇格）は一軍・二軍の双方に成績を持つのが正常な帰結である。
  // 本来の主旨は「集計器（一軍 rt.stats と二軍 rt.farm.stats）が混線していない」ことなので、
  // それを直接検証する：(1) 別オブジェクトであること、(2) 昇降格選手の一軍/二軍ラインが
  // 別インスタンスであること（参照共有なら混線しうる）、(3) 一軍専従選手の二軍ラインは
  // 空（pa=0/outs=0）＝一軍の記録が二軍側へ漏れていないこと。
  const majPids = new Set(ST.rt.stats.stats.keys());
  const farmPids = new Set(ST.rt.farm.stats.stats.keys());
  assert.ok(majPids.size > 0 && farmPids.size > 0);

  // 集計器そのものが別オブジェクト（将来のリファクタで誤って同一Mapを共有しないことの門番）
  assert.notStrictEqual(ST.rt.stats.stats, ST.rt.farm.stats.stats, '一軍/二軍の集計器(Map)は別オブジェクト');
  assert.notStrictEqual(ST.rt.stats, ST.rt.farm.stats, '一軍/二軍の集計器インスタンスは別物');

  // 昇降格で両方に出場記録を持つ選手が実際に存在する（正常な帰結として許容・強制はしない）
  const dualPids = [...majPids].filter((pid) => farmPids.has(pid));
  assert.ok(dualPids.length > 0, '昇降格した選手は一軍・二軍の両方に出場記録を持つ（正常）');
  for (const pid of dualPids) {
    // 混線していれば同一オブジェクト参照や値の伝播が起きうる。別ラインオブジェクトであることを確認する。
    assert.notStrictEqual(ST.rt.stats.getBat(pid), ST.rt.farm.stats.getBat(pid), `${pid}: 一軍/二軍の打撃ラインが別オブジェクト`);
    assert.notStrictEqual(ST.rt.stats.getPitch(pid), ST.rt.farm.stats.getPitch(pid), `${pid}: 一軍/二軍の投球ラインが別オブジェクト`);
  }

  // 一軍にしか出場記録の無い選手は、二軍側では「空ライン」のまま（混線していれば非ゼロになるはず）
  const majOnly = [...majPids].filter((pid) => !farmPids.has(pid));
  assert.ok(majOnly.length > 0);
  for (const pid of majOnly) {
    assert.equal(ST.rt.farm.stats.getBat(pid).pa, 0, `${pid}: 一軍専従選手は二軍打席が0（混線なし）`);
    assert.equal(ST.rt.farm.stats.getPitch(pid).outs, 0, `${pid}: 一軍専従選手は二軍投球アウトが0（混線なし）`);
  }

  // 育成選手（league.farm）にも二軍出場記録が付く
  const devWithStats = ST.league.farm.filter((p) => farmPids.has(p.id));
  assert.ok(devWithStats.length > 0, '育成選手が二軍戦に出場する');
  // per-(player,season) で記録される
  for (const s of ST.rt.farm.stats.stats.values()) {
    assert.equal(s.season, ST.year);
    break;
  }
});

test('F2-2: シーズン完了で careerFarmStats/teamHistory.farmStandings が永続化される', () => {
  assert.ok(ST.careerFarmStats.length > 0, '二軍集計が一軍と別領域に積まれる');
  assert.ok(ST.careerStats.length > 0);
  const hist = ST.teamHistory[0];
  assert.ok(Array.isArray(hist.farmStandings) && hist.farmStandings.length === 12, '二軍順位が記録される');
  for (const row of hist.farmStandings) assert.equal(row.w + row.l + row.t, cfg.league.farm.gamesPerSeason);
});

test('F2-2: 決定論 — 同一シード再実行で二軍順位/集計が bit 一致', () => {
  const a = newGame(777, 'T2', { cfg: createConfig() });
  advanceTo(a, 'seasonEnd');
  const b = newGame(777, 'T2', { cfg: createConfig() });
  advanceTo(b, 'seasonEnd');
  assert.equal(farmSig(a), farmSig(b), '二軍順位が一致');
  assert.equal(statsSig(a.rt.farm.stats.stats), statsSig(b.rt.farm.stats.stats), '二軍集計が一致');
});

test('F2-2: 途中セーブ/ロードで二軍が復元され、続行が無セーブ通しと完全一致（v3）', () => {
  const live = newGame(555, 'T3', { cfg: createConfig() });
  advanceTo(live, 'monthEnd');
  const blob = JSON.parse(JSON.stringify(save(live)));
  assert.equal(blob.schemaVersion, SCHEMA_VERSION);
  assert.ok(blob.seasonState.farm && blob.seasonState.farm.cursor > 0, '二軍の進行がセーブに載る');
  // R5: 集計は列指向の数値エンコードで保存される（{v,paths,rows,detail}）
  assert.ok(blob.farmPlayers && Array.isArray(blob.farmPlayers.rows) && blob.farmPlayers.rows.length > 0, '二軍の当年集計がセーブに載る');
  const restored = load(blob, { cfg: createConfig() });
  assert.equal(restored.rt.farm.cursor, live.rt.farm.cursor, '二軍cursorが復元される');
  assert.equal(farmSig(restored), farmSig(live), '二軍順位が復元される');
  assert.equal(statsSig(restored.rt.farm.stats.stats), statsSig(live.rt.farm.stats.stats), '二軍集計が復元される');
  advanceTo(live, 'seasonEnd');
  advanceTo(restored, 'seasonEnd');
  assert.equal(farmSig(restored), farmSig(live), 'ロード後の続行が無セーブ通しと一致');
});

test('F2-2: 旧スキーマ（v2以前）のセーブは明示拒否される', () => {
  const live = newGame(555, 'T3', { cfg: createConfig() });
  const blob = save(live);
  blob.schemaVersion = 2;
  assert.throws(() => load(blob, { cfg: createConfig() }), /未対応のスキーマ版/);
});

test('F2-2: 2年目も二軍が並走する（オフ遷移後の再編成・farm集計が年別に積まれる）', () => {
  const st = ST; // 1年目完了済みの世界を続ける
  advanceYear(st);
  assert.ok(st.rt.farm, '2年目も二軍リーグが組まれる');
  assert.equal(st.rt.farm.cursor, 0);
  advanceTo(st, 'seasonEnd');
  assert.ok(st.rt.farm.finished);
  const seasons = new Set(st.careerFarmStats.map((s) => s.season));
  assert.equal(seasons.size, 2, '二軍集計が2年ぶん積まれる');
  assert.equal(st.teamHistory.length, 2);
  assert.ok(st.teamHistory[1].farmStandings.length === 12);
});

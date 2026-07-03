// ============================================================================
// フェーズC2a: 加齢・成長カーブ（src/game/aging.mjs）の単体テスト。
//   - 集団の加齢カーブが山型（成長→維持→衰え・§10.1）
//   - 選球眼は加齢で微増（§10.1「むしろ伸びる」）
//   - 球速は加齢で減（§10.1）／低declineRate投手ほど球速を保つ（§10.2「技巧派だけ長生き」）
//   - 晩成/鉄人が"稀に"出る（§12.4・生存バイアスで鉄人が自動レア化・§10.6）
//   - 決定論（順序非依存・同一シードで bit 一致）
//   - エンジン不変: 加齢は 2年目以降のみ。1年目レギュラーは simulateSeason と bit 同一。
//   - advanceYear（オフシーズン遷移）と多年セーブ/ロードの決定論。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';
import { hashSeed } from '../src/rng.mjs';
import { applyAging } from '../src/game/aging.mjs';
import { newGame, advanceDay, advanceTo, advanceYear, save, load } from '../src/game/index.mjs';

const cfg = createConfig();
const SEED = 20260701;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** 制御された同質コホートを作る（能力は既定50・career だけ指定）。 */
function cohort(n, { age = 20, peak = 27, dr = 0.5, role = 'fielder' } = {}) {
  const ps = [];
  for (let i = 0; i < n; i++) {
    const t = createTrueAbility({ career: { peakAge: peak, declineRate: dr } });
    ps.push(createPlayer({ id: `P${i}`, age, role, trueAbility: t }));
  }
  return ps;
}
/** players を y 年ぶん加齢させる（オフシーズンごとに派生シード）。 */
function ageYears(players, y) {
  for (let k = 0; k < y; k++) applyAging(players, cfg, { seed: hashSeed(SEED, 'off', k), yearIndex: k });
}

// --- 加齢カーブの集団特性 ----------------------------------------------------

test('C2a: 集団の加齢カーブが山型（成長→ピーク→衰え・§10.1）', () => {
  const ps = cohort(600, { age: 19, peak: 27, dr: 0.5 });
  // 身体/コンタクト系の合成（選球眼やIQのように後年伸びる軸は含めず、素直に山型を見る）
  const comp = (arr) =>
    mean(arr.map((p) => {
      const b = p.trueAbility;
      return (b.batting.contact + b.batting.ev + b.common.power + b.common.speed) / 4;
    }));
  const traj = [{ age: 19, v: comp(ps) }];
  for (let k = 0; k < 25; k++) {
    applyAging(ps, cfg, { seed: hashSeed(SEED, 'off', k), yearIndex: k });
    traj.push({ age: 20 + k, v: comp(ps) });
  }
  let peak = traj[0];
  for (const e of traj) if (e.v > peak.v) peak = e;
  assert.ok(peak.age >= 26 && peak.age <= 34, `ピークが中盤にある（age=${peak.age}）`);
  assert.ok(traj[0].v < peak.v - 1, '若年は成長余地があり平均がピーク未満');
  assert.ok(traj[traj.length - 1].v < peak.v - 2, '晩年は衰えて平均がピークを明確に下回る');
});

test('C2a: 選球眼は加齢で微増する（§10.1 むしろ伸びる）', () => {
  const ps = cohort(400, { age: 22, peak: 27, dr: 0.5 });
  const eye0 = mean(ps.map((p) => p.trueAbility.batting.eye));
  ageYears(ps, 10); // 22→32
  const eye1 = mean(ps.map((p) => p.trueAbility.batting.eye));
  assert.ok(eye1 > eye0 + 2, `選球眼が加齢で上がる（${eye0.toFixed(1)}→${eye1.toFixed(1)}）`);
});

test('C2a: 球速は加齢で下がる（§10.1）', () => {
  const ps = cohort(400, { age: 28, peak: 27, dr: 0.6, role: 'pitcher' });
  const v0 = mean(ps.map((p) => p.trueAbility.pitching.velocityKmh));
  ageYears(ps, 8); // 28→36
  const v1 = mean(ps.map((p) => p.trueAbility.pitching.velocityKmh));
  assert.ok(v1 < v0 - 1, `球速が加齢で落ちる（${v0.toFixed(1)}→${v1.toFixed(1)}）`);
});

test('C2a: 低declineRate の投手ほど球速を保つ（§10.2 技巧派だけ長生き）', () => {
  const league = generateLeague(SEED, cfg);
  const pit = league.players.filter((p) => p.role === 'pitcher');
  const velo0 = new Map(pit.map((p) => [p.id, p.trueAbility.pitching.velocityKmh]));
  for (let y = 0; y < 10; y++) applyAging(league.players, cfg, { seed: hashSeed(SEED, 'off', y), yearIndex: y });
  const sorted = [...pit].sort((a, b) => a.trueAbility.career.declineRate - b.trueAbility.career.declineRate);
  const half = Math.floor(sorted.length / 2);
  const loss = (p) => velo0.get(p.id) - p.trueAbility.pitching.velocityKmh;
  const loLoss = mean(sorted.slice(0, half).map(loss)); // 低declineRate 群
  const hiLoss = mean(sorted.slice(half).map(loss)); // 高declineRate 群
  assert.ok(loLoss < hiLoss, `低dr群の球速低下 < 高dr群（${loLoss.toFixed(2)} < ${hiLoss.toFixed(2)}）`);
});

test('C2a: 晩成/鉄人が"稀に"出る（§12.4・生存バイアス §10.6）', () => {
  const league = generateLeague(SEED, cfg);
  const pit = league.players.filter((p) => p.role === 'pitcher');
  const fld = league.players.filter((p) => p.role === 'fielder');
  for (let y = 0; y < 10; y++) applyAging(league.players, cfg, { seed: hashSeed(SEED, 'off', y), yearIndex: y });

  // 鉄人（山本昌/石川雅規型）: 高齢でも球速と制球が生きる投手。存在するが少数。
  const ironmen = pit.filter(
    (p) => p.age >= 36 && p.trueAbility.pitching.velocityKmh >= 143 && p.trueAbility.pitching.control >= 55,
  );
  assert.ok(ironmen.length >= 1, '鉄人型が存在する');
  assert.ok(ironmen.length < pit.length * 0.15, `鉄人は稀（${ironmen.length}/${pit.length}）`);

  // 老投手のうち"まだ速球で押せる"のは少数派＝速球派は長生きしない（生存バイアス）。
  const oldPit = pit.filter((p) => p.age >= 38);
  const stillHard = oldPit.filter((p) => p.trueAbility.pitching.velocityKmh >= 148);
  assert.ok(stillHard.length < oldPit.length * 0.5, `老投手の大半は球速を失う（${stillHard.length}/${oldPit.length}）`);

  // 晩成（和田型）: 高齢でも LA最適化が伸びた打者が存在する。
  const lateBloomers = fld.filter((p) => p.age >= 35 && p.trueAbility.batting.la >= 58);
  assert.ok(lateBloomers.length >= 1, '晩成型（LA最適化が伸びた打者）が存在する');
});

test('C2a: 決定論（同一シード・順序非依存で bit 一致）', () => {
  const a = cohort(50, { age: 20 });
  const b = cohort(50, { age: 20 }); // 同一 id・同一初期値
  const seed = hashSeed(SEED, 'det');
  applyAging(a, cfg, { seed, yearIndex: 0 });
  // 逆順で適用しても id 基準派生ゆえ同一結果になる（順序非依存）
  applyAging([...b].reverse(), cfg, { seed, yearIndex: 0 });
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].age, b[i].age);
    assert.deepEqual(a[i].trueAbility, b[i].trueAbility, `選手${i}の真値が一致`);
  }
});

// --- ゲーム層への統合（advanceYear / 多年セーブ） ----------------------------

test('C2a: advanceYear は全選手 age++ し真値を動かす（決定論）', () => {
  const st1 = newGame(SEED, 'T1', { cfg });
  const agesBefore = new Map(st1.league.players.map((p) => [p.id, p.age]));
  const eyeBefore = st1.league.players.map((p) => p.trueAbility.batting.eye);
  advanceTo(st1, 'seasonEnd');
  advanceYear(st1);
  assert.equal(st1.yearIndex, 1);
  assert.equal(st1.year, cfg.game.firstSeason + 1);
  for (const p of st1.league.players) assert.equal(p.age, agesBefore.get(p.id) + 1, '全員 age++');
  const eyeAfter = st1.league.players.map((p) => p.trueAbility.batting.eye);
  assert.ok(eyeAfter.some((v, i) => v !== eyeBefore[i]), '真値が変化する');

  // 別インスタンスで同手順 → league 真値が一致（決定論）
  const st2 = newGame(SEED, 'T1', { cfg });
  advanceTo(st2, 'seasonEnd');
  advanceYear(st2);
  const sig = (st) => st.league.players.map((p) => `${p.id}:${p.age}:${p.trueAbility.batting.eye}:${p.trueAbility.pitching.velocityKmh}`).join('|');
  assert.equal(sig(st1), sig(st2), 'オフシーズン加齢が決定論的');

  // シーズン未終了で呼ぶと弾く
  const st3 = newGame(SEED, 'T1', { cfg });
  assert.throws(() => advanceYear(st3), /シーズン未終了/);
});

test('C2a: エンジン不変 — 1年目レギュラーは simulateSeason と bit 同一（加齢は2年目以降）', () => {
  const league = generateLeague(SEED, cfg);
  const bulk = simulateSeason(league, cfg, { season: cfg.game.firstSeason, seed: SEED });
  const st = newGame(SEED, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  const sig = (table) => table.map((r) => `${r.teamId}:${r.w}-${r.l}-${r.t}/${r.rs}-${r.ra}`).join('|');
  assert.equal(sig(st.rt.table), sig(bulk.standings), '1年目順位が一括APIと一致（加齢の混入なし）');
  assert.equal(st.rt.postseason.champion, bulk.postseason.champion, '1年目の日本一が一致');
});

test('C2a: 多年セーブ/ロードの決定論（advanceYear を跨いで一致）', () => {
  const statsSig = (playerSeasons) =>
    [...playerSeasons]
      .map((s) => `${s.playerId},${s.batting.pa},${s.batting.h},${s.batting.hr},${s.pitching.outs},${s.pitching.so},${s.pitching.er}`)
      .sort()
      .join(';');
  const standingsSig = (t) => t.map((r) => `${r.teamId}:${r.w}-${r.l}-${r.t}/${r.rs}-${r.ra}`).join('|');

  // 基準: 無セーブで 1年目→オフシーズン→2年目終了 まで通す
  const straight = newGame(SEED, 'T4', { cfg });
  advanceTo(straight, 'seasonEnd');
  advanceYear(straight);
  advanceTo(straight, 'seasonEnd');
  const refStand = standingsSig(straight.rt.table);
  const refStats = statsSig(straight.rt.stats.stats.values());

  // 2年目の途中でセーブ → JSON往復 → ロード → 続行
  const mid = newGame(SEED, 'T4', { cfg });
  advanceTo(mid, 'seasonEnd');
  advanceYear(mid);
  for (let i = 0; i < 30 && !mid.rt.finished; i++) advanceDay(mid);
  const blob = JSON.parse(JSON.stringify(save(mid)));
  const restored = load(blob, { cfg });
  assert.equal(restored.yearIndex, 1, '2年目のセーブが復元される');
  // ロード時に過去年の加齢が replay され真値が復元される（2年目の集計が保存時点と一致）
  assert.equal(statsSig(restored.rt.stats.stats.values()), statsSig(mid.rt.stats.stats.values()), 'ロード直後の集計が一致');
  advanceTo(restored, 'seasonEnd');
  assert.equal(standingsSig(restored.rt.table), refStand, '最終順位が無セーブ通しと一致');
  assert.equal(statsSig(restored.rt.stats.stats.values()), refStats, '最終集計が無セーブ通しと一致');
});

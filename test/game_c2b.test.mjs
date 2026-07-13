// ============================================================================
// フェーズC2b: 故障ブレイク・引退世代交代・多年運用（§10.4-10.6 / §11.1）のテスト。
//   - 20年運用が例外なく回る／リーグ人口・ロスター構成が恒常（引退＝1:1補充）
//   - 故障が確率事象として発生し、故障歴があると再発リスク（ハザード）が上がる（§10.5）
//   - ブレイクが上下両方 "稀に" 出る（球種習得/覚醒 と イップス/燃え尽き・§10.4/§11.1）
//   - 引退で世代交代（新人が debut し、集団年齢が定常に保たれる・§10.6）
//   - 生存バイアスで40代がレア（弱い個体が消え鉄人だけ残る・§10.6）
//   - 決定論（20年通しを2回で最終ロスター一致／引退込みの多年セーブ・ロード）
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceDay, advanceTo, advanceYear, save, load } from '../src/game/index.mjs';
import { injuryHazard } from '../src/sim/injury.mjs'; // R3: ハザード定義はシム層（試合中の発生と共有）
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';

const cfg = createConfig();
const SEED = 20260701;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** N年運用し、オフシーズン要約を集約して返す（重い処理なので使い回す）。 */
function runYears(seed, years, teamId = 'T1') {
  const st = newGame(seed, teamId, { cfg });
  const agg = {
    up: 0, down: 0, newPitch: 0, yips: 0, awaken: 0, burnout: 0, postInjury: 0,
    injuries: 0, majorInjuries: 0, yearsWithInjury: 0, retired: 0, firstRetire: 0,
  };
  for (let y = 0; y < years; y++) {
    advanceTo(st, 'seasonEnd');
    const off = advanceYear(st);
    if (y === 0) agg.firstRetire = off.retirees.length;
    agg.injuries += off.injuries.length;
    agg.majorInjuries += off.injuries.filter((e) => e.severity === 'major').length;
    if (off.injuries.length) agg.yearsWithInjury++;
    agg.retired += off.retirees.length;
    for (const b of off.breakouts) {
      if (b.dir === 'up') agg.up++;
      else agg.down++;
      if (b.kind === 'newPitch') agg.newPitch++;
      if (b.kind === 'yips') agg.yips++;
      if (b.kind === 'awaken') agg.awaken++;
      if (b.kind === 'burnout') agg.burnout++;
      if (b.kind === 'postInjury') agg.postInjury++;
    }
  }
  return { st, agg };
}

/** ロスターの決定論シグネチャ（id・年齢・主要真値・球種数を畳み込む）。 */
function rosterSig(st) {
  return st.league.players
    .map((p) => {
      const t = p.trueAbility;
      return `${p.id}:${p.age}:${t.batting.eye}:${t.pitching.velocityKmh}:${t.pitching.control}:${t.pitching.pitches.length}`;
    })
    .join('|');
}

// 20年運用を1回だけ回して各テストで使い回す（node:test はモジュールを1度だけ評価する）。
const YEARS = 20;
const RUN = runYears(SEED, YEARS);

test('C2b: 20年運用が例外なく回り、リーグ人口とロスター構成が恒常（§10.6）', () => {
  const { st } = RUN;
  const P = st.league.players;
  assert.equal(st.yearIndex, YEARS);
  assert.equal(st.year, cfg.game.firstSeason + YEARS);
  const R = cfg.tuning.roster;
  assert.equal(P.length, cfg.league.numTeams * R.controlledPerTeam, 'リーグ人口は恒常（引退＝1:1補充）');
  for (const t of st.league.teams) {
    const roster = P.filter((p) => p.teamId === t.id);
    const nPit = roster.filter((p) => p.role === 'pitcher').length;
    assert.equal(roster.length, R.controlledPerTeam, `${t.id} は支配下70人`);
    assert.ok(nPit >= R.pitchersMin && nPit <= R.pitchersMax, `${t.id} は投手33-36（${nPit}）`);
    assert.equal(t.playerIds.length, R.controlledPerTeam, `${t.id}.playerIds は70`);
  }
});

test('C2b: 故障が確率事象として発生する（§10.5）', () => {
  const { agg } = RUN;
  assert.ok(agg.injuries > 0, '20年で故障が発生する');
  assert.ok(agg.majorInjuries > 0, '重症故障も発生する');
  assert.ok(agg.yearsWithInjury >= YEARS - 2, 'ほぼ毎年どこかで故障が起きる（確率事象）');
});

test('C2b: 故障歴があると再発リスク（ハザード）が上がる／捕手・速球投手は高い（§10.5）', () => {
  const mk = (over, o = {}) => createPlayer({ id: 'H', age: 31, trueAbility: createTrueAbility(over), ...o });
  // 再発: 同一条件で故障歴（重症1件）ありのハザードが上がる。
  const healthy = mk({ pitching: { velocityKmh: 150 } }, { role: 'pitcher', primaryPos: 'P' });
  const scarred = mk(
    { pitching: { velocityKmh: 150 }, career: { injuryHistory: [{ year: 2030, severity: 'major', gamesLost: 100 }] } },
    { role: 'pitcher', primaryPos: 'P' },
  );
  assert.ok(injuryHazard(scarred, cfg) > injuryHazard(healthy, cfg), '故障歴ありのハザードが高い（再発）');
  // 履歴が積み増すほど単調に上がる。
  const twice = mk(
    {
      pitching: { velocityKmh: 150 },
      career: { injuryHistory: [{ year: 2030, severity: 'major', gamesLost: 100 }, { year: 2031, severity: 'minor', gamesLost: 20 }] },
    },
    { role: 'pitcher', primaryPos: 'P' },
  );
  assert.ok(injuryHazard(twice, cfg) > injuryHazard(scarred, cfg), '故障歴が増えるほどハザード増');
  // 役割の構造: 速球投手 > 制球投手（同年齢）＝投球負荷。
  const fast = mk({ pitching: { velocityKmh: 156 } }, { role: 'pitcher', primaryPos: 'P' });
  const soft = mk({ pitching: { velocityKmh: 140 } }, { role: 'pitcher', primaryPos: 'P' });
  assert.ok(injuryHazard(fast, cfg) > injuryHazard(soft, cfg), '速球投手ほど投球負荷でハザード高');

  // ★R3: 「捕手は壊れる（頻度が高い）」は**定量データに支持されない**ので撤回した。
  //   捕手の負傷率 2.75/1000 Athlete-Exposure は他ポジションより低い（Guy 2015・MLB 2001-10・
  //   PubMed 26320222）。Carr 2022 でも捕手の負傷burdenは最低(11.0%)。
  //   現実は「頻度は低いが、膝・頭頸部の負傷は重症化しやすい」→ 差は **重症度** に置いた。
  const catcher = mk({}, { role: 'fielder', primaryPos: 'C' });
  const firstBase = mk({}, { role: 'fielder', primaryPos: '1B' });
  assert.equal(
    injuryHazard(catcher, cfg),
    injuryHazard(firstBase, cfg),
    '捕手の故障"頻度"は他の野手と同じ（割増しない・Guy 2015）',
  );
  assert.ok(cfg.tuning.injury.majorCatcher > 0, '捕手の差は重症度（膝・頭頸部は離脱が長い）に置く');
});

test('C2b: ブレイクが上下両方 "稀に" 出る（§10.4/§11.1）', () => {
  const { agg } = RUN;
  const playerYears = cfg.league.numTeams * cfg.tuning.roster.controlledPerTeam * YEARS;
  assert.ok(agg.up > 0, '上方ブレイクが出る');
  assert.ok(agg.down > 0, '下方ブレイクが出る');
  assert.ok(agg.down >= agg.up, '下方≧上方（インフレ抑止・§11.1）');
  // "稀に": 上下いずれも全 player-year の 10% 未満。
  assert.ok(agg.up < playerYears * 0.1 && agg.down < playerYears * 0.1, 'ブレイクは稀な離散イベント');
  // 発火対象パラメータの差で複数の実在型が同機構から出る。
  assert.ok(agg.newPitch >= 1, '球種習得（列が生える千賀型）が起きる');
  assert.ok(agg.yips >= 1, '制球崩壊（イップス）が起きる');
});

test('C2b: 引退で世代交代が起きる（新人が debut し集団年齢が定常・§10.6）', () => {
  const { st, agg } = RUN;
  assert.ok(agg.retired > cfg.league.numTeams, '20年で多数が引退する（世代交代）');
  assert.equal(st.retiredPlayers.length, agg.retired, '引退者サマリが蓄積される');
  const P = st.league.players;
  // 新人補充で「開始時にいなかった選手」が多数を占める（birthSeason 付き＝ドラフト生成）。
  const debuts = P.filter((p) => p.birthSeason != null).length;
  assert.ok(debuts > P.length * 0.5, '半数超が新規世代に入れ替わっている');
  // 集団年齢は定常（暴走して老化/若年化しない）。
  const m = mean(P.map((p) => p.age));
  assert.ok(m > 25 && m < 31, `平均年齢が定常帯（${m.toFixed(1)}）`);
  assert.ok(Math.min(...P.map((p) => p.age)) <= cfg.game.rookieAgeMax, '若い新人が供給されている');
});

test('C2b: 生存バイアスで40代がレア（鉄人だけ残る・§10.6）', () => {
  const { st } = RUN;
  const P = st.league.players;
  const over40 = P.filter((p) => p.age >= 40).length;
  assert.ok(over40 / P.length < 0.06, `40代はレア（${over40}/${P.length}）`);
  // ただし絶対ゼロではない: 稀に鉄人（衰えなかった個体）が高齢まで残る。
  const veterans = P.filter((p) => p.age >= 37).length;
  assert.ok(veterans >= 1, 'ベテラン（37+）は少数だが存在する');
  assert.ok(veterans < P.length * 0.2, 'ベテランも全体の少数派（加齢カーブは生存バイアスで平ら化）');
});

test('C2b: 決定論 — 20年通しを2回で最終ロスターが bit 一致', () => {
  const a = runYears(SEED, YEARS);
  assert.equal(rosterSig(a.st), rosterSig(RUN.st), '同一シードの20年運用は決定論的');
  const b = runYears(SEED + 1, YEARS);
  assert.notEqual(rosterSig(b.st), rosterSig(RUN.st), '別シードは別の運命');
});

test('C2b: 引退込みの多年セーブ/ロードが決定論（replay で世代交代を再構築）', () => {
  const statsSig = (vals) =>
    [...vals]
      .map((s) => `${s.playerId},${s.batting.pa},${s.batting.h},${s.batting.hr},${s.pitching.outs},${s.pitching.so},${s.pitching.er}`)
      .sort()
      .join(';');
  const standSig = (t) => t.map((r) => `${r.teamId}:${r.w}-${r.l}-${r.t}/${r.rs}-${r.ra}`).join('|');

  // 基準: 5年目まで無セーブで通す（4回のオフシーズン＝引退/補充/故障/ブレイクを経る）。
  const straight = newGame(SEED, 'T7', { cfg });
  for (let y = 0; y < 4; y++) {
    advanceTo(straight, 'seasonEnd');
    advanceYear(straight);
  }
  advanceTo(straight, 'seasonEnd');
  const refStand = standSig(straight.rt.table);
  const refStats = statsSig(straight.rt.stats.stats.values());

  // 5年目の途中で save → JSON往復 → load → 続行。過去4オフの世代交代が replay 再構築される。
  const mid = newGame(SEED, 'T7', { cfg });
  for (let y = 0; y < 4; y++) {
    advanceTo(mid, 'seasonEnd');
    advanceYear(mid);
  }
  for (let i = 0; i < 40 && !mid.rt.finished; i++) advanceDay(mid);
  const blob = JSON.parse(JSON.stringify(save(mid)));
  const restored = load(blob, { cfg });
  assert.equal(restored.yearIndex, 4, '5年目のセーブが復元される');
  assert.equal(restored.league.players.length, mid.league.players.length, 'ロスター人口が復元される');
  assert.equal(rosterSig(restored), rosterSig(mid), 'replay で世代交代後のロスターが復元される');
  assert.equal(statsSig(restored.rt.stats.stats.values()), statsSig(mid.rt.stats.stats.values()), 'ロード直後の集計が一致');
  advanceTo(restored, 'seasonEnd');
  assert.equal(standSig(restored.rt.table), refStand, '最終順位が無セーブ通しと一致');
  assert.equal(statsSig(restored.rt.stats.stats.values()), refStats, '最終集計が無セーブ通しと一致');
});

// ============================================================================
// R3: 試合中の故障（§10.5「シーズン中、何なら試合中に壊れる」）
//   旧実装は「オフに1回ロール→翌年の開幕IL」で、シーズン中に誰も壊れなかった。
//   ＝1年目は故障者ゼロ／二軍からのIL補充が一切湧かない、という破綻だった。
// ============================================================================
test('R3: 故障は試合中に発生し、その場で退場し、以後の試合を離脱する', () => {
  const st = newGame(20260713, 'T1', { cfg });
  const steps = advanceTo(st, 'seasonEnd');
  const log = st.rt.injuryLog;
  assert.ok(log.length > 0, '1年目のシーズン中に故障が発生する（旧実装は0件）');
  // 発生は試合中（day を持ち、契機が露出イベント）
  for (const e of log.slice(0, 20)) {
    assert.ok(Number.isInteger(e.day) && e.day >= 0, '故障は試合日に発生する');
    assert.ok(['perPA', 'perBF', 'perFieldPlay', 'perCatcherPA'].includes(e.cause), `契機が露出イベント: ${e.cause}`);
    assert.ok(e.gamesLost >= cfg.tuning.injury.minorGamesLo, '離脱は最小離脱以上（NPBの10日ルール相当）');
    assert.ok(['minor', 'major'].includes(e.severity));
  }
  // 離脱者は実際に出場から外れる（usage.injuredUntil が立つ）
  const anyIl = [...st.rt.usageByTeam.values()].some((u) => u.injuredUntil.size > 0);
  assert.ok(anyIl, '故障者は起用AIの離脱リストに載る（スタメン/ローテ/救援から外れる）');
  // 二軍からのIL補充が湧く（旧実装は 0件）
  const moves = steps.flatMap((s) => s.rosterMoves ?? []);
  assert.ok(moves.some((m) => m.type === 'ilReplace'), '離脱者は二軍から補充される（IL補充）');
  assert.ok(moves.some((m) => m.type === 'ilReturn'), '復帰した選手は再登録される');
});

test('R3: 真値はシーズン中に動かない（後遺はオフに当季ログを消費して適用する）', () => {
  // 鉄則7の実装上の含意: 試合中に確定するのは「離脱の事実」だけ。能力への影響（後遺）は
  // オフシーズンに入る（＝C2a の不変量「1年目シーズン中に真値/年齢は動かない」を壊さない）。
  const st = newGame(4242, 'T1', { cfg });
  const before = new Map(st.league.players.map((p) => [p.id, p.trueAbility.common.speed]));
  advanceTo(st, 'seasonEnd');
  assert.ok(st.rt.injuryLog.length > 0, '前提: 当季に故障が発生している');
  for (const p of st.league.players) {
    const b = before.get(p.id);
    if (b == null) continue; // 育成→支配下の季節中昇格
    assert.equal(p.trueAbility.common.speed, b, `${p.id}: シーズン中に真値は動かない`);
  }
  // オフを跨ぐと、故障した選手に後遺（身体系の低下）と故障歴が入る
  const injured = st.rt.injuryLog.filter((e) => !e.farm).map((e) => e.playerId);
  advanceYear(st);
  const survivors = new Map(st.league.players.map((p) => [p.id, p]));
  const withHistory = injured.filter((pid) => (survivors.get(pid)?.trueAbility.career.injuryHistory ?? []).length > 0);
  assert.ok(withHistory.length > 0, 'オフを跨ぐと故障歴が真値に積まれる（再発リスク・引退圧の入力）');
});

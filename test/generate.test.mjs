// 架空選手ジェネレータ（0-6）の単体テスト。決定論・編成・三層の器・値域を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLeague, generatePitcher, generateFielder, TEAM_COLORS, TEAM_ABBR } from '../src/generate.mjs';
import { validatePlayer } from '../src/model/player.mjs';
import { makeRng } from '../src/rng.mjs';
import { createConfig } from '../src/config.mjs';
import { FIELD_POSITIONS } from '../src/model/positions.mjs';
import { applyAging } from '../src/game/aging.mjs';
import { clamp } from '../src/model/util.mjs';

const cfg = createConfig();

/** 総合力の粗い代理（~20-80）。roster.mjs の引退判定と同じ物差し（R2 の年齢構造テスト用）。 */
function overallAbility(p) {
  const t = p.trueAbility;
  if (p.role === 'pitcher') {
    const veloR = clamp(50 + (t.pitching.velocityKmh - 145) * 2, 20, 80);
    const pitches = t.pitching.pitches;
    let stuff = 50;
    if (pitches.length) {
      let s = 0;
      for (const pi of pitches) s += (pi.current + pi.whiff) / 2;
      stuff = s / pitches.length;
    }
    return (veloR + t.pitching.control + t.pitching.stamina + stuff) / 4;
  }
  const b = t.batting;
  let bestProf = 20;
  for (const k of Object.keys(t.fielding.positionProf)) bestProf = Math.max(bestProf, t.fielding.positionProf[k]);
  return (b.ev + b.contact + b.la + b.eye + t.common.speed + t.fielding.positioningIQ + bestProf) / 7;
}

test('generateLeague は決定論的（同一masterSeedで同一リーグ）', () => {
  const a = generateLeague(2026, cfg);
  const b = generateLeague(2026, cfg);
  assert.equal(a.players.length, b.players.length);
  // 名前・主要能力が完全一致
  for (let i = 0; i < a.players.length; i++) {
    assert.equal(a.players[i].name, b.players[i].name);
    assert.equal(a.players[i].trueAbility.common.speed, b.players[i].trueAbility.common.speed);
  }
});

test('TEAM_COLORS covers all generated team names', () => {
  const league = generateLeague(1, cfg);
  for (const t of league.teams) assert.ok(TEAM_COLORS[t.name], `color missing for ${t.name}`);
  assert.equal(Object.keys(TEAM_COLORS).length, 12);
});

// G1a: TEAM_ABBR も TEAM_COLORS と同じドリフト防止（改名時に略称マップだけ取り残されないこと）。
test('TEAM_ABBR covers all generated team names', () => {
  const league = generateLeague(1, cfg);
  for (const t of league.teams) assert.ok(TEAM_ABBR[t.name], `abbr missing for ${t.name}`);
  assert.equal(Object.keys(TEAM_ABBR).length, 12);
  for (const v of Object.values(TEAM_ABBR)) assert.ok(v && v.length > 0, 'abbr should be non-empty');
});

test('別masterSeedは別リーグ', () => {
  const a = generateLeague(1, cfg);
  const b = generateLeague(2, cfg);
  assert.notEqual(a.players[0].name + a.players[10].name, b.players[0].name + b.players[10].name);
});

// --- 選手アイデンティティ（2026-07-20・名前=人物） --------------------------------

test('アイデンティティ: 世界内でフルネームは完全一意・同姓は少数に分散（旧56姓×平均20人の解消）', () => {
  const lg = generateLeague(2026, cfg);
  const names = [...lg.players, ...lg.farm].map((p) => p.name);
  assert.equal(new Set(names).size, names.length, '同姓同名が存在しない');
  const sur = new Map();
  for (const n of names) {
    const s = n.split('　')[0];
    sur.set(s, (sur.get(s) ?? 0) + 1);
  }
  const maxUse = Math.max(...sur.values());
  assert.ok(maxUse <= 7, `同姓の最大人数が抑制されている (実測 max=${maxUse})`);
  assert.ok(sur.size >= 250, `十分な種類の苗字が使われる (実測 ${sur.size}種)`);
});

test('アイデンティティ: 同じ名前は別世界でも同じ選手（役割/ポジ/利き手/素質＝同年齢なら真値完全一致）', () => {
  const A = generateLeague(1, cfg);
  const B = generateLeague(2, cfg);
  const byName = new Map([...B.players, ...B.farm].map((p) => [p.name, p]));
  let common = 0;
  let sameAge = 0;
  for (const p of [...A.players, ...A.farm]) {
    const q = byName.get(p.name);
    if (!q) continue;
    common++;
    // 役割・ポジション・利き手・耐性は年齢に依らず一致（innate）
    assert.equal(p.role, q.role, `${p.name} の役割`);
    assert.equal(p.primaryPos, q.primaryPos, `${p.name} の主ポジ`);
    assert.equal(p.bats + p.throws, q.bats + q.throws, `${p.name} の利き手`);
    assert.equal(p.trueAbility.career.durability, q.trueAbility.career.durability, `${p.name} の耐性`);
    // 現在能力は applyMaturity(age) 依存＝同年齢の個体のみ真値全体を厳密比較
    if (p.age === q.age) {
      sameAge++;
      const strip = (x) => JSON.stringify({ ...x.trueAbility, career: { ...x.trueAbility.career, youthDebt: 0 } });
      assert.equal(strip(p), strip(q), `${p.name} の真値（同年齢）`);
    }
  }
  assert.ok(common >= 10, `両世界に共通の名前が十分ある (実測 ${common})`);
  assert.ok(sameAge >= 1, `同年齢の共通個体が存在する (実測 ${sameAge})`);
});

test('リーグ規模どおりの球団数・支配下70人/球団（投手33-36＋野手34-37）（F2-1）', () => {
  const lg = generateLeague(7, cfg);
  const R = cfg.tuning.roster;
  assert.equal(lg.teams.length, cfg.league.numTeams);
  assert.equal(lg.players.length, cfg.league.numTeams * R.controlledPerTeam);
  const pitCounts = new Set();
  for (const t of lg.teams) {
    assert.equal(t.playerIds.length, R.controlledPerTeam);
    const roster = lg.players.filter((p) => p.teamId === t.id);
    const pitchers = roster.filter((p) => p.role === 'pitcher');
    const fielders = roster.filter((p) => p.role === 'fielder');
    assert.equal(roster.length, R.controlledPerTeam, `${t.id} 支配下70人`);
    assert.ok(pitchers.length >= R.pitchersMin && pitchers.length <= R.pitchersMax, `${t.id} 投手 ${pitchers.length} は 33-36`);
    assert.equal(fielders.length, R.controlledPerTeam - pitchers.length, `${t.id} 野手=残り（34-37）`);
    pitCounts.add(pitchers.length);
  }
  assert.ok(pitCounts.size > 1, '投手数に球団差がある（33-36で散る）');
});

test('各守備位置に主ポジ野手が最低3人（一軍・二軍の同時編成が成立する充足・F2-1）', () => {
  const lg = generateLeague(7, cfg);
  for (const t of lg.teams) {
    const fielders = lg.players.filter((p) => p.teamId === t.id && p.role === 'fielder');
    for (const pos of FIELD_POSITIONS) {
      const n = fielders.filter((p) => p.primaryPos === pos).length;
      assert.ok(n >= 3, `${t.id} の ${pos} は主ポジ${n}人（最低3人必要）`);
    }
  }
});

test('育成選手 10-40人/球団・全員minor・球団の育成方針で人数差（F2-1・§12.1）', () => {
  const lg = generateLeague(7, cfg);
  const R = cfg.tuning.roster;
  assert.ok(Array.isArray(lg.farm), 'generateLeague が farm を返す');
  assert.ok(lg.farm.every((d) => d.rosterStatus === 'minor'), '育成は全員 rosterStatus=minor');
  assert.ok(lg.players.every((p) => p.rosterStatus === 'active'), '支配下に minor は混じらない');
  const counts = [];
  for (const t of lg.teams) {
    const farm = lg.farm.filter((d) => d.teamId === t.id);
    assert.ok(farm.length >= R.devCountMin && farm.length <= R.devCountMax, `${t.id} 育成 ${farm.length} は 10-40`);
    // 合計 80-110人/球団（支配下70＋育成10-40）
    const total = R.controlledPerTeam + farm.length;
    assert.ok(total >= 80 && total <= 110, `${t.id} 総保有 ${total} は 80-110`);
    counts.push(farm.length);
  }
  assert.ok(new Set(counts).size > 1, '育成人数に球団差がある（育成方針devFocusの発現）');
  // リーグ総人口 ~1,000-1,300人
  const totalPop = lg.players.length + lg.farm.length;
  assert.ok(totalPop >= 1000 && totalPop <= 1300, `リーグ総人口 ${totalPop} は 1000-1300`);
  // 育成人数は監督/フロントの devFocus と単調（写像 devCountFor の発現）
  const sorted = lg.teams.slice().sort((a, b) => a.manager.devFocus - b.manager.devFocus);
  const farmOf = (tid) => lg.farm.filter((d) => d.teamId === tid).length;
  assert.ok(farmOf(sorted[0].id) <= farmOf(sorted[sorted.length - 1].id), 'devFocus 最小球団 ≤ 最大球団の育成人数');
});

test('育成は支配下より若く、年齢帯（devAgeWeights）に収まる（F2-1 / R2）', () => {
  const lg = generateLeague(7, cfg);
  const ages = Object.keys(cfg.tuning.roster.devAgeWeights).map(Number);
  const lo = Math.min(...ages);
  const hi = Math.max(...ages);
  const avg = (arr) => arr.reduce((a, p) => a + p.age, 0) / arr.length;
  assert.ok(lg.farm.every((d) => d.age >= lo && d.age <= hi), `育成は ${lo}-${hi}`);
  assert.ok(avg(lg.farm) + 2 < avg(lg.players), '育成の平均年齢は支配下より2歳以上若い');
});

// --- R2: 年齢構造（realism_r2_age_roster_spec）。旧実装は年齢と能力が無相関（r=0.012）で、
//     18歳がリーグ2位・一軍登録の38%が20歳以下という破綻を生んでいた（「初期値ができすぎ」）。
test('R2: 支配下の年齢分布が NPB 実態の山型（18歳が極端に膨らまない）', () => {
  const lg = generateLeague(11, cfg);
  const perTeam = (age) => lg.players.filter((p) => p.age === age).length / lg.teams.length;
  assert.ok(perTeam(18) < 5, `18歳は球団あたり5人未満（実測 ${perTeam(18).toFixed(1)}人。旧実装は13.6人）`);
  const mid = lg.players.filter((p) => p.age >= 22 && p.age <= 29).length / lg.players.length;
  assert.ok(mid > 0.4, `22-29歳が支配下の40%超（実測 ${(mid * 100).toFixed(0)}%）＝分布の山が中央にある`);
});

test('R2: 年齢と能力に正の相関がある（無相関＝生成バグの直接検出）', () => {
  const lg = generateLeague(11, cfg);
  const xs = lg.players.map((p) => p.age);
  const ys = lg.players.map((p) => overallAbility(p));
  const mx = xs.reduce((a, v) => a + v, 0) / xs.length;
  const my = ys.reduce((a, v) => a + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  assert.ok(r > 0.25, `年齢×能力の相関 r=${r.toFixed(3)} > 0.25（旧実装 0.012＝完全無相関）`);
});

test('R2: 高卒新人(18-19)は一軍平均を大きく下回る（即戦力レギュラーにならない）', () => {
  const lg = generateLeague(11, cfg);
  const mean = (arr) => arr.reduce((a, p) => a + overallAbility(p), 0) / arr.length;
  const rookies = lg.players.filter((p) => p.age <= 19);
  const prime = lg.players.filter((p) => p.age >= 26 && p.age <= 30);
  assert.ok(rookies.length > 0 && prime.length > 0);
  assert.ok(
    mean(prime) - mean(rookies) > 5,
    `26-30歳(${mean(prime).toFixed(1)}) が 18-19歳(${mean(rookies).toFixed(1)}) を 5pt 超上回る（旧実装は同値）`,
  );
});

test('R2: 生成と加齢が同一カーブ — 18歳を9年加齢させると27歳の生成分布へ収束する', () => {
  const lg = generateLeague(5, cfg);
  const mean = (arr) => arr.reduce((a, p) => a + overallAbility(p), 0) / arr.length;
  const young = lg.players.filter((p) => p.age === 18).map((p) => JSON.parse(JSON.stringify(p)));
  const before = mean(young);
  for (let y = 0; y < 9; y++) applyAging(young, cfg, { seed: 777 + y });
  const after = mean(young);
  // ③やきゅつく的な楽しさ: 若手が実際に育つ（旧実装は9年で +1.8pt しか伸びなかった）
  assert.ok(after - before > 6, `18→27歳で ${(after - before).toFixed(1)}pt 成長（旧実装 +1.8pt）`);
  // 内部整合: 育った27歳が「生成された27歳」と同水準（±4pt。個体差/成長分散gmの揺れを許容）
  const born27 = mean(lg.players.filter((p) => p.age === 27));
  assert.ok(
    Math.abs(after - born27) < 4,
    `育った27歳(${after.toFixed(1)}) ≒ 生成された27歳(${born27.toFixed(1)})＝生成と加齢が同一カーブ`,
  );
});

test('育成選手も validatePlayer を通過し三層の器を持つ（F2-1）', () => {
  const lg = generateLeague(3, cfg);
  for (const d of lg.farm) {
    assert.equal(validatePlayer(d).length, 0, `invalid: ${d.id}`);
    assert.equal(typeof d.scoutSeed, 'number');
    assert.ok(/^T\d+D\d+$/.test(d.id), '育成IDは TxDn 形式（支配下と衝突しない）');
  }
});

test('育成込みの生成も決定論（同一masterSeedで farm まで一致）（F2-1）', () => {
  const a = generateLeague(2026, cfg);
  const b = generateLeague(2026, cfg);
  assert.equal(a.farm.length, b.farm.length);
  for (let i = 0; i < a.farm.length; i++) {
    assert.equal(a.farm[i].id, b.farm[i].id);
    assert.equal(a.farm[i].name, b.farm[i].name);
    assert.equal(a.farm[i].age, b.farm[i].age);
    assert.equal(a.farm[i].trueAbility.common.speed, b.farm[i].trueAbility.common.speed);
  }
});

test('名前プール拡張で衝突率が低い（同姓同名は少数派・F2-1）', () => {
  const lg = generateLeague(7, cfg);
  const names = lg.players.concat(lg.farm).map((p) => p.name);
  const uniq = new Set(names).size;
  assert.ok(uniq / names.length >= 0.8, `同姓同名は2割未満（unique ${uniq}/${names.length}）`);
});

test('全選手が validatePlayer を通過し、名前は非空・架空（実名でない体裁）', () => {
  const lg = generateLeague(3, cfg);
  for (const p of lg.players) {
    assert.equal(validatePlayer(p).length, 0, `invalid: ${p.id}`);
    assert.ok(p.name.length > 0);
    assert.ok(p.id.length > 0);
  }
});

test('リーグ割当: 前半6球団=L1（DH無）・後半6球団=L2（DH有）（S1）', () => {
  const lg = generateLeague(7, cfg);
  const l1 = lg.teams.filter((t) => t.league === 'L1');
  const l2 = lg.teams.filter((t) => t.league === 'L2');
  assert.equal(l1.length, 6);
  assert.equal(l2.length, 6);
  // 前半=L1・後半=L2 の並び
  for (let i = 0; i < 6; i++) assert.equal(lg.teams[i].league, 'L1', `T${i + 1} は L1`);
  for (let i = 6; i < 12; i++) assert.equal(lg.teams[i].league, 'L2', `T${i + 1} は L2`);
});

test('監督プロファイル: 各チームに buntTend/stealTend/ibbTend/quickHook（20-80・決定論）（S1）', () => {
  const a = generateLeague(7, cfg);
  const b = generateLeague(7, cfg);
  for (const t of a.teams) {
    for (const k of ['buntTend', 'stealTend', 'ibbTend', 'quickHook']) {
      assert.ok(t.manager[k] >= 20 && t.manager[k] <= 80, `${t.id}.manager.${k}=${t.manager[k]}`);
    }
  }
  // 決定論: 同一masterSeedで同一の監督
  assert.deepEqual(a.teams.map((t) => t.manager), b.teams.map((t) => t.manager));
  // チーム間で采配の個性が散っている（全員同値ではない）
  const bunts = new Set(a.teams.map((t) => t.manager.buntTend));
  assert.ok(bunts.size > 1, '監督の個性が分布から生成されている');
});

test('三層の器が埋まっている（trueAbility / scoutSeed / 空のcareer.seasons）', () => {
  const lg = generateLeague(3, cfg);
  const p = lg.players[0];
  assert.ok(p.trueAbility.pitching && p.trueAbility.fielding);
  assert.equal(typeof p.scoutSeed, 'number');
  assert.deepEqual(p.career.seasons, {});
});

test('能力素材は両登録分保持（投手も打撃/走塁/守備素材を持つ）', () => {
  const rng = makeRng(1);
  const p = generatePitcher(rng, 'X1');
  assert.ok(p.trueAbility.batting && p.trueAbility.baserunning && p.trueAbility.fielding);
});

test('レーティングは 20–80、球速は妥当域（km/h）', () => {
  const lg = generateLeague(9, cfg);
  for (const p of lg.players) {
    const c = p.trueAbility.common;
    for (const k of ['speed', 'arm', 'hands', 'reaction', 'power']) {
      assert.ok(c[k] >= 20 && c[k] <= 80, `${k}=${c[k]}`);
    }
    if (p.role === 'pitcher') {
      const v = p.trueAbility.pitching.velocityKmh;
      assert.ok(v >= 130 && v <= 165, `velocity ${v}`);
      assert.ok(p.trueAbility.pitching.pitches.length >= 2, '球種2以上');
      assert.ok(p.trueAbility.pitching.pitches.some((x) => x.type === 'fastball'), 'fastball必須');
    }
  }
});

test('各守備位置が主ポジ選手で埋まる', () => {
  const lg = generateLeague(11, cfg);
  const t0 = lg.teams[0];
  const roster = lg.players.filter((p) => p.teamId === t0.id && p.role === 'fielder');
  for (const pos of FIELD_POSITIONS) {
    const hasStarter = roster.some((p) => p.trueAbility.fielding.positionProf[pos] >= 50);
    assert.ok(hasStarter, `${pos} を主守備にする選手がいない`);
  }
});

test('declineRate は能力タイプと相関（速球派サンプルは技巧派より衰えが速い傾向）', () => {
  const rng = makeRng(123);
  let fastSum = 0;
  let fineSum = 0;
  let fastN = 0;
  let fineN = 0;
  for (let i = 0; i < 400; i++) {
    const p = generatePitcher(rng, `P${i}`);
    const pit = p.trueAbility.pitching;
    if (pit.velocityKmh >= 150) { fastSum += p.trueAbility.career.declineRate; fastN++; }
    if (pit.velocityKmh <= 143 && pit.control >= 55) { fineSum += p.trueAbility.career.declineRate; fineN++; }
  }
  if (fastN > 5 && fineN > 5) {
    assert.ok(fastSum / fastN > fineSum / fineN, '速球派の衰えが技巧派より速い');
  }
});

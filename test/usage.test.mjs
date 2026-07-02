// 日次スタメンAI・疲労管理（S3 usage.mjs）のテスト。
// 単体（純関数の判断）＋シーズン統合（先発間隔・連投制限・休養の発現）を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';
import { createBattingLine } from '../src/model/statline.mjs';
import {
  createUsageState,
  blendedWoba,
  selectStarter,
  selectLineup,
  bullpenAvailable,
  reviewAssignments,
} from '../src/sim/usage.mjs';

const cfg = createConfig();

/** テスト用野手（打撃系一括・利き手指定） */
function mkF(id, { bats = 'R', bat = 50 } = {}) {
  return createPlayer({
    id,
    role: 'fielder',
    bats,
    trueAbility: createTrueAbility({
      common: { power: bat },
      batting: { ev: bat, contact: bat, eye: bat, la: bat },
    }),
  });
}

// --- 単体: 混合評価（三層構造） ------------------------------------------------

test('blendedWoba: 無打席=スカウト評価のみ・打席が積むほど観測へ寄る（真値を直接見ない）（S3）', () => {
  const u = cfg.tuning.usage;
  const state = { scoutEval: new Map([['A', 10]]) }; // スカウトは高評価（+10rating相当）
  const empty = createBattingLine();
  const scoutOnly = blendedWoba(state, 'A', () => empty, cfg);
  assert.ok(Math.abs(scoutOnly - (cfg.tuning.mgr.wobaPrior + 10 * u.scoutWobaPerPt)) < 1e-9, '無打席=スカウトのみ');
  // 観測が貧打なら、打席が積むほど評価は下がる（観測を信頼していく）
  const cold = { ...createBattingLine(), pa: 600, ab: 580, b1: 90, sf: 2 };
  const blended = blendedWoba(state, 'A', () => cold, cfg);
  assert.ok(blended < scoutOnly, '貧打の観測600PAでスカウト評価より低下');
});

// --- 単体: 先発の中5日・救援の連投制限 -----------------------------------------

test('selectStarter: 中5日未満のローテ投手は飛ばす・休養十分ならローテ順（S3）', () => {
  const state = {
    charts: { dh: { rotation: ['s1', 's2', 's3', 's4', 's5', 's6'] } },
    lastStartDay: new Map(),
    rotIdx: 0,
  };
  assert.equal(selectStarter(state, 0, cfg), 's1', '初日はローテ頭');
  state.lastStartDay.set('s1', 0);
  state.rotIdx = 1;
  assert.equal(selectStarter(state, 1, cfg), 's2', '翌日は次の先発');
  // ローテ一巡後: s1 は中5日（day6）から再登板可・day5では不可
  state.rotIdx = 0;
  assert.equal(selectStarter(state, 5, cfg), 's2', '中4日ではs1を飛ばす');
  assert.equal(selectStarter(state, 6, cfg), 's1', '中5日でs1が登板可');
});

test('bullpenAvailable: 3連投禁止・前日30球以上は不可（S3）', () => {
  const state = {
    charts: { dh: { bullpen: ['a', 'b', 'c', 'd'] } },
    pitchedByDay: new Map([
      ['a', new Map([[5, 10], [6, 12]])], // 2連投済み → 3連投になるので不可
      ['b', new Map([[6, 35]])], // 前日35球 → 不可
      ['c', new Map([[5, 40]])], // 中1日 → 可
    ]),
  };
  assert.deepEqual(bullpenAvailable(state, 7, cfg), ['c', 'd']);
  // 前々日までの登板なら連投カウントは切れる
  assert.deepEqual(bullpenAvailable(state, 9, cfg), ['a', 'b', 'c', 'd']);
});

// --- 単体: プラトーン入替（selectLineup） --------------------------------------

function mkPlatoonState() {
  const POS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
  const players = POS.map((pos) => mkF(`R${pos}`, { bats: 'R' }));
  players.push(mkF('BL', { bats: 'L' }), mkF('BR', { bats: 'R' }));
  const byId = new Map(players.map((p) => [p.id, p]));
  const defense = {};
  const positionRank = {};
  for (const pos of POS) {
    defense[pos] = `R${pos}`;
    // RFのみベンチ左打者BLが候補上位に入る（他ポジはBRのみ）
    positionRank[pos] = pos === 'RF' ? ['RRF', 'BL', 'BR'] : [`R${pos}`, 'BR'];
  }
  const lineup = [...POS.map((pos) => ({ playerId: `R${pos}`, pos })), { playerId: null, pos: 'P' }];
  const chart = { byId, defense, positionRank, lineup, rotation: [], bullpen: [] };
  const state = createUsageState({ id: 'T' }, { dh: chart, noDh: chart }, cfg);
  for (const pid of state.scoutEval.keys()) state.scoutEval.set(pid, 0); // スカウト評価を均一化
  return state;
}

test('selectLineup: 相手先発が右なら同利きのRF正選手を左のベンチへ入替・左先発なら入替なし（S3）', () => {
  const state = mkPlatoonState();
  const noRest = { next: () => 0.99 }; // 休養・挑戦者の乱数を封じる
  const getBat = () => createBattingLine();
  const vsR = selectLineup(
    state,
    { day: 0, dh: false, oppPitcher: { bats: 'R', throws: 'R' }, rng: noRest, getBat },
    cfg,
  );
  const rf = vsR.lineup.find((s) => s.pos === 'RF');
  assert.equal(rf.playerId, 'BL', '対右投手は左打ベンチをRFへ');
  for (const pos of ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF']) {
    assert.equal(vsR.lineup.find((s) => s.pos === pos).playerId, `R${pos}`, `${pos} は正選手のまま`);
  }
  assert.ok(vsR.bench.includes('RRF') && vsR.bench.includes('BR'), '外れた正選手はベンチへ');
  const vsL = selectLineup(
    state,
    { day: 0, dh: false, oppPitcher: { bats: 'L', throws: 'L' }, rng: noRest, getBat },
    cfg,
  );
  assert.equal(vsL.lineup.find((s) => s.pos === 'RF').playerId, 'RRF', '対左投手は右の正選手のまま');
});

// --- 単体: 観測ベース見直し（漸進昇格） ----------------------------------------

test('reviewAssignments: 好調の控えがシェアを漸増し、share≥1で完全昇格（急な全交代なし）（S3）', () => {
  const reg = mkF('REG');
  const chal = mkF('CHAL');
  const byId = new Map([[reg.id, reg], [chal.id, chal]]);
  const chart = {
    byId,
    defense: { SS: 'REG' },
    positionRank: { SS: ['REG', 'CHAL'] },
    lineup: [{ playerId: 'REG', pos: 'SS' }],
    rotation: [],
    bullpen: [],
  };
  const state = createUsageState({ id: 'T' }, { dh: chart, noDh: chart }, cfg);
  for (const pid of state.scoutEval.keys()) state.scoutEval.set(pid, 0);
  const lines = {
    REG: { ...createBattingLine(), pa: 200, ab: 190, b1: 30, sf: 2 }, // 不振
    CHAL: { ...createBattingLine(), pa: 200, ab: 170, bb: 25, b1: 40, b2: 15, hr: 10 }, // 好調
  };
  const getBat = (pid) => lines[pid];
  const a = state.assign.SS;
  const step = cfg.tuning.usage.promoteStep;

  reviewAssignments(state, getBat, cfg);
  assert.equal(a.regular, 'REG', '1回目の見直しでは即交代しない');
  assert.equal(a.challenger, 'CHAL');
  assert.ok(Math.abs(a.share - step) < 1e-9, '挑戦者のシェアが漸増');

  reviewAssignments(state, getBat, cfg);
  assert.equal(a.regular, 'REG');
  assert.ok(Math.abs(a.share - 2 * step) < 1e-9);

  reviewAssignments(state, getBat, cfg);
  assert.equal(a.regular, 'CHAL', 'シェアが1に達すると完全昇格');
  assert.equal(a.challenger, null);

  // 逆に評価差が消えればシェアは減衰し挑戦解消（一時の好不調で振り回されない）
  lines.CHAL = lines.REG;
  a.challenger = 'REG';
  a.share = step;
  reviewAssignments(state, getBat, cfg);
  assert.equal(a.challenger, null, '評価差が消えると挑戦は解消');
});

// --- シーズン統合（S3の受け入れ条件） ------------------------------------------

const lg = generateLeague(2026, cfg);
const res = simulateSeason(lg, cfg, { seed: 2026 });

test('シーズン統合: 先発の登板間隔は中5日以上（日差≥6日）（S3）', () => {
  let checked = 0;
  for (const [, u] of res.usageByTeam) {
    for (const [pid, days] of u.startDaysByPid) {
      for (let i = 1; i < days.length; i++) {
        assert.ok(
          days[i] - days[i - 1] >= cfg.tuning.fatigue.starterRestDays + 1,
          `${pid} の先発間隔 (${days[i - 1]}→${days[i]})`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 200, `先発間隔を十分検証した (got ${checked})`);
});

test('シーズン統合: 3連投なし・前日30球以上の翌日登板なし（S3）', () => {
  let appearances = 0;
  for (const [, u] of res.usageByTeam) {
    for (const [pid, m] of u.pitchedByDay) {
      const days = [...m.keys()].sort((a, b) => a - b);
      appearances += days.length;
      for (let i = 0; i < days.length; i++) {
        if (i >= 2) {
          assert.ok(
            !(days[i] - days[i - 1] === 1 && days[i - 1] - days[i - 2] === 1),
            `3連投が発生 (${pid} day=${days[i]})`,
          );
        }
        if (i >= 1 && days[i] - days[i - 1] === 1) {
          assert.ok(
            m.get(days[i - 1]) < cfg.tuning.fatigue.prevDayPitchLimit,
            `前日${m.get(days[i - 1])}球で登板 (${pid} day=${days[i]})`,
          );
        }
      }
    }
  }
  assert.ok(appearances > 2000, `登板が十分ある (got ${appearances})`);
});

test('シーズン統合: 休養AIの発現＝143試合フル先発の野手がいない・正捕手は143未満に収まる（S3）', () => {
  const G = cfg.league.gamesPerSeason;
  const topCatcherStarts = [];
  for (const [, u] of res.usageByTeam) {
    for (const [pid, n] of u.startsByPid) assert.ok(n < G, `${pid} が全試合先発していない`);
    let top = 0;
    for (const [, mp] of u.startsAtPos) top = Math.max(top, mp.get('C') ?? 0);
    topCatcherStarts.push(top);
  }
  // 正捕手（捕手先発最多）の出場: 目標帯は100-135（S4較正指標）。
  // S5較正済み: catcherRestProb 0.085 + catcherSwapMargin 0.04 で平均~104（暫定帯[70,138]から復帰）
  const avg = topCatcherStarts.reduce((a, b) => a + b, 0) / topCatcherStarts.length;
  assert.ok(avg >= 100 && avg <= 135, `正捕手の平均先発 (got ${avg.toFixed(1)})`);
  for (const c of topCatcherStarts) assert.ok(c >= 55 && c < G, `正捕手の先発数が妥当 (got ${c})`);
});

test('シーズン統合: 見直しAIで先発機会が観測成績に応じて分配される（レギュラー独占でない）（S3）', () => {
  // どのチームも「先発出場が80試合以上の野手」を5人以上持ち、かつベンチにも先発機会が回る
  for (const [tid, u] of res.usageByTeam) {
    const starts = [...u.startsByPid.values()];
    const regulars = starts.filter((n) => n >= 80).length;
    const partTimers = starts.filter((n) => n >= 10 && n < 80).length;
    assert.ok(regulars >= 5, `${tid} レギュラー層が形成される (got ${regulars})`);
    assert.ok(partTimers >= 2, `${tid} 控えにも先発機会 (got ${partTimers})`);
  }
});

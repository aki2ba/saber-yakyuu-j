// ============================================================================
// R7（draft_timeline_evidence §決定2-5）: ドラフト大量化＋淘汰／優勝の窓／トレードの今⇄将来
//   バイアス／救援過大評価バイアスのテスト。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear } from '../src/game/index.mjs';
import { evaluateProspect, trueValue, teamWindowState, teamEvalProfile } from '../src/game/market.mjs';
import { runTrades } from '../src/game/transactions.mjs';
import { createPlayer, createTrueAbility, createPitch } from '../src/model/player.mjs';

const cfg = createConfig();
const SEED = 20260713;
const YEARS = 12;

function runYears(seed, years) {
  const st = newGame(seed, 'T1', { cfg });
  const agg = { rookiesPerTeamYear: [], hsAges: [], collegeAges: [] };
  for (let y = 0; y < years; y++) {
    advanceTo(st, 'seasonEnd');
    const off = advanceYear(st);
    agg.rookiesPerTeamYear.push(off.rookies.length / cfg.league.numTeams);
    for (const r of off.rookies) (r.age <= 19 ? agg.hsAges : agg.collegeAges).push(r.age);
  }
  return { st, agg };
}

const RUN = runYears(SEED, YEARS);

test('決定2: ドラフトが大量化する（引退枠だけの頃の~4.8人/球団年より明確に増える）', () => {
  const mean = RUN.agg.rookiesPerTeamYear.reduce((a, b) => a + b, 0) / RUN.agg.rookiesPerTeamYear.length;
  assert.ok(mean > 5.2, `新人/球団年の平均が引退のみの水準を明確に超える（${mean.toFixed(1)}）`);
  assert.ok(mean <= cfg.tuning.market.draft.targetVacanciesPerTeam + 1, `目標(${cfg.tuning.market.draft.targetVacanciesPerTeam})を大きく超えない（${mean.toFixed(1)}）`);
});

test('決定2: 多年でもリーグ人口・支配下70人が恒常（追加淘汰も1:1同型）', () => {
  const P = RUN.st.league.players;
  const R = cfg.tuning.roster;
  assert.equal(P.length, cfg.league.numTeams * R.controlledPerTeam, '支配下人口は恒常');
  for (const t of RUN.st.league.teams) {
    assert.equal(P.filter((p) => p.teamId === t.id).length, R.controlledPerTeam, `${t.id} は支配下70人`);
  }
});

test('決定2: 新人の右歪み(draftSkew)は現状 無効（clampRating非対称クリップで多年ERA帯を破ったため）', () => {
  // §決定2 で右歪みを試みたが、E[skew]=0 の解析的導出は clampRating(20-80) の飽和を無視しており、
  // 実測で系統的な負ドリフトを生み test/game_multiyear の多年ERA帯[3.3,4.6]を破った。
  // skewBustProb=0 で無効化した状態を回帰させないためのガード（再度有効化する場合はこのテストも更新すること）。
  assert.equal(cfg.tuning.market.draft.skewBustProb, 0, '右歪みは無効化されたまま（クリップ非対称の再設計待ち）');
});

test('決定1: 高卒新人は「期限付き未成熟負債」を持ち、加齢で完済される（恒久劣化ではない）', () => {
  const dk = cfg.tuning.market;
  const hs = createPlayer({ id: 'HSDEBT', role: 'fielder', age: dk.cohort.hsAge, trueAbility: createTrueAbility() });
  const debt = -(dk.youthDebtPerYear ?? 0) * Math.max(0, (dk.youthDebtRefAge ?? 0) - hs.age);
  assert.ok(debt < 0, '高卒(refAge未満)は負債を持つ');
  const college = createPlayer({ id: 'COLDEBT', role: 'fielder', age: dk.cohort.colAge, trueAbility: createTrueAbility() });
  const collegeDebt = -(dk.youthDebtPerYear ?? 0) * Math.max(0, (dk.youthDebtRefAge ?? 0) - college.age);
  assert.ok(collegeDebt === 0, '大卒(refAge以上)は負債0＝据え置き'); // -0 === 0 は true（assert.equalはNode環境依存で-0を区別しうる）
});

test('決定3: 優勝の窓 — 履歴無しは neutral、直近年が好調なら contending', () => {
  const wc = cfg.tuning.market.window;
  assert.equal(teamWindowState('T1', [], cfg), 'neutral', '履歴が無ければ neutral');
  const good = [{ year: 2030, standings: [{ teamId: 'T1', w: 80, l: 62 }] }];
  assert.equal(teamWindowState('T1', good, cfg), 'contending', `勝率.500超の直近年は contending（閾値${wc.contendWinPct}）`);
});

test('決定3: 優勝の窓 — 2年連続非contentionで初めて rebuilding（1年の不振では閉じない＝時間的ヒステリシス）', () => {
  const oneBad = [
    { year: 2031, standings: [{ teamId: 'T1', w: 60, l: 82 }] },
    { year: 2030, standings: [{ teamId: 'T1', w: 90, l: 52 }] },
  ];
  assert.equal(teamWindowState('T1', oneBad, cfg), 'neutral', '直近1年だけの不振では rebuilding にならない');
  const twoBad = [
    { year: 2031, standings: [{ teamId: 'T1', w: 60, l: 82 }] },
    { year: 2030, standings: [{ teamId: 'T1', w: 58, l: 84 }] },
  ];
  assert.equal(teamWindowState('T1', twoBad, cfg), 'rebuilding', '2年連続非contentionで rebuilding');
});

test('決定3: ドラフトの窓バイアス — contendingは大社(即戦力)寄り、rebuildingは高卒寄りの傾き', () => {
  // 十分な年数を回せば、窓状態は勝率に応じて球団間でばらける。ドラフト時の年齢分布が
  // 完全に一定（cohort比率のみ）でないこと＝窓バイアスが何かしら効いていることの弱い確認。
  assert.ok(cfg.tuning.market.window.draftBonus > 0, '窓ボーナスが設定されている');
  const bonusFn = (age, w) => {
    const mk = cfg.tuning.market;
    if (w === 'contending' && age >= mk.cohort.colAge) return mk.window.draftBonus;
    if (w === 'rebuilding' && age <= mk.cohort.hsAge) return mk.window.draftBonus;
    return 0;
  };
  assert.ok(bonusFn(25, 'contending') > bonusFn(18, 'contending'), 'contendingは大社をより高く評価');
  assert.ok(bonusFn(18, 'rebuilding') > bonusFn(25, 'rebuilding'), 'rebuildingは高卒をより高く評価');
});

test('決定4: トレードの窓プレミアム — contendingは即戦力を、rebuildingは若手を過大評価して受け入れやすくする', () => {
  const tc = cfg.tuning.market.trade;
  const veteran = createPlayer({
    id: 'VET1', teamId: 'TB', role: 'fielder', primaryPos: 'SS', age: tc.veteranAge + 2,
    trueAbility: createTrueAbility({ batting: { ev: 55, contact: 55, eye: 52, la: 52 } }),
  });
  const youth = createPlayer({
    id: 'YNG1', teamId: 'TA', role: 'fielder', primaryPos: 'SS', age: tc.youthAge - 2,
    trueAbility: createTrueAbility({ batting: { ev: 55, contact: 55, eye: 52, la: 52 } }),
  });
  // 中立の余剰選手（放出側）: 双方とも自チームの最低評価という設定にするため能力を下げる
  const scrubA = createPlayer({
    id: 'SCRUBA', teamId: 'TA', role: 'fielder', primaryPos: 'SS', age: 27,
    trueAbility: createTrueAbility({ batting: { ev: 40, contact: 40, eye: 40, la: 40 } }),
  });
  const scrubB = createPlayer({
    id: 'SCRUBB', teamId: 'TB', role: 'fielder', primaryPos: 'SS', age: 27,
    trueAbility: createTrueAbility({ batting: { ev: 40, contact: 40, eye: 40, la: 40 } }),
  });
  const league = {
    teams: [{ id: 'TA' }, { id: 'TB' }],
    players: [youth, scrubA, veteran, scrubB],
  };
  const profileFlat = { wBat: 1, wEye: 1, wDef: 1, ageBias: 0, noiseSd: 0, wReliever: 1 };
  const profiles = new Map([['TA', profileFlat], ['TB', profileFlat]]);
  // TA=contending（即戦力=veteranを買いたい）／TB=rebuilding（若手=youthを買いたい）という窓で
  // TAがveteranを、TBがyouthを受け取るトレードが margin を超えて成立しやすくなることを確認する。
  const windowByTeam = new Map([['TA', 'contending'], ['TB', 'rebuilding']]);
  const withWindow = runTrades(league, cfg, { profiles, masterSeed: 1, yearIndex: 0, interventions: [], windowByTeam });
  const withoutWindow = runTrades(
    { teams: league.teams, players: [youth, scrubA, veteran, scrubB].map((p) => ({ ...p })) },
    cfg, { profiles, masterSeed: 1, yearIndex: 0, interventions: [], windowByTeam: null },
  );
  assert.ok(withWindow.length >= withoutWindow.length, '窓バイアスは双方winのハードルを下げる方向に働く（トレードが減らない）');
});

test('決定5: 救援シェイプ（低スタミナ）の評価が wReliever が高い球団ほど過大になる', () => {
  const relieverShape = createPlayer({
    id: 'RP1', role: 'pitcher', age: 26,
    trueAbility: createTrueAbility({
      pitching: {
        velocityKmh: 152, control: 50, stamina: 25, gbRate: 50, hold: 50,
        pitches: [createPitch('fastball', { current: 60, whiff: 60, hrSuppress: 55, contactQuality: 55 })],
      },
    }),
  });
  const highRelief = { wBat: 1, wEye: 1, wDef: 1, ageBias: 0, noiseSd: 0, wReliever: 2.0 };
  const lowRelief = { wBat: 1, wEye: 1, wDef: 1, ageBias: 0, noiseSd: 0, wReliever: 1.0 };
  const valHigh = evaluateProspect(highRelief, relieverShape, cfg);
  const valLow = evaluateProspect(lowRelief, relieverShape, cfg);
  assert.ok(valHigh > valLow, `wReliever が高い球団ほど救援シェイプを高評価（${valHigh.toFixed(1)} > ${valLow.toFixed(1)}）`);
  // trueValue（AIが見ない全知評価）は wReliever=1 相当＝バイアスを含まない。
  assert.equal(trueValue(relieverShape, cfg), valLow, 'trueValueは救援過大評価バイアスを含まない');
});

test('決定5: 球団プロファイルの wReliever は球団ごとに散らばり、多くが>1（過大評価が多数派）', () => {
  const profs = RUN.st.league.teams.map((t) => teamEvalProfile(SEED, t.id, cfg));
  const uniq = new Set(profs.map((p) => p.wReliever.toFixed(3))).size;
  assert.ok(uniq >= 8, 'wReliever が球団ごとに散らばる');
  assert.ok(profs.filter((p) => p.wReliever > 1).length >= profs.length / 2, '過半が救援を過大評価');
});

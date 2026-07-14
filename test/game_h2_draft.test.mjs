// ============================================================================
// フェーズH2: プレイヤー参加型ドラフト会議（phaseH_fun_spec H2）のテスト。
//   - 非対話モード後方互換: cfg.game.interactiveDraft 既定はfalse。advanceYearは常に完了し
//     中断しない（既存テスト・headlessは全自動のまま挙動不変）
//   - 競合くじ敗退→再指名の状態遷移: runDraft単体（決定論シード固定）で
//     「自チームの指名がロットで負ける→pool内の別候補で再指名可能な状態に中断→
//      再指名で解決」を厳密に検証
//   - save-load 経由の replay 一致: ドラフト中断中のセーブを、意図的に「間違ったcfg」
//     （interactiveDraft:falseのまま・src/ui.mjsのloadFromBlobが素のcreateConfig()を
//      呼んでいた旧実装のバグを模したケース）で load しても中断状態が正しく再構築され、
//     続きを解決した結果が「save/loadを挟まないフル対話」の結果と完全一致する
//     （＝driveOffseasonDraftのplayerTeamId決定がstate.offseasonStageも見るフォールバックの回帰テスト）
//   - 70人枠等の不変量: 対話ドラフトを複数年回しても支配下人口/投手数レンジが恒常
//   - scoutViewの真値非参照: 伸びしろ判定は個体の真の career.peakAge を見ない（config定数のみ）／
//     同一プロスペクトへの評価が球団間で異なる（球団固有の観測ノイズ・三層構造の証拠）／
//     戻り値にtrueAbilityが一切含まれない
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, submitDraftPick, save, load, draftScoutView } from '../src/game/index.mjs';
import { generateLeague } from '../src/generate.mjs';
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';
import { runDraft, teamEvalProfile } from '../src/game/market.mjs';

const SEED = 20260701;

/** aw（state.awaitingDraft）から「自チームの空き枠型と一致する候補のうちidが最小」を決定論に選ぶ。 */
function pickStrategy(aw) {
  const types = new Set(aw.vacTypes.map((v) => `${v.role}:${v.primaryPos}`));
  const candidates = aw.pool.filter((p) => types.has(`${p.role}:${p.primaryPos}`));
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!candidates.length) throw new Error('pickStrategy: 候補が空（呼び出し側の前提が崩れている）');
  return candidates[0].id;
}

/** 中断が解消するまで pickStrategy で指名し続ける。全ラウンド解決時の off 要約を返す。 */
function resolveDraft(state) {
  let off = null;
  while (off === null) off = submitDraftPick(state, pickStrategy(state.awaitingDraft));
  return off;
}

/** シーズン終了→advanceYearを繰り返し、自チームの指名番で最初に中断した state を返す。 */
function toFirstPause(seed, maxYears = 10) {
  const cfg = createConfig({ game: { interactiveDraft: true } });
  const st = newGame(seed, 'T1', { cfg });
  for (let y = 0; y < maxYears; y++) {
    advanceTo(st, 'seasonEnd');
    const off = advanceYear(st);
    if (off === null) return st;
  }
  throw new Error(`toFirstPause: ${maxYears}年以内に自チームの指名番が発生しなかった（テスト前提の見直しが必要）`);
}

test('H2: 非対話モード（既定config）は後方互換 — advanceYearが常に完了し中断しない', () => {
  const cfg = createConfig();
  assert.equal(cfg.game.interactiveDraft, false, '既定値はfalse（headless/既存テストが全自動のまま挙動不変であるための前提）');
  const st = newGame(SEED, 'T1', { cfg });
  for (let y = 0; y < 6; y++) {
    advanceTo(st, 'seasonEnd');
    const off = advanceYear(st);
    assert.ok(off !== null, `${y}年目: 非対話モードではadvanceYearが中断せず完了する`);
    assert.equal(st.awaitingDraft, null, `${y}年目: awaitingDraftは常にnull`);
    assert.equal(st.offseasonStage, null, `${y}年目: offseasonStageは常にnull`);
  }
});

test('H2: 競合くじ敗退→再指名の状態遷移（runDraft単体・決定論シード固定）', () => {
  const cfg = createConfig();
  const lg = generateLeague(1, cfg); // 実在チームIDを得るためだけに使う（プール/空き枠は自前で作る）
  const teamA = lg.teams[0].id; // player（自チーム）
  const teamB = lg.teams[1].id; // AI（同型を欲しがる競合相手）
  const order = [teamB, teamA]; // nomsのbyTeam挿入順→teams配列順を固定するため順序を明示
  const vacancies = [
    { teamId: teamA, role: 'fielder', primaryPos: 'CF' },
    { teamId: teamB, role: 'fielder', primaryPos: 'CF' },
  ];
  // X1（圧倒的優良）を両チームが欲しがるよう仕込む＝どのプロファイル/ノイズでも確実に競合する。
  const mk = (id, grade) => createPlayer({
    id, name: id, role: 'fielder', primaryPos: 'CF', age: 20,
    trueAbility: createTrueAbility({
      batting: { ev: grade, contact: grade, la: grade },
      common: { power: grade, arm: grade, reaction: grade },
      fielding: { positioningIQ: grade },
    }),
  });
  const X1 = mk('X1', 80);
  const X2 = mk('X2', 20);
  const pool = new Map([['fielder:CF', [X1, X2]]]);
  const profiles = new Map();
  for (const tid of order) profiles.set(tid, teamEvalProfile(1, tid, cfg));
  // masterSeed=5・prospectId='X1'・yearIndex=0 は事前調査により teams=[teamB,teamA] の
  // ロットで teamB（index0）が勝つ（=自チームteamAが負ける）ことを確認済みの固定値。
  const masterSeed = 5;
  const yearIndex = 0;
  const opts = { masterSeed, yearIndex, playerTeamId: teamA };

  // 1手目: 自チームがX1（両チームの第一希望）を指名 → 競合くじで敗退 → 再中断。
  const r1 = runDraft(vacancies, pool, profiles, order, cfg, { ...opts, pickLog: [{ round: 1, prospectId: 'X1' }] });
  assert.equal(r1.paused, true, 'ロット結果が決まるまでは中断のまま（同関数を最初から再実行する設計）');
  assert.equal(r1.awaitingDraft.round, 1, '同じラウンド内での再指名');
  assert.equal(r1.awaitingDraft.contested, true, 'くじ敗退後はcontestedフラグが立つ（UIの再指名メッセージのトリガ）');
  assert.deepEqual(r1.awaitingDraft.pool.map((p) => p.id), ['X2'], 'X1は競合相手が獲得済み＝プールから消える（残りはX2のみ）');
  assert.equal(r1.awaitingDraft.picksSoFar.length, 1, '指名済みボードにX1（相手球団が獲得）が1件載る');
  assert.equal(r1.awaitingDraft.picksSoFar[0].teamId, teamB, 'X1を実際に獲得したのは競合相手');

  // 2手目: 残りのX2を再指名 → 全枠解決。
  const r2 = runDraft(vacancies, pool, profiles, order, cfg, {
    ...opts,
    pickLog: [{ round: 1, prospectId: 'X1' }, { round: 1, prospectId: 'X2' }],
  });
  assert.ok(!r2.paused, '2手目で全ラウンド解決する');
  assert.equal(r2.rookies.find((p) => p.id === 'X1').teamId, teamB, 'X1は競合相手（teamB）が獲得');
  assert.equal(r2.rookies.find((p) => p.id === 'X2').teamId, teamA, 'X2は再指名した自チーム（teamA）が獲得');
  assert.equal(r2.draftLog.lotteries.length, 1, 'くじは1回だけ発生（X1を巡る競合）');
  assert.deepEqual(r2.draftLog.lotteries[0].contenders.slice().sort(), [teamA, teamB].sort(), 'くじの対象は自チームと競合相手');
  assert.equal(r2.draftLog.lotteries[0].winner, teamB, '実際の勝者はteamB（負けた自チームが再指名した筋書きと整合）');
});

test('H2: save-load 経由でもドラフト中断が再現される（誤ったcfgでloadしても再開できる＝loadFromBlobルーティングバグの回帰）', () => {
  const cfgWrong = createConfig(); // interactiveDraft:false（UIのloadFromBlobが素のcreateConfig()を呼んでいた旧バグを模す）

  // 基準: save/loadを一切挟まないフル対話での最終結果。
  const ref = toFirstPause(SEED);
  const refAwSnapshot = { round: ref.awaitingDraft.round, poolIds: ref.awaitingDraft.pool.map((p) => p.id).sort() };
  const refOff = resolveDraft(ref);
  const sig = (off) => JSON.stringify({
    rookies: off.rookies.map((p) => p.id).sort(),
    picks: off.draftLog.picks.map((p) => `${p.round}:${p.teamId}:${p.prospectId}:${p.contested}`).sort(),
  });
  const refSig = sig(refOff);

  // 独立に同一シードで同じ中断点まで進める（決定論なのでrefと同一状態のはず）。
  const b = toFirstPause(SEED);
  assert.equal(b.awaitingDraft.round, refAwSnapshot.round, '同一seedで同一の中断点（ラウンド）に達する');
  assert.deepEqual(b.awaitingDraft.pool.map((p) => p.id).sort(), refAwSnapshot.poolIds, '同一seedで同一の中断点（プール構成）に達する');

  // 中断中（1手も指名する前）にsave → 意図的に「間違ったcfg」でload。
  const blob = JSON.parse(JSON.stringify(save(b)));
  assert.equal(blob.offseasonStage, 'awaitingDraft', 'セーブにドラフト中断状態が記録される（additive save field）');
  assert.equal(blob.awaitingDraft, undefined, 'awaitingDraftの中身（残りプール等）自体は保存しない（シードから再生成できるため）');
  const loaded = load(blob, { cfg: cfgWrong });
  assert.ok(loaded.awaitingDraft, 'ロード直後にドラフト中断状態が再構築される（バグがあればnullになり全自動で完了してしまう）');
  assert.equal(loaded.offseasonStage, 'awaitingDraft');
  assert.equal(loaded.awaitingDraft.round, refAwSnapshot.round, '再構築された中断点のラウンドが一致');
  assert.deepEqual(loaded.awaitingDraft.pool.map((p) => p.id).sort(), refAwSnapshot.poolIds, '再構築された中断点のプール構成が一致');

  // 誤cfgのまま解決を続けても（同じ戦略で）フル対話と同一結果に収束する。
  const loadedOff = resolveDraft(loaded);
  assert.equal(sig(loadedOff), refSig, 'load(誤cfg)経由でも同じ指名列を辿れば同一結果に収束する（決定論の再現・設計方針4）');
});

test('H2: 対話ドラフトを経ても支配下ロスター構成（70人・投手33-36）等の不変量が保たれる', () => {
  const cfg = createConfig({ game: { interactiveDraft: true } });
  const st = newGame(SEED, 'T1', { cfg });
  const R = cfg.tuning.roster;
  for (let y = 0; y < 5; y++) {
    advanceTo(st, 'seasonEnd');
    let off = advanceYear(st);
    while (off === null) off = submitDraftPick(st, pickStrategy(st.awaitingDraft));
    assert.equal(st.league.players.length, cfg.league.numTeams * R.controlledPerTeam, `${y}年目オフ後も支配下人口は恒常`);
    for (const t of st.league.teams) {
      const roster = st.league.players.filter((p) => p.teamId === t.id);
      assert.equal(roster.length, R.controlledPerTeam, `${t.id}: 支配下${R.controlledPerTeam}人`);
      const nPit = roster.filter((p) => p.role === 'pitcher').length;
      assert.ok(nPit >= R.pitchersMin && nPit <= R.pitchersMax, `${t.id}: 投手${R.pitchersMin}-${R.pitchersMax}人（実際${nPit}）`);
    }
    assert.ok(st.league.players.every((p) => p.rosterStatus === 'active'), '支配下は全員active（対話ドラフトでも育成が混ざらない）');
  }
});

test('H2: draftScoutView は真値(trueAbility)を露出しない — 伸びしろは個体の真のpeakAgeを見ない／評価は球団ごとに異なる（三層構造）', () => {
  const cfg = createConfig();

  // (a) 伸びしろ見立ては config の referencePeakAge 固定値のみを使う（個体の真の career.peakAge は不参照）。
  //     同一id・同一年齢で career.peakAge だけ大きく違う2体を比較し、upside が変わらないことを見る。
  const fakeState = (over = {}) => ({ cfg, masterSeed: 999, yearIndex: 0, playerTeamId: 'TX', league: { teams: [{ id: 'TX' }, { id: 'TY' }] }, ...over });
  const pYoungPeak = createPlayer({ id: 'PEAKTEST', name: 'PEAKTEST', role: 'fielder', primaryPos: 'CF', age: 20, trueAbility: createTrueAbility({ career: { peakAge: 20 } }) });
  const pOldPeak = createPlayer({ id: 'PEAKTEST', name: 'PEAKTEST', role: 'fielder', primaryPos: 'CF', age: 20, trueAbility: createTrueAbility({ career: { peakAge: 35 } }) });
  const vYoung = draftScoutView(fakeState(), pYoungPeak, [pYoungPeak]);
  const vOld = draftScoutView(fakeState(), pOldPeak, [pOldPeak]);
  assert.equal(vYoung.upside, vOld.upside, '伸びしろ判定は真の career.peakAge に依存しない（config定数referencePeakAgeのみを使う設計）');

  // (b) 同一プロスペクトへの評価が球団間で異なる（球団固有の評価プロファイル/観測ノイズが効いている＝
  //     真値をそのまま公開しているなら全球団で完全一致するはず）。
  const lg = generateLeague(SEED, cfg);
  const teamIds = lg.teams.map((t) => t.id);
  const pool = [];
  for (let i = 0; i < 20; i++) {
    pool.push(createPlayer({
      id: `SP${i}`, name: `SP${i}`, role: 'fielder', primaryPos: 'CF', age: 18 + (i % 10),
      trueAbility: createTrueAbility({ batting: { ev: 20 + i * 3, contact: 20 + (19 - i) * 3 }, common: { power: 30 + i * 2 } }),
    }));
  }
  const target = pool[10];
  const stateFor = (teamId) => ({ cfg, masterSeed: SEED, yearIndex: 3, playerTeamId: teamId, league: { teams: lg.teams } });
  const views = teamIds.map((tid) => draftScoutView(stateFor(tid), target, pool));
  const percentiles = new Set(views.map((v) => v.myPercentile.toFixed(6)));
  assert.ok(percentiles.size > 1, '同一プロスペクトへの評価(myPercentile)が球団間で異なる（球団固有ノイズ/重みの効果＝三層構造の証拠）');

  // (c) 構造チェック: 戻り値にtrueAbilityが一切含まれない／等級・ツール別段階が有効レンジに収まる。
  for (const v of views) {
    assert.ok(!('trueAbility' in v), 'draftScoutView の戻り値に trueAbility キーが無い');
    assert.ok(!JSON.stringify(v).includes('trueAbility'), 'シリアライズしても "trueAbility" という文字列すら含まれない');
    assert.ok(['S', 'A', 'B', 'C', 'D'].includes(v.grade), `等級はS/A/B/C/Dのいずれか（実際 ${v.grade}）`);
    for (const [tool, lvl] of Object.entries(v.tools)) {
      assert.ok(Number.isInteger(lvl) && lvl >= 1 && lvl <= 5, `ツール別段階は1-5の整数（${tool}=${lvl}）`);
    }
  }

  // 投手側の分岐（velo/control/stamina/stuff）もクラッシュせず有効レンジに収まることを確認。
  const pitcherProspect = createPlayer({ id: 'PITCH1', name: 'PITCH1', role: 'pitcher', primaryPos: 'P', age: 19, trueAbility: createTrueAbility() });
  const pv = draftScoutView(fakeState(), pitcherProspect, [pitcherProspect]);
  for (const [tool, lvl] of Object.entries(pv.tools)) {
    assert.ok(Number.isInteger(lvl) && lvl >= 1 && lvl <= 5, `投手ツール別段階は1-5の整数（${tool}=${lvl}）`);
  }
});

// ============================================================================
// F2-3: 昇格・降格（phaseF_spec F2-3）
//
// 主張:
//   1) IL補充: 一軍登録者が開幕IL入り→初日に二軍の同型最良（球団AI評価=観測＋スカウト）と
//      入替登録され、一軍デプスチャートの edit が成立する。離脱者は二軍でも出場不可。
//      復帰日に再入替（ilReturn）される。
//   2) 成績入替: 25試合レビュー周期で一軍不振者⇔二軍好調者の入替（perfSwap）が野手・投手の
//      双方で発生する。同型1:1（構成恒常）・クールダウン（10日ルール簡略）を破らない・
//      育成は登録されない。
//   3) 育成→支配下（C3a強化）: 昇格判定に二軍実成績（farmObs）が効く。支配下70枠が埋まって
//      いる球団は昇格できない（枠管理）。
//   4) 不変量: 多年運用でも支配下70人/球団・リーグ総人口840が保存され、登録は常に29人。
//   5) 決定論: 同一シードの再実行で rosterMoves が完全一致。途中セーブ→ロードの replay も
//      同一の入替を再構築し、続行結果が無セーブ通しと一致する。
//   6) R2: 1年目から出場登録入替が作動する（旧仕様は yearIndex>=1 のみ enableMoves を立てて
//      いたため rt.moves=null で1年目は入替が皆無だったが、これだとプレイヤーが最初に遊ぶ
//      1年目だけ故障者が一軍登録に居座り続ける破綻があった＝ユーザー報告で反転）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { selectActiveRoster } from '../src/sim/team.mjs';
import { createBattingLine } from '../src/model/statline.mjs';
import { newGame, advanceTo, advanceYear, save, load, rosterMoveHeadline } from '../src/game/index.mjs';
import { startSeasonRuntime, advanceRuntimeDay, pendingDay } from '../src/game/season_runtime.mjs';
import { runMarket } from '../src/game/market.mjs';

const SEED = 20260705;

// --- 共有ワールド: 1回だけ3年回して各主張で使い回す（テスト時間の節約） -----------------
const cfg = createConfig();
const ST = newGame(SEED, 'T1', { cfg });
advanceTo(ST, 'seasonEnd');
const MOVES_Y1 = ST.rt.rosterMoves.slice();
// R2検証用: 1年目終了時点の登録人数（1:1入替なら恒常のはず）を後で使うため、ここで確定させておく。
const REG_SIZE_Y1 = new Map(ST.league.teams.map((t) => [t.id, ST.rt.registeredByTeam.get(t.id).size]));
const OFF1 = advanceYear(ST);
advanceTo(ST, 'seasonEnd');
const MOVES_Y2 = ST.rt.rosterMoves.slice();
const OFF2 = advanceYear(ST);
// 昇格の検証は「昇格直後」の状態で行う。3年目のシーズン中に farmPromote スワップで
// 支配下→育成へ再契約されうる（applyFarmPromotionSwap は 1:1 の同型入替）ため、
// 後の時点で「昇格者は支配下」を要求すると正しい挙動を誤検知する。
const PROMO2_AFTER = new Map(
  OFF2.promotions.map((pr) => {
    const p = ST.league.players.find((x) => x.id === pr.playerId);
    return [pr.playerId, { inPlayers: !!p, status: p ? p.rosterStatus : null, inFarm: ST.league.farm.some((x) => x.id === pr.playerId) }];
  })
);
advanceTo(ST, 'seasonEnd');

test('F2-3: 1年目から入替が作動する（R2: 故障者の一軍居座り防止・二軍好調者の昇格）', () => {
  // 旧テストは「1年目は rosterMoves が空」であることを鉄則7の証拠として要求していたが、これは
  // 意図的に反転させた仕様（R2）。旧実装のままだと、プレイヤーが最初に遊ぶ1年目だけ故障者が
  // 一軍登録に居座り続け、二軍で好成績を残しても誰も昇格してこないという破綻があった
  // （ユーザー報告「一軍や二軍の入れ替えが正常じゃない」）。鉄則7の主旨は「多年要素（加齢/
  // 時代トレンド）を1年目に混ぜない」ことであり、登録入替はシーズン中の運用であって多年要素
  // ではない（era.test.mjs / game_c1a.test.mjs / game_c2a.test.mjs で別途直接検証済み）。
  // 本テストは「1年目からも入替が正しく機能する」ことを直接検証する。
  assert.ok(MOVES_Y1.length > 0, '1年目にも登録入替が発生する（旧実装は0件固定だった）');
  const types = new Set(MOVES_Y1.map((m) => m.type));
  assert.ok(
    types.has('ilReplace') || types.has('perfSwap') || types.has('farmPromote'),
    `1年目にIL補充/成績入替/育成昇格のいずれかが発生する（実際: ${[...types].join(',')}）`,
  );
  // 入替は常に同型1:1（swapRegistration/applyFarmPromotionSwap とも1減1増）なので、
  // 1年目を通じて登録人数（29人/球団）は恒常のはず。
  for (const t of ST.league.teams) {
    assert.equal(REG_SIZE_Y1.get(t.id), cfg.league.rosterActive, `${t.id}: 1年目終了時点でも登録29人（1:1入替で恒常）`);
  }
});

test('F2-3: IL補充 — 開幕ILの登録者が二軍の同型と入替され一軍editが成立、復帰日に再入替', () => {
  const c = createConfig();
  const lg = generateLeague(777, c);
  // 登録される野手を1人選び、開幕ILとして持ち込む（決定論の合成故障）
  const roster = lg.players.filter((p) => p.teamId === 'T1');
  const reg0 = new Set(selectActiveRoster(roster, c).map((p) => p.id));
  const victim = roster.find((p) => reg0.has(p.id) && p.role === 'fielder');
  const GAMES_LOST = 20;
  const rt = startSeasonRuntime(lg, c, {
    season: c.game.firstSeason,
    seed: 777,
    playerTeamId: 'T1',
    injuries: [{ id: victim.id, severity: 'minor', gamesLost: GAMES_LOST }],
    enableMoves: true,
    masterSeed: 777,
  });
  assert.ok(rt.moves, 'movesランタイムが成立する');
  // 初日: IL補充が発生する
  const step0 = advanceRuntimeDay(rt);
  const rep = step0.rosterMoves.find((m) => m.type === 'ilReplace' && m.downId === victim.id);
  assert.ok(rep, '離脱者のIL補充が初日に発生する');
  assert.equal(rep.teamId, 'T1');
  assert.equal(rep.upPos, victim.primaryPos, '補充は同ポジション');
  const reg = rt.registeredByTeam.get('T1');
  assert.equal(reg.size, c.league.rosterActive, '登録は29人のまま');
  assert.ok(!reg.has(victim.id) && reg.has(rep.upId), '登録の入替が反映される');
  // 一軍デプスチャートの edit が成立（editされたチャートは補充選手を含み離脱者を含まない）
  const chart = rt.chartsByTeam.get('T1').dh;
  assert.ok(chart.byId.has(rep.upId) && !chart.byId.has(victim.id), '一軍チャートがeditされる');
  // 補充選手は育成でない（支配下のみ登録可）
  assert.ok(!lg.farm.some((p) => p.id === rep.upId), '育成はシーズン中に登録されない');
  // 離脱者は二軍でも出場不可（IL選手が二軍戦に出る矛盾の防止）
  assert.equal(rt.farm.usageByTeam.get('T1').injuredUntil.get(victim.id), GAMES_LOST);
  // 復帰日: 再入替（ilReturn）
  let ret = null;
  while (!ret && pendingDay(rt) <= GAMES_LOST + 8 && !rt.finished) {
    const s = advanceRuntimeDay(rt);
    ret = s.rosterMoves.find((m) => m.type === 'ilReturn' && m.upId === victim.id);
  }
  assert.ok(ret, '復帰日に再入替が発生する');
  assert.ok(ret.day >= GAMES_LOST, '離脱期間中は復帰しない');
  assert.ok(reg.has(victim.id), '復帰者が再登録される');
  assert.equal(reg.size, c.league.rosterActive, '登録は29人のまま');
  // 離脱者は在籍中に二軍出場記録を持たない（IL徹底の検証）
  assert.ok(!rt.farm.stats.stats.has(victim.id), '離脱者は二軍戦にも出ていない');
  // ニュース見出しが生成できる（週次ダイジェスト/ハブの素材）
  const tname = () => 'チーム';
  assert.ok(rosterMoveHeadline(rep, tname).includes('昇格'));
  assert.ok(rosterMoveHeadline(ret, tname).includes('復帰'));
});

test('F2-3: 成績入替 — 不振降格/好調昇格が野手・投手の双方で発生する（2年目）', () => {
  const perf = MOVES_Y2.filter((m) => m.type === 'perfSwap');
  assert.ok(perf.length > 0, '成績入替が発生する');
  assert.ok(perf.some((m) => m.upPos === 'P'), '投手の入替がある');
  assert.ok(perf.some((m) => m.upPos !== 'P'), '野手の入替がある');
  // 昇格した好調者は実際に一軍で出場機会を得る（入替が機能している）
  const played = perf.filter((m) => ST.careerStats.some((s) => s.season === ST.year - 1 && s.playerId === m.upId));
  assert.ok(played.length / perf.length > 0.5, '昇格者の過半が一軍成績を持つ');
});

test('F2-3: 入替は同型1:1（構成恒常）でクールダウン（10日ルール簡略）を破らない', () => {
  for (const MOVES of [MOVES_Y2, ST.rt.rosterMoves]) {
    for (const m of MOVES) {
      // 投手は同role・野手は同primaryPos（登録・二軍双方のポジション構成が不変）
      assert.equal(m.upPos === 'P', m.downPos === 'P', `${m.type}: role一致`);
      if (m.upPos !== 'P') assert.equal(m.upPos, m.downPos, `${m.type}: 同ポジション`);
    }
    // クールダウン: 成績入替は直近の移動から swapCooldownDays 未満では起きない（IL入替は強制で対象外）
    const lastDay = new Map();
    for (const m of MOVES) {
      for (const pid of [m.upId, m.downId]) {
        const prev = lastDay.get(pid);
        if (prev != null && m.type === 'perfSwap') {
          assert.ok(m.day - prev >= cfg.tuning.moves.swapCooldownDays, `${pid}: クールダウン ${prev}→${m.day}`);
        }
        lastDay.set(pid, m.day);
      }
    }
  }
});

test('F2-3: 多年不変量 — 支配下70人/球団・登録29人・総人口保存・育成と登録の分離', () => {
  const nTeams = ST.league.teams.length;
  assert.equal(ST.league.players.length, cfg.tuning.roster.controlledPerTeam * nTeams, '総支配下人口の保存');
  const minorIds = new Set(ST.league.farm.map((p) => p.id));
  for (const t of ST.league.teams) {
    const controlled = ST.league.players.filter((p) => p.teamId === t.id);
    assert.equal(controlled.length, cfg.tuning.roster.controlledPerTeam, `${t.id}: 支配下70人`);
    const reg = ST.rt.registeredByTeam.get(t.id);
    assert.equal(reg.size, cfg.league.rosterActive, `${t.id}: 登録29人`);
    for (const pid of reg) assert.ok(!minorIds.has(pid), `${t.id}: 登録に育成が混ざらない`);
    // 登録と二軍ロスターの排他（入替後も重複なし）
    const farmIds = new Set(ST.rt.farm.rosterByTeam.get(t.id).map((p) => p.id));
    for (const pid of reg) assert.ok(!farmIds.has(pid), `${t.id}: 登録者は二軍ロスターに居ない`);
    // 育成枠は上限以内
    const nDev = ST.league.farm.filter((p) => p.teamId === t.id).length;
    assert.ok(nDev <= cfg.tuning.market.farm.perTeamMax, `${t.id}: 育成枠上限`);
  }
  assert.ok(ST.league.farm.every((p) => p.rosterStatus === 'minor'), '育成は全員minor');
});

test('F2-3: 育成→支配下 — オフの昇格は空き枠を同型消費し支配下70を超えない', () => {
  // 共有ワールドの2オフで発生した昇格（二軍実成績ベース判定・farmObs 配線の実地確認）
  const promos = [...OFF1.promotions, ...OFF2.promotions];
  assert.ok(promos.length > 0, '多年で育成昇格が発生する');
  for (const pr of promos) {
    // 昇格「直後」に支配下(active)へ移り、育成枠から抜けていること（後年の再契約は別問題）
    if (OFF2.promotions.includes(pr)) {
      const st = PROMO2_AFTER.get(pr.playerId);
      assert.ok(st.inPlayers, `${pr.playerId}: 昇格直後は支配下に居る`);
      assert.equal(st.status, 'active', `${pr.playerId}: 昇格直後は active`);
      assert.ok(!st.inFarm, `${pr.playerId}: 昇格直後は育成枠から抜けている`);
    }
  }
});

test('F2-3: 育成→支配下 — 二軍実成績（farmObs）が昇格判定を左右する', () => {
  const mkCfg = () => {
    const c = createConfig();
    c.tuning.market.farm.promoteThreshold = 200; // 素の観測では絶対に届かない
    c.tuning.market.farm.promoteWobaW = 4000; // 二軍実成績ボーナスが支配的
    return c;
  };
  const pick = (lg) => lg.farm.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).find((d) => d.role === 'fielder');
  // 二軍で打ちまくった観測ライン（wOBA高・十分な標本）
  const monsterBat = () => {
    const b = createBattingLine();
    Object.assign(b, { pa: 400, ab: 340, h: 130, b1: 70, b2: 30, b3: 5, hr: 25, bb: 50, hbp: 5, so: 60 });
    return b;
  };
  // (a) 空き枠あり＋二軍実成績あり → 昇格する
  const cA = mkCfg();
  const lgA = generateLeague(4242, cA);
  const devA = pick(lgA);
  const victimA = lgA.players.find((p) => p.teamId === devA.teamId && p.role === 'fielder' && p.primaryPos === devA.primaryPos);
  lgA.players = lgA.players.filter((p) => p.id !== victimA.id); // 引退で1枠空く（69/70）
  const vacA = [{ teamId: devA.teamId, role: 'fielder', primaryPos: devA.primaryPos }];
  const farmObs = new Map([[devA.id, { playerId: devA.id, batting: monsterBat(), pitching: null }]]);
  const resA = runMarket(lgA, cA, { vacancies: vacA, standings: null, masterSeed: 4242, yearIndex: 1, debutYear: 2027, farmObs });
  assert.ok(resA.promoted.some((p) => p.id === devA.id), '二軍実成績が良い育成が昇格する');
  // (b) 同一条件で二軍実成績なし → 昇格しない（実成績が判定を左右した証明）
  const cB = mkCfg();
  const lgB = generateLeague(4242, cB);
  const devB = pick(lgB);
  lgB.players = lgB.players.filter((p) => p.id !== lgB.players.find((p2) => p2.teamId === devB.teamId && p2.role === 'fielder' && p2.primaryPos === devB.primaryPos).id);
  const resB = runMarket(lgB, cB, { vacancies: [{ teamId: devB.teamId, role: 'fielder', primaryPos: devB.primaryPos }], standings: null, masterSeed: 4242, yearIndex: 1, debutYear: 2027, farmObs: null });
  assert.ok(!resB.promoted.some((p) => p.id === devB.id), '実成績なしでは昇格しない');
  // (c) 支配下70枠が埋まっている → 実成績が良くても昇格できない（枠管理）
  const cC = mkCfg();
  const lgC = generateLeague(4242, cC);
  const devC = pick(lgC);
  const resC = runMarket(lgC, cC, {
    vacancies: [{ teamId: devC.teamId, role: 'fielder', primaryPos: devC.primaryPos }], // 枠は空いていないが空き枠だけ偽装
    standings: null, masterSeed: 4242, yearIndex: 1, debutYear: 2027,
    farmObs: new Map([[devC.id, { playerId: devC.id, batting: monsterBat(), pitching: null }]]),
  });
  assert.ok(!resC.promoted.some((p) => p.id === devC.id), '支配下70が埋まった球団は昇格不可');
});

test('F2-3: 決定論 — 同一シード再実行で入替ログと順位が完全一致', () => {
  const mk = () => {
    const s = newGame(999, 'T4', { cfg: createConfig() });
    advanceTo(s, 'seasonEnd');
    advanceYear(s);
    advanceTo(s, 'seasonEnd');
    return s;
  };
  const a = mk();
  const b = mk();
  assert.ok(a.rt.rosterMoves.length > 0, '2年目に入替が発生する');
  assert.deepEqual(a.rt.rosterMoves, b.rt.rosterMoves, 'rosterMoves が bit 一致');
  const sig = (s) => JSON.stringify([...s.rt.standings.values()].map((r) => [r.teamId, r.w, r.l, r.t, r.rs, r.ra]));
  assert.equal(sig(a), sig(b), '順位が一致');
});

test('F2-3: セーブ/ロード — replay が同一の入替を再構築し続行が無セーブ通しと一致', () => {
  const live = newGame(555, 'T3', { cfg: createConfig() });
  advanceTo(live, 'seasonEnd');
  advanceYear(live);
  advanceTo(live, 'monthEnd'); // 2年目の途中（開幕IL補充が発生している時期）
  const blob = JSON.parse(JSON.stringify(save(live)));
  const restored = load(blob, { cfg: createConfig() });
  assert.deepEqual(restored.rt.rosterMoves, live.rt.rosterMoves, 'replayが同一の入替を再構築する');
  advanceTo(live, 'seasonEnd');
  advanceTo(restored, 'seasonEnd');
  assert.deepEqual(restored.rt.rosterMoves, live.rt.rosterMoves, 'ロード後の続行も同一の入替');
  const sig = (s) => JSON.stringify([...s.rt.standings.values()].map((r) => [r.teamId, r.w, r.l, r.t, r.rs, r.ra]));
  assert.equal(sig(restored), sig(live), '続行結果が無セーブ通しと一致');
});

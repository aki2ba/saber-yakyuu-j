// ============================================================================
// フェーズC3a: 編成市場（球団AI評価の球団差・ドラフト・育成/支配下二層）のテスト。
//   - 球団AI評価が球団ごとに異なる（癖・重み・ノイズの差・§13/§15）
//   - 守備を重める球団(wDef>1)が守備型選手を相対的に高評価（守備版マネーボールの素・§13）
//   - 宝の泉: 高wDefの球団群が真の守備価値の高い新人を系統的に多く獲る（市場の非効率の発現）
//   - ドラフト: ウェーバー逆順（前年最下位が先）＋1位競合くじ（NPB風・§15）
//   - 育成/支配下 二層: 育成枠が populate され、そこからの昇格が "稀に" 起きる（§12.1）
//   - 決定論（同一シードの20年運用が bit 一致／別シードは別運命）
//   - 多年でリーグ人口・ロスター構成が恒常（引退枠を市場が過不足なく埋める）
//   - 1年目（既存50較正）はオフシーズン前＝市場ゼロ（エンジン不変の担保）
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear } from '../src/game/index.mjs';
import { teamEvalProfile, evaluateProspect, trueValue } from '../src/game/market.mjs';
import { createPlayer, createTrueAbility } from '../src/model/player.mjs';
import { POSITION_ADJUST_PER_1350 } from '../src/model/positions.mjs';

const cfg = createConfig();
const SEED = 20260701; // 決定論テスト＝一度PASSすれば恒久（下の各帯はこのシードで検証済み）

/** N年運用し、市場イベントを集約する（重いので使い回す）。 */
function runYears(seed, years, teamId = 'T1') {
  const st = newGame(seed, teamId, { cfg });
  const agg = {
    promotions: 0, rookies: 0, lotteries: 0, contested: 0,
    waiverWorstFirst: 0, lotteryWinnerValid: true,
    acquiredDef: new Map(), // teamId → {sum,n}（獲得新人の真の守備価値）
    marketSig: [],
  };
  for (let y = 0; y < years; y++) {
    advanceTo(st, 'seasonEnd');
    const preHist = st.teamHistory.find((h) => h.year === st.year);
    const off = advanceYear(st);
    agg.promotions += off.promotions.length;
    agg.rookies += off.rookies.length;
    agg.lotteries += off.draftLog.lotteries.length;
    agg.contested += off.draftLog.picks.filter((p) => p.contested).length;
    // ウェーバー逆順: 先頭は前年の最下位（最小勝率）であるべき（同率は許容）。
    const wp = (s) => { const d = s.w + s.l; return d ? s.w / d : 0.5; };
    const minWp = Math.min(...preHist.standings.map(wp));
    const leadWp = wp(preHist.standings.find((s) => s.teamId === off.draftLog.order[0]));
    if (Math.abs(leadWp - minWp) < 1e-9) agg.waiverWorstFirst++;
    for (const lot of off.draftLog.lotteries) {
      if (!lot.contenders.includes(lot.winner)) agg.lotteryWinnerValid = false;
    }
    for (const r of off.rookies) {
      const d = defTrue(r);
      if (d == null) continue;
      if (!agg.acquiredDef.has(r.teamId)) agg.acquiredDef.set(r.teamId, { s: 0, n: 0 });
      const a = agg.acquiredDef.get(r.teamId);
      a.s += d; a.n++;
    }
    agg.marketSig.push(`${off.promotions.length},${off.rookies.length},${off.draftLog.lotteries.length},${off.draftLog.order.join('')}`);
  }
  return { st, agg };
}

/** 新人（野手）の「真の守備価値」＝守備ツール＋位置価値（AIは正しくは見ない量・§13）。 */
function defTrue(p) {
  if (p.role !== 'fielder') return null;
  const t = p.trueAbility;
  return (
    (t.fielding.positionProf[p.primaryPos] ?? 20) +
    t.fielding.positioningIQ +
    t.common.reaction +
    0.5 * t.common.arm +
    (POSITION_ADJUST_PER_1350[p.primaryPos] ?? 0) * 1.4
  );
}

function rosterSig(st) {
  return st.league.players
    .map((p) => `${p.id}:${p.age}:${p.trueAbility.batting.eye}:${p.trueAbility.pitching.velocityKmh}`)
    .sort()
    .join('|');
}

const YEARS = 20;
const RUN = runYears(SEED, YEARS);

test('C3a: 球団AI評価が球団ごとに異なる（癖・重み・ノイズ・§15）', () => {
  const profs = RUN.st.league.teams.map((t) => teamEvalProfile(SEED, t.id, cfg));
  // 重みが球団間でばらける（全球団同一ではない＝市場の非効率の前提）。
  const uniq = (xs) => new Set(xs.map((v) => v.toFixed(3))).size;
  assert.ok(uniq(profs.map((p) => p.wDef)) >= 8, '守備重みが球団ごとに散らばる');
  assert.ok(uniq(profs.map((p) => p.wEye)) >= 8, '出塁重みが球団ごとに散らばる');
  // 多くの球団は守備/位置を過小評価(wDef<1)し、稀に正しく重める球団(wDef>1)が混じる（§13）。
  assert.ok(profs.filter((p) => p.wDef < 1).length >= profs.length / 2, '過半が守備を過小評価（市場の非効率）');
  assert.ok(profs.some((p) => p.wDef > 1), '守備を正しく重める球団が存在（守備版マネーボールの担い手）');
  // 同一 prospect でも球団ごとに評価がばらつく（重み＋スカウトノイズ）。
  const sample = RUN.st.league.players.find((p) => p.role === 'fielder');
  const evals = RUN.st.league.teams.map((t) =>
    evaluateProspect(teamEvalProfile(SEED, t.id, cfg), sample, cfg, { masterSeed: SEED, yearIndex: 5, teamId: t.id }),
  );
  assert.ok(new Set(evals.map((e) => e.toFixed(2))).size >= 8, '同一選手の評価が球団ごとに異なる');
});

test('C3a: 守備を重める球団は守備型選手を相対的に高評価（§13）', () => {
  // 守備型（高守備・高位置価値SS・低打撃）と 打撃型（強打の1B・低守備）を作る。
  const defType = createPlayer({
    id: 'DEFTYPE', role: 'fielder', primaryPos: 'SS',
    trueAbility: createTrueAbility({
      common: { reaction: 72, arm: 70, power: 35 },
      batting: { ev: 35, contact: 38, eye: 40, la: 40 },
      fielding: { positionProf: { SS: 74 }, positioningIQ: 72 },
    }),
  });
  const slugType = createPlayer({
    id: 'SLUGTYPE', role: 'fielder', primaryPos: '1B',
    trueAbility: createTrueAbility({
      common: { reaction: 40, arm: 42, power: 72 },
      batting: { ev: 72, contact: 68, eye: 66, la: 66 },
      fielding: { positionProf: { '1B': 45 }, positioningIQ: 40 },
    }),
  });
  const smart = { wBat: 1, wEye: 1, wDef: 1.6, ageBias: 0, noiseSd: 0 };
  const dumb = { wBat: 1, wEye: 1, wDef: 0.1, ageBias: 0, noiseSd: 0 };
  const relSmart = evaluateProspect(smart, defType, cfg) - evaluateProspect(smart, slugType, cfg);
  const relDumb = evaluateProspect(dumb, defType, cfg) - evaluateProspect(dumb, slugType, cfg);
  // 守備を重める球団ほど「守備型 − 打撃型」の相対評価が上がる（守備型を拾いやすい）。
  assert.ok(relSmart > relDumb, `守備重視ほど守備型を相対的に高評価（smart ${relSmart.toFixed(0)} > dumb ${relDumb.toFixed(0)}）`);
  // 真価値では守備型SSは位置価値込みで十分高い（AIの多数派はこれを取りこぼす＝宝の泉）。
  assert.ok(trueValue(defType, cfg) > 0, '守備型SSの真価値は正（位置価値込み）');
});

test('C3a: 宝の泉 — 守備を重める球団群が真の守備価値の高い新人を系統的に多く獲る（§13）', () => {
  const profs = new Map(RUN.st.league.teams.map((t) => [t.id, teamEvalProfile(SEED, t.id, cfg)]));
  const rows = [...RUN.agg.acquiredDef]
    .map(([tid, a]) => ({ tid, wDef: profs.get(tid).wDef, avgDef: a.s / a.n }))
    .sort((x, y) => x.wDef - y.wDef);
  const avg = (a) => a.reduce((s, r) => s + r.avgDef, 0) / a.length;
  const half = Math.floor(rows.length / 2);
  const low = avg(rows.slice(0, half)); // wDef 下位（守備軽視）
  const high = avg(rows.slice(rows.length - half)); // wDef 上位（守備重視）
  assert.ok(high > low, `高wDef球団群ほど真守備価値の高い新人を獲得（high ${high.toFixed(1)} > low ${low.toFixed(1)}）`);
});

test('C3a: ドラフトはウェーバー逆順＋1位競合くじ（NPB風・§15）', () => {
  const { agg } = RUN;
  // ウェーバー逆順: ドラフト順の先頭は前年最下位（最小勝率・同率許容）＝ほぼ毎年成立。
  assert.ok(agg.waiverWorstFirst >= YEARS - 1, `指名順の先頭が前年最下位（${agg.waiverWorstFirst}/${YEARS}）`);
  // 1位競合くじ: 複数球団の1位が競合しくじで決まる事象が起きる。勝者は必ず競合者の中から出る。
  assert.ok(agg.lotteries > 0, '1位競合くじが発生する');
  assert.ok(agg.contested > 0, '競合を経た指名がログに残る');
  assert.ok(agg.lotteryWinnerValid, 'くじの当選球団は必ず入札球団の中から出る');
});

test('C3a: 育成/支配下 二層 — 育成枠が populate され、昇格が "稀に" 起きる（§12.1）', () => {
  const { st, agg } = RUN;
  // 育成枠（farm）は支配下396とは別枠で保持され、rosterStatus='minor'。支配下には minor は混じらない。
  assert.ok(st.league.farm.length > 0, '育成枠に選手が在籍する');
  assert.ok(st.league.farm.every((d) => d.rosterStatus === 'minor'), '育成枠は全員 minor 登録');
  assert.ok(st.league.players.every((p) => p.rosterStatus !== 'minor'), '支配下ロスターに育成選手は混じらない');
  // 這い上がり: 20年で昇格が起きる（0でない）。ただし新人補充総数に比べて "稀"（這い上がりの箱）。
  assert.ok(agg.promotions > 0, '20年で育成からの昇格が起きる（這い上がり）');
  assert.ok(agg.promotions < agg.rookies * 0.25, `昇格は補充の少数派（稀・${agg.promotions}/${agg.rookies}）`);
});

test('C3a: 多年でリーグ人口・ロスター構成が恒常（引退枠を市場が過不足なく埋める）', () => {
  const P = RUN.st.league.players;
  const R = cfg.tuning.roster;
  assert.equal(P.length, cfg.league.numTeams * R.controlledPerTeam, '支配下人口は恒常（引退枠 = 昇格+ドラフト）');
  for (const t of RUN.st.league.teams) {
    const roster = P.filter((p) => p.teamId === t.id);
    const nPit = roster.filter((p) => p.role === 'pitcher').length;
    assert.equal(roster.length, R.controlledPerTeam, `${t.id} は支配下70人`);
    assert.ok(nPit >= R.pitchersMin && nPit <= R.pitchersMax, `${t.id} は投手33-36（${nPit}）`);
  }
  // 育成枠は有限（球団あたり上限 perTeamMax）。
  const farmMax = cfg.tuning.market.farm.perTeamMax;
  for (const t of RUN.st.league.teams) {
    assert.ok(RUN.st.league.farm.filter((d) => d.teamId === t.id).length <= farmMax, `${t.id} 育成枠は上限以内`);
  }
});

test('C3a: 決定論 — 同一シードの20年市場が bit 一致／別シードは別運命', () => {
  const a = runYears(SEED, YEARS);
  assert.equal(a.agg.marketSig.join(';'), RUN.agg.marketSig.join(';'), '市場イベント列が一致');
  assert.equal(a.agg.promotions, RUN.agg.promotions, '昇格数が一致');
  assert.equal(rosterSig(a.st), rosterSig(RUN.st), '最終ロスターが bit 一致');
  const b = runYears(SEED + 1, YEARS);
  assert.notEqual(rosterSig(b.st), rosterSig(RUN.st), '別シードは別の運命');
});

test('C3a: 1年目はオフシーズン前＝市場ゼロ（育成枠は初期生成分のみ・F2-1）', () => {
  const st = newGame(SEED, 'T1', { cfg });
  advanceTo(st, 'seasonEnd');
  // 1年目レギュラーシーズン完了時点で年インデックスは0のまま＝市場は一切走っていない。
  // F2-1: 育成枠は初期生成から埋まる（各球団 devCountMin-Max・全員minor）。市場由来の増減はない。
  const R = cfg.tuning.roster;
  for (const t of st.league.teams) {
    const n = st.league.farm.filter((d) => d.teamId === t.id).length;
    assert.ok(n >= R.devCountMin && n <= R.devCountMax, `${t.id} の育成 ${n} は初期生成の帯内（10-40）`);
  }
  assert.ok(st.league.farm.every((d) => d.rosterStatus === 'minor'), '育成は全員 minor');
  assert.equal(st.yearIndex, 0, '1年目のまま（advanceYear 前は世代交代なし）');
  assert.equal(st.league.players.length, cfg.league.numTeams * R.controlledPerTeam, '1年目ロスターは生成時のまま');
});

// 試合エンジンS2（ベンチ・采配・投手打席・継投v2）の統合テスト。
// simulateGame の返り値（pitchers=投手使用ログ / subs=交代ログ）で内部状態の不変量を検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { buildDepthChart } from '../src/sim/team.mjs';
import { simulateGame } from '../src/sim/game.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { makeRng, hashSeed } from '../src/rng.mjs';
import { NEUTRAL_PARK } from '../src/model/battedball.mjs';
import { createPlayerSeason } from '../src/model/statline.mjs';

const cfg = createConfig();
const lg = generateLeague(2026, cfg);
const byId = new Map(lg.players.map((p) => [p.id, p]));

// 対戦カード: T1(L1) vs T7(L2)。DH有/無の両編成を用意
const A = lg.teams[0];
const B = lg.teams[6];
const chartsOf = (t) => {
  const r = lg.players.filter((p) => p.teamId === t.id);
  return { dh: buildDepthChart(r, cfg, { dh: true }), noDh: buildDepthChart(r, cfg, { dh: false }) };
};
const cA = chartsOf(A);
const cB = chartsOf(B);

function playGame(seed, dh) {
  const stats = new Map();
  const statFor = (pid, teamId) => {
    let s = stats.get(pid);
    if (!s) {
      s = createPlayerSeason(pid, 2026);
      s.teamId = teamId;
      stats.set(pid, s);
    }
    return s;
  };
  const res = simulateGame(
    { teamId: A.id, depth: dh ? cA.dh : cA.noDh, starterIdx: seed, manager: A.manager, dh },
    { teamId: B.id, depth: dh ? cB.dh : cB.noDh, starterIdx: seed, manager: B.manager, dh },
    cfg,
    makeRng(hashSeed(777, 'game', seed, dh ? 1 : 0)),
    statFor,
    NEUTRAL_PARK,
  );
  return { res, stats };
}

test('simulateGame: 同一seedで完全に決定論（スコア・投手ログ・交代ログ）', () => {
  const a = playGame(3, false);
  const b = playGame(3, false);
  assert.deepEqual(JSON.parse(JSON.stringify(a.res)), JSON.parse(JSON.stringify(b.res)));
});

test('引分試合の innings は maxInnings(12) を超えない（off-by-one 回帰）', () => {
  // 12回制で引分に至った試合が innings=13 を返さないこと（決着試合は最大12）。
  let ties = 0;
  let decided = 0;
  for (let seed = 0; seed < 60; seed++) {
    const { res } = playGame(seed, seed % 2 === 0);
    assert.ok(res.innings <= 12, `innings が 12 を超えた (seed=${seed}, innings=${res.innings})`);
    if (res.tie) {
      ties++;
      assert.equal(res.innings, 12, `引分は12回で確定すべき (seed=${seed}, innings=${res.innings})`);
    } else {
      decided++;
      assert.ok(res.innings >= 9, `決着は9回以降 (seed=${seed}, innings=${res.innings})`);
    }
  }
  assert.ok(ties > 0, `検証に足る引分試合が発生しなかった（ties=${ties}）`);
  assert.ok(decided > 0);
});

test('記録アウトのある投手は必ず登板G>0（幽霊登板の回帰・盗塁死のみで降板を含む）', () => {
  // 盗塁死の第3アウトのみで降板した投手（bf=0, outs>0）も登板として計上されること。
  // シーズン全体で「pitching.outs>0 なのに g=0」の投手が1人も出ないことを不変量として検証。
  const r = simulateSeason(lg, cfg, { seed: 4242, postseason: false });
  let violations = 0;
  for (const s of r.playerSeasons) {
    if (s.pitching.outs > 0 && s.pitching.g === 0) violations++;
  }
  assert.equal(violations, 0, `記録アウトはあるが登板G=0の幽霊投手が ${violations} 人`);
});

test('投手打席はDH無し試合のみ（DH有=投手PA0 / DH無=投手が打席に立つ）（S2）', () => {
  for (let seed = 0; seed < 5; seed++) {
    const dhGame = playGame(seed, true);
    for (const [pid, s] of dhGame.stats) {
      if (byId.get(pid).role === 'pitcher') assert.equal(s.batting.pa, 0, `DH有で投手 ${pid} が打席に立たない`);
    }
    const noDhGame = playGame(seed, false);
    let pitcherPA = 0;
    for (const [pid, s] of noDhGame.stats) {
      if (byId.get(pid).role === 'pitcher') pitcherPA += s.batting.pa;
    }
    assert.ok(pitcherPA > 0, `DH無で投手が打席に立つ (seed=${seed}, got ${pitcherPA})`);
  }
});

test('一度退いた選手は再出場不可・入場は一度だけ（交代ログの不変量）（S2）', () => {
  let events = 0;
  for (let seed = 0; seed < 40; seed++) {
    for (const dh of [true, false]) {
      const { res } = playGame(seed, dh);
      for (const key of ['home', 'away']) {
        const left = new Set(); // 退場済み
        const came = new Set(); // 入場済み
        for (const ev of res.subs[key]) {
          events++;
          assert.ok(!left.has(ev.inPid), `退場済み選手の再出場 (${ev.type} ${ev.inPid} seed=${seed})`);
          assert.ok(!came.has(ev.inPid), `同一選手の二重入場 (${ev.type} ${ev.inPid} seed=${seed})`);
          came.add(ev.inPid);
          if (ev.outPid != null) left.add(ev.outPid);
        }
      }
    }
  }
  assert.ok(events > 100, `交代が十分発生している (got ${events})`);
});

test('代打/代走/守備固めが発生し、交代後も守備アウト勘定が整合（Σ守備アウト=8×Σ投手アウト）（S2）', () => {
  const typeCount = { PH: 0, PR: 0, DEF: 0, RP: 0 };
  for (let seed = 0; seed < 30; seed++) {
    for (const dh of [true, false]) {
      const { res, stats } = playGame(seed, dh);
      for (const key of ['home', 'away']) for (const ev of res.subs[key]) typeCount[ev.type]++;
      // 勘定恒等式（監査A2の per-game 版）: 交代（代打の守備引き継ぎ・守備固め・投手交代）後も守る
      let posOuts = 0;
      let pOuts = 0;
      for (const s of stats.values()) {
        for (const k of Object.keys(s.fielding.positionOuts)) {
          if (k !== 'DH') posOuts += s.fielding.positionOuts[k];
        }
        pOuts += s.pitching.outs;
      }
      assert.equal(posOuts, 8 * pOuts, `守備アウト整合 (seed=${seed} dh=${dh})`);
      // 代打には batting.ph が計上される
      for (const key of ['home', 'away']) {
        for (const ev of res.subs[key]) {
          if (ev.type === 'PH') assert.ok(stats.get(ev.inPid).batting.ph >= 1, `PH計上 ${ev.inPid}`);
        }
      }
    }
  }
  assert.ok(typeCount.PH > 0, `代打が発生 (${typeCount.PH})`);
  assert.ok(typeCount.PR > 0, `代走が発生 (${typeCount.PR})`);
  assert.ok(typeCount.DEF > 0, `守備固めが発生 (${typeCount.DEF})`);
  assert.ok(typeCount.RP > 0, `投手交代が発生 (${typeCount.RP})`);
});

test('継投v2: closerは9回以降のセーブ機会（リード1-3で登板）のみ・大差では出ない（S2）', () => {
  let closerEntries = 0;
  for (let seed = 0; seed < 40; seed++) {
    for (const dh of [true, false]) {
      const { res } = playGame(seed, dh);
      for (const key of ['home', 'away']) {
        const chart = key === 'home' ? (dh ? cA.dh : cA.noDh) : dh ? cB.dh : cB.noDh;
        const closer = chart.bullpenRoles.closer;
        for (const ap of res.pitchers[key]) {
          if (ap.pid !== closer) continue;
          closerEntries++;
          assert.ok(
            ap.enterDiff >= 1 && ap.enterDiff <= cfg.tuning.pen.saveLeadMax && ap.enterInning >= 9,
            `closerの登板はセーブ機会のみ (seed=${seed} dh=${dh} diff=${ap.enterDiff} inn=${ap.enterInning})`,
          );
        }
      }
    }
  }
  assert.ok(closerEntries > 10, `closerがセーブ機会に登板している (got ${closerEntries})`);
});

test('DH無し試合: 交代した新投手が同スロット（9番）で打席に立つ（S2）', () => {
  let relieverBatPA = 0;
  for (let seed = 0; seed < 40; seed++) {
    const { res, stats } = playGame(seed, false);
    for (const key of ['home', 'away']) {
      const starterPid = res.pitchers[key][0]?.pid;
      for (const ap of res.pitchers[key]) {
        if (ap.pid === starterPid) continue;
        const s = stats.get(ap.pid);
        if (s && s.batting.pa > 0) relieverBatPA++;
      }
    }
  }
  assert.ok(relieverBatPA > 0, `救援投手が打順スロットを引き継いで打席に立つ (got ${relieverBatPA})`);
});

test('投手使用ログ（pid,pitches,outs）が返り、statlineと整合する（S3疲労管理の素材）（S2）', () => {
  for (let seed = 0; seed < 10; seed++) {
    const { res, stats } = playGame(seed, seed % 2 === 0);
    for (const [key, teamId] of [
      ['home', A.id],
      ['away', B.id],
    ]) {
      const log = res.pitchers[key];
      assert.ok(log.length >= 1, '投手使用ログがある');
      let logOuts = 0;
      for (const ap of log) {
        assert.ok(ap.pitches > 0, '投球数が正');
        assert.equal(byId.get(ap.pid).role, 'pitcher');
        logOuts += ap.outs;
      }
      let statOuts = 0;
      for (const [pid, s] of stats) {
        if (s.teamId === teamId) statOuts += s.pitching.outs;
      }
      assert.equal(logOuts, statOuts, `ログのアウト計=投手アウト計 (seed=${seed} ${key})`);
    }
  }
});

test('DH有はDH無より得点環境が高い（同一ロスターのA/B比較・セパ得点差の機序）（S2）', () => {
  // 決定論（固定seed列）なので結果は安定。帯の較正はS5、ここでは向きだけを固定する。
  const charts = lg.teams.map((t) => ({ t, ...chartsOf(t) }));
  const sum = { dh: 0, noDh: 0 };
  let n = 0;
  for (let seed = 0; seed < 200; seed++) {
    const hi = seed % 12;
    const ai = (seed + 1 + (seed % 11)) % 12;
    if (hi === ai) continue;
    const H = charts[hi];
    const Aw = charts[ai];
    for (const dh of [true, false]) {
      const stats = new Map();
      const statFor = (pid, teamId) => {
        let s = stats.get(pid);
        if (!s) {
          s = createPlayerSeason(pid, 2026);
          s.teamId = teamId;
          stats.set(pid, s);
        }
        return s;
      };
      const r = simulateGame(
        { teamId: H.t.id, depth: dh ? H.dh : H.noDh, starterIdx: seed, manager: H.t.manager, dh },
        { teamId: Aw.t.id, depth: dh ? Aw.dh : Aw.noDh, starterIdx: seed, manager: Aw.t.manager, dh },
        cfg,
        makeRng(hashSeed(555, 'ab', seed, dh ? 1 : 0)),
        statFor,
        NEUTRAL_PARK,
      );
      sum[dh ? 'dh' : 'noDh'] += r.homeScore + r.awayScore;
    }
    n++;
  }
  const diff = (sum.dh - sum.noDh) / n / 2;
  assert.ok(diff > 0.02, `DH有−DH無 の得点/チーム/試合 > 0 (got ${diff.toFixed(3)})`);
});

// --- シーズン統合（season.mjs のDH規則接続・戦術カウントの発現） -----------------

const seasonRes = simulateSeason(lg, cfg, { seed: 2026 });

test('シーズン: PA恒等式 pa=AB+BB+HBP+SF+SH（犠打はABに計上しない）・SH/PH/IBBの発現（S2）', () => {
  let sh = 0;
  let ph = 0;
  let ibb = 0;
  for (const s of seasonRes.playerSeasons) {
    const b = s.batting;
    assert.equal(b.pa, b.ab + b.bb + b.hbp + b.sf + b.sh, `PA恒等式 ${s.playerId}`);
    sh += b.sh;
    ph += b.ph;
    ibb += b.ibb;
  }
  assert.ok(sh > 0, `犠打が発生 (got ${sh})`);
  assert.ok(ph > 0, `代打が発生 (got ${ph})`);
  assert.ok(ibb > 0, `敬遠が発生 (got ${ibb})`);
});

test('シーズン: IBB⊆BB（打者・投手の両側）（S2）', () => {
  let ibbP = 0;
  for (const s of seasonRes.playerSeasons) {
    assert.ok(s.batting.ibb <= s.batting.bb, `打者IBB<=BB ${s.playerId}`);
    assert.ok(s.pitching.ibb <= s.pitching.bb, `投手IBB<=BB ${s.playerId}`);
    ibbP += s.pitching.ibb;
  }
  assert.ok(ibbP > 0, '投手側にもIBBが計上される');
});

test('シーズン: 投手打席はDH無しリーグ主催の試合で発現し、L1球団の投手PAがL2球団より多い（S2）', () => {
  const leagueOf = new Map(lg.teams.map((t) => [t.id, t.league]));
  const pa = { L1: 0, L2: 0 };
  for (const s of seasonRes.playerSeasons) {
    if (byId.get(s.playerId).role !== 'pitcher') continue;
    pa[leagueOf.get(s.teamId)] += s.batting.pa;
  }
  assert.ok(pa.L1 > 0 && pa.L2 > 0, `両リーグの投手が（主催規則に応じて）打席に立つ (${pa.L1}/${pa.L2})`);
  // L1球団はホーム全試合＋L1同士のビジターで投手が打つ＝L2球団の~2.5倍
  assert.ok(pa.L1 > pa.L2 * 1.5, `投手打席がL1球団に集中 (L1=${pa.L1} L2=${pa.L2})`);
});

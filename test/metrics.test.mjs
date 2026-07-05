// リーグ定数(1-6)＋選手別指標(1-7)の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants, fillLeagueConstants, rawRunValuePerPA } from '../src/sim/leagueConstants.mjs';
import { playerBatting, playerPitching, playerBaserunning, pythag } from '../src/sim/metrics.mjs';
import { leagueBatting } from '../src/sim/leagueStats.mjs';
import { createBattingLine, createPitchingLine } from '../src/model/statline.mjs';

const cfg = createConfig();
const res = simulateSeason(generateLeague(2026, cfg), cfg, { season: 2026, seed: 2026 });
const lc = deriveLeagueConstants(res);

test('リーグ定数: lgwOBA=lgOBP・wobaScale>0・fipConstant有限・rpwが妥当', () => {
  const lb = leagueBatting(res.playerSeasons);
  assert.ok(Math.abs(lc.lgwOBA - lb.obp) < 1e-9, 'lgwOBA=lgOBP');
  assert.ok(lc.wobaScale > 0.5 && lc.wobaScale < 3, `wobaScale=${lc.wobaScale}`);
  assert.ok(Number.isFinite(lc.fipConstant), 'fipConstant finite');
  assert.ok(lc.rpw > 7 && lc.rpw < 12, `rpw=${lc.rpw}`);
});

test('リーグ平均打者の wRC+ は ~100', () => {
  // リーグ全体を1人の打者に見立てて wRC+ を出すと 100 付近
  const lb = leagueBatting(res.playerSeasons);
  const fake = { batting: { ...lb } };
  const m = playerBatting(fake, lc);
  assert.ok(Math.abs(m.wrcPlus - 100) < 5, `league wRC+ = ${m.wrcPlus}`);
});

test('リーグ平均打者の wOBA は lgwOBA(=lgOBP) 付近', () => {
  const lb = leagueBatting(res.playerSeasons);
  const m = playerBatting({ batting: lb }, lc);
  assert.ok(Math.abs(m.woba - lc.lgwOBA) < 0.01, `woba ${m.woba} ~ lgwOBA ${lc.lgwOBA}`);
});

test('好打者は wRC+ > 100、凡打者 < 100', () => {
  const qual = res.playerSeasons.filter((s) => s.batting.pa >= 443);
  const metrics = qual.map((s) => playerBatting(s, lc)).sort((a, b) => b.wrcPlus - a.wrcPlus);
  assert.ok(metrics[0].wrcPlus > 120, `トップ wRC+ ${metrics[0].wrcPlus}`);
  assert.ok(metrics[metrics.length - 1].wrcPlus < 100, `最下位 wRC+ ${metrics[metrics.length - 1].wrcPlus}`);
  // AVG/OBP/SLG/OPS の整合
  const t = metrics[0];
  assert.ok(t.ops > 0.001 && Math.abs(t.ops - (t.obp + t.slg)) < 1e-9);
});

test('投手指標: 規定投手の ERA/FIP が妥当域・整合', () => {
  const qp = res.playerSeasons.filter((s) => s.pitching.outs / 3 >= 143);
  assert.ok(qp.length > 0, '規定投球回の投手が存在');
  for (const s of qp) {
    const m = playerPitching(s, lc);
    assert.ok(m.era >= 0 && m.era < 8, `ERA ${m.era}`);
    assert.ok(m.fip > 0 && m.fip < 8, `FIP ${m.fip}`);
    assert.ok(Math.abs(m.ip - s.pitching.outs / 3) < 1e-9);
  }
});

test('FIPはIBBを除外する（FG式 13HR+3(BB−IBB+HBP)−2K）（S3）', () => {
  const mk = (ibb) => ({ pitching: { ...createPitchingLine(), outs: 300, hr: 10, bb: 40, ibb, hbp: 5, so: 90 } });
  const a = playerPitching(mk(0), lc);
  const b = playerPitching(mk(10), lc);
  const ip = 100;
  assert.ok(Math.abs(a.fip - b.fip - (3 * 10) / ip) < 1e-9, 'IBB10個で 3×10/IP だけFIPが低い');
});

test('wOBAの素(rawRunValuePerPA)はFG定義準拠: uBB・分母=AB+BB−IBB+SF+HBP（S3）', () => {
  const base = { ...createBattingLine(), ab: 100, bb: 10, ibb: 0, hbp: 2, sf: 3, b1: 20, b2: 5, b3: 1, hr: 4 };
  const withIbb = { ...base, bb: 15, ibb: 5 }; // 敬遠5個の追加は分子・分母から消える
  assert.ok(Math.abs(rawRunValuePerPA(base) - rawRunValuePerPA(withIbb)) < 1e-12, 'IBBはwOBAに影響しない');
  // 分母の確認: SF/HBP込み・IBB抜き
  const denomBase = base.ab + base.bb - base.ibb + base.sf + base.hbp;
  const num = 0.55 * 10 + 0.58 * 2 + 0.7 * 20 + 1.0 * 5 + 1.27 * 1 + 1.65 * 4;
  assert.ok(Math.abs(rawRunValuePerPA(base) - num / denomBase) < 1e-12, '分母=AB+BB−IBB+SF+HBP');
});

test('fillLeagueConstants は cfg.leagueConstants を埋める（2パスの糊）', () => {
  const c = createConfig();
  assert.equal(c.leagueConstants.wobaScale, null);
  fillLeagueConstants(c, res);
  assert.ok(c.leagueConstants.wobaScale > 0);
  assert.ok(Number.isFinite(c.leagueConstants.fipConstant));
});

test('wSB はリーグ基準で中心化され、リーグ総和 ≈ 0（監査C1）', () => {
  // lc に wSB 基準(lgSB/lgCS/lgSBOpp)が導出されている
  assert.ok(lc.lgSBOpp > 0, 'lgSBOpp(一塁到達機会)が導出されている');
  assert.ok(lc.lgSB > 0, 'lgSB が集計されている');
  // 走者ごとの wSB を合計すると、基準控除により ≈ 0 に収束する
  let sumWSB = 0;
  for (const ps of res.playerSeasons) sumWSB += playerBaserunning(ps, cfg, lc).wSB;
  // リーグ総SB得点価値が小さい(数十run)ので、中心化後の残差は数run以内に収まる
  assert.ok(Math.abs(sumWSB) < 5, `リーグwSB総和が中心化されている (Σ=${sumWSB.toFixed(2)})`);
  // 中心化前(素点)は正なので、控除が効いている
  let raw = 0;
  for (const ps of res.playerSeasons) {
    const b = ps.batting;
    raw += b.sb * cfg.tuning.run.runSB + b.cs * cfg.tuning.run.runCS;
  }
  assert.ok(Math.abs(sumWSB) < Math.abs(raw), '中心化で素点より0へ寄っている');
});

test('pythag: ピタゴラス期待勝率＋幸運度（得失点から実力勝率を推定・§団体指標）', () => {
  // 得失点均衡なら期待勝率≈.500
  const even = pythag({ w: 70, l: 70, rs: 600, ra: 600 });
  assert.ok(Math.abs(even.expWinPct - 0.5) < 1e-9, '得失点均衡→期待勝率.500');
  // 得点>失点なら期待勝率>.500、逆は<.500
  assert.ok(pythag({ w: 80, l: 60, rs: 700, ra: 550 }).expWinPct > 0.5, '得点優位→期待勝率>.500');
  assert.ok(pythag({ w: 60, l: 80, rs: 550, ra: 700 }).expWinPct < 0.5, '失点優位→期待勝率<.500');
  // 幸運度: 得失点差の割に勝ち越すと luck>0（接戦強い/幸運）、その逆は luck<0
  const lucky = pythag({ w: 82, l: 58, rs: 610, ra: 600 }); // ほぼ均衡なのに勝ち越し
  assert.ok(lucky.luck > 0, '得失点均衡で勝ち越し→運>0');
  const unlucky = pythag({ w: 58, l: 82, rs: 600, ra: 610 });
  assert.ok(unlucky.luck < 0, '得失点均衡で負け越し→運<0');
  // pythagenpat 指数は得点環境で動く（高得点環境ほど指数大）
  assert.ok(pythag({ w: 70, l: 70, rs: 900, ra: 900 }).exponent > pythag({ w: 70, l: 70, rs: 400, ra: 400 }).exponent, '高得点環境→指数大');
  // 実シーズンで リーグ全体の運の総和は概ね0付近（ゼロサム性）
  const cfg = createConfig();
  const res = simulateSeason(generateLeague(2026, cfg), cfg, { postseason: false });
  const totalLuck = res.standings.reduce((a, t) => a + pythag(t).luck, 0);
  assert.ok(Math.abs(totalLuck) < 20, `リーグ全体の運は概ねゼロサム（実測 ${totalLuck.toFixed(1)}）`);
});

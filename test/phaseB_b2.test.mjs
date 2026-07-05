// フェーズB B2（文脈指標 RE24/WPA/LI/Clutch・§B2）の単体テスト。
// 恒等式（リーグ ΣRE24≈0 / 1試合 WPA ゼロサム=勝者±0.5 / 打席加重平均 LI=1.0）・
// SD/MD 分布・救援WARのレバレッジ加重の向き・context無効時の完全不変を検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { leagueBatting, leaguePitching } from '../src/sim/leagueStats.mjs';
import { playerPitching, playerBatting } from '../src/sim/metrics.mjs';
import { pitcherWAR } from '../src/sim/war.mjs';
import { gameOverAfter } from '../src/sim/context.mjs';

const cfg = createConfig();
const lg = generateLeague(2026, cfg);
// 文脈指標つき（2パス）シーズン。base統計は非context単一パスと同一（下でも検証）。
const res = simulateSeason(lg, cfg, { season: 2026, seed: 2026, postseason: false, context: true });
const lc = deriveLeagueConstants(res);

// リーグ集計
let reBat = 0,
  reRun = 0,
  rePit = 0,
  wpaBat = 0,
  wpaRun = 0,
  wpaPit = 0,
  liB = 0,
  paB = 0,
  liP = 0,
  bf = 0,
  totSD = 0,
  totMD = 0,
  sdLead = 0;
for (const ps of res.playerSeasons) {
  reBat += ps.batting.re24;
  reRun += ps.baserunning.re24;
  rePit += ps.pitching.re24;
  wpaBat += ps.batting.wpa;
  wpaRun += ps.baserunning.wpa;
  wpaPit += ps.pitching.wpa;
  liB += ps.batting.liSum;
  paB += ps.batting.pa;
  liP += ps.pitching.liSum;
  bf += ps.pitching.bf;
  totSD += ps.pitching.sd;
  totMD += ps.pitching.md;
  sdLead = Math.max(sdLead, ps.pitching.sd);
}

test('RE24 恒等: リーグ総和 ≈ 0（打者+走者側と投手側が相殺し、各側も0近傍）', () => {
  const grand = reBat + reRun + rePit;
  assert.ok(Math.abs(grand) < 1e-6, `ΣRE24 全体 ${grand}（打者+走者+投手 = 0 恒等）`);
  // 打者側（打者+走者）は構造上0近傍（残差は空塁0死の再出現による標準的な微小ズレ）。
  const batside = reBat + reRun;
  assert.ok(Math.abs(batside) < 40, `ΣRE24 打者側 ${batside.toFixed(2)}（≈0）`);
  // 投手側は打者側のちょうど逆符号
  assert.ok(Math.abs(batside + rePit) < 1e-6, `投手側 = −打者側`);
});

test('WPA ゼロサム: 1試合の総和が 勝者+0.5 / 敗者−0.5 に一致（decisive 全試合）', () => {
  // season.mjs が pass2 の各試合で |ホーム側WPA − 勝敗期待| の最大誤差を記録している。
  assert.ok(res.contextCheck.wpaMaxErr < 1e-9, `WPAゼロサム最大誤差 ${res.contextCheck.wpaMaxErr}`);
  // リーグ全体では打者側と投手側が相殺（ΣWPA=0）
  assert.ok(Math.abs(wpaBat + wpaRun + wpaPit) < 1e-6, 'リーグ ΣWPA = 0');
  // 攻撃側/守備側の総和はそれぞれ ≈0（martingale。3アウト境界の勝率引継ぎが正しいことの証左）
  assert.ok(Math.abs(wpaBat + wpaRun) < 60, `攻撃側ΣWPA ${(wpaBat + wpaRun).toFixed(1)}（≈0）`);
});

test('LI 正規化: リーグ打席加重平均 LI = 1.0（aLI / pLI とも）', () => {
  assert.ok(Math.abs(liB / paB - 1) < 1e-9, `打者側 平均aLI ${(liB / paB).toFixed(6)}`);
  assert.ok(Math.abs(liP / bf - 1) < 1e-9, `投手側 平均pLI ${(liP / bf).toFixed(6)}`);
});

test('SD/MD: 好救援はシャットダウン優位・SD王が妥当域（30級）', () => {
  // 好リリーバー集団は成功が多い＝リーグ総SD > 総MD（登板時レバレッジと整合）。
  assert.ok(totSD > totMD, `リーグ総SD ${totSD} > 総MD ${totMD}`);
  // SD王（この継投設定での実測 ~25-34）。B2目標(30-45級)に整合する妥当域で健全性を担保。
  assert.ok(sdLead >= 20 && sdLead <= 50, `SD王 ${sdLead}`);
  const mdMax = Math.max(...res.playerSeasons.map((s) => s.pitching.md));
  assert.ok(mdMax > 0, `メルトダウンも分布する（MD王 ${mdMax}）`);
});

test('RE行列: 状態価値の序列が正しい（塁埋まり>空塁・少死>多死）', () => {
  const re = res.contextTables.re; // 添字 = outs*8 + base（base ビット: 1B|2B<<1|3B<<2）
  const g = (base, outs) => re[outs * 8 + base];
  assert.ok(g(7, 0) > g(0, 0), `満塁0死 ${g(7, 0).toFixed(2)} > 空塁0死 ${g(0, 0).toFixed(2)}`);
  assert.ok(g(0, 0) > g(0, 2), `空塁0死 ${g(0, 0).toFixed(2)} > 空塁2死 ${g(0, 2).toFixed(2)}`);
  assert.ok(g(4, 0) > g(0, 0), `三塁0死 ${g(4, 0).toFixed(2)} > 空塁0死`); // 走者三塁は得点期待↑
  // RE0（空塁0死）は 1イニングの平均得点相当（NPB ~0.4-0.55）
  assert.ok(g(0, 0) > 0.3 && g(0, 0) < 0.7, `RE0 ${g(0, 0).toFixed(3)}`);
});

test('派生: aLI/pLI/gmLI・Clutch・WPA/LI が算出される（有限・スケール妥当）', () => {
  // 規定級の救援で pLI（レバレッジ）が算出され、抑え役は高レバレッジ
  const relievers = res.playerSeasons
    .filter((s) => s.pitching.g >= 20 && s.pitching.gs === 0 && s.pitching.bf > 0)
    .map((s) => playerPitching(s, lc, cfg));
  assert.ok(relievers.length >= 10, `救援が十分いる (${relievers.length})`);
  for (const m of relievers) {
    // TODO(F2-5): F2-1でブルペンが27-30人へ拡大し、敗戦処理側の救援の平均レバレッジが低下（pLI~0.1台）。
    //   F2-2の出場登録29人でブルペンが絞られたら下限を 0.2/0.1 へ戻すこと（削除禁止・一時緩和）。
    assert.ok(m.pLI > 0.05 && m.pLI < 4, `pLI 妥当 ${m.pLI.toFixed(2)}`);
    assert.ok(m.gmLI > 0.05 && m.gmLI < 4, `gmLI 妥当 ${m.gmLI.toFixed(2)}`);
    assert.ok(Number.isFinite(m.clutch) && Number.isFinite(m.wpaLI), 'Clutch/WPA-LI が有限');
  }
  // 抑え役（SV上位）は平均レバレッジ pLI > 1
  const closers = res.playerSeasons.filter((s) => s.pitching.sv >= 15).map((s) => playerPitching(s, lc, cfg));
  if (closers.length) {
    const avgPLI = closers.reduce((a, m) => a + m.pLI, 0) / closers.length;
    assert.ok(avgPLI > 1.2, `抑え役の平均pLI ${avgPLI.toFixed(2)} > 1.2`);
  }
  // 打者側も aLI が算出され、リーグ規定打者で 1.0 前後に分布
  const bm = res.playerSeasons.filter((s) => s.batting.pa >= 300).map((s) => playerBatting(s, lc));
  for (const m of bm) assert.ok(m.aLI > 0.5 && m.aLI < 2, `aLI 妥当 ${m.aLI.toFixed(2)}`);
});

test('救援WARレバレッジ加重（§B2・FG方式）: WAR = 中立WAR × (1+gmLI)/2（救援ぶん）・先発は不変', () => {
  const neutralWar = (ps) => pitcherWAR({ ...ps, pitching: { ...ps.pitching, gmLiN: 0 } }, cfg, lc).war;
  let upMult = 0;
  let downMult = 0;
  let closerGain = 0;
  for (const ps of res.playerSeasons) {
    if (!ps.pitching.gmLiN) continue;
    const w = pitcherWAR(ps, cfg, lc);
    const gsShare = ps.pitching.g ? ps.pitching.gs / ps.pitching.g : 0;
    // レバレッジは救援ぶんの代替水準対比runへ乗じる＝WAR全体に leverageMult が掛かる（恒等）。
    assert.ok(Math.abs(w.war - neutralWar(ps) * w.leverageMult) < 1e-9, 'WAR = 中立WAR × leverageMult');
    if (gsShare === 1) {
      assert.ok(Math.abs(w.leverageMult - 1) < 1e-12, '純先発は leverageMult=1（WAR不変）');
    }
    if (gsShare === 0 && ps.pitching.g >= 20) {
      // 加重係数の向き: gmLI>1 で >1, gmLI<1 で <1（救援＝gsShare=0）
      if (w.gmLI > 1.05) {
        assert.ok(w.leverageMult > 1, `高gmLI救援は加重>1 (gmLI ${w.gmLI.toFixed(2)})`);
        upMult++;
        // 好リリーバー（中立WARが正）は高レバレッジで WAR が増える＝「WARの死角」の埋め合わせ
        if (neutralWar(ps) > 0) {
          assert.ok(w.war > neutralWar(ps), '正WAR救援は高gmLIでWAR増');
          closerGain++;
        }
      } else if (w.gmLI < 0.95) {
        assert.ok(w.leverageMult < 1, `低gmLI救援は加重<1 (gmLI ${w.gmLI.toFixed(2)})`);
        downMult++;
      }
    }
  }
  assert.ok(upMult >= 1, '高gmLI救援の加重↑を確認');
  assert.ok(downMult >= 1, '低gmLI救援の加重↓を確認');
  assert.ok(closerGain >= 1, '好リリーバー（正WAR）の高レバレッジ加点を確認');
});

test('context無効時は完全不変: 文脈フィールドは0・base統計は2パスと同一', () => {
  const cfg2 = createConfig();
  const lg2 = generateLeague(2026, cfg2);
  const off = simulateSeason(lg2, cfg2, { season: 2026, seed: 2026, postseason: false });
  // 文脈フィールドは全て0（context無効＝集計器に一切触れない）
  let anyCtx = 0;
  for (const ps of off.playerSeasons) {
    anyCtx += Math.abs(ps.batting.re24) + Math.abs(ps.batting.wpa) + Math.abs(ps.pitching.wpa) + ps.pitching.sd + ps.pitching.md + ps.pitching.gmLiN;
  }
  assert.equal(anyCtx, 0, 'context無効時は文脈フィールドが全て0');
  assert.equal(off.contextTables, null, 'contextTables は null');
  // base統計（AVG/HR/ERA）は context有効(pass2)と完全一致＝pass2の試合が単一パスと同一である証拠
  const bOff = leagueBatting(off.playerSeasons);
  const bOn = leagueBatting(res.playerSeasons);
  const pOff = leaguePitching(off.playerSeasons);
  const pOn = leaguePitching(res.playerSeasons);
  assert.equal(bOff.h, bOn.h, 'リーグ安打が完全一致');
  assert.equal(bOff.hr, bOn.hr, 'リーグ本塁打が完全一致');
  assert.equal(bOff.ab, bOn.ab, 'リーグ打数が完全一致');
  assert.equal(pOff.er, pOn.er, 'リーグ自責点が完全一致');
  assert.equal(pOff.so, pOn.so, 'リーグ奪三振が完全一致');
});

test('gameOverAfter: 決着判定が simulateGame の break 条件と整合', () => {
  // サヨナラ（裏・9回以降・ホーム勝ち越し）
  assert.deepEqual(gameOverAfter(true, 9, 3, 2, 1, 12), { over: true, homeWon: true });
  // 表終了・ホーム(守備)リード → 決着（裏省略）
  assert.deepEqual(gameOverAfter(false, 9, 1, 4, 3, 12), { over: true, homeWon: true });
  // 表終了・ビジターリード → 続行（裏へ）
  assert.deepEqual(gameOverAfter(false, 9, 4, 1, 3, 12), { over: false });
  // 裏終了・ビジター勝ち
  assert.deepEqual(gameOverAfter(true, 9, 2, 5, 3, 12), { over: true, homeWon: false });
  // 裏終了・同点・上限回 → 引分
  assert.deepEqual(gameOverAfter(true, 12, 3, 3, 3, 12), { over: true, tie: true });
  // 裏終了・同点・上限未満 → 続行
  assert.deepEqual(gameOverAfter(true, 10, 3, 3, 3, 12), { over: false });
  // 9回未満は決着しない
  assert.deepEqual(gameOverAfter(false, 8, 1, 9, 3, 12), { over: false });
});

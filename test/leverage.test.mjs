// フェーズD4 レバレッジ駆動継投（§8.3の完成）のシーズンレベル検証。
//   継投AIが接戦度(代理LI)で最良救援を高レバレッジ場面へ回す結果、
//   (1) gmLI が救援の質と相関し、(2)「WARは平凡だがWPA抜群のセットアッパー」が出現し、
//   (3) SV/HLD/救援登板の分布は維持され、(4) 2パス文脈算出が決定論であることを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import { playerPitching } from '../src/sim/metrics.mjs';

const cfg = createConfig();
const lg = generateLeague(2026, cfg);
const res = simulateSeason(lg, cfg, { season: 2026, seed: 2026, context: true, postseason: false });
const lc = deriveLeagueConstants(res);
const P = res.playerSeasons;

// 規定級の救援（先発でない・対戦あり）の投手指標
const relievers = P.filter((s) => s.pitching.g >= 20 && s.pitching.gs === 0 && s.pitching.bf > 0).map((s) => ({
  sv: s.pitching.sv,
  ...playerPitching(s, lc, cfg),
}));

test('D4: gmLI が救援の質と相関（好FIPの救援ほど高レバレッジ場面に集まる）', () => {
  assert.ok(relievers.length >= 20, `救援が十分いる (${relievers.length})`);
  const byQual = [...relievers].filter((r) => r.gmLI != null).sort((a, b) => a.fip - b.fip); // FIP昇順=質の高い順
  const q = Math.floor(byQual.length / 4);
  const topAvg = byQual.slice(0, q).reduce((a, r) => a + r.gmLI, 0) / q; // 上位1/4（好救援）
  const botAvg = byQual.slice(-q).reduce((a, r) => a + r.gmLI, 0) / q; // 下位1/4
  assert.ok(topAvg > botAvg, `好救援ほど高gmLI（上位 ${topAvg.toFixed(3)} > 下位 ${botAvg.toFixed(3)}）`);
});

test('D4: 「WARは平凡だがWPA抜群のセットアッパー」が出現（救援WPA首位が非クローザー）', () => {
  const byWpa = [...relievers].sort((a, b) => b.wpa - a.wpa);
  const top = byWpa[0];
  assert.ok(top.wpa > 1.0, `救援WPA首位が明確にプラス (${top.wpa.toFixed(2)})`);
  // WPA上位3人に「セーブの少ない（=クローザーでない）セットアッパー」が含まれる（高LI起用の果実）。
  const setupperInTop = byWpa.slice(0, 3).some((r) => r.sv < 15);
  assert.ok(setupperInTop, 'WPA上位にセットアッパー（SV<15）が入る（§8.3の死角の再現）');
});

test('D4: SV/HLD/救援登板の分布が維持される（継投再構成でも目標帯内）', () => {
  const svMax = Math.max(...P.map((s) => s.pitching.sv));
  const hldMax = Math.max(...P.map((s) => s.pitching.hld));
  let reliefGMax = 0;
  for (const s of P) {
    const p = s.pitching;
    if (!(p.gs > 0 && p.gs * 2 >= p.g)) reliefGMax = Math.max(reliefGMax, p.g);
  }
  // 単一シーズンのリーダーはシード揺らぎを持つため較正帯をやや広げて健全性を担保（12シード平均は calibrate が保証）。
  assert.ok(svMax >= 28 && svMax <= 48, `SV王 ${svMax}（分布維持）`);
  assert.ok(hldMax >= 24 && hldMax <= 48, `HLD王 ${hldMax}（分布維持）`);
  assert.ok(reliefGMax >= 45 && reliefGMax <= 68, `登板数王 ${reliefGMax}（分布維持）`);
});

test('D4: 継投がレバレッジ駆動でも決定論（2パス文脈算出が完全再現）', () => {
  const a = simulateSeason(lg, cfg, { season: 2026, seed: 2026, context: true, postseason: false });
  const b = simulateSeason(lg, cfg, { season: 2026, seed: 2026, context: true, postseason: false });
  assert.equal(JSON.stringify(a.playerSeasons), JSON.stringify(b.playerSeasons), '同一シード=同一成績（文脈込み）');
  assert.ok(a.contextCheck.wpaMaxErr < 1e-9, 'WPAゼロサム誤差が微小（pass1=pass2の継投一致の証左）');
});

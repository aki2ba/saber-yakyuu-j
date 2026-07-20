// ============================================================================
// リアリズム恒常ゲート（realism-check）— 「実装と現実の野球の食い違い」の自動検出網
//
// 経緯: ユーザー報告「CF定位置の目の前に落ちたライナーがツーベースになった」から始まった
// リアリズム全域監査（thyroxin/research/realism_gap_audit.md・79所見74件確定）を受けて、
// この種の穴を機械的に見張る仕組みとして新設。calibrate（リーグ集計の目標帯）が守るのは
// 「総量」であり、「そのプレーは現実に起きるか」という粒度の嘘は素通りしていた。
// ここでは 打球1球ごとの情報と結果を突き合わせる不変量 ＋ 現実の公開集計値との帯比較 を行う。
//
// 2層構造:
//   GATE  … 修正済みの現実整合。破ったら exit 1（回帰＝リアリズムバグの再発）。
//   WATCH … 監査（realism_gap_audit.md）で既知・未修正の穴に対応する観測値。表示のみ。
//           該当の穴を修正したら帯を決めて GATE へ昇格させること（削除禁止）。
//
// 現実側の参照値の出典はコメントに明記する（NPB公式集計・Statcast公開値・正典research/*.md）。
// 使い方: `npm run realism`（変更後は npm test → npm run calibrate → npm run realism を通す）
// ============================================================================
import { createConfig, METRICS_CONST } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { simulateGame } from '../src/sim/game.mjs';
import { buildDepthChart } from '../src/sim/team.mjs';
import { buildTeamCharts } from '../src/sim/season.mjs';
import { applyAging } from '../src/game/aging.mjs';
import { newGame, advanceTo, advanceYear } from '../src/game/index.mjs';
import { leagueSummary } from '../src/sim/leagueStats.mjs';
import { generateBattedBall } from '../src/sim/battedBall.mjs';
import { resolveBattedBall, battedType, outfieldGeometry } from '../src/sim/battedBallResult.mjs';
import { FG_INFIELD } from '../src/sim/fieldingGeometry.mjs';
import { isBarrel } from '../src/sim/battedBallStats.mjs';
import { makeRng, hashSeed } from '../src/rng.mjs';
import { NEUTRAL_PARK } from '../src/model/battedball.mjs';
import { createPlayerSeason } from '../src/model/statline.mjs';
import { MLB_PHYSICS, NPB_SEASON, NPB_ROSTER_AGE, NPB_INJURY } from './realism-refs.mjs';

const cfg = createConfig();
let gatePass = 0;
let gateFail = 0;
const pad = (s, n) => String(s).padEnd(n);
const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : String(v));

function gate(name, value, lo, hi, digits = 3) {
  const ok = value >= lo && value <= hi;
  if (ok) gatePass++;
  else gateFail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${pad(name, 44)} ${fmt(value, digits).padStart(8)}   [${lo}, ${hi}]`);
}
function watch(name, value, note, digits = 3) {
  console.log(`WATCH ${pad(name, 44)} ${fmt(value, digits).padStart(8)}   ${note}`);
}
function info(text) {
  console.log(`      ${text}`);
}

/** 総合力の粗い代理（~20-80）。roster.mjs の引退判定と同じ物差し（R2 年齢構造ゲート用）。 */
function overallOf(p) {
  const t = p.trueAbility;
  if (p.role === 'pitcher') {
    const veloR = Math.max(20, Math.min(80, 50 + (t.pitching.velocityKmh - 145) * 2));
    let s = 0;
    for (const pi of t.pitching.pitches) s += (pi.current + pi.whiff) / 2;
    const stuff = t.pitching.pitches.length ? s / t.pitching.pitches.length : 50;
    return (veloR + t.pitching.control + t.pitching.stamina + stuff) / 4;
  }
  const b = t.batting;
  let bp = 20;
  for (const k of Object.keys(t.fielding.positionProf)) bp = Math.max(bp, t.fielding.positionProf[k]);
  return (b.ev + b.contact + b.la + b.eye + t.common.speed + t.fielding.positioningIQ + bp) / 7;
}

console.log('=== リアリズム恒常ゲート（打球イベント×現実整合・realism_gap_audit.md 連動） ===\n');

// ============================================================================
// Part A: 打球ミクロ（合成20万球・リーグ平均マッチアップ・seed固定）
//   「そのプレーは現実に起きるか」を打球1球単位のカテゴリで見張る。
// ============================================================================
console.log('--- A. 打球ミクロ（合成20万球・打球情報と結果の突き合わせ） ---');
{
  const lg = generateLeague(20260701, cfg);
  const rng = makeRng(424242);
  // ★リーグ平均マッチアップ（R2修正）: 旧実装は `find()` でリーグ最初の1人（T1F1/T1P1）だけを
  //   使っており、「リーグ平均」と称しながら実際は特定個体の能力に依存していた（年齢構造の導入で
  //   その1人が別能力の選手に変わった途端 2B/H が 0.288 へ飛び、ゲートが誤検知した）。
  //   全打者×全投手を巡回サンプリングしてリーグ平均のマッチアップにする（決定論・順序固定）。
  const batters = lg.players.filter((p) => p.role === 'fielder');
  const pitchers = lg.players.filter((p) => p.role === 'pitcher');

  let hits = 0, h2 = 0, h3 = 0;
  let frontCutHits = 0, frontCutXbh = 0; // 前落ち遮断圏（ロール線の真上）に落ちた安打
  let nearOfFrontHits = 0, nearOfFrontXbh = 0; // 外野手の正面至近(8m以内・手前)に落ちた安打
  let puBalls = 0, puHits = 0; // ポップ（LA>50）
  let gbBalls = 0, gbHits = 0, gbXbh = 0;
  for (let i = 0; i < 200000; i++) {
    const batter = batters[i % batters.length];
    const pitcher = pitchers[(i * 7) % pitchers.length]; // 7=互いに素な歩幅＝全組合せを均等に巡回
    const bb = generateBattedBall(batter, pitcher, cfg, rng);
    const r = resolveBattedBall(bb, cfg, rng, NEUTRAL_PARK);
    const type = battedType(bb.laDeg);
    if (type === 'PU') {
      puBalls++;
      if (r.result !== 'out' && r.result !== 'HR') puHits++;
    }
    if (type === 'GB') {
      gbBalls++;
      if (r.result !== 'out') {
        gbHits++;
        if (r.result !== '1B') gbXbh++;
      }
    }
    if (r.result === 'HR' || r.result === 'out') continue;
    hits++;
    const isXbh = r.result === '2B' || r.result === '3B';
    if (r.result === '2B') h2++;
    if (r.result === '3B') h3++;
    if (bb.laDeg > 0 && bb.distanceM >= cfg.tuning.bb.gapDistM) {
      const { dNear, beyond, dPerpMin } = outfieldGeometry(bb, cfg);
      if (beyond <= 0 && dPerpMin <= 5) {
        // ロール線のほぼ真上に外野手がいる前落ち＝突っ込んでくる野手が必ずカットする状況
        frontCutHits++;
        if (isXbh) frontCutXbh++;
      }
      if (beyond <= 0 && dNear <= 8) {
        // 外野手の正面至近に落ちるポトリ（発端バグの直接の見張り）
        nearOfFrontHits++;
        if (isXbh) nearOfFrontXbh++;
      }
    }
  }
  // 発端バグの恒常ゲート: 外野手の目の前/ロール線上の前落ちが長打になる割合。
  // 現実: 突っ込む野手の正面のワンバウンドはほぼ確実にカット＝単打（二塁打は例外的な後逸のみ）。
  gate('前落ち遮断圏(ロール線±5m)の安打の長打率', frontCutHits ? frontCutXbh / frontCutHits : 0, 0, 0.12);
  // 2026-07-20 帯適正化: 母数 n≈57 と小さく1イベント≈0.018 の粒度。sim非改変の世界引き直しだけで
  // 0.026〜0.123 の振れを実測（選手アイデンティティ刷新時の複数ラン）＝旧上限0.08は健全プロセスの
  // 揺れの内側で誤検知する。発端バグの破綻水準（>0.3級）は 0.15 でも確実に検知できる。
  gate('外野手の正面至近(8m以内・手前)の安打の長打率', nearOfFrontHits ? nearOfFrontXbh / nearOfFrontHits : 0, 0, 0.15);
  info(`（前落ち遮断圏の安打 n=${frontCutHits} / 正面至近 n=${nearOfFrontHits}）`);
  // 安打内訳の現実整合: NPB近年の 2B/H ≈ 0.18-0.20（例: 2023セ 二塁打~200/安打~1150/球団）・3B/H ≈ 0.010-0.020
  gate('安打に占める二塁打の割合 (2B/H)', h2 / hits, 0.13, 0.24);
  gate('安打に占める三塁打の割合 (3B/H)', h3 / hits, 0.004, 0.03);
  // ゴロ長打: ライン際のコーナー到達のみ＝ゴロ安打の~5-12%が現実的（Statcast: GBのXBH率は低い）
  gate('ゴロ安打の長打率 (GB XBH/GB H)', gbHits ? gbXbh / gbHits : 0, 0.01, 0.15);
  // 既知の穴（audit §2: 捕手・投手が守備網に不在→本塁至近の真上ポップが落ちる）: 修正後にGATE昇格
  watch('ポップ(LA>50)の被安打率', puBalls ? puHits / puBalls : 0, '現実~0.01-0.02 / 既知の穴: 捕手・投手不在(audit§2)');
}

// ============================================================================
// Part B: イベントレベル不変量（80試合×onEvent・「起きてはいけないプレー」の網羅走査）
//   打球の情報(EV/LA/落下点)と記録(犠飛/塁打/アウト)を1プレーずつ突き合わせる。
// ============================================================================
console.log('\n--- B. イベント不変量（80試合の全プレー走査） ---');
{
  const lg = generateLeague(20260701, cfg);
  const A = lg.teams[0];
  const B = lg.teams[6];
  const chartsOf = (t) => {
    const r = lg.players.filter((p) => p.teamId === t.id);
    return { dh: buildDepthChart(r, cfg, { dh: true }), noDh: buildDepthChart(r, cfg, { dh: false }) };
  };
  const cA = chartsOf(A);
  const cB = chartsOf(B);

  let paCount = 0;
  let violations = [];
  let sacFlies = 0, fcs = 0, twoOutKills = 0, frontCut2B = 0, airCatches = 0;
  for (let seed = 0; seed < 80; seed++) {
    const dh = seed % 2 === 0;
    const stats = new Map();
    const statFor = (pid, teamId) => {
      let s = stats.get(pid);
      if (!s) { s = createPlayerSeason(pid, 2026); s.teamId = teamId; stats.set(pid, s); }
      return s;
    };
    const events = [];
    simulateGame(
      { teamId: A.id, depth: dh ? cA.dh : cA.noDh, starterIdx: seed, manager: A.manager, dh },
      { teamId: B.id, depth: dh ? cB.dh : cB.noDh, starterIdx: seed, manager: B.manager, dh },
      cfg, makeRng(hashSeed(9999, 'realism', seed)), statFor, NEUTRAL_PARK, undefined,
      { onEvent: (e) => events.push(e) },
    );
    for (const e of events) {
      if (e.type !== 'pa') continue;
      paCount++;
      // 不変量1: 犠飛は「深い空中打球のタッグアップ生還」のみ（内野フライ犠飛・ゴロ犠飛・暴投偽犠飛の根絶）
      if (e.sacFly) {
        sacFlies++;
        if (!e.bb || e.battedType === 'GB') violations.push(`seed${seed}: ゴロ/打球なしで犠飛`);
        else if (e.bb.distanceM < cfg.tuning.run.tagMinDistM) violations.push(`seed${seed}: 浅い飛球(${e.bb.distanceM.toFixed(0)}m)で犠飛`);
        if (!(e.runsOnPlay >= 1)) violations.push(`seed${seed}: 得点のない犠飛`);
      }
      // 不変量2: アウト数の整合（1プレーで3を超えない・負に動かない）
      if (e.outsAfter > 3 || e.outsAfter < e.outsBefore) violations.push(`seed${seed}: アウト数異常 ${e.outsBefore}→${e.outsAfter}`);
      // 不変量3: 前落ち遮断圏（ロール線±3m・手前）の二塁打は例外的（発端バグのイベントレベル監視）
      if (e.result === '2B' && e.bb && e.bb.laDeg > 0 && e.bb.distanceM >= cfg.tuning.bb.gapDistM) {
        const rad = (e.bb.sprayDeg * Math.PI) / 180;
        const g = outfieldGeometry({ landingX: e.bb.distanceM * Math.sin(rad), landingY: e.bb.distanceM * Math.cos(rad) }, cfg);
        if (g.beyond <= 0 && g.dPerpMin <= 3) frontCut2B++;
      }
      // 不変量4: airCatch（実質ライナー捕球）は併殺・犠飛を生まない（走者は帰塁のみ。
      // 打席中の暴投得点(wpRuns)は打球と無関係に発生しうるため runsOnPlay はチェックしない）
      if (e.airCatch) {
        airCatches++;
        if (e.outsAfter - e.outsBefore >= 2) violations.push(`seed${seed}: ライナー捕球で複数アウト`);
        if (e.sacFly) violations.push(`seed${seed}: ライナー捕球で犠飛`);
      }
      // 発現カウント（存在しないと逆に不自然なプレー）
      if (e.fc) fcs++;
      if (e.outsBefore === 2 && e.outsAfter === 3 && (e.result === '1B' || e.result === '2B')) twoOutKills++;
    }
  }
  gate('イベント不変量違反（犠飛・アウト整合）', violations.length, 0, 0);
  if (violations.length) for (const v of violations.slice(0, 5)) info(`  違反: ${v}`);
  gate('前落ち遮断圏(ロール線±3m)の二塁打 /80試合', frontCut2B, 0, 3, 0);
  gate('犠飛の発現 /80試合', sacFlies, 8, 80, 0); // 現実: 143試合で25-40/球団 ≈ 80試合(両軍)で15-45
  gate('フィールダースチョイスの発現 /80試合', fcs, 5, 200, 0); // ゴロのFC=二塁封殺のみは日常プレー
  gate('2死からの走塁死(安打時)の発現 /80試合', twoOutKills, 1, 60, 0); // 旧実装は構造的にゼロだった（audit）
  gate('実質ライナー捕球(airCatch)の発現 /80試合', airCatches, 20, 400, 0); // 実測~1.3件/試合（ユーザー指摘の穴の門番）
  info(`（走査した打席イベント n=${paCount}）`);
}

// ============================================================================
// Part C: シーズン集計 vs 現実の公開集計値（2シード）
//   出典: NPB公式の年度別チーム成績（近年143試合）・正典 thyroxin/research/*.md
// ============================================================================
console.log('\n--- C. シーズン集計 vs NPB公式チーム成績（2シード平均・出典: realism-refs.mjs） ---');
{
  const seeds = [1, 2];
  const acc = {
    b2: 0, b3: 0, sf: 0, sh: 0, gdp: 0, sb: 0, cs: 0, hbp: 0, e: 0, h: 0,
    oob: 0, a1t3Taken: 0, a1t3Opp: 0, gb3hTaken: 0, gb3hOpp: 0, tagTaken: 0, tagOpp: 0,
    avg: 0, rpg: 0, hr: 0,
  };
  for (const seed of seeds) {
    const lg = generateLeague(seed, cfg);
    const res = simulateSeason(lg, cfg, { season: 2026, seed, postseason: false });
    const s = leagueSummary(res, cfg.league.numTeams);
    acc.b2 += s.batting.b2 / cfg.league.numTeams;
    acc.b3 += s.batting.b3 / cfg.league.numTeams;
    acc.sf += s.batting.sf / cfg.league.numTeams;
    acc.h += s.batting.h / cfg.league.numTeams;
    acc.avg += s.batting.h / s.batting.ab;
    acc.rpg += s.runsPerTeamPerGame;
    acc.hr += s.hrPerTeam;
    for (const ps of res.playerSeasons) {
      acc.gdp += ps.batting.gdp || 0; // leagueBattingが集計しないカウンタは直接合算
      acc.sb += ps.batting.sb || 0;
      acc.cs += ps.batting.cs || 0;
      acc.sh += ps.batting.sh || 0;
      acc.hbp += ps.batting.hbp || 0;
      acc.e += ps.fielding.e || 0;
      const br = ps.baserunning;
      acc.oob += br.outsOnBase || 0;
      acc.a1t3Taken += br.adv1t3bTaken || 0;
      acc.a1t3Opp += br.adv1t3bOpp || 0;
      acc.gb3hTaken += br.gbAdv3hTaken || 0;
      acc.gb3hOpp += br.gbAdv3hOpp || 0;
      acc.tagTaken += br.tag3hTaken || 0;
      acc.tagOpp += br.tag3hOpp || 0;
    }
  }
  const n = seeds.length;
  const nT = cfg.league.numTeams;
  const perTeam = (k) => acc[k] / n / nT;
  const R = NPB_SEASON;

  // --- 時代整合の明示（最重要の設計判断・config CALIBRATION_TARGETS 注記と連動） ---
  // シムの得点環境はNPB 2015-19「飛ぶボール」時代へ較正されている（config注記で自覚済み）。
  // 現在のNPB(2023-25)は AVG.242-.244 / R/G 3.29-3.48 / HR 81-104 と大幅に低反発側。
  // 三原則②「現状のセパ近似」に照らした再ベースラインは大規模較正のため独立の設計判断（未着手）。
  info(`【時代整合】sim AVG ${fmt(acc.avg / n)} / R/G ${fmt(acc.rpg / n, 2)} / HR ${fmt(acc.hr / n, 0)} ⇔ NPB2023-25実測 AVG .242-.244 / R/G 3.29-3.48 / HR 81-104（＝シムは2015-19時代を選択中・再ベースラインは別課題）`);

  // --- 時代にロバストな比率・総量（NPB公式2023-25の帯でGATE/WATCH） ---
  // 二塁打シェア: NPB実測 2B/H = .165-.173（era非依存に安定）。sim ~.206 = 本ハーネスが検出した実穴。
  watch('二塁打シェア (2B/H)', (acc.b2 / n) / (acc.h / n), `NPB実測 .165-.173（3年）/ sim超過=既知の穴（2B→1Bミックス再較正待ち）`, 3);
  info(`  （絶対数: 二塁打/球団 sim ${fmt(acc.b2 / n, 1)} ⇔ NPB平均 ${R.b2PerTeam.means.join('/')}）`);
  gate('三塁打シェア (3B/H)', (acc.b3 / n) / (acc.h / n), 0.008, 0.03);
  // 盗塁: NPB実測 66-77個/球団・成功率.67-.71（2023-25公式）。2026-07-12検証で乖離を検出（未修正）
  watch('盗塁/球団', perTeam('sb'), `NPB実測 平均66-77・チーム最大110 / sim超過=新発見の穴（企図が過剰）`, 1);
  watch('盗塁成功率', acc.sb / (acc.sb + acc.cs), 'NPB実測 .672/.688/.707（2023/24/25公式）', 3);
  // 犠飛: NPB実測 31.1/31.1/31.6（3年とも31前後で極めて安定・チーム帯20-47）
  watch('犠飛/球団', acc.sf / n, 'NPB実測 平均31.1（帯20-47）/ R1直後~21=不足（sfBase/tagMinDistM再較正待ち）', 1);
  // 犠打: NPB実測 平均93-111/球団・チーム帯57-137（パ・リーグ球団も85+が普通の年あり）
  watch('犠打/球団（両リーグ計平均）', perTeam('sh'), 'NPB実測 平均93-111（チーム帯57-137）/ simは特にDH有リーグで過少', 1);
  // 失策: NPB実測 平均69-74/球団（チーム帯52-96）。チーム帯でGATE
  gate('失策/球団', perTeam('e'), 50, 96, 1);
  // 死球: NPB実測 平均47-51/球団（チーム帯25-65）。チーム帯でGATE
  gate('死球/球団', perTeam('hbp'), 25, 70, 1);
  // 併殺打: NPB実測 平均87-99/球団（チーム帯66-120）
  gate('併殺打/球団', perTeam('gdp'), 66, 120, 1);
  // 単打での一塁→三塁進塁率: 文献実測 25-40%（正典 baserunning_metrics_reference.md §XBT）
  gate('一塁→三塁進塁率（単打時）', acc.a1t3Taken / Math.max(1, acc.a1t3Opp), 0.18, 0.45);
  // ゴロゴー（三塁走者がゴロアウトの間に生還を試みる機会での生還率）: 中間守備前提で~4-6割
  gate('三塁走者のゴロゴー生還率', acc.gb3hTaken / Math.max(1, acc.gb3hOpp), 0.35, 0.75);
  // タッグアップ本塁生還率（深い犠飛機会）: 現実の犠飛機会は大半が成功（自重込みの機会率）
  gate('タッグアップ本塁生還率', acc.tagTaken / Math.max(1, acc.tagOpp), 0.45, 0.9);
  watch('走塁死(outsOnBase)/球団', perTeam('oob'), '参考値（NPB公式は本塁憤死等の分計なし）', 1);
}

// ============================================================================
// Part D: MLB Statcast 物理プロキシ比較（EV/LA→結果の条件付き分布・ユーザー指示 2026-07-12）
//   NPBには一球粒度の公開データが存在しないため、打球物理の現実整合は MLB Statcast/FanGraphs
//   の公開実測値を代理参照とする。比較するのは「条件付き分布」（この打球ならどうなるか）のみ。
//   総量（得点環境・頻度）はNPB較正（calibrate）の管轄で、ここでは物理の写像だけを見る。
//   参照値は tools/realism-refs.mjs（出典URL・シーズン付き）。ref未収載の項目はWATCH表示。
// ============================================================================
console.log('\n--- D. MLB Statcast 物理プロキシ比較（30万球・条件付き分布） ---');
{
  const lg = generateLeague(777, cfg);
  const rng = makeRng(20260712);
  const batters = lg.players.filter((p) => p.role === 'fielder');
  const pitchers = lg.players.filter((p) => p.role === 'pitcher');
  const mk = () => ({ n: 0, h: 0, hr: 0, tb: 0 });
  const byType = { GB: mk(), LD: mk(), FB: mk(), PU: mk() };
  const cats = { barrel: mk(), hardHit: mk(), sweetSpot: mk() };
  const TB = { '1B': 1, '2B': 2, '3B': 3, HR: 4 };
  let hrLaSum = 0, hrN = 0, hrLdBand = 0; // HRの打球角度分布（LD帯15-25°に偏っていないかの検証）
  const IFSET = new Set(FG_INFIELD);
  let ldOutIF = 0, airCatchOut = 0; // 内野ライナーの発現（LD直＋GB分類の初バウンド前迎撃=遊直等）
  const N = 300000;
  for (let i = 0; i < N; i++) {
    // 打者/投手を一様サンプル（才能の分散込みの打球分布。PA加重でない近似はband幅で吸収）
    const batter = batters[rng.int(batters.length)];
    const pitcher = pitchers[rng.int(pitchers.length)];
    const bb = generateBattedBall(batter, pitcher, cfg, rng);
    const r = resolveBattedBall(bb, cfg, rng, NEUTRAL_PARK);
    const type = battedType(bb.laDeg);
    const isHit = r.result !== 'out';
    const isHr = r.result === 'HR';
    const tb = TB[r.result] || 0;
    const bump = (s) => { s.n++; if (isHit) s.h++; if (isHr) s.hr++; s.tb += tb; };
    bump(byType[type]);
    if (isHr) { hrLaSum += bb.laDeg; hrN++; if (bb.laDeg < 25) hrLdBand++; }
    if (r.result === 'out' && type === 'LD' && IFSET.has(r.fielderPos)) ldOutIF++;
    if (r.result === 'out' && r.airCatch) airCatchOut++;
    if (isBarrel(bb.evKmh, bb.laDeg, METRICS_CONST)) bump(cats.barrel);
    if (bb.evKmh >= METRICS_CONST.hardHitKmh) bump(cats.hardHit);
    if (bb.laDeg >= METRICS_CONST.sweetSpotLoLA && bb.laDeg <= METRICS_CONST.sweetSpotHiLA) bump(cats.sweetSpot);
  }
  const babipExHr = (s) => (s.n - s.hr ? (s.h - s.hr) / (s.n - s.hr) : 0); // BABIP: HRを分子分母から除外
  const ba = (s) => (s.n ? s.h / s.n : 0); // インプレー打率（HR込み・ROEなし＝現実よりわずかに高め方向）
  const slg = (s) => (s.n ? s.tb / s.n : 0);
  const total = byType.GB.n + byType.LD.n + byType.FB.n + byType.PU.n;

  // 比較器: refs に band があれば GATE。watchNote（既知の穴/新発見の乖離）なら WATCH。
  const cmp = (name, simVal, refKey, digits = 3) => {
    const ref = !MLB_PHYSICS.pending && MLB_PHYSICS[refKey];
    if (ref && ref.band) {
      gate(`${name}`, simVal, ref.band[0], ref.band[1], digits);
      info(`  現実(MLB ${ref.season}): ${ref.value}  出典: ${ref.source}`);
    } else if (ref && ref.watchNote) {
      watch(name, simVal, `現実(MLB ${ref.season}): ${ref.value}`, digits);
      info(`  ${ref.watchNote}`);
    } else {
      watch(name, simVal, 'MLB参照値の収載待ち（realism-refs.mjs）', digits);
    }
  };
  cmp('GB BABIP（ゴロのインプレー打率）', babipExHr(byType.GB), 'gbBabip');
  cmp('LD BABIP（ライナー）', babipExHr(byType.LD), 'ldBabip');
  cmp('FB BABIP（フライ・HR除く）', babipExHr(byType.FB), 'fbBabipExHr');
  cmp('PU 被打率（ポップ）', ba(byType.PU), 'puBa');
  cmp('Barrel打率（Statcast公式定義そのまま）', ba(cats.barrel), 'barrelBa');
  cmp('Barrel SLG', slg(cats.barrel), 'barrelSlg', 2);
  cmp('Hard-Hit打率（EV≥152km/h≈95mph）', ba(cats.hardHit), 'hardHitBa');
  cmp('Sweet-Spot打率（LA8-32°）', ba(cats.sweetSpot), 'sweetSpotBa');
  cmp('HR/FB（FB=LA25-50°のHR化率）', byType.FB.n ? byType.FB.hr / byType.FB.n : 0, 'hrPerFb');
  info(`  （HRのLA分布: 平均${hrN ? (hrLaSum / hrN).toFixed(1) : '-'}° / LA<25°(LD帯)のHR比率 ${hrN ? (hrLdBand / hrN * 100).toFixed(0) : '-'}%。MLBのHR平均LAは~28°・LD帯HRは少数派）`);
  info(`（打球プロファイル: GB ${(byType.GB.n / total * 100).toFixed(1)}% / LD ${(byType.LD.n / total * 100).toFixed(1)}% / FB ${(byType.FB.n / total * 100).toFixed(1)}% / PU ${(byType.PU.n / total * 100).toFixed(1)}%・Barrel/BBE ${(cats.barrel.n / total * 100).toFixed(1)}%）`);
  const profRef = !MLB_PHYSICS.pending && MLB_PHYSICS.profile;
  if (profRef) {
    // Statcast 2023実測（LA閾値分類＝simと同一定義）: GB43.1/LD23.9/FB26.2/PU6.9%
    gate('GB%（打球プロファイル）', byType.GB.n / total, profRef.gb[0], profRef.gb[1]);
    gate('LD%', byType.LD.n / total, profRef.ld[0], profRef.ld[1]);
    gate('FB%', byType.FB.n / total, profRef.fb[0], profRef.fb[1]);
    gate('PU%', byType.PU.n / total, profRef.pu[0], profRef.pu[1]);
  }
  // 内野ライナーの発現（ユーザー指摘 2026-07-12「内野ライナーがありえない設定になってたら嫌」への門番）:
  //   ①LD分類(LA10-25)を内野手が落下点で捕る「ポテライナーの直」 ②GB分類(LA<10)の初バウンド前
  //   迎撃=「痛烈なライナーの直」（airCatch・従来は全てゴロ表記だった穴の修正）。どちらも消えたらFAIL。
  gate('内野ライナー(LD直)の発現率/打球', ldOutIF / total, 0.002, 0.03);
  gate('実質ライナー捕球(airCatch=遊直等)の発現率/打球', airCatchOut / total, 0.005, 0.05);
  info(`  （1試合換算: LD直 ${(ldOutIF / total * 55).toFixed(2)}件 / airCatch直 ${(airCatchOut / total * 55).toFixed(2)}件。MLB2024実測: 内野ライナーアウト~1.30/試合(両軍)・ライナーアウトの内野手シェア28.7% [realism-refs MLB_LINEOUT]。ライナー併殺0.10/試合はsim未モデル）`);
}

// ============================================================================
// Part E: 年齢構造（R2・realism_r2_age_roster_spec / NPB_ROSTER_AGE）
//   「18歳がリーグ2位」「規定到達者の36%が20歳以下」という破綻の再発を防ぐ恒常ゲート。
//   旧実装は年齢と能力が完全無相関（r=0.012）だった＝生成の構造バグの直接検出になる。
// ============================================================================
console.log('\n--- E. 年齢構造（R2: 生成の年齢×能力・一軍の年齢・若手の成長） ---');
{
  const A = NPB_ROSTER_AGE;
  const ages = [];
  const ovs = [];
  const regAges = [];
  const farmAges = [];
  const devAges = [];
  const qualAges = [];
  let age18 = 0;
  for (const seed of [31, 32, 33]) {
    const lg = generateLeague(seed, cfg);
    const { registeredByTeam } = buildTeamCharts(lg, cfg);
    const reg = new Set();
    for (const s of registeredByTeam.values()) for (const pid of s) reg.add(pid);
    for (const p of lg.players) {
      ages.push(p.age);
      ovs.push(overallOf(p));
      if (p.age === 18) age18++;
      (reg.has(p.id) ? regAges : farmAges).push(p.age);
    }
    for (const d of lg.farm) { farmAges.push(d.age); devAges.push(d.age); }
    const res = simulateSeason(lg, cfg, { season: 2026, seed, postseason: false });
    const byId = new Map(lg.players.map((p) => [p.id, p]));
    const qPA = Math.round(cfg.league.gamesPerSeason * 3.1);
    const qOuts = cfg.league.gamesPerSeason * 3;
    for (const s of res.playerSeasons) {
      const p = byId.get(s.playerId ?? s.id);
      if (!p) continue;
      if (p.role === 'fielder' && s.batting.pa >= qPA) qualAges.push(p.age);
      if (p.role === 'pitcher' && s.pitching.outs >= qOuts) qualAges.push(p.age);
    }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  // 年齢×能力の相関（無相関=生成バグの直接検出）
  const mx = mean(ages);
  const my = mean(ovs);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < ages.length; i++) {
    sxy += (ages[i] - mx) * (ovs[i] - my);
    sxx += (ages[i] - mx) ** 2;
    syy += (ovs[i] - my) ** 2;
  }
  gate('年齢×能力の相関 r（旧実装 0.012＝無相関）', sxy / Math.sqrt(sxx * syy), 0.25, 0.75);
  gate('支配下の平均年齢（NPB実測 26.9-27.1）', mx, A.meanAgeControlled.band[0], A.meanAgeControlled.band[1], 1);
  gate('18歳/球団（NPB実測 1人。旧実装 13.6人）', age18 / 3 / cfg.league.numTeams, A.perTeam.age18.band[0], A.perTeam.age18.band[1], 1);
  gate('一軍登録29人の平均年齢（NPB ~28）', mean(regAges), A.meanAgeActive.band[0], A.meanAgeActive.band[1], 1);
  // 育成選手のみを NPB 実測(21.88)と比較する。シムの「二軍」= 登録外の支配下＋育成 であり、
  //   前者はベテランの控えを含むぶん年齢が高い（NPB側にこの粒度の公表集計が無いので帯を作れない）。
  gate('育成選手の平均年齢（NPB実測 21.9）', mean(devAges), A.meanAgeFarm.band[0], A.meanAgeFarm.band[1], 1);
  gate('一軍−二軍(登録外+育成)の年齢差', mean(regAges) - mean(farmAges), 2.5, 7.5, 1);
  // ★本丸: 規定到達者に占める20歳以下（旧実装 36.1%／NPB は過去20年で確実な例なし＝実質0%）
  const u20 = qualAges.filter((a) => a <= 20).length / qualAges.length;
  gate('規定到達者の20歳以下比率（旧 0.361）', u20, A.rookieQualifiedShare.band[0], A.rookieQualifiedShare.band[1], 3);
  info(`規定到達者の平均年齢 ${mean(qualAges).toFixed(1)}歳（旧実装 24.0歳・NPB は20代後半〜30代前半）`);

  // ③やきゅつく的な楽しさ: 高卒新人が数年で育つ（旧実装は9年で +1.8pt しか伸びなかった）
  const lg = generateLeague(41, cfg);
  const rookies = lg.players.filter((p) => p.age === 18).map((p) => JSON.parse(JSON.stringify(p)));
  const before = mean(rookies.map(overallOf));
  for (let y = 0; y < 9; y++) applyAging(rookies, cfg, { seed: hashSeed(41, 'grow', y) });
  gate('高卒新人の9年間の成長pt（旧実装 +1.8）', mean(rookies.map(overallOf)) - before, 6, 16, 1);
}

// ============================================================================
// Part F: 故障（R3・§10.5「試合中に壊れる」／NPB_INJURY）
//   旧実装は「オフに1回ロール→翌年の開幕IL」で、**シーズン中に誰も壊れなかった**。
//   ここでは「試合中に発生し、その場で退き、二軍から補充される」ことを恒常ゲートで見張る。
// ============================================================================
console.log('\n--- F. 故障（試合中の発生・離脱・IL補充） ---');
{
  const I = NPB_INJURY;
  let inj = 0;
  let injTop = 0;
  let major = 0;
  let days = 0;
  let pit = 0;
  let fld = 0;
  let catcherInj = 0;
  let cornerInj = 0;
  let moves = 0;
  let ilMoves = 0;
  let used = 0;
  let games = 0;
  let exits = 0;
  const SEEDS = [11, 12];
  for (const seed of SEEDS) {
    const st = newGame(seed, 'T1', { cfg });
    const steps = advanceTo(st, 'seasonEnd');
    const byId = new Map([...st.league.players, ...st.league.farm].map((p) => [p.id, p]));
    for (const e of st.rt.injuryLog) {
      inj++;
      if (!e.farm) injTop++;
      if (e.severity === 'major') major++;
      days += e.gamesLost * st.rt.dayScale;
      const p = byId.get(e.playerId);
      if (!p) continue;
      if (p.role === 'pitcher') pit++;
      else fld++;
      if (p.primaryPos === 'C') catcherInj++;
      if (p.primaryPos === '1B' || p.primaryPos === 'LF') cornerInj++;
      if (!e.farm) exits++;
    }
    const ms = steps.flatMap((x) => x.rosterMoves ?? []);
    moves += ms.length;
    ilMoves += ms.filter((m) => m.type === 'ilReplace' || m.type === 'ilReturn').length;
    games += st.rt.schedule.length;
    const byTeam = new Map();
    for (const s of st.careerStats.filter((x) => x.season === st.year)) {
      if (!((s.batting?.pa ?? 0) > 0 || (s.pitching?.bf ?? 0) > 0)) continue;
      if (!byTeam.has(s.teamId)) byTeam.set(s.teamId, new Set());
      byTeam.get(s.teamId).add(s.playerId);
    }
    used += [...byTeam.values()].reduce((a, x) => a + x.size, 0) / byTeam.size;
  }
  const n = SEEDS.length;
  const nT = cfg.league.numTeams;
  gate('故障/球団/年（一軍・NPB実測 7.3人）', injTop / n / nT, I.perTeamSeason.band[0], I.perTeamSeason.band[1], 1);
  gate('重症(シーズン絶望級)の割合', inj ? major / inj : 0, I.majorShare.band[0], I.majorShare.band[1], 3);
  gate('投手:野手の故障件数比（NPB 1.10-1.18:1）', fld ? pit / fld : 0, I.pitcherToFielderCount.band[0], I.pitcherToFielderCount.band[1], 2);
  gate('1件あたりの平均離脱日数', inj ? days / inj : 0, I.meanDaysLost.band[0], I.meanDaysLost.band[1], 0);
  gate('試合中の負傷退場/試合（両軍計・導出値）', games ? exits / (games / n) : 0, I.inGameExitsPerGame.band[0], I.inGameExitsPerGame.band[1], 3);
  // ★捕手は「壊れやすい」わけではない（Guy 2015）: 捕手の故障件数がコーナー(1B/LF)を大きく超えない
  gate('捕手の故障件数 / コーナー(1B+LF)の故障件数', cornerInj ? catcherInj / cornerInj : 0, 0, 1.6, 2);
  // ★IL補充が実際に湧いている（旧実装は1年目に0件＝故障者が一軍に居座り続けた）
  gate('IL関連の登録入替/球団/年（旧実装 0件）', ilMoves / n / nT, 2, 30, 1);
  gate('登録入替/球団/年（NPB 実入替50-70回）', moves / n / nT, 15, 70, 1);
  info(`一軍出場の異なり選手 ${(used / n).toFixed(1)}人/球団（NPB実測 61人・旧実装 35.8人）`);
}

// ============================================================================
// Part G: R7（draft_timeline_evidence §決定1/2）— 高卒新人の1年目デビュー時間軸・ドラフト量
//   出典: note/ハマノンタン（2010-2019・NPB）「高卒野手の1年目50打席以上」= 10年で12人＝年1.2人
//   （全12球団換算で 5.5%）。旧実装は年齢と無関係に「即戦力寄り」に育ち 12.9% で約2.3倍甘かった
//   （thyroxin/research/draft_timeline_evidence.md 決定1・2026-07-13修正）。
// ============================================================================
console.log('\n--- G. R7: 高卒新人の1年目デビュー時間軸・ドラフト量 ---');
{
  const HS_SEEDS = [4242, 7, 99, 2024, 555, 8080];
  const HS_YEARS = 12;
  let hsF = 0;
  let hsF50 = 0;
  let hsFQual = 0;
  let rookiesTotal = 0;
  let rookieYears = 0;
  for (const seed of HS_SEEDS) {
    const st = newGame(seed, 'T1', { cfg });
    const rk = new Map();
    for (let y = 0; y < HS_YEARS; y++) {
      advanceTo(st, 'seasonEnd');
      const off = advanceYear(st);
      rookiesTotal += off.rookies.length;
      rookieYears++;
      for (const r of off.rookies ?? []) rk.set(r.id, { draftYear: st.year, age: r.age, role: r.role });
    }
    const y1 = new Map();
    for (const s of st.careerStats) {
      const r = rk.get(s.playerId);
      if (!r || s.season !== r.draftYear) continue;
      y1.set(s.playerId, s.batting?.pa ?? 0);
    }
    for (const [id, r] of rk) {
      if (r.age > 19 || r.role !== 'fielder') continue;
      hsF++;
      const pa = y1.get(id) ?? 0;
      if (pa >= 50) hsF50++;
      if (pa >= 443) hsFQual++;
    }
  }
  gate('高卒野手「1年目50打席以上」率（実測5.5%＝年1.2人/12球団）', hsF ? hsF50 / hsF : 0, 0.03, 0.09, 3);
  gate('高卒新人が1年目に規定打席到達（過去実測: 確実な例なし）', hsF ? hsFQual / hsF : 0, 0, 0.02, 3);
  // NPB実態は支配下~10人/球団年だが、6以上への較正ヘッドルーム（多年ERA帯[3.3,4.6]）の制約で
  // targetVacanciesPerTeam=6 に抑制済み（thyroxin/research/draft_timeline_evidence.md 決定2参照）。
  gate('新人/球団年（引退のみの~4.8人/球団年より明確に増加）', rookieYears ? rookiesTotal / rookieYears / cfg.league.numTeams : 0, 5, 7.5, 1);
}

// ============================================================================
// Part H: H5-A（phaseH_fun_spec）— 年俸予算の実弾化が市場成立数を潰していないかのWATCH。
//   FA入札/トレード/戦力外拾い上げに「提示salary下限＋予算内」「salary差許容」の制約を追加した
//   （src/game/transactions.mjs runFA/runTrades・budgetCuts→runReleaseAndPickup）。市場は
//   AI/プレイヤー対称の制約なので、bandを緩く取りすぎると制約が実質無効化し、締めすぎると
//   H5-A前の市場成立数（実測: FA≈9.5件/年・トレード≈5.9件/年・拾い上げ≈15.3件/年＝
//   5seed×8年平均・12球団）から激減する。WATCH（表示のみ・まだGATE化しない＝spec指定）:
//   将来 budget/salaryDiffMax/salaryFloor を較正で追い込んだらGATEへ昇格させること。
// ============================================================================
console.log('\n--- H. H5-A: 年俸予算の実弾化 — 市場成立数（FA/トレード/拾い上げ）が激減していないか ---');
{
  const MKT_SEEDS = [11, 22, 33, 44, 55];
  const MKT_YEARS = 8;
  let faN = 0, trN = 0, puN = 0, budgetCutN = 0, years = 0;
  let overBudgetTeamYears = 0, teamYears = 0;
  for (const seed of MKT_SEEDS) {
    const st = newGame(seed, 'T1', { cfg });
    for (let y = 0; y < MKT_YEARS; y++) {
      advanceTo(st, 'seasonEnd');
      const off = advanceYear(st);
      faN += (off.fa ?? []).length;
      trN += (off.trades ?? []).filter((t) => !t.rejected).length;
      puN += (off.pickups ?? []).length;
      budgetCutN += (off.pickups ?? []).filter((p) => p.reason === 'budget').length;
      years++;
      for (const t of st.league.teams) {
        teamYears++;
        if (t.finance && t.finance.payroll > t.finance.budget) overBudgetTeamYears++;
      }
    }
  }
  const nT = cfg.league.numTeams;
  // H5-A前の実測（5seed×8年・12球団）: FA≈9.5/年、トレード≈5.9/年、拾い上げ≈15.3/年。
  //   激減の目安（半減未満）を割ったら要再較正（budget帯/salaryDiffMax/salaryFloorを緩める）。
  watch('FA成立/年（H5-A前実測 約9.5）', years ? faN / years : 0, 'FA/トレード/拾い上げが激減していないかの観測（表示のみ）', 2);
  watch('トレード成立/年（H5-A前実測 約5.9）', years ? trN / years : 0, '同上', 2);
  watch('拾い上げ成立/年（H5-A前実測 約15.3）', years ? puN / years : 0, '同上', 2);
  watch('拾い上げのうち予算超過起因/年', years ? budgetCutN / years : 0, '予算メカニクスが実際に発火しているか（0だと機能が死んでいる恐れ）', 2);
  watch('予算超過の球団・年の割合', teamYears ? overBudgetTeamYears / teamYears : 0, `全${nT}球団×${years}年中`, 3);
}

// ============================================================================
// 既知の未修正穴（realism_gap_audit.md より・修正したらGATEをここに追加して見張ること）
// ============================================================================
console.log('\n--- 既知の未修正穴（audit連動・修正時にGATE昇格すべき項目の覚え書き） ---');
info('・シーズン中の登録入替が ~12件/球団年（NPB実測: 実入替 50-70回・一軍出場の異なり選手 61人/球団）'
  + ' → reviewInterval/入替マージンの再較正後: registrationMoves の帯でGATE化');
info('・二塁打/球団が~260とNPB実測(170-230)超過（本ハーネス初回実行で検出）→ 2B/1Bミックス再較正後: [150,240]でGATE化');
info('・フェンス越え落下でもHRにならない帯（hrScaleの掛け方＋LA<15°のHR判定除外）→ 修正後: 「柵越え落下の非HR率=0」をGATE化');
info('・捕手/投手が守備網に不在（本塁至近ポップが落ちる）→ 修正後: PU被安打率[0, 0.05]をGATE化');
info('・EV分布に弱接触の左裾がない（内野安打が湧かない）→ 修正後: 内野安打/球団の帯をGATE化');
info('・継承走者の失点が現投手に付く（R2ユニット）→ 修正後: イベント不変量に失点帰属チェックを追加');

console.log(`\n=== realism-check: GATE ${gatePass} PASS / ${gateFail} FAIL（WATCHは表示のみ） ===`);
if (gateFail > 0) process.exit(1);

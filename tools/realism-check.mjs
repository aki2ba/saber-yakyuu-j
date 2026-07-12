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
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { simulateGame } from '../src/sim/game.mjs';
import { buildDepthChart } from '../src/sim/team.mjs';
import { leagueSummary } from '../src/sim/leagueStats.mjs';
import { generateBattedBall } from '../src/sim/battedBall.mjs';
import { resolveBattedBall, battedType, outfieldGeometry } from '../src/sim/battedBallResult.mjs';
import { makeRng, hashSeed } from '../src/rng.mjs';
import { NEUTRAL_PARK } from '../src/model/battedball.mjs';
import { createPlayerSeason } from '../src/model/statline.mjs';

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

console.log('=== リアリズム恒常ゲート（打球イベント×現実整合・realism_gap_audit.md 連動） ===\n');

// ============================================================================
// Part A: 打球ミクロ（合成20万球・リーグ平均マッチアップ・seed固定）
//   「そのプレーは現実に起きるか」を打球1球単位のカテゴリで見張る。
// ============================================================================
console.log('--- A. 打球ミクロ（合成20万球・打球情報と結果の突き合わせ） ---');
{
  const lg = generateLeague(20260701, cfg);
  const rng = makeRng(424242);
  const batter = lg.players.find((p) => p.role === 'fielder');
  const pitcher = lg.players.find((p) => p.role === 'pitcher');

  let hits = 0, h2 = 0, h3 = 0;
  let frontCutHits = 0, frontCutXbh = 0; // 前落ち遮断圏（ロール線の真上）に落ちた安打
  let nearOfFrontHits = 0, nearOfFrontXbh = 0; // 外野手の正面至近(8m以内・手前)に落ちた安打
  let puBalls = 0, puHits = 0; // ポップ（LA>50）
  let gbBalls = 0, gbHits = 0, gbXbh = 0;
  for (let i = 0; i < 200000; i++) {
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
  gate('外野手の正面至近(8m以内・手前)の安打の長打率', nearOfFrontHits ? nearOfFrontXbh / nearOfFrontHits : 0, 0, 0.08);
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
  let sacFlies = 0, fcs = 0, twoOutKills = 0, frontCut2B = 0;
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
  info(`（走査した打席イベント n=${paCount}）`);
}

// ============================================================================
// Part C: シーズン集計 vs 現実の公開集計値（2シード）
//   出典: NPB公式の年度別チーム成績（近年143試合）・正典 thyroxin/research/*.md
// ============================================================================
console.log('\n--- C. シーズン集計 vs 現実参照値（2シード平均） ---');
{
  const seeds = [1, 2];
  const acc = { b2: 0, b3: 0, sf: 0, gdp: 0, oob: 0, a1t3Taken: 0, a1t3Opp: 0, gb3hTaken: 0, gb3hOpp: 0, tagTaken: 0, tagOpp: 0 };
  for (const seed of seeds) {
    const lg = generateLeague(seed, cfg);
    const res = simulateSeason(lg, cfg, { season: 2026, seed, postseason: false });
    const s = leagueSummary(res, cfg.league.numTeams);
    acc.b2 += s.batting.b2 / cfg.league.numTeams;
    acc.b3 += s.batting.b3 / cfg.league.numTeams;
    acc.sf += s.batting.sf / cfg.league.numTeams;
    for (const ps of res.playerSeasons) {
      acc.gdp += ps.batting.gdp || 0; // leagueBattingはgdpを集計しないため直接合算
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
  // 二塁打/球団: NPB近年（143試合）の実測は 170-230（出典: npb.jp 年度別チーム打撃成績）。
  // 本ハーネス初回実行（2026-07-12）で ~260 と上限超過を検出＝新発見の実穴。修正には
  // 2B→1Bミックスの組み替え（AVG/SLG帯との同時再較正＝得点環境ベースライン見直し）が必要な
  // ため次の較正パス送り。それまでWATCHで観測し、修正後に[150,240]でGATE化すること。
  watch('二塁打/球団', acc.b2 / n, '現実(NPB)170-230 / 実測~260=本ハーネスが検出した新しい穴（未修正）', 1);
  gate('三塁打/球団', acc.b3 / n, 8, 35, 1);
  // 単打での一塁→三塁進塁率: 文献実測 25-40%（正典 baserunning_metrics_reference.md §XBT）
  gate('一塁→三塁進塁率（単打時）', acc.a1t3Taken / Math.max(1, acc.a1t3Opp), 0.18, 0.45);
  // ゴロゴー（三塁走者がゴロアウトの間に生還を試みる機会での生還率）: 中間守備前提で~4-6割
  gate('三塁走者のゴロゴー生還率', acc.gb3hTaken / Math.max(1, acc.gb3hOpp), 0.35, 0.75);
  // タッグアップ本塁生還率（深い犠飛機会）: 現実の犠飛機会は大半が成功（自重込みの機会率）
  gate('タッグアップ本塁生還率', acc.tagTaken / Math.max(1, acc.tagOpp), 0.45, 0.9);
  // 併殺打/球団: NPB近年 90-120（143試合）
  gate('併殺打/球団', acc.gdp / n / nT, 60, 140, 1);
  // 犠飛/球団: NPB近年 ~25-40。走塁再設計（R1）で深さ依存化した直後は下振れ気味＝WATCHで観測継続
  watch('犠飛/球団', acc.sf / n, '現実(NPB)~25-40 / R1直後は~20前後。次の較正パスで判断', 1);
  watch('走塁死(outsOnBase)/球団', acc.oob / n / nT, '参考値（NPB公式は本塁憤死等の分計なし）', 1);
}

// ============================================================================
// 既知の未修正穴（realism_gap_audit.md より・修正したらGATEをここに追加して見張ること）
// ============================================================================
console.log('\n--- 既知の未修正穴（audit連動・修正時にGATE昇格すべき項目の覚え書き） ---');
info('・二塁打/球団が~260とNPB実測(170-230)超過（本ハーネス初回実行で検出）→ 2B/1Bミックス再較正後: [150,240]でGATE化');
info('・フェンス越え落下でもHRにならない帯（hrScaleの掛け方＋LA<15°のHR判定除外）→ 修正後: 「柵越え落下の非HR率=0」をGATE化');
info('・捕手/投手が守備網に不在（本塁至近ポップが落ちる）→ 修正後: PU被安打率[0, 0.05]をGATE化');
info('・EV分布に弱接触の左裾がない（内野安打が湧かない）→ 修正後: 内野安打/球団の帯をGATE化');
info('・継承走者の失点が現投手に付く（R2ユニット）→ 修正後: イベント不変量に失点帰属チェックを追加');

console.log(`\n=== realism-check: GATE ${gatePass} PASS / ${gateFail} FAIL（WATCHは表示のみ） ===`);
if (gateFail > 0) process.exit(1);

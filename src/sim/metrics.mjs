// ============================================================================
// 選手別セイバー指標（1-7 / §5 §9）
// 生カウント(PlayerSeason)＋リーグ定数(1-6) から打撃・投手指標を算出する。
// 指標は「後付け」でなく、打席・打球のシミュレートの副産物である生カウントから湧く（付録原則1）。
// ============================================================================
import { rawRunValuePerPA, LINEAR_WEIGHTS } from './leagueConstants.mjs';
import { METRICS_CONST } from '../config.mjs';
import { uzrComponents } from './fielding.mjs';
import { createSplitLine } from '../model/statline.mjs';

const div = (a, b) => (b ? a / b : 0);

/**
 * ピタゴラス期待勝率（pythagenpat・チーム得失点から実力勝率を推定）＋幸運度（§セイバー団体指標）。
 * 指数は得点環境に応じて動く pythagenpat: exp = ((RS+RA)/G)^0.287。
 * luck = (実勝率 − 期待勝率) × 決着試合数（+なら得失点差の割に勝ち越し＝幸運/接戦強い）。
 * 三層構造に無関係な純関数（順位表の得失点=公開情報のみ使用）。
 * @param {{w:number,l:number,rs:number,ra:number}} t 順位表の行（引分は決着に含めない）
 * @returns {{expWinPct:number, luck:number, exponent:number}}
 */
export function pythag(t) {
  const decided = (t.w || 0) + (t.l || 0);
  const rs = t.rs || 0;
  const ra = t.ra || 0;
  if (decided === 0 || rs + ra === 0) return { expWinPct: 0.5, luck: 0, exponent: 2 };
  const rpg = (rs + ra) / decided; // 1試合あたり総得点（両軍）
  const exp = Math.pow(Math.max(rpg, 0.5), 0.287); // pythagenpat 指数
  const expWinPct = Math.pow(rs, exp) / (Math.pow(rs, exp) + Math.pow(ra, exp));
  const actualWinPct = t.w / decided;
  return { expWinPct, luck: (actualWinPct - expWinPct) * decided, exponent: exp };
}

/** スプリット器→スラッシュライン（AVG/OBP/SLG/OPS・§B3b）。 */
function slashOf(sl) {
  const tb = sl.b1 + 2 * sl.b2 + 3 * sl.b3 + 4 * sl.hr;
  const obp = div(sl.h + sl.bb + sl.hbp, sl.ab + sl.bb + sl.hbp + sl.sf);
  const slg = div(tb, sl.ab);
  return { pa: sl.pa, ab: sl.ab, h: sl.h, hr: sl.hr, bb: sl.bb, so: sl.so, avg: div(sl.h, sl.ab), obp, slg, ops: obp + slg };
}

/** 打撃スプリット表示（対左/対右・得点圏(RISP)・ホーム/ビジター・§B3b）。 */
export function battingSplits(ps) {
  const sp = (ps.batting && ps.batting.splits) || {};
  const g = (k) => slashOf(sp[k] || createSplitLine());
  return { vsL: g('vsL'), vsR: g('vsR'), risp: g('risp'), home: g('home'), away: g('away') };
}

/** 守備成分の表示（UZR分解 RngR/ErrR/ARM/DPR/rSB/framing・§B3b）。WAR用uzrRunsとは独立の内訳表示。 */
export function playerFielding(ps, cfg, lc) {
  const comp = uzrComponents(ps, cfg, lc);
  const f = ps.fielding;
  return {
    ...comp, // pos/rngR/errR/framing/arm/dpr/rSB/total
    armOpp: f.armOpp || 0,
    dpOpp: f.dpOpp || 0,
    dpTurned: f.dpTurned || 0,
    sbAllowed: f.sbAllowed || 0,
    csMade: f.csMade || 0,
  };
}

/** 打撃指標（wOBA/wRAA/wRC+ ＋ B3a: xBA/xSLG/xwOBA・Barrel%等・OPS+/wRC/SecA…） */
export function playerBatting(ps, lc) {
  const b = ps.batting;
  const tb = b.b1 + 2 * b.b2 + 3 * b.b3 + 4 * b.hr;
  const avg = div(b.h, b.ab);
  const obp = div(b.h + b.bb + b.hbp, b.ab + b.bb + b.hbp + b.sf);
  const slg = div(tb, b.ab);
  const babip = div(b.h - b.hr, b.ab - b.so - b.hr + b.sf);

  const raw = rawRunValuePerPA(b, lc.linearWeights);
  const woba = lc.wobaScale ? lc.wobaScale * raw : 0;
  const wraa = (raw - (lc.lgRawPerPA || 0)) * b.pa;
  const wrcPlus =
    lc.lgRunsPerPA && b.pa ? ((wraa / b.pa + lc.lgRunsPerPA) / lc.lgRunsPerPA) * 100 : 100;
  // パーク補正 wRC+（D2・§11.2）: 本拠地PFで割る（打高球場の打者は割り引かれ、リーグ100中心に戻る）。
  //   PF未提供（中立単一park/teamId不明）時は素の wRC+ と一致（後方互換）。
  const pf = (lc.parkBatByTeam && ps.teamId && lc.parkBatByTeam.get(ps.teamId)) || 1;
  const wrcPlusPF =
    lc.lgRunsPerPA && b.pa ? ((wraa / b.pa + lc.lgRunsPerPA) / (pf * lc.lgRunsPerPA)) * 100 : wrcPlus;

  // --- B3a: 期待値系（xBA/xSLG/xwOBA）。打球イベントの期待out率/塁打分布(rng抽選前)の累積から。 ---
  const xh = b.xB1 + b.xB2 + b.xB3 + b.xHR;
  const xtb = b.xB1 + 2 * b.xB2 + 3 * b.xB3 + 4 * b.xHR;
  const xba = div(xh, b.ab);
  const xslg = div(xtb, b.ab);
  const W = lc.linearWeights || LINEAR_WEIGHTS;
  const ibb = b.ibb || 0;
  const xDenom = b.ab + b.bb - ibb + b.sf + b.hbp; // wOBAと同一の分母
  const xNum = W.bb * (b.bb - ibb) + W.hbp * b.hbp + W.b1 * b.xB1 + W.b2 * b.xB2 + W.b3 * b.xB3 + W.hr * b.xHR;
  const xRaw = xDenom ? xNum / xDenom : 0;
  const xwoba = lc.wobaScale ? lc.wobaScale * xRaw : 0;

  // --- B3a: 打球分類・質（分母=bbEvents）。GB/LD/FB/PU%・Pull/Cent/Oppo%・Barrel/HardHit/SweetSpot% ---
  const bbe = b.bbEvents;
  // --- B3a: 伝統系の派生（OPS+/wRC/TB/XBH/SecA/BB/K/ISO） ---
  const opsPlus = lc.lgOBP && lc.lgSLG ? 100 * (obp / lc.lgOBP + slg / lc.lgSLG - 1) : 100;
  const wrc = wraa + (lc.lgRunsPerPA || 0) * b.pa; // wRC = wRAA + lgR/PA×PA
  const xbh = b.b2 + b.b3 + b.hr; // 長打(二塁打+三塁打+本塁打)
  const secA = div(tb - b.h + b.bb + (b.sb - b.cs), b.ab); // Secondary Average

  return {
    pa: b.pa,
    ab: b.ab,
    h: b.h,
    hr: b.hr,
    rbi: b.rbi,
    sb: b.sb,
    bb: b.bb,
    so: b.so,
    avg,
    obp,
    slg,
    ops: obp + slg,
    iso: slg - avg,
    babip,
    kPct: div(b.so, b.pa),
    bbPct: div(b.bb, b.pa),
    woba,
    wraa,
    wrcPlus,
    wrcPlusPF, // パーク補正 wRC+（D2・§11.2）
    pf, // 本拠地パークファクター（打者補正・1.0=中立）
    tb,
    // --- B3a 追加 ---
    xba,
    xslg,
    xwoba,
    opsPlus,
    wrc,
    xbh,
    secA,
    bbK: div(b.bb, b.so),
    gbPct: div(b.bbGB, bbe),
    ldPct: div(b.bbLD, bbe),
    fbPct: div(b.bbFB, bbe),
    puPct: div(b.bbPU, bbe),
    pullPct: div(b.bbPull, bbe),
    centPct: div(b.bbCent, bbe),
    oppoPct: div(b.bbOppo, bbe),
    barrelPct: div(b.barrels, bbe),
    hardHitPct: div(b.hardHits, bbe),
    sweetSpotPct: div(b.sweetSpots, bbe),
    evAvg: div(b.evSum, bbe),
    evMax: b.evMax,
    bbEvents: bbe,
    // --- B2 文脈指標（RE24/WPA/LI・§B2。context有効時のみ非0） ---
    re24: b.re24,
    wpa: b.wpa,
    aLI: div(b.liSum, b.pa), // 打席加重レバレッジ（リーグ平均=1.0）
    wpaLI: b.wpaLiSum, // 文脈中立WPA（Σ 打席WPA/打席LI）
    clutch: div(b.wpa, div(b.liSum, b.pa)) - b.wpaLiSum, // Clutch = WPA/aLI − WPA/LI
  };
}

/**
 * UBRのシナリオ別内訳1件ぶんのrun価値（§req_20260708・Fangraphs UBR/BP EqBRRのRE24分解準拠）。
 * シナリオごとにリーグ平均進塁率で中心化し、run/機会の重み(runW)を掛ける（リーグΣ≈0）。
 */
function ubrScenario(br, lc, key, runW) {
  const opp = br[`${key}Opp`] || 0;
  if (!opp) return 0;
  const rate = lc && lc.lgAdvRateByScenario ? lc.lgAdvRateByScenario[key] || 0 : 0;
  return ((br[`${key}Taken`] || 0) - rate * opp) * runW;
}

/**
 * 走塁指標（§6／§req_20260708強化）。BsR = wSB + UBR + wGDP。
 * UBR はシナリオ別（単打での二塁走者本塁突入・二塁打での一塁走者本塁突入・単打での一塁走者
 * 三塁進塁・タッグアップ）にRE24分解して合算する（Fangraphs UBR/Baseball Prospectus EqBRR準拠。
 * 単一の全シナリオ合算率で中心化する旧方式は、進塁機会ごとに基準確率が異なるため偏りがあった）。
 */
export function playerBaserunning(ps, cfg, lc) {
  const b = ps.batting;
  // wSB（監査C1）: リーグ基準 lgwSB×(一塁到達機会) を控除して中心化する。
  // 走らない選手は僅かに負の基準、盗塁者は正味加点というゼロ点になり、リーグwSB総和≈0。
  const sbOpp = (b.b1 || 0) + (b.bb || 0) + (b.hbp || 0) - (b.ibb || 0);
  const lgwSBrate =
    lc && lc.lgSBOpp ? (lc.lgSB * cfg.tuning.run.runSB + lc.lgCS * cfg.tuning.run.runCS) / lc.lgSBOpp : 0;
  const wSB = b.sb * cfg.tuning.run.runSB + b.cs * cfg.tuning.run.runCS - lgwSBrate * sbOpp;
  const br = ps.baserunning || {};
  // wGDP: 期待併殺(リーグ率×機会)より少なく併殺した分がプラス。§6
  const gdpOpp = br.gdpOpp || 0;
  const wGDP =
    lc && lc.lgGDPrate != null ? (lc.lgGDPrate * gdpOpp - (b.gdp || 0)) * Math.abs(cfg.tuning.gdp.runGDP) : 0;
  // UBR: シナリオ別に中心化して合算（走者Speed/IQ）。§6／§req_20260708
  const rw = cfg.tuning.run;
  const ubr =
    ubrScenario(br, lc, 'adv2h1b', rw.runUBR) +
    ubrScenario(br, lc, 'adv1h2b', rw.runUBR) +
    ubrScenario(br, lc, 'adv1t3b', rw.runUBR1t3b) +
    ubrScenario(br, lc, 'tag', rw.runUBRTag);
  return {
    sb: b.sb,
    cs: b.cs,
    sbPct: b.sb + b.cs ? b.sb / (b.sb + b.cs) : 0,
    gdp: b.gdp,
    wSB,
    ubr,
    wGDP,
    bsr: wSB + ubr + wGDP,
    // --- 走塁の追加集計（XBT%）---
    //   ※ Spd（Speed Score）は撤去した。FanGraphs 自身が「outdated / run スケールでない。UBR を使え」と
    //     明言しており、各 factor の正確な係数は一次情報で確認できなかった（Wikipedia 単独ソースかつ
    //     一般に流布する式と係数が食い違う）。旧実装は「守備位置速度」という打席を1つも見ない
    //     ルックアップ項を含み、しかもその表はこのシムの生成分布と矛盾していた。
    //     走塁の価値は BsR = UBR + wSB + wGDP（すべて一次情報で定義・生カウントから創発）で表す。
    //     正典: thyroxin/research/fielding_metrics_reference.md §7
    xbt: div(br.advTaken || 0, br.advOpp || 0), // 追加進塁率（advTaken/advOpp）
    advOpp: br.advOpp || 0,
    advTaken: br.advTaken || 0,
    // --- B2 文脈指標（走塁イベントのRE24/WPA・§B2。context有効時のみ非0） ---
    re24: br.re24 || 0, // 盗塁/追加進塁の得点期待値寄与
    wpa: br.wpa || 0, // 盗塁/追加進塁の勝率寄与
  };
}

/**
 * 投手指標（ERA/FIP ＋ B3a: xFIP/SIERA/kwERA/ERA-/FIP-/xFIP-/K-BB%/LOB%/被打球分類/HR-FB/QS）。
 * FIPはFG式 (13HR+3(BB−IBB+HBP)−2K)/IP + C（敬遠は投手の技量でないため除外・S3）。
 * @param {Object} ps PlayerSeason
 * @param {Object} lc リーグ定数（lgHRFB/lgERA/lgFIP/fipConstant を含む）
 * @param {Object} [cfg] 設定（SIERA/kwERA係数=cfg.tuning.metrics。省略時は METRICS_CONST 既定）
 */
export function playerPitching(ps, lc, cfg = null) {
  const p = ps.pitching;
  const ip = p.outs / 3;
  const m = (cfg && cfg.tuning && cfg.tuning.metrics) || METRICS_CONST;
  // 本拠地パークファクター（D2・§11.2）。PF未提供/teamId不明なら1.0（＝park補正=素の値）。
  const pfPit = (lc.parkPitByTeam && ps.teamId && lc.parkPitByTeam.get(ps.teamId)) || 1;
  const uBBhbp = p.bb - (p.ibb || 0) + p.hbp;
  const fipRaw = ip ? (13 * p.hr + 3 * uBBhbp - 2 * p.so) / ip : 0;
  const fip = ip ? fipRaw + (lc.fipConstant || 0) : 0;
  const era = div(p.er * 9, ip);
  const kPct = div(p.so, p.bf);
  const bbPct = div(p.bb, p.bf);

  // xFIP（§B3a）: 被HRを 被FB×lgHR/FB に置換（FG式）。fipConstant共通ゆえ リーグxFIP=リーグFIP。
  const xHRexp = p.bbFB * (lc.lgHRFB || 0);
  const xfipRaw = ip ? (13 * xHRexp + 3 * uBBhbp - 2 * p.so) / ip : 0;
  const xfip = ip ? xfipRaw + (lc.fipConstant || 0) : 0;

  // SIERA（FanGraphs公開式・Swartz）。netGB²項は符号保存（GB>FB+PU で好投側=負寄与）。
  const pa = p.bf;
  const soR = div(p.so, pa);
  const bbR = div(p.bb, pa);
  const netGB = div(p.bbGB - p.bbFB - p.bbPU, pa);
  const S = m.siera;
  const siera = pa
    ? S.c0 +
      S.cSO * soR +
      S.cBB * bbR +
      S.cNet * netGB +
      S.cSO2 * soR * soR +
      S.cNet2 * netGB * Math.abs(netGB) +
      S.cSOnet * soR * netGB +
      S.cBBnet * bbR * netGB
    : 0;

  // kwERA = 5.40 − 12×(K% − BB%)
  const kwera = m.kwERA.c0 - m.kwERA.k * (kPct - bbPct);

  // LOB% = (H+BB+HBP−R)/(H+BB+HBP−1.4HR)（残塁率）
  const lobDen = p.h + p.bb + p.hbp - 1.4 * p.hr;
  const lobPct = lobDen ? (p.h + p.bb + p.hbp - p.r) / lobDen : 0;

  // 被打球分類（分母=bbEvents）と HR/FB
  const bbe = p.bbEvents;

  return {
    g: p.g,
    gs: p.gs,
    ip,
    bf: p.bf,
    w: p.w,
    l: p.l,
    sv: p.sv,
    hld: p.hld,
    so: p.so,
    bb: p.bb,
    h: p.h,
    hr: p.hr,
    era,
    fip,
    whip: div(p.h + p.bb, ip),
    kPer9: div(p.so * 9, ip),
    bbPer9: div(p.bb * 9, ip),
    hrPer9: div(p.hr * 9, ip),
    kPct,
    bbPct,
    // --- B3a 追加 ---
    xfip,
    siera,
    kwera,
    kbbPct: kPct - bbPct,
    lobPct,
    // リーグ=100基準（低いほど良い）。素の値は非パーク補正。park補正版は下の *PF（D2・§11.2）。
    eraMinus: lc.lgERA ? (era / lc.lgERA) * 100 : 100,
    fipMinus: lc.lgFIP ? (fip / lc.lgFIP) * 100 : 100,
    xfipMinus: lc.lgFIP ? (xfip / lc.lgFIP) * 100 : 100,
    // パーク補正版（D2）: 本拠地PFで割る（打高球場の投手は ERA-/FIP- が優遇＝低くなる）。
    //   PF未提供時は素の値と一致（後方互換）。
    pf: pfPit,
    eraMinusPF: lc.lgERA ? (era / (pfPit * lc.lgERA)) * 100 : 100,
    fipMinusPF: lc.lgFIP ? (fip / (pfPit * lc.lgFIP)) * 100 : 100,
    gbPct: div(p.bbGB, bbe),
    ldPct: div(p.bbLD, bbe),
    fbPct: div(p.bbFB, bbe),
    puPct: div(p.bbPU, bbe),
    hrFbPct: div(p.hr, p.bbFB),
    qs: p.qs,
    bbEvents: bbe,
    // --- B2 文脈指標（RE24/WPA/LI・§B2。context有効時のみ非0） ---
    re24: p.re24,
    wpa: p.wpa,
    pLI: div(p.liSum, p.bf), // 投手の平均レバレッジ（リーグ平均=1.0）
    gmLI: div(p.gmLiSum, p.gmLiN), // 登板時レバレッジ（救援WARのレバレッジ加重に使用）
    wpaLI: p.wpaLiSum, // 文脈中立WPA（Σ 被WPA/打席LI）
    clutch: div(p.wpa, div(p.liSum, p.bf)) - p.wpaLiSum, // Clutch = WPA/pLI − WPA/LI
    sd: p.sd, // シャットダウン（1登板WPA ≥ +0.06）
    md: p.md, // メルトダウン（1登板WPA ≤ −0.06）
  };
}

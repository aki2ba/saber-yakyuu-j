// ============================================================================
// 選手別セイバー指標（1-7 / §5 §9）
// 生カウント(PlayerSeason)＋リーグ定数(1-6) から打撃・投手指標を算出する。
// 指標は「後付け」でなく、打席・打球のシミュレートの副産物である生カウントから湧く（付録原則1）。
// ============================================================================
import { rawRunValuePerPA } from './leagueConstants.mjs';

const div = (a, b) => (b ? a / b : 0);

/** 打撃指標（wOBA/wRAA/wRC+ 含む） */
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
    tb,
  };
}

/**
 * 走塁指標（§6）。現状 wSB のみ実装（UBR/wGDPは2-5/2-6で追加）。
 * BsR = wSB + UBR + wGDP。
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
  // UBR: 追加進塁を平均より多く取った分がプラス（走者Speed/IQ）。§6
  const advOpp = br.advOpp || 0;
  const ubr =
    lc && lc.lgAdvRate != null ? ((br.advTaken || 0) - lc.lgAdvRate * advOpp) * cfg.tuning.run.runUBR : 0;
  return {
    sb: b.sb,
    cs: b.cs,
    sbPct: b.sb + b.cs ? b.sb / (b.sb + b.cs) : 0,
    gdp: b.gdp,
    wSB,
    ubr,
    wGDP,
    bsr: wSB + ubr + wGDP,
  };
}

/** 投手指標（ERA/FIP 含む）。FIPはFG式 (13HR+3(BB−IBB+HBP)−2K)/IP + C（敬遠は投手の技量でないため除外・S3） */
export function playerPitching(ps, lc) {
  const p = ps.pitching;
  const ip = p.outs / 3;
  const fipRaw = ip ? (13 * p.hr + 3 * (p.bb - (p.ibb || 0) + p.hbp) - 2 * p.so) / ip : 0;
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
    era: div(p.er * 9, ip),
    fip: ip ? fipRaw + (lc.fipConstant || 0) : 0,
    whip: div(p.h + p.bb, ip),
    kPer9: div(p.so * 9, ip),
    bbPer9: div(p.bb * 9, ip),
    kPct: div(p.so, p.bf),
    bbPct: div(p.bb, p.bf),
  };
}

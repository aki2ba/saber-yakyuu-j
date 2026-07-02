// ============================================================================
// リーグ集計指標（1-7の一部・1-11較正で再利用）
// シーズン結果(playerSeasons + standings)から、レート指標を算出する。
// ============================================================================

/** リーグ打撃集計 */
export function leagueBatting(playerSeasons) {
  const s = { pa: 0, ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, ibb: 0, hbp: 0, so: 0, sf: 0, sh: 0 };
  for (const ps of playerSeasons) {
    const b = ps.batting;
    s.pa += b.pa; s.ab += b.ab; s.h += b.h; s.b1 += b.b1; s.b2 += b.b2; s.b3 += b.b3;
    s.hr += b.hr; s.bb += b.bb; s.ibb += b.ibb; s.hbp += b.hbp; s.so += b.so; s.sf += b.sf; s.sh += b.sh;
  }
  const tb = s.b1 + 2 * s.b2 + 3 * s.b3 + 4 * s.hr;
  const avg = s.ab ? s.h / s.ab : 0;
  const obp = s.ab + s.bb + s.hbp + s.sf ? (s.h + s.bb + s.hbp) / (s.ab + s.bb + s.hbp + s.sf) : 0;
  const slg = s.ab ? tb / s.ab : 0;
  const babipDen = s.ab - s.so - s.hr + s.sf;
  return {
    ...s,
    tb,
    avg,
    obp,
    slg,
    ops: obp + slg,
    iso: slg - avg,
    kPct: s.pa ? s.so / s.pa : 0,
    bbPct: s.pa ? s.bb / s.pa : 0,
    babip: babipDen ? (s.h - s.hr) / babipDen : 0,
  };
}

/** リーグ投手集計 */
export function leaguePitching(playerSeasons) {
  const s = { outs: 0, bf: 0, h: 0, hr: 0, bb: 0, ibb: 0, hbp: 0, so: 0, r: 0, er: 0 };
  for (const ps of playerSeasons) {
    const p = ps.pitching;
    s.outs += p.outs; s.bf += p.bf; s.h += p.h; s.hr += p.hr; s.bb += p.bb; s.ibb += p.ibb;
    s.hbp += p.hbp; s.so += p.so; s.r += p.r; s.er += p.er;
  }
  const ip = s.outs / 3;
  return { ...s, ip, era: ip ? (s.er / ip) * 9 : 0, whip: ip ? (s.h + s.bb) / ip : 0 };
}

/**
 * シーズン結果からリーグ全体のサマリを作る（較正の判定用）。
 * @param {{playerSeasons:Array, standings:Array}} res
 * @param {number} numTeams
 */
export function leagueSummary(res, numTeams) {
  const bat = leagueBatting(res.playerSeasons);
  const pit = leaguePitching(res.playerSeasons);
  const totalRS = res.standings.reduce((a, t) => a + t.rs, 0);
  const totalG = res.standings.reduce((a, t) => a + t.g, 0); // = リーグ延べ試合数(=2×試合)
  const gamesPerTeam = totalG / numTeams;
  return {
    batting: bat,
    pitching: pit,
    hrPerTeam: bat.hr / numTeams,
    runsPerTeamPerGame: totalRS / numTeams / gamesPerTeam,
    gamesPerTeam,
  };
}

/**
 * リーグ別（L1/L2）のサマリ（S3・セパ得点差の較正用）。チームの所属リーグ単位で集計する。
 * ※DH規則単位（試合のDH有無別）の得点差は simulateSeason の runSplit を使うこと
 *   （所属リーグ単位は球団戦力ノイズで符号が反転しうる・S2引き継ぎ注意）。
 * @param {{playerSeasons:Array, standings:Array}} res simulateSeason の結果
 * @param {Array<{id:string,league:?string}>} teams league.teams
 * @returns {Object<string, ReturnType<leagueSummary>>} リーグid → サマリ
 */
export function leagueSummaryByLeague(res, teams) {
  const leagueOf = new Map(teams.map((t) => [t.id, t.league]));
  const out = {};
  for (const lid of new Set(teams.map((t) => t.league))) {
    const ps = res.playerSeasons.filter((s) => leagueOf.get(s.teamId) === lid);
    const rows = res.standings.filter((t) => leagueOf.get(t.teamId) === lid);
    if (!rows.length) continue;
    out[lid ?? 'ALL'] = leagueSummary({ playerSeasons: ps, standings: rows }, rows.length);
  }
  return out;
}

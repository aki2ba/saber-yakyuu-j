// ============================================================================
// Q4/Q8: 殿堂/球団史ギャラリー・二つ名/記録の「アルバム」
//   （thyroxin/research/baseball_game_mechanics_research_20260723 Q4・Q8・
//    OOTP Hall of Fame / プロスピA称号・Diamond Dynasty コレクションの翻案・ガチャなし）。
//
//   hallOfFamers(state)     … 引退済み＋通算成績閾値（安打/本塁打/勝利/セーブ/奪三振）または
//                             受賞数閾値を満たす引退選手を集計する（Q4）。
//   nicknameAlbum(state)    … これまで生まれた二つ名の一覧（現役+引退選手にnicknameForを適用し
//                             「未知数」を除外して集計。Q8前半）。
//   recordAlbum(state)      … 球団記録（優勝年一覧）/リーグ記録（現保持者）の再編集（Q8後半）。
//
// 設計原則（CLAUDE.md鉄則・タスク仕様の厳守事項）:
//   - 表示層のみ: awardsHistory/careerStats/retiredPlayers/teamHistory（既存の永続データ）だけの
//     純関数集計。新規保存フィールドは追加しない。真値(trueAbility)は一切参照しない。
//   - 決定論: 乱数を一切使わない（並び順は数値降順→playerId昇順のタイブレークのみ）。
// ============================================================================
import { careerBatting, careerPitching, nicknameFor, playerAwardHistory, leagueRecords, teamRecords } from './awards.mjs';

// バンドルは全エンジンモジュールを同一スコープへconcatするため、トップレベル名は全モジュールで一意にする
// （storylines.mjs の idAsc と衝突しないようリネーム）。
const idAscGal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 殿堂入り基準（関数内定数・研究レポートの目安どおり）。いずれか1つでも満たせば殿堂。 */
const HOF_THRESHOLDS = {
  hits: 2000, // 通算安打
  homeRuns: 200, // 通算本塁打
  wins: 150, // 通算勝利
  saves: 150, // 通算セーブ
  strikeouts: 1500, // 通算奪三振
  minAwards: 5, // 受賞数（MVP/新人王/タイトル/ベストナイン/守備の栄誉賞の合計）
};

/** playerId が careerStats 上で在籍した球団（初出順・重複無し）。 */
function tenureTeams(careerStats, playerId) {
  const teams = [];
  for (const s of careerStats) {
    if (s.playerId !== playerId) continue;
    if (!teams.includes(s.teamId)) teams.push(s.teamId);
  }
  return teams;
}

/**
 * Q4: 殿堂入り基準（引退済み＋通算成績閾値いずれか、または受賞数閾値）を満たす引退選手を集計する。
 * state.retiredPlayers（§17集計値サマリ）＋state.careerStats/awardsHistoryのみを参照する純関数
 * （新規保存フィールド不要）。
 * @param {Object} state GameState（retiredPlayers/careerStats/teamHistory/awardsHistory/cfg が必要）
 * @returns {Array<{playerId,name,role,primaryPos,finalAge,retiredAfterYear,nickname,career,awardsCount,teams}>}
 *   通算成績降順（引退年降順→playerId昇順の決定論タイブレーク）
 */
export function hallOfFamers(state) {
  const cfg = state.cfg;
  const careerStats = state.careerStats || [];
  const playersById = new Map((state.retiredPlayers ?? []).map((r) => [r.id, r]));
  const out = [];
  for (const r of state.retiredPlayers ?? []) {
    const isPitcher = r.role === 'pitcher';
    const bat = isPitcher ? null : careerBatting(careerStats, r.id);
    const pit = isPitcher ? careerPitching(careerStats, r.id) : null;
    const hist = playerAwardHistory(r.id, {
      careerStats, teamHistory: state.teamHistory || [], playersById, cfg, awardsHistory: state.awardsHistory || [],
    });
    const meetsStat = isPitcher
      ? (pit.w >= HOF_THRESHOLDS.wins || pit.sv >= HOF_THRESHOLDS.saves || pit.so >= HOF_THRESHOLDS.strikeouts)
      : (bat.h >= HOF_THRESHOLDS.hits || bat.hr >= HOF_THRESHOLDS.homeRuns);
    const meetsAwards = hist.length >= HOF_THRESHOLDS.minAwards;
    if (!meetsStat && !meetsAwards) continue;
    out.push({
      playerId: r.id,
      name: r.name,
      role: r.role,
      primaryPos: r.primaryPos,
      finalAge: r.finalAge,
      retiredAfterYear: r.retiredAfterYear,
      nickname: nicknameFor(r, careerStats, cfg),
      career: isPitcher ? pit : bat,
      awardsCount: hist.length,
      teams: tenureTeams(careerStats, r.id),
    });
  }
  out.sort((a, b) => b.retiredAfterYear - a.retiredAfterYear || idAscGal(a.playerId, b.playerId));
  return out;
}

/**
 * Q8前半: これまで生まれた二つ名の一覧（現役+育成+引退選手へ nicknameFor を適用し「未知数」を除外）。
 * 新規保存フィールド不要（既存 league.players/farm/retiredPlayers + careerStats からの純関数集計）。
 * @param {Object} state GameState
 * @returns {Array<{playerId,name,nickname,role,status:'active'|'retired'}>} playerId昇順
 */
export function nicknameAlbum(state) {
  const cfg = state.cfg;
  const careerStats = state.careerStats || [];
  const out = [];
  const seen = new Set();
  const consider = (p, status) => {
    if (!p || seen.has(p.id)) return;
    seen.add(p.id);
    const nick = nicknameFor(p, careerStats, cfg);
    if (nick === '未知数') return;
    out.push({ playerId: p.id, name: p.name, nickname: nick, role: p.role, status });
  };
  for (const p of state.league?.players ?? []) consider(p, 'active');
  for (const p of state.league?.farm ?? []) consider(p, 'active');
  for (const p of state.retiredPlayers ?? []) consider(p, 'retired');
  out.sort((a, b) => idAscGal(a.playerId, b.playerId));
  return out;
}

/** リーグ記録アルバムの表示カテゴリ定義（leagueRecordsのキー→見出し）。 */
const RECORD_ALBUM_CATS = [
  ['seasonHR', 'シーズン本塁打記録'], ['seasonH', 'シーズン安打記録'], ['seasonSB', 'シーズン盗塁記録'],
  ['seasonW', 'シーズン勝利記録'], ['seasonSO', 'シーズン奪三振記録'], ['seasonSV', 'シーズンセーブ記録'],
  ['careerHR', '通算本塁打記録'], ['careerH', '通算安打記録'], ['careerSB', '通算盗塁記録'],
  ['careerW', '通算勝利記録'], ['careerSO', '通算奪三振記録'], ['careerSV', '通算セーブ記録'],
];

/**
 * Q8後半: 球団記録（優勝年一覧）/リーグ記録（現保持者トップ1）の再編集アルバム。
 * 既存 leagueRecords/teamRecords（awards.mjs）の見せ方を変えるだけ（新規集計ロジック無し）。
 * @param {Object} state GameState
 * @returns {{leagueTop:Array<{key,label,row}>, teamTitles:Array<{teamId,years:number[]}>}}
 */
export function recordAlbum(state) {
  const byId = new Map();
  for (const p of state.league?.players ?? []) byId.set(p.id, p);
  for (const p of state.league?.farm ?? []) if (!byId.has(p.id)) byId.set(p.id, p);
  for (const p of state.retiredPlayers ?? []) if (!byId.has(p.id)) byId.set(p.id, p);
  const rec = leagueRecords({ careerStats: state.careerStats || [], playersById: byId, cfg: state.cfg });
  const leagueTop = RECORD_ALBUM_CATS
    .map(([key, label]) => ({ key, label, row: (rec[key] && rec[key][0]) || null }))
    .filter((x) => x.row);

  const teamTitles = [];
  for (const t of state.league?.teams ?? []) {
    const th = teamRecords(state.teamHistory || [], t.id);
    const years = th.filter((r) => r.champion).map((r) => r.year);
    if (years.length) teamTitles.push({ teamId: t.id, years });
  }
  teamTitles.sort((a, b) => b.years.length - a.years.length || idAscGal(a.teamId, b.teamId));
  return { leagueTop, teamTitles };
}

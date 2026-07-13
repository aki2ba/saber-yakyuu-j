// ============================================================================
// R5: 成績集計（careerStats / careerFarmStats）の数値エンコード
//
// 問題: playerSeason は {batting:{pa,ab,h,...}, pitching:{...}, fielding:{positionOuts:{...}},
//   baserunning:{...}} という **キー名だらけの入れ子オブジェクト** で、1行 ≈ 2,000B のうち大半が
//   キー名の繰り返し。前史30年＋長期プレイでは数万行になり、save が十数MBに膨らむ。
//   （保存先は IndexedDB なので容量は足りるが、**日次オートセーブで毎回それを直列化する**コストが痛い）
//
// 方式: 数値の位置を固定した「列指向」エンコード。
//   paths（数値リーフのパス一覧）を1回だけ書き、各行は [playerId, season, teamId, ...数値] の配列にする。
//   キー名が行ごとに消えるので 1/3 以下になる。**値は一切丸めない**（丸めると load 後の
//   オフシーズン査定が無セーブ通しと食い違い、決定論が壊れる）。
//
//   スプリット/カウント別（表示専用の入れ子。直近2年のみ保持・index.mjs compactCareerStats）は
//   数が少ないので、行番号をキーにした detail としてそのまま持つ。
// ============================================================================
import { createPlayerSeason } from '../model/statline.mjs';

const SECTIONS = ['batting', 'pitching', 'fielding', 'baserunning'];
const SKIP = new Set(['splits', 'byCount']); // 表示専用の入れ子（detail 側で持つ）

/** テンプレートから「数値リーフのパス」を決定論的に列挙する（キー順＝挿入順で安定）。 */
function collectPaths(obj, prefix, out) {
  for (const k of Object.keys(obj)) {
    if (SKIP.has(k)) continue;
    const v = obj[k];
    if (v === null || typeof v === 'number') out.push(prefix ? `${prefix}.${k}` : k);
    else if (v && typeof v === 'object' && !Array.isArray(v)) collectPaths(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

/** playerSeason の数値パス一覧（モジュール初期化時に1回だけ作る）。 */
function statPaths() {
  const tpl = createPlayerSeason('x', 0);
  const out = [];
  for (const sec of SECTIONS) if (tpl[sec]) collectPaths(tpl[sec], sec, out);
  return out;
}
const PATHS = statPaths();

function getPath(row, path) {
  let cur = row;
  for (const k of path.split('.')) {
    if (cur == null) return 0;
    cur = cur[k];
  }
  return typeof cur === 'number' ? cur : 0;
}

function setPath(row, path, val) {
  const keys = path.split('.');
  let cur = row;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = val;
}

/**
 * playerSeason[] → 列指向のエンコード済みブロブ。
 * @returns {{v:number, paths:string[], rows:Array, detail:Object}}
 */
export function encodeSeasons(seasons) {
  const rows = [];
  const detail = {};
  seasons.forEach((s, i) => {
    const vals = PATHS.map((p) => getPath(s, p));
    rows.push([s.playerId, s.season, s.teamId ?? null, ...vals]);
    // 表示専用の入れ子（直近年のみ存在）はそのまま退避
    const d = {};
    if (s.batting?.splits) d.splits = s.batting.splits;
    if (s.batting?.byCount) d.byCount = s.batting.byCount;
    if (s.pitching?.byCount) d.pByCount = s.pitching.byCount;
    if (Object.keys(d).length) detail[i] = d;
  });
  return { v: 1, paths: PATHS, rows, detail };
}

/** エンコード済みブロブ → playerSeason[]（未エンコードの配列がそのまま来たら素通し＝旧セーブ互換）。 */
export function decodeSeasons(blob) {
  if (!blob) return [];
  if (Array.isArray(blob)) return blob; // 生配列（旧形式/テスト）
  const { paths, rows, detail = {} } = blob;
  return rows.map((r, i) => {
    const [playerId, season, teamId, ...vals] = r;
    const ps = createPlayerSeason(playerId, season);
    ps.teamId = teamId;
    for (let k = 0; k < paths.length; k++) setPath(ps, paths[k], vals[k] ?? 0);
    const d = detail[i];
    if (d) {
      if (d.splits) ps.batting.splits = d.splits;
      if (d.byCount) ps.batting.byCount = d.byCount;
      if (d.pByCount) ps.pitching.byCount = d.pByCount;
    }
    return ps;
  });
}

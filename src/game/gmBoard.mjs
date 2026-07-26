// ============================================================================
// Wave C（thyroxin/specs/gm_analytics_spec.md「GM分析仕様」§Wave C）: GMボード
//
//   positionStrengthMap(state)   … 12球団×守備位置(8)+DH+投手2枠(先発/救援)の観測戦力ヒートマップ素材。
//   prospectWatch(state)         … 他球団の「塞がれている」有望若手（年齢≤25×高観測百分位×出場機会薄）。
//   tradeTargetSuggestions(state)… 自球団の飽和位置×他球団の弱点位置のマッチング上位（トレードの窓）。
//   ownDepthSolutions(state)     … 自軍限定「格上げ候補」（一軍弱点×自軍控え/二軍の高観測百分位）。
//
// ★2026-07-24 監査修正（3seed実測: 飽和★が120セル中87.5〜90%で指標として死んでいた）:
//   a/c/d. 「控え百分位＞レギュラー百分位＋margin」の逆転を saturated（真のサプラス）から分離し
//     misallocated（起用のねじれ）として扱う。satMinPctl も 0.6→0.8 に引上げ。
//   b. 控え候補プールから「同球団の他ポジションでregularの選手」を除外し、1選手は最多出場の
//     1ポジションでのみ控え候補になれるようにする（多重カウント排除）。トレードの窓も
//     同一backup選手由来の提案を最良マッチ1件に統合する。
//   c. 救援の飽和/塞がれ判定は qualifiedIP（先発基準）ではなく役割別分母を使う。
//   d. 自軍限定・年齢上限なしの「格上げ候補」節（ownDepthSolutions）を新設し、トレードより先に
//     自軍内の解を提示する。
//
// ★2026-07-25 DH可視化＋球団並び順（前日2026-07-25の全リーグDH制統一に追随。ユーザー指摘の残課題）:
//   e. GB_POSITIONS に 'DH' を追加（守備位置8+DH+投手2枠=11枠）。DHのレギュラーは
//     positionOuts.DH（sim/game.mjs がDHスロットの選手へ実際に加算する動的キー・sim/fielding.mjs
//     mainPositionが同型に拾う）が最多の選手。評価はwOBA百分位のみ（他の野手位置と同じ物差し・
//     gbValueOfは既定でwOBAを返すため分岐追加不要）。GB_FIELD_POSITIONS = FIELD_POSITIONS+DH を
//     「野手ポジション」として扱う箇所（候補収集・他ポジregular除外・自軍regular集合）に用いる。
//   f. ownDepthSolutions の隣接ポジマッチ（gbAdjacentPositions）はDHを対象外のまま維持
//     （spectrumDistanceでC/DHは隔絶＝positions.mjsの仕様通り）。ただし弱点位置がDHのときは
//     「守備適性を問わない」という現実の性質を反映し、隣接縛りを外して自軍の非regular野手/二軍野手
//     ならwOBA百分位が高ければ誰でも候補にする特例（gbOwnDepthDhCandidates）を入れる。
//   g. 球団の表示順（ヒート表）を「自チーム先頭→自リーグ勝率順→他リーグ勝率順」に変更
//     （gbTeamDisplayOrder）。観測 rt.standings のみ参照（真値不参照・三層構造準拠）。
//
// 設計原則（CLAUDE.md鉄則・gm_analytics_spec.md §0・タスク仕様の厳守事項）:
//   - 観測のみ: rt.stats（当季一軍・正確値）と rt.farm.stats（当季二軍観測）だけを使う。
//     真値(trueAbility)・能力値レーティング・p.trueAbility.fielding.positionProf 等は一切参照しない
//     （三層構造・観測成績のみ）。守備位置の判定は「当季観測の守備アウト数 positionOuts 最多」
//     （sim/fielding.mjs mainPosition と同型の考え方）で行う。表示用のフォールバック位置ラベルのみ
//     p.primaryPos（生成時に割り当てられる編成上の型・ability非依存の静的フィールド）を使う。
//   - 表示層のみ・純関数・保存フィールド追加なし: 毎回その場で導出する（§17準拠）。
//   - 決定論: 乱数はテンプレ文言選択のみ hashSeed(masterSeed,'gmBoard',...) の独立座標。
//     百分位・ソートは値の同点時 playerId/teamId 昇順のタイブレークで完全決定論。
//   - 表示閾値は cfg.tuning.storylines.gmBoard 配下（マジックナンバーを散らさない・鉄則2）。
//   - トップレベル宣言名は全モジュール横断で一意（analystColumn.mjs の ac / form.mjs の fm と同じ
//     流儀で gb 接頭辞に統一）。
// ============================================================================
import { FIELD_POSITIONS } from '../model/positions.mjs';
import { deriveLeagueConstants } from '../sim/leagueConstants.mjs';
import { playerBatting, playerPitching } from '../sim/metrics.mjs';
import { mainPosition } from '../sim/fielding.mjs';
import { qualifiedPA, qualifiedIP } from '../config.mjs';
import { makeRng, hashSeed } from '../rng.mjs';

const gbIdAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 「野手ポジション」= 守備8位置+DH（監査e）。DHは守備アウトを持たないが、DHスロット出場は
 *  positionOuts.DH として実際に記録される（sim/game.mjs）ため、他の野手位置と同型に扱える。 */
const GB_FIELD_POSITIONS = [...FIELD_POSITIONS, 'DH'];
/** 投手/救援の2枠を含めた「位置」一覧（表示順）。SP/RP は個々の投手ではなくチーム集計値。 */
export const GB_POSITIONS = [...GB_FIELD_POSITIONS, 'SP', 'RP'];
const GB_POS_LABEL = { SP: '先発', RP: '救援' };
/** 位置コード→表示ラベル（野手位置はコードそのまま＝既存UI(posJP)と同じ流儀・パススルー）。 */
export function gbPosLabel(pos) {
  return GB_POS_LABEL[pos] ?? pos;
}

const gbPct = (v) => `${Math.round(v * 100)}%`;

/** 昇順配列 sortedAsc 内での v の百分位（0..1）。dir<0 なら低いほど良い指標として反転する
 *  （ui.mjs の statHeatBand と同じ二分探索・同じ「順位/(n-1)」定義・母集団が1件なら null）。 */
function gbPercentile(sortedAsc, v, dir = 1) {
  if (!sortedAsc || sortedAsc.length < 2 || v == null || !Number.isFinite(v)) return null;
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sortedAsc[m] < v) lo = m + 1;
    else hi = m;
  }
  let p = lo / (sortedAsc.length - 1);
  if (dir < 0) p = 1 - p;
  return Math.max(0, Math.min(1, p)); // v が母集団の範囲外（新規の控え等）でも 0..1 に収める
}

/** シーズン消化率（0-1）。標準チーム試合数の平均から算出（序盤ノイズの除外ゲート用）。 */
function gbSeasonProgress(standRows, cfg) {
  if (!standRows.length) return 0;
  const avgG = standRows.reduce((a, r) => a + (r.g || 0), 0) / standRows.length;
  return cfg.league.gamesPerSeason ? avgG / cfg.league.gamesPerSeason : 0;
}

/** 投手個人が「先発型」か（team.mjs の prole 列と同じ判定式 = gs*2>=g）。 */
function gbIsStarterLine(line) {
  return line.g > 0 && line.gs * 2 >= line.g;
}
/** 投手個人が「救援型」か（gbIsStarterLine の補集合・g=0はどちらでもない）。 */
function gbIsRelieverLine(line) {
  return line.g > 0 && line.gs * 2 < line.g;
}

// ============================================================================
// 共通コンテキスト（rt.stats/rt.standings から一軍のリーグ定数・シーズン統計マップを作る）。
// ============================================================================

function gbBuildCtx(state) {
  const rt = state.rt;
  if (!rt || !rt.stats || !rt.standings) return null;
  const seasons = [...rt.stats.stats.values()];
  const standRows = [...rt.standings.values()];
  if (!seasons.length || !standRows.length) return null;
  const lc = deriveLeagueConstants({ playerSeasons: seasons, standings: standRows });
  const statsById = new Map(seasons.map((s) => [s.playerId, s]));
  const standByTeam = new Map(standRows.map((r) => [r.teamId, r]));
  return { lc, statsById, standByTeam, standRows };
}

/** 二軍側の同型コンテキスト（rt.farm が不成立の構成では null）。 */
function gbBuildFarmCtx(state) {
  const f = state.rt && state.rt.farm;
  if (!f || !f.stats || !f.standings) return null;
  const seasons = [...f.stats.stats.values()];
  const standRows = [...f.standings.values()];
  if (!seasons.length || !standRows.length) return null;
  const lc = deriveLeagueConstants({ playerSeasons: seasons, standings: standRows });
  const statsById = new Map(seasons.map((s) => [s.playerId, s]));
  const standByTeam = new Map(standRows.map((r) => [r.teamId, r]));
  return { lc, statsById, standByTeam };
}

// ============================================================================
// 1. positionStrengthMap: 12球団×11枠（守備8+DH+投手2）の観測戦力ヒートマップ素材。
// ============================================================================

/**
 * 各球団各位置の「レギュラー」候補を集める（野手=positionOuts最多順・投手=先発/救援ごとの投球回順）。
 * 野手候補には bestPos（当季観測の全ポジション中で positionOuts 最多の1ポジション＝
 * sim/fielding.mjs mainPosition と同型）を付与する。監査修正b（多重カウント排除）: 控え候補として
 * 数えてよいのは「その選手にとって最多出場の1ポジション」のみに限定するための印。
 * @returns {Map<string, Map<string, Array>>} pos → teamId → [{playerId, s, playTime, bestPos}]（降順・playerId昇順タイブレーク）
 */
function gbCollectCandidates(state, ctx) {
  const byPos = new Map(GB_POSITIONS.map((pos) => [pos, new Map()]));
  const teams = state.league.teams ?? [];
  for (const t of teams) {
    const roster = (state.league.players ?? []).filter((p) => p.teamId === t.id);
    // --- 野手9ポジション（守備8+DH）: 当季観測の守備アウト数/DHスロット出場(positionOuts)最多順 ---
    for (const pos of GB_FIELD_POSITIONS) {
      const cands = [];
      for (const p of roster) {
        if (p.role !== 'fielder') continue;
        const s = ctx.statsById.get(p.id);
        if (!s || !s.fielding || !(s.fielding.positionOuts[pos] > 0)) continue;
        if (!s.batting || !(s.batting.pa > 0)) continue; // wOBA算出不能な出場（PAゼロ）は候補から除く
        cands.push({ playerId: p.id, s, playTime: s.fielding.positionOuts[pos], bestPos: mainPosition(s.fielding) });
      }
      cands.sort((a, b) => b.playTime - a.playTime || gbIdAsc(a.playerId, b.playerId));
      byPos.get(pos).set(t.id, cands);
    }
    // --- 投手2枠: 先発(gs*2>=g)/救援を分け、投球回(outs)最多順に並べる ---
    const starters = [];
    const relievers = [];
    for (const p of roster) {
      if (p.role !== 'pitcher') continue;
      const s = ctx.statsById.get(p.id);
      if (!s || !s.pitching || !(s.pitching.outs > 0)) continue;
      const entry = { playerId: p.id, s, playTime: s.pitching.outs };
      (gbIsStarterLine(s.pitching) ? starters : relievers).push(entry);
    }
    starters.sort((a, b) => b.playTime - a.playTime || gbIdAsc(a.playerId, b.playerId));
    relievers.sort((a, b) => b.playTime - a.playTime || gbIdAsc(a.playerId, b.playerId));
    byPos.get('SP').set(t.id, starters);
    byPos.get('RP').set(t.id, relievers);
  }
  return byPos;
}

/** 個々の候補(s)から当該指標の値を取り出す（野手=wOBA/先発=K-BB%/救援=FIP）。 */
function gbValueOf(pos, s, ctx) {
  if (pos === 'SP') return playerPitching(s, ctx.lc).kbbPct;
  if (pos === 'RP') return playerPitching(s, ctx.lc).fip;
  return playerBatting(s, ctx.lc).woba;
}
/** 高いほど良いか（RP=FIPのみ低いほど良い）。 */
function gbDirOf(pos) {
  return pos === 'RP' ? -1 : 1;
}
/** 監査修正c: 救援の役割別「規定投球回」相当 = チーム試合数×relieverIpGamesFrac。
 *  qualifiedIP（先発基準=試合数×1）を救援に使うとフル稼働でも規定の35%程度にしかならず
 *  「塞がれている」と誤判定されるため、救援だけ分母を分離する。 */
function gbQualifiedReliefIP(games, gb) {
  return games * gb.relieverIpGamesFrac;
}
/** 飽和判定の「規定」に対する控えの出場量割合（野手=PA/規定打席・投手=IP/規定投球回。
 *  救援は規定投球回の分母を役割別(gbQualifiedReliefIP)に分岐する＝監査修正c）。 */
function gbPlayTimeFrac(pos, entry, teamGames, gb) {
  if (pos === 'SP' || pos === 'RP') {
    const ip = entry.s.pitching.outs / 3;
    const q = pos === 'RP' ? gbQualifiedReliefIP(teamGames, gb) : qualifiedIP(teamGames);
    return q > 0 ? ip / q : 0;
  }
  const pa = entry.s.batting.pa;
  const q = qualifiedPA(teamGames);
  return q > 0 ? pa / q : 0;
}

/** 各位置のレギュラー値/レギュラーID/母集団(百分位化用ソート済み配列)を1回構築する
 *  （positionStrengthMap と ownDepthSolutions で共有・二重計算を避ける）。 */
function gbBuildPopulations(byPos, teams, ctx) {
  const pops = new Map();
  for (const pos of GB_POSITIONS) {
    const teamCands = byPos.get(pos);
    const regularValue = new Map(); // teamId -> value|null
    const regularId = new Map(); // teamId -> playerId|null（表示用の代表選手。投手は最多起用個人）
    for (const teamId of teams) {
      const cands = teamCands.get(teamId) ?? [];
      if (!cands.length) { regularValue.set(teamId, null); regularId.set(teamId, null); continue; }
      regularId.set(teamId, cands[0].playerId);
      if (pos === 'SP' || pos === 'RP') {
        // 投手2枠は「先発陣/救援陣全体の平均」を球団のポジション値とする（spec: 先発のK-BB%平均/救援のFIP平均）。
        const vals = cands.map((c) => gbValueOf(pos, c.s, ctx)).filter((v) => Number.isFinite(v));
        regularValue.set(teamId, vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null);
      } else {
        regularValue.set(teamId, gbValueOf(pos, cands[0].s, ctx));
      }
    }
    const sortedAsc = [...regularValue.values()].filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
    pops.set(pos, { regularValue, regularId, sortedAsc });
  }
  return pops;
}

/**
 * 12球団×守備位置(8)+DH+投手2枠の観測戦力ヒートマップ素材（Wave C §1・DHは監査e）。
 * 「レギュラー」＝当季観測の守備アウト数(野手)/投球回(投手・先発と救援を分ける)最多の選手。
 * その観測値（wOBA/K-BB%/FIP）をリーグ内(12球団)で百分位化し、弱点(下位20%)・飽和/起用のねじれ
 * フラグを立てる（監査修正a/b/c）:
 *   - saturated（真のサプラス）＝規定30%以上×百分位80%以上の控えが同位置に居て、かつ控え百分位が
 *     レギュラー百分位+satMisallocMargin以内（＝レギュラーが上・控えも良いという素直な余剰）。
 *   - misallocated（起用のねじれ）＝控え百分位がレギュラー百分位+marginを超える逆転。真の余剰ではなく
 *     「スタメン変更で強化できる可能性」を示す別シグナル。トレード材料にはしない。
 *   控え候補は「同球団の他ポジションでregularになっている選手」を除外し、1選手は最多出場の
 *   1ポジションでのみ候補化する（監査修正b・多重カウント排除）。
 * @param {Object} state GameState
 * @returns {{positions:string[], cells:Array}} cells: 1件=(teamId,pos)。value/pctlはデータ無ければnull。
 */
export function positionStrengthMap(state) {
  const ctx = gbBuildCtx(state);
  if (!ctx) return { positions: GB_POSITIONS, cells: [] };
  const cfg = state.cfg;
  const gb = cfg.tuning.storylines.gmBoard;
  const progress = gbSeasonProgress(ctx.standRows, cfg);
  const progressOk = progress >= gb.minSeasonProgress;
  const byPos = gbCollectCandidates(state, ctx);
  const teams = (state.league.teams ?? []).map((t) => t.id).sort(gbIdAsc);
  const pops = gbBuildPopulations(byPos, teams, ctx);

  // 監査修正b: 「同球団の他ポジションでregularになっている選手」は控え候補プールから除外する。
  //   野手9ポジション（守備8+DH・監査e）のregularId和集合を球団ごとに先に確定する（全ポジション
  //   処理後でないと確定しないため、セルのメインループより先に1パス回す）。
  const regularIdSetByTeam = new Map(teams.map((teamId) => [teamId, new Set()]));
  for (const pos of GB_FIELD_POSITIONS) {
    const { regularId } = pops.get(pos);
    for (const teamId of teams) {
      const rid = regularId.get(teamId);
      if (rid) regularIdSetByTeam.get(teamId).add(rid);
    }
  }

  const cells = [];
  for (const pos of GB_POSITIONS) {
    const dir = gbDirOf(pos);
    const teamCands = byPos.get(pos);
    const { regularValue, regularId, sortedAsc } = pops.get(pos);
    const popOk = sortedAsc.length >= gb.minPositionPopulation;
    const isPitcherPos = pos === 'SP' || pos === 'RP';

    for (const teamId of teams) {
      const value = regularValue.get(teamId);
      const pctl = popOk ? gbPercentile(sortedAsc, value, dir) : null;
      const weak = !!(progressOk && pctl != null && pctl <= gb.weakPctlMax);
      const teamGames = ctx.standByTeam.get(teamId)?.g ?? 0;
      let saturated = false;
      let backupId = null;
      let backupPctl = null;
      let misallocated = false;
      let misallocBackupId = null;
      let misallocBackupPctl = null;
      if (progressOk && popOk) {
        const cands = teamCands.get(teamId) ?? [];
        const playTimeThresh = isPitcherPos ? gb.satMinIpFrac : gb.satMinPaFrac;
        const regSet = regularIdSetByTeam.get(teamId);
        for (const entry of cands.slice(1)) { // 先頭=レギュラー自身は除く
          if (!isPitcherPos) {
            if (regSet.has(entry.playerId)) continue; // 他ポジのregular=控え候補から除外（監査b）
            if (entry.bestPos && entry.bestPos !== pos) continue; // 最多出場ポジ以外は控え候補にしない（監査b）
          }
          const frac = gbPlayTimeFrac(pos, entry, teamGames, gb);
          if (frac < playTimeThresh) continue;
          const bv = gbValueOf(pos, entry.s, ctx);
          const bp = gbPercentile(sortedAsc, bv, dir);
          if (bp == null || bp < gb.satMinPctl) continue;
          // 監査a/c/d: 控え百分位がレギュラー百分位+marginを超える＝逆転（起用のねじれ）。
          //   真のサプラス(saturated)ではなく misallocated として分離する。トレード材料にはしない。
          if (pctl != null && bp > pctl + gb.satMisallocMargin) {
            if (!misallocated) { misallocated = true; misallocBackupId = entry.playerId; misallocBackupPctl = bp; }
            continue; // このポジション内に他の真サプラス候補がいないか探索継続
          }
          saturated = true;
          backupId = entry.playerId;
          backupPctl = bp;
          break; // 出場量最多の控えから探索し最初の該当者を採用（決定論）
        }
      }
      cells.push({
        teamId, pos, value, pctl, regularId: regularId.get(teamId), weak,
        saturated, backupId, backupPctl,
        misallocated, misallocBackupId, misallocBackupPctl,
      });
    }
  }
  return { positions: GB_POSITIONS, cells };
}

// ============================================================================
// 2. prospectWatch: 他球団の「塞がれている」有望若手。
//
// 根拠（セイバー定説準拠・将来の断定はしない）: 年齢が若く観測百分位が高いのに出場機会が薄い選手は、
//   実力に見合った出場機会を得られていない「塞がれた」状態にあるという、実際のGM/アナリストが
//   トレード材料を探す際の定番の着眼点（役割を得れば化ける可能性がある、という傾向の指摘に留め、
//   「必ず活躍する」という断定はしない）。
// 監査修正c: 救援投手は qualifiedIP（先発基準）ではなく役割別分母(gbQualifiedReliefIP)で判定し、
//   登板数(g)が relieverEstablishedG 以上の救援は「既に役割を得ている」として対象外にする。
// ============================================================================

const GB_PROSPECT_TPL = {
  fielderMajorThin: [
    (n, pa, pct, pctl) => `一軍出場は${pa}打席（規定の${pct}）に留まるが、その中でのwOBA百分位は${pctl}——出場機会さえ得れば化ける可能性がある塞がれた有望株`,
    (n, pa, pct, pctl) => `${n}、一軍で規定の${pct}しか打席が回っていないが、限られた出場でのwOBA百分位は${pctl}。控えに埋もれた逸材か`,
  ],
  fielderFarm: [
    (n, pctl) => `二軍でwOBA百分位${pctl}・出場機会は一軍になし——塞がれた有望株`,
    (n, pctl) => `${n}、二軍でのwOBA百分位は${pctl}と高いが一軍出場の機会が無い。編成の壁に塞がれている`,
  ],
  pitcherMajorThinStarter: [
    (n, ip, pct, pctl) => `一軍登板は${ip}回（規定の${pct}）に留まるが、その中でのK-BB%百分位は${pctl}——役割さえ得れば化ける可能性がある塞がれた有望株`,
    (n, ip, pct, pctl) => `${n}、一軍で規定の${pct}しか投げていないが、限られた登板でのK-BB%百分位は${pctl}。先を見据えれば狙い目`,
  ],
  // 監査修正c: 救援は「規定のX%」（先発基準の分母）を使わず、登板数/チーム試合数の自然な表現にする。
  pitcherMajorThinReliever: [
    (n, g, teamG, pctl) => `一軍登板は${g}試合（チーム${teamG}試合中）に留まるが、その中でのK-BB%百分位は${pctl}——出番さえ増えれば化ける可能性がある塞がれた有望株`,
    (n, g, teamG, pctl) => `${n}、一軍登板${g}試合とまだ少ないが、限られた登板でのK-BB%百分位は${pctl}。先を見据えれば狙い目`,
  ],
  pitcherFarm: [
    (n, pctl) => `二軍でK-BB%百分位${pctl}・出場機会は一軍になし——塞がれた有望株`,
    (n, pctl) => `${n}、二軍でのK-BB%百分位は${pctl}と高いが一軍登板の機会が無い。編成の壁に塞がれている`,
  ],
};

/** リーグ全体の百分位母集団（wOBA=野手/K-BB%=投手）を1回だけ構築する（サンプル最低ゲート込み）。 */
function gbProspectPopulation(seasons, lc, gb, isPitcher) {
  const out = [];
  for (const s of seasons) {
    if (isPitcher) {
      if (!s.pitching || !(s.pitching.outs / 3 >= gb.prospectMinIP)) continue;
      const v = playerPitching(s, lc).kbbPct;
      if (Number.isFinite(v)) out.push(v);
    } else {
      if (!s.batting || !(s.batting.pa >= gb.prospectMinPA)) continue;
      const v = playerBatting(s, lc).woba;
      if (Number.isFinite(v)) out.push(v);
    }
  }
  return out.sort((a, b) => a - b);
}

/** 選手の観測位置ラベル（表示用）。観測(positionOuts/gs)から決め、無ければ p.primaryPos（編成上の
 *  静的な型・trueAbility非参照）へフォールバックする。 */
function gbObservedPos(p, s) {
  if (p.role === 'pitcher') {
    if (s && s.pitching && s.pitching.outs > 0) return gbIsStarterLine(s.pitching) ? 'SP' : 'RP';
    return 'P';
  }
  if (s && s.fielding) {
    const mp = mainPosition(s.fielding);
    if (mp) return mp;
  }
  return p.primaryPos ?? '';
}

/**
 * 他球団の有望若手（Wave C §2）: 年齢≤gb.prospectMaxAge × 観測百分位が高い（プール内百分位
 * ≥gb.prospectMinPctl・一軍または二軍）× 出場機会が細い（一軍PA/IPが規定のprospectThinPaFrac/
 * IpFrac未満、または二軍在籍）＝「塞がれている」。狙い目順（百分位の高い順）にソートする。
 * 上限件数(gb.prospectMaxItems)超過時は戻り配列に truncated=true を付与する（監査修正・小修正5）。
 * @param {Object} state GameState
 * @returns {Array<{playerId,teamId,age,role,pos,source,pctl,text}>}
 */
export function prospectWatch(state) {
  const ctx = gbBuildCtx(state);
  if (!ctx) return [];
  const cfg = state.cfg;
  const gb = cfg.tuning.storylines.gmBoard;
  const my = state.playerTeamId;
  const farmCtx = gbBuildFarmCtx(state);

  const majorFielderPop = gbProspectPopulation([...ctx.statsById.values()], ctx.lc, gb, false);
  const majorPitcherPop = gbProspectPopulation([...ctx.statsById.values()], ctx.lc, gb, true);
  const farmFielderPop = farmCtx ? gbProspectPopulation([...farmCtx.statsById.values()], farmCtx.lc, gb, false) : [];
  const farmPitcherPop = farmCtx ? gbProspectPopulation([...farmCtx.statsById.values()], farmCtx.lc, gb, true) : [];

  const roster = [...(state.league.players ?? []), ...(state.league.farm ?? [])];
  const out = [];
  for (const p of roster) {
    if (!p.teamId || p.teamId === my) continue;
    if (!(p.age <= gb.prospectMaxAge)) continue;
    const isPitcher = p.role === 'pitcher';
    const teamGames = ctx.standByTeam.get(p.teamId)?.g ?? 0;

    let best = null; // {source, pctl, s, extra}
    const majorS = ctx.statsById.get(p.id);
    if (majorS) {
      if (!isPitcher && majorS.batting && majorS.batting.pa >= gb.prospectMinPA) {
        const q = qualifiedPA(teamGames);
        const frac = q > 0 ? majorS.batting.pa / q : 0;
        if (frac < gb.prospectThinPaFrac) {
          const pctl = gbPercentile(majorFielderPop, playerBatting(majorS, ctx.lc).woba, 1);
          if (pctl != null && pctl >= gb.prospectMinPctl && (!best || pctl > best.pctl)) best = { source: 'majorThin', pctl, s: majorS, pa: majorS.batting.pa, frac };
        }
      } else if (isPitcher && majorS.pitching && majorS.pitching.outs / 3 >= gb.prospectMinIP) {
        const isReliever = gbIsRelieverLine(majorS.pitching);
        const alreadyEstablished = isReliever && majorS.pitching.g >= gb.relieverEstablishedG;
        if (!alreadyEstablished) {
          const q = isReliever ? gbQualifiedReliefIP(teamGames, gb) : qualifiedIP(teamGames);
          const ip = majorS.pitching.outs / 3;
          const frac = q > 0 ? ip / q : 0;
          if (frac < gb.prospectThinIpFrac) {
            const pctl = gbPercentile(majorPitcherPop, playerPitching(majorS, ctx.lc).kbbPct, 1);
            if (pctl != null && pctl >= gb.prospectMinPctl && (!best || pctl > best.pctl)) {
              best = { source: 'majorThin', pctl, s: majorS, ip, frac, isReliever, g: majorS.pitching.g, teamGames };
            }
          }
        }
      }
    }
    if (farmCtx) {
      const farmS = farmCtx.statsById.get(p.id);
      if (farmS) {
        if (!isPitcher && farmS.batting && farmS.batting.pa >= gb.prospectMinPA) {
          const pctl = gbPercentile(farmFielderPop, playerBatting(farmS, farmCtx.lc).woba, 1);
          if (pctl != null && pctl >= gb.prospectMinPctl && (!best || pctl > best.pctl)) best = { source: 'farm', pctl, s: farmS };
        } else if (isPitcher && farmS.pitching && farmS.pitching.outs / 3 >= gb.prospectMinIP) {
          const pctl = gbPercentile(farmPitcherPop, playerPitching(farmS, farmCtx.lc).kbbPct, 1);
          if (pctl != null && pctl >= gb.prospectMinPctl && (!best || pctl > best.pctl)) best = { source: 'farm', pctl, s: farmS };
        }
      }
    }
    if (!best) continue;
    const pos = gbObservedPos(p, best.s);
    const tplKey = !isPitcher
      ? (best.source === 'farm' ? 'fielderFarm' : 'fielderMajorThin')
      : (best.source === 'farm' ? 'pitcherFarm' : (best.isReliever ? 'pitcherMajorThinReliever' : 'pitcherMajorThinStarter'));
    const tplList = GB_PROSPECT_TPL[tplKey];
    const r = makeRng(hashSeed(state.masterSeed, 'gmBoard', 'tpl', 'prospect', tplKey, p.id));
    const tpl = tplList[r.int(tplList.length)];
    const pctlTxt = gbPct(best.pctl);
    const text = best.source === 'farm'
      ? tpl(p.name, pctlTxt)
      : isPitcher
        ? (best.isReliever
            ? tpl(p.name, best.g, best.teamGames, pctlTxt)
            : tpl(p.name, best.ip.toFixed(1), gbPct(best.frac), pctlTxt))
        : tpl(p.name, best.pa, gbPct(best.frac), pctlTxt);
    out.push({ playerId: p.id, teamId: p.teamId, age: p.age, role: p.role, pos, source: best.source, pctl: best.pctl, text });
  }
  out.sort((a, b) => b.pctl - a.pctl || a.age - b.age || gbIdAsc(a.playerId, b.playerId));
  const result = out.slice(0, gb.prospectMaxItems);
  result.truncated = out.length > gb.prospectMaxItems; // 小修正5: 上限到達時にUIへ「他にも該当あり」を出す印
  return result;
}

// ============================================================================
// 3. tradeTargetSuggestions: 自球団の飽和位置×他球団の弱点位置のマッチング上位。
// ============================================================================

const GB_TRADE_TPL = [
  (myLabel, myPctl, oppName, oppLabel, oppPctl) => `あなたの${myLabel}は飽和（控えの百分位${myPctl}）。${oppName}の${oppLabel}は弱点（百分位${oppPctl}）——トレードの窓がある`,
  (myLabel, myPctl, oppName, oppLabel, oppPctl) => `${oppName}は${oppLabel}が手薄（百分位${oppPctl}）。あなたの${myLabel}には控え（百分位${myPctl}）が余っている——打診してみる価値がある`,
];

/**
 * 自球団の飽和位置×他球団の弱点位置のマッチング上位（Wave C §3）。同一ポジション同士のみを
 * 突き合わせる（既存トレードは同型1:1交換・stove.mjs stoveTypeOf と同じ制約）。misallocated
 * （起用のねじれ）は真の余剰ではないため材料に使わない（saturatedのみが対象・監査修正a/c/d）。
 * 監査修正b: 同一backup選手由来の提案は最良マッチ1件に統合する。
 * @param {Object} state GameState
 * @returns {Array<{myPos:string, oppTeamId:string, oppPos:string, myBackupId:?string, oppRegularId:?string, score:number, text:string}>}
 */
export function tradeTargetSuggestions(state) {
  const my = state.playerTeamId;
  if (!my) return [];
  const gb = state.cfg.tuning.storylines.gmBoard;
  const { cells } = positionStrengthMap(state);
  const mine = cells.filter((c) => c.teamId === my && c.saturated);
  const weakByPos = new Map();
  for (const c of cells) {
    if (c.teamId === my || !c.weak) continue;
    if (!weakByPos.has(c.pos)) weakByPos.set(c.pos, []);
    weakByPos.get(c.pos).push(c);
  }
  const matches = [];
  for (const m of mine) {
    const opps = (weakByPos.get(m.pos) ?? []).slice().sort((a, b) => gbIdAsc(a.teamId, b.teamId));
    for (const o of opps) {
      const myPctl = m.backupPctl ?? m.pctl ?? 0;
      const oppPctl = o.pctl ?? 1;
      const score = myPctl + (1 - oppPctl);
      const myLabel = gbPosLabel(m.pos);
      const oppTeam = (state.league.teams ?? []).find((t) => t.id === o.teamId);
      const oppName = oppTeam ? oppTeam.name : o.teamId;
      const r = makeRng(hashSeed(state.masterSeed, 'gmBoard', 'tpl', 'trade', my, o.teamId, m.pos));
      const tpl = GB_TRADE_TPL[r.int(GB_TRADE_TPL.length)];
      const text = tpl(myLabel, gbPct(myPctl), oppName, myLabel, gbPct(oppPctl));
      matches.push({
        myPos: m.pos, oppTeamId: o.teamId, oppPos: m.pos,
        myBackupId: m.backupId, oppRegularId: o.regularId,
        score, text,
      });
    }
  }
  // 監査修正b: 同一backup選手由来の提案は1件に統合（最良スコアのみ・スコア同点はteamId昇順）。
  const bestByBackup = new Map();
  for (const m of matches) {
    const key = m.myBackupId ?? `${m.myPos}|${m.oppTeamId}`; // backupId不在は理論上起きないが保険
    const cur = bestByBackup.get(key);
    if (!cur || m.score > cur.score || (m.score === cur.score && gbIdAsc(m.oppTeamId, cur.oppTeamId) < 0)) {
      bestByBackup.set(key, m);
    }
  }
  const deduped = [...bestByBackup.values()];
  deduped.sort((a, b) => b.score - a.score || gbIdAsc(a.oppTeamId, b.oppTeamId) || GB_POSITIONS.indexOf(a.myPos) - GB_POSITIONS.indexOf(b.myPos));
  return deduped.slice(0, gb.tradeSuggestMax);
}

// ============================================================================
// 4. ownDepthSolutions: 自軍限定「格上げ候補」— 一軍の弱点位置×自軍の控え/二軍の高観測百分位
//   （同位置または隣接位置＝外野LF/CF/RF相互・内野中枢SS/2B/3B相互）。
//
// 根拠（監査修正・GM定説）: トレードを検討する前にまず自軍の在庫（控え・二軍）を確認するのが定石。
//   prospectWatch は他球団限定×年齢≤25だったため「自軍二軍の高観測選手×一軍弱点の完全一致」が
//   自軍除外＋年齢上限の二重壁で不可視だった（監査実例: 自軍二軍2B(29歳)×一軍弱点2B）。この節は
//   自軍限定・年齢上限なしでその穴を埋める。二軍観測は必ず「二軍水準の観測」である留保を文言に
//   含める（三層構造の作法・観測≠真値）。
// ============================================================================

const GB_OF_MUTUAL = new Set(['LF', 'CF', 'RF']);
const GB_MID_INF_MUTUAL = new Set(['SS', '2B', '3B']);
/** posの「隣接候補位置」集合（pos自身を含む）。外野3者相互・内野中枢3者相互のみ隣接とみなす
 *  （コーナー守備との難易度差が大きい1B等は含めない・定説的にコンバートが利く範囲に限定）。 */
function gbAdjacentPositions(pos) {
  if (GB_OF_MUTUAL.has(pos)) return GB_OF_MUTUAL;
  if (GB_MID_INF_MUTUAL.has(pos)) return GB_MID_INF_MUTUAL;
  return new Set([pos]);
}

const GB_OWNDEPTH_TPL = {
  major: [
    (n, curLabel, myLabel, pctl) => `一軍${curLabel}が弱点。控えの${n}（${myLabel}での観測百分位${pctl}）を回せば埋まる可能性——まず自軍を見る格上げ候補`,
    (n, curLabel, myLabel, pctl) => `${n}、${myLabel}での観測百分位は${pctl}。一軍${curLabel}の弱点を内部で埋められる格上げ候補`,
  ],
  farm: [
    (n, curLabel, myLabel, pctl) => `二軍観測では${n}の${myLabel}百分位は${pctl}——一軍${curLabel}の弱点を埋める格上げ候補（二軍水準の観測である点に留意）`,
    (n, curLabel, myLabel, pctl) => `${n}、二軍観測での${myLabel}百分位は${pctl}。一軍${curLabel}が弱点のいま昇格を検討する価値がある（二軍水準の観測点に留意）`,
  ],
};

/**
 * 自軍限定・年齢上限なしの「格上げ候補」（Wave C 監査修正・新設）。一軍の弱点位置（下位20%）に対し、
 * 自軍の控え（一軍・他ポジのregularでない＝多重カウント排除と同じ考え方）または二軍選手を、
 * 同位置または隣接位置（外野相互・内野中枢SS/2B/3B相互）で観測百分位が高い順にマッチングする。
 * 弱点がDHのとき（監査f）は守備適性を問わないため隣接縛りを外し、他ポジのregularでない野手/
 * 二軍野手なら誰でもwOBA百分位のみで候補化する特例を使う。
 * 同一選手が複数の弱点位置に該当する場合は最良マッチのみ残す（決定論）。
 * @param {Object} state GameState
 * @returns {Array<{weakPos:string, playerId:string, age:?number, pos:string, source:'major'|'farm', pctl:number, text:string}>}
 */
export function ownDepthSolutions(state) {
  const my = state.playerTeamId;
  if (!my) return [];
  const ctx = gbBuildCtx(state);
  if (!ctx) return [];
  const cfg = state.cfg;
  const gb = cfg.tuning.storylines.gmBoard;
  const progress = gbSeasonProgress(ctx.standRows, cfg);
  if (progress < gb.minSeasonProgress) return [];
  const byPos = gbCollectCandidates(state, ctx);
  const teams = (state.league.teams ?? []).map((t) => t.id).sort(gbIdAsc);
  const pops = gbBuildPopulations(byPos, teams, ctx);
  const playersById = new Map((state.league.players ?? []).map((p) => [p.id, p]));

  const myRegularSet = new Set();
  for (const pos of GB_FIELD_POSITIONS) {
    const rid = pops.get(pos).regularId.get(my);
    if (rid) myRegularSet.add(rid);
  }

  const weakPositions = GB_FIELD_POSITIONS.filter((pos) => {
    const { regularValue, sortedAsc } = pops.get(pos);
    if (sortedAsc.length < gb.minPositionPopulation) return false;
    const pctl = gbPercentile(sortedAsc, regularValue.get(my), 1);
    return pctl != null && pctl <= gb.weakPctlMax;
  });
  if (!weakPositions.length) return [];

  const farmCtx = gbBuildFarmCtx(state);
  const farmFielderPop = farmCtx ? gbProspectPopulation([...farmCtx.statsById.values()], farmCtx.lc, gb, false) : [];

  const byPlayer = new Map(); // playerId -> 最良マッチ（決定論: weakPositions処理順で同点は先着優先）
  for (const weakPos of weakPositions) {
    const { sortedAsc } = pops.get(weakPos);
    const curLabel = gbPosLabel(weakPos);

    if (weakPos === 'DH') {
      // 監査f: DHは守備適性を問わない特例。gbAdjacentPositions の隣接縛り（spectrumDistanceで
      // C/DHは隔絶＝正典の仕様）を外し、自軍で他ポジ(DH含む)のregularでない野手なら、観測位置を
      // 問わずwOBA百分位のみで候補化する（一軍控え/二軍とも「打てるなら誰でもDHの答えになる」）。
      const bench = (state.league.players ?? []).filter((p) => p.teamId === my && p.role === 'fielder' && !myRegularSet.has(p.id));
      for (const p of bench) {
        const s = ctx.statsById.get(p.id);
        if (!s || !s.batting || !(s.batting.pa >= gb.prospectMinPA)) continue;
        const pctl = gbPercentile(sortedAsc, playerBatting(s, ctx.lc).woba, 1);
        if (pctl == null || pctl < gb.prospectMinPctl) continue;
        const cur = byPlayer.get(p.id);
        if (cur && cur.pctl >= pctl) continue;
        const dispPos = gbObservedPos(p, s);
        const r = makeRng(hashSeed(state.masterSeed, 'gmBoard', 'tpl', 'owndepth', 'major', weakPos, p.id));
        const tpl = GB_OWNDEPTH_TPL.major[r.int(GB_OWNDEPTH_TPL.major.length)];
        const text = tpl(p.name, curLabel, gbPosLabel(dispPos), gbPct(pctl));
        byPlayer.set(p.id, { weakPos, playerId: p.id, age: p.age, pos: dispPos, source: 'major', pctl, text });
      }
      if (farmCtx) {
        const farmBench = (state.league.farm ?? []).filter((p) => p.teamId === my && p.role === 'fielder');
        for (const p of farmBench) {
          const s = farmCtx.statsById.get(p.id);
          if (!s || !s.batting || !(s.batting.pa >= gb.prospectMinPA)) continue;
          const pctl = gbPercentile(farmFielderPop, playerBatting(s, farmCtx.lc).woba, 1);
          if (pctl == null || pctl < gb.prospectMinPctl) continue;
          const cur = byPlayer.get(p.id);
          if (cur && cur.pctl >= pctl) continue;
          const obsPos = gbObservedPos(p, s);
          const r = makeRng(hashSeed(state.masterSeed, 'gmBoard', 'tpl', 'owndepth', 'farm', weakPos, p.id));
          const tpl = GB_OWNDEPTH_TPL.farm[r.int(GB_OWNDEPTH_TPL.farm.length)];
          const text = tpl(p.name, curLabel, gbPosLabel(obsPos), gbPct(pctl));
          byPlayer.set(p.id, { weakPos, playerId: p.id, age: p.age, pos: obsPos, source: 'farm', pctl, text });
        }
      }
      continue;
    }

    const adjSet = gbAdjacentPositions(weakPos);

    // (a) 自軍の一軍控え（他ポジのregularでない・最多出場ポジがadjSet内の位置と一致）
    for (const pos of adjSet) {
      const cands = byPos.get(pos)?.get(my) ?? [];
      for (const entry of cands.slice(1)) { // 先頭=レギュラー自身は除く
        if (myRegularSet.has(entry.playerId)) continue; // 他ポジのregular=候補から除外（多重カウント排除）
        if (entry.bestPos !== pos) continue; // 最多出場ポジのみで候補化
        const pl = playersById.get(entry.playerId);
        if (!pl) continue;
        const v = gbValueOf(weakPos, entry.s, ctx); // 野手位置なら常にwOBA（位置非依存）
        const pctl = gbPercentile(sortedAsc, v, 1);
        if (pctl == null || pctl < gb.prospectMinPctl) continue;
        const cur = byPlayer.get(entry.playerId);
        if (cur && cur.pctl >= pctl) continue;
        const r = makeRng(hashSeed(state.masterSeed, 'gmBoard', 'tpl', 'owndepth', 'major', weakPos, entry.playerId));
        const tpl = GB_OWNDEPTH_TPL.major[r.int(GB_OWNDEPTH_TPL.major.length)];
        const text = tpl(pl.name, curLabel, gbPosLabel(pos), gbPct(pctl));
        byPlayer.set(entry.playerId, { weakPos, playerId: entry.playerId, age: pl.age, pos, source: 'major', pctl, text });
      }
    }

    // (b) 自軍の二軍選手（年齢上限なし・観測位置がadjSet内）
    if (farmCtx) {
      const farmRoster = (state.league.farm ?? []).filter((p) => p.teamId === my && p.role === 'fielder');
      for (const p of farmRoster) {
        const s = farmCtx.statsById.get(p.id);
        if (!s || !s.batting || !(s.batting.pa >= gb.prospectMinPA)) continue;
        const obsPos = gbObservedPos(p, s);
        if (!adjSet.has(obsPos)) continue;
        const pctl = gbPercentile(farmFielderPop, playerBatting(s, farmCtx.lc).woba, 1);
        if (pctl == null || pctl < gb.prospectMinPctl) continue;
        const cur = byPlayer.get(p.id);
        if (cur && cur.pctl >= pctl) continue;
        const r = makeRng(hashSeed(state.masterSeed, 'gmBoard', 'tpl', 'owndepth', 'farm', weakPos, p.id));
        const tpl = GB_OWNDEPTH_TPL.farm[r.int(GB_OWNDEPTH_TPL.farm.length)];
        const text = tpl(p.name, curLabel, gbPosLabel(obsPos), gbPct(pctl));
        byPlayer.set(p.id, { weakPos, playerId: p.id, age: p.age, pos: obsPos, source: 'farm', pctl, text });
      }
    }
  }

  const out = [...byPlayer.values()];
  out.sort((a, b) => b.pctl - a.pctl || GB_POSITIONS.indexOf(a.weakPos) - GB_POSITIONS.indexOf(b.weakPos) || gbIdAsc(a.playerId, b.playerId));
  return out.slice(0, gb.ownDepthMaxItems);
}

// ============================================================================
// 5. gbTeamDisplayOrder: 球団の表示順（監査g・GMボード新設）。
//   ヒート表・比較ビューを「自チーム先頭→自リーグを勝率順→他リーグを勝率順」に並べる。
//   観測 rt.standings（勝敗の実カウント）のみ参照（真値不参照・三層構造準拠）。
//   同率はteamId昇順のタイブレーク（game/owner.mjs ownerLeagueRankOf と同型の定義・決定論）。
// ============================================================================

/** チームの観測勝率（引分は分母から除く・NPB方式）。standings行が無ければ0.5（未着手シーズンの中立値）。 */
function gbWinPct(row) {
  if (!row) return 0.5;
  const d = (row.w ?? 0) + (row.l ?? 0);
  return d ? row.w / d : 0.5;
}

/**
 * 球団の表示順（Wave C 監査g）: 自チーム→自リーグを勝率降順→他リーグを勝率降順
 * （同率はteamId昇順の決定論タイブレーク）。GMボードのヒート表（renderGmPositionTable）で使う。
 * @param {Object} state GameState
 * @returns {string[]} teamId の表示順配列
 */
export function gbTeamDisplayOrder(state) {
  const teamObjs = new Map((state.league.teams ?? []).map((t) => [t.id, t]));
  const teamIds = [...teamObjs.keys()].sort(gbIdAsc);
  const my = state.playerTeamId;
  const myLeague = my ? teamObjs.get(my)?.league ?? null : null;
  const standByTeam = (state.rt && state.rt.standings) || new Map();
  const wp = (id) => gbWinPct(standByTeam.get(id));
  return teamIds.slice().sort((a, b) => {
    if (a === my) return -1;
    if (b === my) return 1;
    const aMine = myLeague != null && teamObjs.get(a)?.league === myLeague;
    const bMine = myLeague != null && teamObjs.get(b)?.league === myLeague;
    if (aMine !== bMine) return aMine ? -1 : 1;
    const wa = wp(a);
    const wb = wp(b);
    if (wa !== wb) return wb - wa;
    return gbIdAsc(a, b);
  });
}

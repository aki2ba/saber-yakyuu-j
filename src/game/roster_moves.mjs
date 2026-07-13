// ============================================================================
// F2-3: シーズン中の出場登録入替（昇格・降格）— phaseF_spec F2-3 / §S3-2 / §12.1
//
//   applyRosterMovesForDay(rt, day)
//     … 日次進行の冒頭（その日の試合前）に呼ばれ、各球団AIが出場登録29人を入れ替える:
//       (1) IL復帰:   故障離脱で入替登録されていた選手が復帰 → 補充選手（不在なら同型最下位）と再入替
//       (2) IL補充:   一軍登録者が離脱中 → 二軍から同型最良（球団AI評価=観測＋スカウト）を登録へ昇格
//       (3) 成績入替: 既存の25試合レビューと同周期で、一軍で不振の登録者と「二軍観測成績」が
//                     良い控えを入替（クールダウン日数ノブ＝NPB10日ルールの簡略化）
//
// 設計原則（req_1/req_2・厳守）:
//   - 三層構造: 判定は 観測statline（一軍 rt.stats / 二軍 rt.farm.stats）＋スカウト評価
//     （scoutSeed・球団評価プロファイル由来の決定論ノイズ）のみ。trueAbility の直接参照は
//     編成の初期値の再構築（buildDepthChart/createUsageState）だけに閉じる（既存の原則と同輪）。
//   - 決定論: 乱数の共有ストリームを一切消費しない（評価は hashSeed 派生の独立RNG or 乱数非使用。
//     同点は id 昇順で解決）。load の replay は同一観測から同一の入替を再現する（verifyStandings が門番）。
//   - 1年目シム不変（鉄則7）: startYear が yearIndex>=1 でのみ enableMoves を立てる。
//     1年目のゲームランナーは simulateSeason（一括）と bit 同一のまま（較正53指標に非干渉）。
//   - 構成恒常: 入替は 野手=同 primaryPos／投手=同 role の1:1＝登録・二軍双方のポジション構成が
//     シーズンを通じて不変（両軍デプスチャート成立の保証）。育成(rosterStatus='minor')はシーズン中
//     は登録しない（支配下70枠の管理。育成→支配下はオフの C3a 強化判定＝market.runMarket のみ）。
//   - ニュース: 入替は rt.rosterMoves に記録され step.rosterMoves でも返る（週次ダイジェスト/
//     ハブの素材。§17: 集計値・当該シーズンのみ＝save 非対象、replay で再構築）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { buildDepthChart, starterScore } from '../sim/team.mjs';
import { createUsageState, blendedWoba, isInjured } from '../sim/usage.mjs';
import { observedWoba } from '../sim/manager.mjs';
import { deriveLeagueConstants } from '../sim/leagueConstants.mjs';
import { uzrRuns, totalFieldInnings } from '../sim/fielding.mjs';
import { playerBaserunning } from '../sim/metrics.mjs';
import { teamEvalProfile, evaluateProspect, overallRating, farmPerfBonus } from './market.mjs';
import { releaseScore } from './transactions.mjs';

/** id 昇順の安定比較（決定論・順序非依存の走査に使う）。 */
function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ============================================================================
// ★R4: 守備・走塁の「観測」を球団AIの査定に入れる（ユーザー指摘）。
//
// 旧実装の欠陥: 二軍選手の査定（callupScore / farmPerfBonus）も、一軍選手の降格判定も、
//   **打撃（wOBA）と防御率（RA9）しか見ていなかった**。二軍の守備・走塁は集計器が
//   ちゃんと積んでいる（UZR成分・UBR/wSB/wGDP の生カウント）のに、査定でも表示でも捨てていた。
//   結果「守備の上手い二軍野手は永遠に上がってこない」「守備で稼ぐ一軍野手が打撃だけで
//   二軍に落とされる」という、現実にあり得ない編成AIになっていた。
// 三層構造: 見るのは**観測成績**（rt.stats / rt.farm.stats）だけ＝真値は覗かない。
// ============================================================================

/** 当季の観測から一軍/二軍のリーグ定数を導出する（レビュー時に作り直す・水準が違うので別々に）。 */
function refreshLeagueConstants(rt) {
  const top = [...rt.stats.stats.values()];
  rt.moves.lc = top.length
    ? deriveLeagueConstants({ playerSeasons: top, standings: [...rt.standings.values()] })
    : null;
  const farm = rt.farm ? [...rt.farm.stats.stats.values()] : [];
  rt.moves.farmLc = farm.length
    ? deriveLeagueConstants({ playerSeasons: farm, standings: [...rt.farm.standings.values()] })
    : null;
}

/**
 * 観測された守備＋走塁の価値（得点）。標本が薄いうちは信頼度で縮める（UZRは少イニングで暴れる）。
 * @returns {number} runs above average（守備UZR＋走塁BsR）
 */
function obsDefRunRuns(ps, cfg, lc) {
  if (!ps || !lc) return 0;
  const inn = totalFieldInnings(ps.fielding);
  const uzr = inn > 0 ? uzrRuns(ps, cfg, lc) : 0;
  const bsr = playerBaserunning(ps, cfg, lc).bsr || 0;
  const mv = cfg.tuning.moves;
  const trust = inn / (inn + mv.defTrustInnings); // 少イニングの守備評価は信じない
  return uzr * trust + bsr;
}

/** 得点 → wOBA 相当（打撃評価と足せる単位へ）。PA が少ないと発散するので下限を噛ませる。 */
function runsToWoba(runs, pa, lc, cfg) {
  if (!lc || !lc.wobaScale) return 0;
  const denom = Math.max(pa, cfg.tuning.moves.defWobaMinPA);
  return (runs / denom) * lc.wobaScale;
}

/** 一軍野手の「打撃＋守備＋走塁」の観測混合評価（降格判定の物差し）。 */
function fielderValue(rt, pid, cfg) {
  const u = rt.usageByTeam.get(rt.moves.byId.get(pid).teamId);
  const bat = blendedWoba(u, pid, rt.stats.getBat, cfg);
  const ps = rt.stats.stats.get(pid);
  if (!ps) return bat;
  return bat + runsToWoba(obsDefRunRuns(ps, cfg, rt.moves.lc), ps.batting.pa, rt.moves.lc, cfg);
}

/** 観測RA9（未出場/アウト0は null＝判定対象外）。 */
function obsRA9(line) {
  if (!line || !(line.outs > 0)) return null;
  return (line.r * 27) / line.outs;
}

/** 出場登録中の支配下ロスター（league.players ∩ registered）。 */
function activeRosterOf(rt, teamId) {
  const reg = rt.registeredByTeam.get(teamId);
  return rt.league.players.filter((p) => p.teamId === teamId && reg.has(p.id));
}

/** 球団評価プロファイル（キャリア中固定・§13）。moves 用に遅延キャッシュ。 */
function profileOf(rt, teamId) {
  let pr = rt.moves.profiles.get(teamId);
  if (!pr) {
    pr = teamEvalProfile(rt.masterSeed, teamId, rt.cfg);
    rt.moves.profiles.set(teamId, pr);
  }
  return pr;
}

/** クールダウン中か（10日ルール簡略・swapCooldownDays）。 */
function inCooldown(rt, pid, day) {
  return (rt.moves.cooldownUntil.get(pid) ?? -1) > day;
}

/**
 * IL補充の球団AI評価（観測＋スカウト）: evaluateProspect（観測ツール=真値＋球団固有ノイズ・
 * 球団の癖の重み）を土台に、二軍の観測statline（wOBA/RA9）を信頼度加重で加点する。
 * 三層構造: 真値の直接参照はない（evaluateProspect がスカウト観測を模す既存の球団AI評価）。
 */
function callupScore(rt, teamId, p, cfg) {
  const mv = cfg.tuning.moves;
  const ctx = { masterSeed: rt.moves.scoutSeed, yearIndex: rt.season, teamId };
  let score = evaluateProspect(profileOf(rt, teamId), p, cfg, ctx);
  if (p.role === 'fielder') {
    const b = rt.farm.stats.getBat(p.id);
    if (b.pa > 0) {
      const trust = b.pa / (b.pa + mv.callupTrustPA);
      score += mv.callupWobaW * (observedWoba(b, cfg) - cfg.tuning.mgr.wobaPrior) * trust;
    }
    // ★R4: 二軍の守備・走塁の観測も査定に入れる（旧実装は打撃だけを見ていた＝守備の上手い
    //   二軍野手が永遠に上がってこなかった）。UZR＋BsR の得点をそのまま評価点へ換算する。
    score += mv.callupDefW * obsDefRunRuns(rt.farm.stats.stats.get(p.id), cfg, rt.moves.farmLc);
  } else {
    const ra9 = obsRA9(rt.farm.stats.getPitch(p.id));
    if (ra9 != null) {
      const pi = rt.farm.stats.getPitch(p.id);
      const trust = pi.outs / (pi.outs + mv.callupTrustOuts);
      score += mv.callupRa9W * (mv.callupRa9Ref - ra9) * trust;
    }
  }
  return score;
}

/**
 * チャート＋起用状態を新ロスターで再構築し、動的フィールド（疲労/出場履歴/IL/担当）を引き継ぐ。
 * createUsageState は選手ごとの scoutSeed 派生RNGのみ使用＝共有ストリーム非消費（決定論）。
 * 残留選手の scoutEval/defEval/rangeEval は再構築でも同値（scoutSeed 基準）＝評価の連続性が保たれる。
 * @returns {{dh:Object, noDh:Object}} 新チャート
 */
function rebuildSlice({ team, roster, cfg, chartsByTeam, usageByTeam }) {
  const charts = {
    dh: buildDepthChart(roster, cfg, { dh: true }),
    noDh: buildDepthChart(roster, cfg, { dh: false }),
  };
  chartsByTeam.set(team.id, charts);
  const old = usageByTeam.get(team.id);
  const nu = createUsageState(team, charts, cfg, old ? old.priorPitch : null);
  if (old) {
    nu.games = old.games;
    nu.lastSnap = old.lastSnap;
    nu.consecStarts = old.consecStarts;
    nu.startsByPid = old.startsByPid;
    nu.startsAtPos = old.startsAtPos;
    nu.lastStartDay = old.lastStartDay;
    nu.startDaysByPid = old.startDaysByPid;
    nu.pitchedByDay = old.pitchedByDay;
    nu.injuredUntil = old.injuredUntil;
    nu.rotIdx = charts.dh.rotation.length ? old.rotIdx % charts.dh.rotation.length : 0;
    // 担当（regular/challenger/share）の引き継ぎ: 旧担当が新ロスターに残っていればそのまま
    // （見直しの漸進性を保つ）。抹消された担当は新チャートの既定（編成時評価）へ戻る。
    for (const pos of Object.keys(nu.assign)) {
      const oa = old.assign[pos];
      if (!oa || oa.regular == null || !charts.dh.byId.has(oa.regular)) continue;
      const keepCh = oa.challenger != null && charts.dh.byId.has(oa.challenger);
      nu.assign[pos] = { regular: oa.regular, challenger: keepCh ? oa.challenger : null, share: keepCh ? oa.share : 0 };
    }
  }
  usageByTeam.set(team.id, nu);
  return charts;
}

/**
 * 出場登録の1:1入替を実行する（up=二軍→登録・down=登録→二軍）。一軍/二軍双方の
 * チャート・起用状態を再構築し、双方の選手にクールダウンを課す。
 */
function swapRegistration(rt, teamId, up, down, day) {
  const cfg = rt.cfg;
  const reg = rt.registeredByTeam.get(teamId);
  reg.delete(down.id);
  reg.add(up.id);
  // 一軍側の再編成（depthByTeam も所属リーグ規則で張り替え＝後方互換の参照を保つ）
  const team = rt.teamById.get(teamId);
  const charts = rebuildSlice({ team, roster: activeRosterOf(rt, teamId), cfg, chartsByTeam: rt.chartsByTeam, usageByTeam: rt.usageByTeam });
  rt.depthByTeam.set(teamId, (rt.leagueDh.get(team.league) ?? true) ? charts.dh : charts.noDh);
  // 二軍側（up を除き down を加える）
  const f = rt.farm;
  const fr = f.rosterByTeam.get(teamId);
  const idx = fr.findIndex((p) => p.id === up.id);
  if (idx >= 0) fr.splice(idx, 1);
  fr.push(down);
  rebuildSlice({ team: f.teamById.get(teamId), roster: fr, cfg, chartsByTeam: f.chartsByTeam, usageByTeam: f.usageByTeam });
  // クールダウン（10日ルール簡略）: 双方とも当分は成績入替の対象にしない（IL復帰は強制につき無視される）
  const until = day + cfg.tuning.moves.swapCooldownDays;
  rt.moves.cooldownUntil.set(up.id, until);
  rt.moves.cooldownUntil.set(down.id, until);
}

/** 入替をニュースイベントとして記録する（rt.rosterMoves・当該シーズンのみ・§17）。 */
function logMove(rt, out, { day, teamId, type, up, down }) {
  const mv = {
    day,
    teamId,
    type, // 'ilReplace' | 'ilReturn' | 'perfSwap'
    upId: up.id,
    upName: up.name,
    upPos: up.role === 'pitcher' ? 'P' : up.primaryPos,
    downId: down.id,
    downName: down.name,
    downPos: down.role === 'pitcher' ? 'P' : down.primaryPos,
  };
  rt.rosterMoves.push(mv);
  out.push(mv);
  return mv;
}

/** 同型（野手=同 primaryPos／投手=同 role）の二軍昇格候補（育成・離脱中・クールダウン中は除外）。 */
function farmCandidates(rt, teamId, like, day) {
  const fu = rt.farm.usageByTeam.get(teamId);
  return rt.farm.rosterByTeam.get(teamId).filter(
    (q) =>
      q.rosterStatus !== 'minor' && // 育成はシーズン中は登録できない（支配下70枠・オフのC3aのみ）
      q.role === like.role &&
      (like.role === 'pitcher' || q.primaryPos === like.primaryPos) &&
      !isInjured(fu, q.id, day) &&
      !inCooldown(rt, q.id, day),
  );
}

/** 候補から score 最大を選ぶ（同点は id 昇順＝決定論）。 */
function bestBy(cands, score) {
  let best = null;
  let bv = -Infinity;
  for (const q of cands.slice().sort(byId)) {
    const v = score(q);
    if (v > bv) {
      bv = v;
      best = q;
    }
  }
  return best;
}

/** (1) IL復帰: 離脱が明けた入替対象を再登録する（補充選手が居なければ同型の観測最下位と入替）。 */
function processIlReturns(rt, teamId, day, out) {
  const entries = [...rt.moves.ilSwaps].filter(([, s]) => s.teamId === teamId).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [pid, swap] of entries) {
    const u = rt.usageByTeam.get(teamId);
    if (isInjured(u, pid, day)) continue; // まだ離脱中
    const p = rt.moves.byId.get(pid);
    rt.moves.ilSwaps.delete(pid);
    if (!p || p.teamId !== teamId) continue; // 安全弁（シーズン中の移籍は無い）
    const reg = rt.registeredByTeam.get(teamId);
    if (reg.has(pid)) continue; // 既に登録済み（想定外の安全弁）
    if (p.rosterStatus === 'minor') continue; // 育成契約の選手は出場登録できない（支配下70枠の管理・安全弁）
    // 復帰と入替で抹消する相手: 原則は補充選手。成績入替で既に降格済みなら同型の観測最下位。
    let down = rt.moves.byId.get(swap.subId);
    if (!down || !reg.has(swap.subId)) {
      const cands = activeRosterOf(rt, teamId).filter(
        (q) => q.role === p.role && (p.role === 'pitcher' || q.primaryPos === p.primaryPos) && !isInjured(u, q.id, day),
      );
      down = p.role === 'pitcher'
        ? bestBy(cands, (q) => obsRA9(rt.stats.getPitch(q.id)) ?? rt.cfg.tuning.moves.callupRa9Ref) // RA9最悪
        : bestBy(cands, (q) => -blendedWoba(u, q.id, rt.stats.getBat, rt.cfg)); // 混合評価最低
      if (!down) continue; // 同型が居ない（理論上は起きない）
    }
    swapRegistration(rt, teamId, p, down, day);
    logMove(rt, out, { day, teamId, type: 'ilReturn', up: p, down });
  }
}

/** (2) IL補充: 離脱中の登録者を、二軍の同型最良（球団AI評価=観測＋スカウト）と入替する。 */
function processIlReplacements(rt, teamId, day, out) {
  const cfg = rt.cfg;
  const mv = cfg.tuning.moves;
  for (const p of activeRosterOf(rt, teamId).sort(byId)) {
    const u = rt.usageByTeam.get(teamId);
    const until = u.injuredUntil.get(p.id) ?? 0;
    if (until <= day) continue; // 離脱していない
    if (until - day < mv.ilMinDays) continue; // 残り離脱が短い＝登録を動かさない
    if (rt.moves.ilSwaps.has(p.id)) continue; // 補充済み（登録に残らないため通常は来ない）
    const best = bestBy(farmCandidates(rt, teamId, p, day), (q) => callupScore(rt, teamId, q, cfg));
    if (!best) continue; // 同型候補が枯れている→起用AIのベンチ運用に任せる
    swapRegistration(rt, teamId, best, p, day);
    // 降格した離脱者は二軍でも出場不可（IL選手が二軍戦に出る矛盾の防止）
    rt.farm.usageByTeam.get(teamId).injuredUntil.set(p.id, until);
    rt.moves.ilSwaps.set(p.id, { teamId, subId: best.id });
    logMove(rt, out, { day, teamId, type: 'ilReplace', up: best, down: p });
  }
}

/**
 * (3) 成績入替: 25試合レビューと同周期で、一軍の観測不振者と二軍観測好調者を入替する。
 * 三層構造: 一軍側=混合評価（観測wOBA＋スカウト・blendedWoba）／二軍側=二軍の混合評価から
 * レベル差割引 farmGapWoba を引いた値。投手は観測RA9同士の比較（真値不参照）。
 * 野手・投手 各1件/レビューまで（急な総入替をしない＝シェア漸増の見直しと同じ思想）。
 */
function processPerfSwaps(rt, teamId, day, out) {
  const cfg = rt.cfg;
  const mv = cfg.tuning.moves;
  const fu = () => rt.farm.usageByTeam.get(teamId);
  const u = () => rt.usageByTeam.get(teamId);

  // 二軍から誰を上げるか＝球団AI評価（スカウト＋二軍観測の信頼度加重。IL補充と同じ物差し）。
  //   ★R4: 旧実装は「二軍で farmMinPA/farmPitchMinOuts 以上を消化し、かつ一軍の選手より明確に
  //   良い成績を残した選手」しか昇格候補にしなかった（＝**相対比較のみ**）。そのため
  //   「打ち込まれた中継ぎ」も、二軍に実績十分な上位互換が居なければ一軍に居座り続けた。
  //   現実の球団は「ダメなら落とす」→「二軍から誰かを上げる」（上げる相手は実績が薄くても
  //   スカウト評価で選ぶ）。昇格側の下限標本を外し、callupScore（真値を見ないスカウト観測＋
  //   二軍成績の加点）で選ぶ。
  const bestFarmFor = (p, extra) =>
    bestBy(farmCandidates(rt, teamId, p, day), (q) => callupScore(rt, teamId, q, cfg) + (extra ? extra(q) : 0));
  const doSwap = (up, down) => {
    swapRegistration(rt, teamId, up, down, day);
    logMove(rt, out, { day, teamId, type: 'perfSwap', up, down });
  };

  // --- (a) 打ち込まれた投手を二軍へ落とす -------------------------------------------
  //   救援は少ない対戦打者数で判断される（数試合打ち込まれれば抹消＝NPBの実務）。
  //   先発は緩衝を厚く取り、数試合の不調では動かさない（実際に先発は簡単には外されない）。
  const rot = new Set(rt.chartsByTeam.get(teamId).dh.rotation);
  const pitchers = activeRosterOf(rt, teamId)
    .filter((p) => p.role === 'pitcher' && !isInjured(u(), p.id, day) && !inCooldown(rt, p.id, day))
    .map((p) => ({ p, line: rt.stats.getPitch(p.id), starter: rot.has(p.id) }))
    .filter(({ line, starter }) => obsRA9(line) != null && line.bf >= (starter ? mv.rotationMinBF : mv.pitchMinBF))
    .sort((a, b) => obsRA9(b.line) - obsRA9(a.line) || byId(a.p, b.p));
  let nPitchSwaps = 0;
  for (const { p, line, starter } of pitchers) {
    if (nPitchSwaps >= mv.maxPitchSwapsPerReview) break;
    const ra9 = obsRA9(line);
    const best = bestFarmFor(p, starter ? (q) => starterScore(q) * mv.rotationStarterScoreW : null);
    if (!best) continue; // 同型の代わりが二軍に居ない（枠を壊せない）
    const farmRa9 = obsRA9(rt.farm.stats.getPitch(best.id));
    // ①絶対評価: 観測RA9が「打ち込まれた」水準（＝二軍の実績を問わず落とす）
    const shelled = ra9 >= (starter ? mv.relegateStarterRA9 : mv.relegateRelieverRA9);
    // ②相対評価: 二軍に明確に良い投手が居る（レベル差割引 farmGapRA9 込み）
    const outclassed =
      farmRa9 != null &&
      (rt.farm.stats.getPitch(best.id).outs ?? 0) >= mv.farmPitchMinOuts &&
      ra9 - (farmRa9 + mv.farmGapRA9) > (starter ? mv.rotationSwapRA9 : mv.pitchSwapRA9);
    if (!shelled && !outclassed) continue;
    doSwap(best, p);
    nPitchSwaps++;
  }

  // --- (b) 打てない野手を二軍へ落とす -----------------------------------------------
  const fielders = activeRosterOf(rt, teamId)
    .filter((p) => p.role === 'fielder' && !isInjured(u(), p.id, day) && !inCooldown(rt, p.id, day))
    .map((p) => ({ p, bat: rt.stats.getBat(p.id), v: fielderValue(rt, p.id, cfg) }))
    .filter(({ bat }) => bat.pa >= mv.fieldMinPA) // 標本不足（代打専任等）は判断しない
    .sort((a, b) => a.v - b.v || byId(a.p, b.p));
  let nFieldSwaps = 0;
  for (const { p, v } of fielders) {
    if (nFieldSwaps >= mv.maxFieldSwapsPerReview) break;
    const best = bestFarmFor(p, null);
    if (!best) continue;
    const fb = rt.farm.stats.getBat(best.id);
    const fps = rt.farm.stats.stats.get(best.id);
    const farmV =
      fb.pa >= mv.farmMinPA
        ? blendedWoba(fu(), best.id, rt.farm.stats.getBat, cfg)
          + runsToWoba(obsDefRunRuns(fps, cfg, rt.moves.farmLc), fb.pa, rt.moves.farmLc, cfg)
          - mv.farmGapWoba
        : null;
    const slumping = v <= mv.relegateWoba; // ①絶対評価: 観測混合評価が「打てない」水準
    const outclassed = farmV != null && farmV - v > mv.perfSwapMargin; // ②相対評価: 二軍に明確に良い打者
    if (!slumping && !outclassed) continue;
    doSwap(best, p);
    nFieldSwaps++;
  }
}

/**
 * (4) 育成→支配下の季節中昇格（§req_20260708・NPB実務: 支配下登録は例年7月末までシーズン中随時
 * 可能。旧実装は年1回のオフシーズンのみ＋自球団の同型引退枠待ちで、育成の好成績が塩漬けになる
 * 欠陥があった）。同型(role,primaryPos)の支配下のうち一軍登録外で観測不振な選手と1:1で入れ替える
 * （支配下70人枠を常に不変に保つ・releaseの代わりに育成契約へ落とす簡略化。実際のNPBでも新規の
 * 支配下登録には既存選手の育成契約化/自由契約などで枠を空ける必要がある）。
 */
function processFarmPromotions(rt, teamId, day, out) {
  const cfg = rt.cfg;
  const mv = cfg.tuning.moves;
  const mk = cfg.tuning.market.farm;
  if (day > rt.finalDay * mv.farmPromoteDeadlineFrac) return; // 実務の7/31相当の昇格期限

  const candidates = rt.league.farm.filter((d) => d.teamId === teamId && !inCooldown(rt, d.id, day));
  if (!candidates.length) return;
  let best = null;
  let bestScore = -Infinity;
  for (const d of candidates.slice().sort(byId)) {
    const r = makeRng(hashSeed(rt.masterSeed, 'inseasonPromote', rt.season, day, d.id));
    // R4: 守備(UZR)・走塁(BsR)も査定に入れるので playerSeason 丸ごと渡す（無出場は従来どおり0点）
    const obs = rt.farm.stats.stats.get(d.id)
      ?? (d.role === 'fielder' ? { batting: rt.farm.stats.getBat(d.id) } : { pitching: rt.farm.stats.getPitch(d.id) });
    const score = overallRating(d) + mk.promoteObsBias + r.normal(0, mk.promoteObsNoiseSd) + farmPerfBonus(d, obs, cfg, rt.moves.farmLc);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  if (!best || bestScore < mk.promoteThreshold) return;

  // 交換相手: 同型(role,primaryPos)の支配下・一軍登録外（登録メンバー構成は乱さない）で
  // 当季観測が最も振るわない選手（transactions.mjs releaseScore と同じ物差し・当季観測のみ）。
  const reg = rt.registeredByTeam.get(teamId);
  const sameType = rt.league.players.filter(
    (p) => p.teamId === teamId && !reg.has(p.id) && p.role === best.role &&
      (best.role === 'pitcher' || p.primaryPos === best.primaryPos) && !inCooldown(rt, p.id, day) &&
      // ★R3: 故障でIL入替中の選手を育成落ちさせない。旧実装は「登録外＋当季観測が不振」だけで選ぶため、
      //   **故障で登録を外れた選手が（出場が少ないので観測が不振に見え）育成契約へ落とされ**、
      //   IL明けの再登録（processIlReturns）で **育成選手が一軍登録に混ざる** 不変量違反を起こした。
      //   現実にも「故障者を育成契約に落として即再登録」は起こらない（療養は支配下のまま）。
      !rt.moves.ilSwaps.has(p.id),
  );
  if (!sameType.length) return; // 交換相手が居ない（枠を崩せない・稀）
  const obsMap = { get: (pid) => ({ batting: rt.stats.getBat(pid), pitching: rt.stats.getPitch(pid) }) };
  const worst = bestBy(sameType, (p) => -(releaseScore(p, obsMap, cfg) ?? Infinity));
  if (!worst) return;

  applyFarmPromotionSwap(rt.league, best.id, worst.id);
  const until = day + cfg.tuning.moves.swapCooldownDays;
  rt.moves.cooldownUntil.set(best.id, until);
  rt.moves.cooldownUntil.set(worst.id, until);
  // §req_20260708: league.players/farmの直接変更はsaveに含まれず、過去年はoffseasonTransitionのみの
  // replay近道で再構築される（day単位の再シムをしない）ため、このログをGameState側で年ごとに畳み込み、
  // load時にreplay適用する（index.mjs load()を参照）。rt.farmPromotionLogは当該シーズンのみ（年ごとに
  // 新規作成）で、状態自体は決定論的に同一入替を再現するが、このログが無いと過去完了年の再構築時に
  // league.players/farmの構成が食い違う（verifyStandingsが検出）。
  rt.farmPromotionLog.push({ day, teamId, upId: best.id, downId: worst.id });
  logMove(rt, out, { day, teamId, type: 'farmPromote', up: best, down: worst });
}

/**
 * 育成⇄支配下のロースター状態を1:1で入れ替える（population不変・§req_20260708）。
 * processFarmPromotions（当季の決定）と index.mjs load()（過去完了年のログreplay適用）の
 * 両方から呼ばれる共有ロジック。
 * @returns {boolean} 入替を実行できたか（upId/downIdが見つからなければfalse・安全弁）
 */
export function applyFarmPromotionSwap(league, upId, downId) {
  const fi = league.farm.findIndex((d) => d.id === upId);
  const pi = league.players.findIndex((p) => p.id === downId);
  if (fi < 0 || pi < 0) return false;
  const up = league.farm[fi];
  const down = league.players[pi];
  up.rosterStatus = 'active';
  down.rosterStatus = 'minor';
  // ★R5: **配列の位置をそのまま入れ替える**（splice+push で末尾へ動かさない）。
  //   league.players の並び順は selectActiveRoster/buildDepthChart の同点解決に効くため、
  //   昇格のたびに並びが変わると「同じ入替を巻き戻しても元のリーグに戻らない」。
  //   位置を保存する入替にすると、逆スワップが厳密に元へ戻す＝セーブの開幕時点復元が成立する。
  league.players[pi] = up;
  league.farm[fi] = down;
  return true;
}

/**
 * この day の試合前に出場登録の入替を適用する（F2-3の入口・advanceRuntimeDay から呼ばれる）。
 * enableMoves が立っていない（1年目・sim層・ミニリーグ=farm不成立）構成では常に何もしない。
 * @returns {Array} 実行した入替 [{day,teamId,type,upId,upName,upPos,downId,downName,downPos}]
 */
export function applyRosterMovesForDay(rt, day) {
  if (!rt.moves || !rt.farm || !rt.cfg.tuning.moves) return [];
  const out = [];
  for (const team of rt.league.teams) {
    processIlReturns(rt, team.id, day, out);
    processIlReplacements(rt, team.id, day, out);
    // 成績入替/育成昇格はチーム消化試合が reviewInterval を跨ぐたびに1回（既存25試合レビューの拡張）
    const reviewIdx = Math.floor(rt.usageByTeam.get(team.id).games / rt.cfg.tuning.moves.reviewInterval);
    if (reviewIdx > (rt.moves.lastReviewIdx.get(team.id) ?? 0)) {
      rt.moves.lastReviewIdx.set(team.id, reviewIdx);
      // R4: 守備/走塁の観測を得点換算するためのリーグ定数（一軍・二軍で水準が違うので別々に導出）
      if (rt.moves.lcDay !== day) {
        refreshLeagueConstants(rt);
        rt.moves.lcDay = day;
      }
      processPerfSwaps(rt, team.id, day, out);
      processFarmPromotions(rt, team.id, day, out); // §req_20260708: 育成→支配下の季節中昇格
    }
  }
  return out;
}

/**
 * moves 状態の初期化（startSeasonRuntime から呼ばれる）。enableMoves=false（1年目・sim層）や
 * farm 不成立（ミニリーグ）では null＝完全不作動（既存挙動と bit 同一）。
 */
export function createMovesState(league, { enableMoves, masterSeed, season, farm }) {
  if (!enableMoves || !farm) return null;
  const byIdMap = new Map();
  for (const p of league.players) byIdMap.set(p.id, p);
  for (const p of league.farm ?? []) byIdMap.set(p.id, p);
  return {
    scoutSeed: hashSeed(masterSeed, 'moves', season), // 球団AI評価の観測ノイズ座標（決定論・年別）
    byId: byIdMap, // 全選手 id→player（シーズン中は不変）
    cooldownUntil: new Map(), // pid → この day まで再移動不可（10日ルール簡略）
    ilSwaps: new Map(), // 離脱者 pid → {teamId, subId}（復帰時の再入替に使う）
    lastReviewIdx: new Map(), // teamId → 処理済みレビュー番号（25試合周期）
    profiles: new Map(), // teamId → teamEvalProfile（遅延キャッシュ・キャリア中固定と同値）
    lc: null, // R4: 一軍のリーグ定数（守備/走塁の観測を得点換算する）
    farmLc: null, // R4: 二軍のリーグ定数（水準が違うので別々に導出）
    lcDay: -1, // 上記を作り直した day
  };
}

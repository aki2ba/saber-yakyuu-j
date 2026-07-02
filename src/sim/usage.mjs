// ============================================================================
// 日次スタメンAI・疲労管理（フェーズA S3 / §S3-2 / 設計原則「起用はポリシー経由」）
//
// season.mjs から試合ごとに呼ばれる純関数群＋チームごとの起用状態（UsageState）:
//   selectStarter    → 中5日以上のローテ先発を選ぶ（投手可用性）
//   bullpenAvailable → 連投制限（3連投禁止）・前日30球以上をフィルタした救援可用リスト
//   selectLineup     → 休養（捕手は厚め・連続出場で確率↑）、相手先発の利き手プラトーン、
//                      観測ベースの担当（regular/challenger の先発シェア）で当日スタメンを組む
//   recordGameUsage  → 出場・登板履歴を更新し、25試合ごとに reviewAssignments を回す
//   reviewAssignments→ 観測成績ベースの見直し: 不振レギュラーの先発頻度が下がり、
//                      好調の控えが「シェア」を上げて徐々に昇格する（急な全交代はしない。
//                      これが「WAR -6 が出ない」仕組みの本体・§S3-2）
//
// 三層構造の原則: シーズン中の見直しは trueAbility を直接見ない。
//   評価 = 観測wOBA（PAで信頼度加重・少PAはリーグ平均へ回帰）
//        ＋ スカウト評価（真値 + scoutSeed 由来の決定論ノイズ。状態作成時に一度だけ固める）
// 初期の担当（regular）とポジション候補（positionRank）だけは編成時評価（S1）を引き継ぐ。
// 采配（試合中の判断）は manager.mjs、ここは「試合前の起用」を担う（フェーズCの差し替えフック）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { observedWoba } from './manager.mjs';
import { hitScore } from './team.mjs';
import { isSameHand } from '../model/player.mjs';
import { POSITION_DIFFICULTY } from '../model/positions.mjs';

/**
 * チームの起用状態を作る（シーズン開始時に1回）。
 * @param {{id:string}} team
 * @param {{dh:Object, noDh:Object}} charts buildDepthChart のDH有/無ペア（byId等は共通）
 */
export function createUsageState(team, charts, cfg) {
  const u = cfg.tuning.usage;
  const chart = charts.dh; // byId / positionRank / rotation / bullpen は dh/noDh で共通
  // スカウト打撃評価（真値 + scoutSeed由来の決定論ノイズ。50中心rating相当）: ここで一度だけ固める
  const scoutEval = new Map();
  for (const [pid, p] of chart.byId) {
    if (p.role !== 'fielder') continue;
    const noise = makeRng(hashSeed(p.scoutSeed ?? hashSeed(pid, 'scout'), 'usageScout')).normal(0, u.scoutSd);
    scoutEval.set(pid, hitScore(p) / 4.5 - 50 + noise);
  }
  // ポジション担当: regular=編成時のスタメン、challenger=見直しで浮上した控え（share=先発シェア）
  const assign = {};
  for (const pos of Object.keys(chart.defense)) {
    assign[pos] = { regular: chart.defense[pos], challenger: null, share: 0 };
  }
  const dhSlot = chart.lineup.find((s) => s.pos === 'DH');
  assign.DH = { regular: dhSlot ? dhSlot.playerId : null, challenger: null, share: 0 };
  return {
    teamId: team.id,
    charts,
    scoutEval,
    assign,
    games: 0, // 消化試合数（見直しタイマー）
    consecStarts: new Map(), // 野手 pid → 連続先発出場数（休養確率の入力）
    startsByPid: new Map(), // 野手 pid → 先発出場数（較正・検証用）
    startsAtPos: new Map(), // 野手 pid → Map(pos→先発数)（正捕手出場の較正・検証用）
    lastStartDay: new Map(), // 先発投手 pid → 前回先発day
    startDaysByPid: new Map(), // 先発投手 pid → [day,...]（登板間隔の検証用）
    pitchedByDay: new Map(), // 投手 pid → Map(day→球数)（連投制限・前日球数の判定）
    rotIdx: 0, // ローテの次の先発候補index
  };
}

/**
 * 混合評価（§S3-2）: 観測wOBA（回帰込み）を打席数で信頼度加重し、スカウト評価と混合。
 * 真値は直接見ない（観測statline＋scoutSeedノイズのみ）。
 * @param {Function} getBat pid → 観測battingライン（読み取り専用）
 */
export function blendedWoba(state, pid, getBat, cfg) {
  const u = cfg.tuning.usage;
  const b = getBat(pid);
  const obs = observedWoba(b, cfg);
  const w = b.pa / (b.pa + u.trustPA); // PAが積み上がるほど観測を信じる
  const scout = cfg.tuning.mgr.wobaPrior + (state.scoutEval.get(pid) ?? 0) * u.scoutWobaPerPt;
  return w * obs + (1 - w) * scout;
}

/** 当日の先発投手（中 starterRestDays 日以上のローテ投手をローテ順に）。§S3-2投手可用性 */
export function selectStarter(state, day, cfg) {
  const rot = state.charts.dh.rotation;
  const need = cfg.tuning.fatigue.starterRestDays;
  let fallback = rot[state.rotIdx % rot.length];
  let fallbackRest = -1;
  for (let k = 0; k < rot.length; k++) {
    const pid = rot[(state.rotIdx + k) % rot.length];
    const last = state.lastStartDay.get(pid);
    const rest = last == null ? Infinity : day - last - 1;
    if (rest >= need) return pid;
    if (rest > fallbackRest) {
      fallbackRest = rest;
      fallback = pid;
    }
  }
  return fallback; // 1日1試合×ローテ6なら理論上ここへは来ない（安全弁: 最も休めた投手）
}

/** 救援の可用リスト: 直近 maxConsecDays 日連続登板（=3連投になる）と前日30球以上を除外。§S3-2 */
export function bullpenAvailable(state, day, cfg) {
  const f = cfg.tuning.fatigue;
  return state.charts.dh.bullpen.filter((pid) => {
    const m = state.pitchedByDay.get(pid);
    if (!m) return true;
    if ((m.get(day - 1) ?? 0) >= f.prevDayPitchLimit) return false; // 前日30球以上は不可
    let consec = 0;
    for (let d = 1; d <= f.maxConsecDays; d++) {
      if ((m.get(day - d) ?? 0) > 0) consec++;
      else break;
    }
    return consec < f.maxConsecDays; // 2連投まで（3連投禁止）
  });
}

/**
 * 当日スタメンを組む（§S3-2）。担当（regular/challengerシェア）→休養→プラトーン入替の順で解決。
 * 捕手はリード面の継続性を優先しプラトーン入替の対象外（休養と見直しのみ）。
 * @param {{day:number, dh:boolean, oppPitcher:?Object, rng:Object, getBat:Function}} ctx
 * @returns {{lineup:Array<{playerId:?string,pos:string}>, bench:string[], rested:string[]}}
 */
export function selectLineup(state, ctx, cfg) {
  const u = cfg.tuning.usage;
  const r = cfg.tuning.rest;
  const chart = ctx.dh ? state.charts.dh : state.charts.noDh;
  const byId = chart.byId;
  const fielders = [];
  for (const [pid, p] of byId) if (p.role === 'fielder') fielders.push(pid);

  // 評価（当日メモ）: 混合評価＋相手先発とのプラトーン補正（スイッチは常に有利側=減点なし）
  const cache = new Map();
  const baseEval = (pid) => {
    let v = cache.get(pid);
    if (v === undefined) {
      v = blendedWoba(state, pid, ctx.getBat, cfg);
      cache.set(pid, v);
    }
    return v;
  };
  const effEval = (pid) =>
    baseEval(pid) - (ctx.oppPitcher && isSameHand(byId.get(pid), ctx.oppPitcher) ? u.platoonWobaPenalty : 0);

  const used = new Set(); // 今日すでにスタメンへ入れた選手
  const resting = new Set(); // 今日休養させる選手（スタメン候補から外す。代打等ベンチ待機は可）
  const excluded = (pid) => used.has(pid) || resting.has(pid);
  const today = {}; // pos → 当日スタメン

  const positions = ctx.dh ? [...POSITION_DIFFICULTY, 'DH'] : POSITION_DIFFICULTY;
  for (const pos of positions) {
    const a = state.assign[pos] ?? { regular: null, challenger: null, share: 0 };
    // 候補プール: 守備ポジは編成時 positionRank 上位（守備適性の担保）、DHは全野手
    const pool = pos === 'DH' ? fielders : chart.positionRank[pos].slice(0, u.candidatesPerPos);
    const bestOf = (list) => {
      let best = null;
      let bv = -Infinity;
      for (const pid of list) {
        if (excluded(pid)) continue;
        const v = effEval(pid);
        if (v > bv) {
          bv = v;
          best = pid;
        }
      }
      return best;
    };

    // (1) 担当: challenger は share の頻度で先発（観測ベース見直しの漸進昇格）
    let pid = a.regular != null && !excluded(a.regular) ? a.regular : null;
    if (a.challenger && !excluded(a.challenger) && ctx.rng.next() < a.share) pid = a.challenger;

    // (2) 休養: 捕手は厚めに、連続出場が長いほど確率↑（正捕手100-135試合の機序）
    if (pid != null) {
      const restP =
        (pos === 'C' ? r.catcherRestProb : r.fielderRestProb) + r.streakW * (state.consecStarts.get(pid) ?? 0);
      if (ctx.rng.next() < restP) {
        resting.add(pid);
        pid = null;
      }
    }

    // (3) 空席の充填: 候補プールの実効評価最良（全滅なら positionRank/全野手から最初の未使用）
    if (pid == null) {
      pid = bestOf(pool) ?? (pos === 'DH' ? fielders : chart.positionRank[pos]).find((x) => !excluded(x));
    } else if (pos !== 'C' && ctx.oppPitcher && isSameHand(byId.get(pid), ctx.oppPitcher)) {
      // (4) プラトーン: 同利きの担当に対し、実効評価で上回る候補がいれば当日限りの入替
      const alt = bestOf(pool.filter((x) => x !== pid));
      if (alt != null && effEval(alt) - effEval(pid) > u.platoonMargin) pid = alt;
    }
    used.add(pid);
    today[pos] = pid;
  }

  // 打順スロットへ反映（交代者は同じ打順スロットを引き継ぐ）。9番'P'は initSide が当日先発を充填。
  const lineup = chart.lineup.map((s) => ({ playerId: s.pos === 'P' ? null : today[s.pos], pos: s.pos }));
  const inLineup = new Set(lineup.map((s) => s.playerId));
  const bench = fielders.filter((pid) => !inLineup.has(pid)); // 休養者も代打要員としてベンチに残る
  return { lineup, bench, rested: [...resting] };
}

/**
 * 試合後の起用履歴の更新。ローテ進行・投手の日次球数（S2投手使用ログの接続）・
 * 野手の連続出場/先発数を記録し、reviewInterval 試合ごとに見直しを回す。
 */
export function recordGameUsage(state, { day, starterPid, lineup, pitcherLog }, getBat, cfg) {
  // 先発ローテの進行と登板日の記録
  const rot = state.charts.dh.rotation;
  const ri = rot.indexOf(starterPid);
  if (ri >= 0) state.rotIdx = (ri + 1) % rot.length;
  state.lastStartDay.set(starterPid, day);
  let sd = state.startDaysByPid.get(starterPid);
  if (!sd) {
    sd = [];
    state.startDaysByPid.set(starterPid, sd);
  }
  sd.push(day);

  // 投手の日次球数（連投制限・前日球数の判定材料）
  for (const ap of pitcherLog) {
    let m = state.pitchedByDay.get(ap.pid);
    if (!m) {
      m = new Map();
      state.pitchedByDay.set(ap.pid, m);
    }
    m.set(day, (m.get(day) ?? 0) + ap.pitches);
  }

  // 野手の連続出場・先発数（先発した野手は+1、しなかった野手は0へリセット）
  const started = new Set();
  for (const s of lineup) {
    if (s.pos === 'P' || !s.playerId) continue;
    started.add(s.playerId);
    state.startsByPid.set(s.playerId, (state.startsByPid.get(s.playerId) ?? 0) + 1);
    let mp = state.startsAtPos.get(s.playerId);
    if (!mp) {
      mp = new Map();
      state.startsAtPos.set(s.playerId, mp);
    }
    mp.set(s.pos, (mp.get(s.pos) ?? 0) + 1);
  }
  for (const [pid, p] of state.charts.dh.byId) {
    if (p.role !== 'fielder') continue;
    state.consecStarts.set(pid, started.has(pid) ? (state.consecStarts.get(pid) ?? 0) + 1 : 0);
  }

  // 観測成績ベースの見直し（25試合ごと・§S3-2）
  state.games++;
  if (state.games % cfg.tuning.usage.reviewInterval === 0) reviewAssignments(state, getBat, cfg);
}

/**
 * 観測成績ベースの担当見直し（§S3-2）。ポジションごとに混合評価で候補を再ランクし、
 * swapMargin を超えて上回る候補を challenger としてシェアを漸増（share≥1で完全昇格）。
 * 差が縮めばシェアは減衰する（一時の好不調で振り回されない）。真値は見ない。
 */
export function reviewAssignments(state, getBat, cfg) {
  const u = cfg.tuning.usage;
  const chart = state.charts.dh;
  const fielders = [];
  for (const [pid, p] of chart.byId) if (p.role === 'fielder') fielders.push(pid);
  const ev = new Map(fielders.map((pid) => [pid, blendedWoba(state, pid, getBat, cfg)]));

  const used = new Set();
  for (const pos of [...POSITION_DIFFICULTY, 'DH']) {
    const a = state.assign[pos];
    if (!a) continue;
    const pool = (pos === 'DH' ? fielders : chart.positionRank[pos].slice(0, u.candidatesPerPos)).filter(
      (pid) => !used.has(pid),
    );
    if (!pool.length) continue;
    // レギュラーが他ポジションの担当に取られた（or不在）なら評価最良を新担当に
    if (a.regular == null || used.has(a.regular)) {
      a.regular = pool.reduce((b, pid) => (ev.get(pid) > ev.get(b) ? pid : b));
      a.challenger = null;
      a.share = 0;
      used.add(a.regular);
      continue;
    }
    let top = a.regular;
    for (const pid of pool) if (ev.get(pid) > ev.get(top)) top = pid;
    if (top === a.regular || ev.get(top) - ev.get(a.regular) <= u.swapMargin) {
      // 現状維持: 挑戦者のシェアは減衰（差が消えたら挑戦解消）
      a.share = Math.max(0, a.share - u.promoteStep);
      if (a.share === 0) a.challenger = null;
    } else if (a.challenger === top) {
      a.share += u.promoteStep;
      if (a.share >= 1) {
        // 完全昇格: 不振レギュラーはベンチ（次回見直しから挑戦者になりうる）
        a.regular = top;
        a.challenger = null;
        a.share = 0;
      }
    } else {
      a.challenger = top; // 新挑戦者はシェア漸増から（急な全交代をしない）
      a.share = u.promoteStep;
    }
    used.add(a.regular);
  }
}

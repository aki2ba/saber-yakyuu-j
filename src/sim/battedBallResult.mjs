// ============================================================================
// 打球結果解決（1-3）— 2段パイプラインの第2段・後半（§3.2）
//
// 打球3要素(EV/LA/方向)＋球場ジオメトリから落下点・滞空時間を出し、
//   - フェンス越え → HR
//   - それ以外 → Distance-Time モデルで各野手のアウト化確率を幾何から導き、
//     責任野手(argmax)のリーグ中立確率 pOut を期待アウト率とし、
//     責任野手"個人"の Smax で実際の抽選を行う
// を行う。expOut はリーグ中立（＝Statcast catch probability と同じ性質）。
// 個人の上手さは OAA(1-9) で "期待からの差分" として湧く。
//
// 【重要】打球種別ごとの安打率(旧 hitGB/hitLD/hitFB/hitPU)はもはやノブではない。
//   守備隊形と打球の幾何から創発する（鉄則4・正典§11.2）。
// ============================================================================
import { fenceDistanceAt, NEUTRAL_PARK } from '../model/battedball.mjs';
import { clamp } from '../model/util.mjs';
import { neutralResponsible, fieldingChances, outProb, smaxOf, FIELD_POS } from './fieldingGeometry.mjs';

const G = 9.8;

/** 打球種別（角度で分類） */
export function battedType(laDeg) {
  if (laDeg < 10) return 'GB'; // ゴロ（負角含む）
  if (laDeg < 25) return 'LD'; // ライナー
  if (laDeg <= 50) return 'FB'; // フライ
  return 'PU'; // ポップ
}

/** 飛距離・滞空・落下点を計算して bb に書き込む */
export function computeGeometry(bb, cfg, park = NEUTRAL_PARK) {
  const v = bb.evKmh / 3.6; // m/s
  const laRad = (bb.laDeg * Math.PI) / 180;
  let distanceM;
  let hangTimeS;
  if (bb.laDeg <= 0) {
    // ゴロ: 地面を転がる想定。内野到達距離の目安のみ。
    distanceM = Math.max(0, ((v * v) / G) * 0.15);
    hangTimeS = 0;
  } else {
    // キャリー効率: 最適LA ~26°を中心に山（空気抵抗込みの現実近似。真空sin(2θ)より現実的）
    const lift = Math.exp(-Math.pow((bb.laDeg - 26) / 24, 2));
    distanceM = Math.max(0, cfg.tuning.bb.carry * ((v * v) / G) * lift);
    hangTimeS = (2 * v * Math.sin(laRad)) / G;
  }
  const sprayRad = (bb.sprayDeg * Math.PI) / 180;
  bb.distanceM = distanceM;
  bb.hangTimeS = hangTimeS;
  bb.landingX = distanceM * Math.sin(sprayRad);
  bb.landingY = distanceM * Math.cos(sprayRad);
  return bb;
}

/**
 * 落下点・打球種別から責任野手を決める（OAAの主語）。
 * Distance-Time モデルのリーグ中立 argmax（DRS の流儀・正典§9.2）。
 * 旧実装は spray角のみで1人に決め打ちしていた（正典§5.4 の根本原因）。
 */
export function assignFielder(bb, type, cfg) {
  return neutralResponsible(bb, type, cfg).pos;
}

/** 安打種別を落下点から決める（監査B1: 単打/二塁打境界＝gapDistM、深いギャップ球は打者脚力で三塁打化） */
export function decideBases(bb, type, cfg, rng) {
  const g = cfg.tuning.bb;
  if (type === 'GB') {
    return Math.abs(bb.sprayDeg) > 38 && rng.next() < 0.2 ? '2B' : '1B';
  }
  // 外野手到達圏(gapDistM)手前に前落ちする空中安打は単打
  if (bb.distanceM < g.gapDistM) return '1B';
  // 深い打球は二塁打ベース。さらに深いギャップ/ライン際(|spray|>18)は打者speedで三塁打になりうる
  if (bb.distanceM >= g.tripleDistM && Math.abs(bb.sprayDeg) > 18) {
    const speed = bb.runnerSpeed ?? 50;
    const pTriple = clamp(g.tripleBase + (speed - 50) * g.tripleSpeedW, 0.02, 0.55);
    if (rng.next() < pTriple) return '3B';
  }
  return '2B';
}

/**
 * 塁打分布の"期待値"（rng抽選を伴わない decideBases の確率版・§B3a xBA/xSLG/xwOBA用）。
 * decideBases と同一の分岐条件を確率として返す（実結果の期待値＝モデルの塁打分布）。
 * @returns {{p1:number, p2:number, p3:number}} 安打を打った条件下での 1B/2B/3B 確率（Σ=1）
 */
export function expectedBases(bb, type, cfg) {
  const g = cfg.tuning.bb;
  if (type === 'GB') {
    const p2 = Math.abs(bb.sprayDeg) > 38 ? 0.2 : 0;
    return { p1: 1 - p2, p2, p3: 0 };
  }
  if (bb.distanceM < g.gapDistM) return { p1: 1, p2: 0, p3: 0 };
  if (bb.distanceM >= g.tripleDistM && Math.abs(bb.sprayDeg) > 18) {
    const speed = bb.runnerSpeed ?? 50;
    const pTriple = clamp(g.tripleBase + (speed - 50) * g.tripleSpeedW, 0.02, 0.55);
    return { p1: 0, p2: 1 - pTriple, p3: pTriple };
  }
  return { p1: 0, p2: 1, p3: 0 };
}

/**
 * 打球を解決。bb.result と bb.fielderPos を確定し、要約を返す。
 * 追加(§B3a): 期待塁打分布 xB1/xB2/xB3/xHR（rng抽選前の防御中立=pHit基準の期待値）を返す。
 *   実結果とは独立の"期待値"であり、リーグ集計で xwOBA≈wOBA を恒等成立させる（副作用・rng消費なし）。
 * @returns {{result:string, type:string, expOut:number, fielderPos:string, distanceM:number,
 *   xB1:number, xB2:number, xB3:number, xHR:number}}
 */
/**
 * @param {Function} [fielderRangeFor] (pos) => Rangeレーティング(50=平均)。守備者個人の
 *   レンジで実効被安打率を上下させる（2-7）。省略時は50＝リーグ平均（Phase1互換）。
 */
export function resolveBattedBall(bb, cfg, rng, park = NEUTRAL_PARK, fielderRangeFor) {
  computeGeometry(bb, cfg, park);
  const type = battedType(bb.laDeg);

  // --- HR判定（D1-1・§D1）: 適角のフライ/ライナーが「HR専用飛距離」でフェンスを越える ---
  // 幾何の distanceM（安打/長打の落下点用）とは別に、フェンス越え専用の飛距離 hrDist を明示化:
  //   hrDist = carry・(v²/g)・hrLift(適角ガウス;peak,conc)・evBoost(飽和ロジスティック;ref,width,gain)
  // 打者power/EV/最適LAへの依存を露わにする（v²＋evBoostで高EVほど非線形にHR化＝スラッガー書き分け）。
  // 既定は集中無効(gain=0・peak26/conc24=幾何lift一致)で baseline HR挙動を維持（D1調査: 集中は
  // out-of-sample の HR王 床を削るため／config §hrEvGain 参照）。総量(HR/team)は hrScale が門番。
  if ((type === 'FB' || type === 'LD') && bb.laDeg >= 15 && bb.laDeg <= 48) {
    const g = cfg.tuning.bb;
    // 実効フェンス距離（D2・§11.2）: 方向別のフェンス距離＋フェンス高ペナルティ。高い壁ほどHRに要する
    //   飛距離が増える（中立4mは差0＝baseline不変）。狭い翼/低い壁の球場で「同じ打球がHRに」なる。
    const fence =
      fenceDistanceAt(bb.sprayDeg, park) +
      g.hrFenceHeightW * ((park.fenceHeightM ?? g.hrFenceHeightBase) - g.hrFenceHeightBase);
    const v = bb.evKmh / 3.6; // m/s
    const hrLift = Math.exp(-Math.pow((bb.laDeg - g.hrLaPeak) / g.hrLaConcentration, 2)); // 適角へ狭く集中
    // 飽和EVブースト: よく捉えた球(EV>hrEvRef)へ上限 hrEvGain までのHR飛距離ボーナス（怪物の暴走を抑える）
    const evBoost = 1 + g.hrEvGain / (1 + Math.exp(-(bb.evKmh - g.hrEvRef) / g.hrEvWidth));
    const hrDist = g.carry * ((v * v) / G) * hrLift * evBoost;
    if (hrDist * cfg.tuning.hrScale >= fence) {
      bb.fielderPos = assignFielder(bb, type, cfg);
      bb.result = 'HR';
      return { result: 'HR', type, expOut: 0, fielderPos: bb.fielderPos, distanceM: bb.distanceM, xB1: 0, xB2: 0, xB3: 0, xHR: 1 };
    }
  }

  // --- インプレー: Distance-Time モデルで各野手のアウト化確率を出し、責任野手を決める ---
  // 各野手の「必要走速度」「送球アウト確率」は野手の能力を含まない（＝Statcast catch probability）。
  const { reqSpeed, pThrow } = fieldingChances(bb, type, cfg);
  const smaxBase = cfg.tuning.field.smaxBase;

  // 責任野手 = リーグ中立 p の argmax（DRS の流儀・正典§9.2）。
  // 全員 p≈0（誰にも捕れない打球）なら「最も惜しかった」＝必要走速度が最小の野手。
  let fielderPos = null;
  let pOut = -1;
  let bestReq = Infinity;
  for (const pos of FIELD_POS) {
    const p = outProb(reqSpeed[pos], pThrow[pos], smaxBase, cfg);
    if (p > pOut + 1e-12 || (Math.abs(p - pOut) <= 1e-12 && reqSpeed[pos] < bestReq)) {
      pOut = p;
      bestReq = reqSpeed[pos];
      fielderPos = pos;
    }
  }
  if (fielderPos == null) fielderPos = type === 'GB' ? 'SS' : 'CF';
  bb.fielderPos = fielderPos;

  const expOut = clamp(Math.max(0, pOut), 0, 1); // リーグ中立の期待アウト（OAAのベースライン）
  const pHit = 1 - expOut;

  // 期待塁打分布（§B3a）: 防御中立の pHit × decideBases 確率版。rng を消費しない（決定論不変）。
  const eb = expectedBases(bb, type, cfg);
  const xB1 = pHit * eb.p1;
  const xB2 = pHit * eb.p2;
  const xB3 = pHit * eb.p3;

  // 実際の抽選は責任野手"個人"の Smax で行う（OAAの個人シグナル源）。
  // 難しいプレー（p≈0.5）でのみ巧拙が大きく効き、凡プレー/絶望的な打球では効きにくい
  // ＝ロジスティックの性質から自動的に導かれる（旧 rangeLogitSlope の人為的近似は不要）。
  const rangeR = fielderRangeFor ? fielderRangeFor(fielderPos) : 50;
  const effPOut = clamp(outProb(reqSpeed[fielderPos], pThrow[fielderPos], smaxOf(rangeR, cfg), cfg), 0.005, 0.995);
  const effPHit = 1 - effPOut;

  if (rng.next() >= effPHit) {
    bb.result = 'out';
    return { result: 'out', type, expOut, fielderPos, distanceM: bb.distanceM, xB1, xB2, xB3, xHR: 0 };
  }
  const base = decideBases(bb, type, cfg, rng);
  bb.result = base;
  return { result: base, type, expOut, fielderPos, distanceM: bb.distanceM, xB1, xB2, xB3, xHR: 0 };
}

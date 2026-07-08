// ============================================================================
// 打球結果解決（1-3）— 2段パイプラインの第2段・後半（§3.2 / 自己レビュー F29）
//
// 打球3要素(EV/LA/方向)＋球場ジオメトリから落下点・滞空時間を出し、
//   - フェンス越え → HR
//   - それ以外 → 「そのポジション平均の期待アウト率」で安打/アウトを確定し、
//     安打種別(1B/2B/3B)を落下点から導く
// を行う。ここで守備者"個人"の巧拙は入れない（＝ポジション平均）。
// 個人の上手さは OAA(1-9) と守備モデル(2-7)で "期待からの差分" として後付けする。
// ============================================================================
import { fenceDistanceAt, NEUTRAL_PARK } from '../model/battedball.mjs';
import { clamp } from '../model/util.mjs';
import { logit, expit, ratingDelta } from './rates.mjs';

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

/** 落下点・打球種別から担当野手ポジションを決める（OAAの主語） */
export function assignFielder(bb, type) {
  const s = bb.sprayDeg;
  const infield = type === 'GB' || type === 'PU' || (type === 'LD' && bb.distanceM < 45);
  if (infield) {
    if (s <= -18) return '3B';
    if (s <= -4) return 'SS';
    if (s < 6) return s < 0 ? 'SS' : '2B';
    if (s < 20) return '2B';
    return '1B';
  }
  // 外野: CFの担当角を狭め（±15→±10）、モード(0°)集中による機会・UZR過大を緩和（監査B6）
  if (s <= -10) return 'LF';
  if (s < 10) return 'CF';
  return 'RF';
}

/** 打球種別ごとの基準hit率（ポジション平均のxBABIP的な値） */
function baseHitProb(type, cfg) {
  const bb = cfg.tuning.bb;
  return type === 'GB' ? bb.hitGB : type === 'LD' ? bb.hitLD : type === 'FB' ? bb.hitFB : bb.hitPU;
}

/**
 * 滞空時間ベースの難易度加点（§req_20260708・UZR/DRS/Statcast OAAの「到達可能時間」の近似）。
 * 守備者の初期位置は持たないため、担当ポジションの定位置(posTypicalDepthM)と落下点の距離ギャップを
 * 滞空時間で割り「間に合わせるのに要する速度」とする。ゴロ(hangTimeS=0)は対象外＝0。
 * 外野に割り当てられたライナー(LD)はフライ(FB)より手前の定位置(outfieldLDTypicalDepthM)を使う
 * （assignFielderの45m閾値超で外野判定される浅いライナーがFB定位置比で軒並み高難度化する偏りを回避）。
 */
function timeDifficultyAdj(fielderPos, type, distanceM, hangTimeS, cfg) {
  if (!(hangTimeS > 0)) return 0;
  const g = cfg.tuning.bb;
  const typical = (type === 'LD' && g.outfieldLDTypicalDepthM[fielderPos] != null)
    ? g.outfieldLDTypicalDepthM[fielderPos]
    : g.posTypicalDepthM[fielderPos];
  if (typical == null) return 0;
  const gapM = Math.abs(distanceM - typical);
  const reqSpeed = gapM / hangTimeS; // m/s相当
  return clamp(reqSpeed * g.timeDifficultyW, 0, g.timeDifficultyCap);
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
      bb.fielderPos = assignFielder(bb, type);
      bb.result = 'HR';
      return { result: 'HR', type, expOut: 0, fielderPos: bb.fielderPos, distanceM: bb.distanceM, xB1: 0, xB2: 0, xB3: 0, xHR: 1 };
    }
  }

  // --- インプレー: ポジション平均の期待アウト率で安打/アウト ---
  const fielderPos = assignFielder(bb, type);
  bb.fielderPos = fielderPos;
  let pHit = baseHitProb(type, cfg) + (bb.evKmh - 140) * cfg.tuning.bb.evHitW;
  if (type === 'FB' && bb.distanceM >= cfg.tuning.bb.fbHitBonusM) pHit += 0.15; // 警告帯FBの被安打（BABIP環境維持のため二塁打境界と別閾値）
  // 滞空時間ベースの難易度（§req_20260708）: 担当ポジションの定位置から離れた落下点（浅すぎ/深すぎ＝
  // no man's land）ほど、滞空時間に対して間に合わせにくくヒット寄りに加点。
  pHit += timeDifficultyAdj(fielderPos, type, bb.distanceM, bb.hangTimeS, cfg);
  pHit = clamp(pHit, 0.01, 0.97);
  const expOut = 1 - pHit; // リーグ平均基準（OAAのベースライン・ポジション中立）

  // 期待塁打分布（§B3a）: 防御中立の pHit × decideBases 確率版。rng を消費しない（決定論不変）。
  const eb = expectedBases(bb, type, cfg);
  const xB1 = pHit * eb.p1;
  const xB2 = pHit * eb.p2;
  const xB3 = pHit * eb.p3;

  // 守備者個人のRangeで実効被安打率を上下（good fielder→outを増やす）。OAAの個人シグナル源。
  // logit空間でシフト（§req_20260708・UZR/DRS/OAAの確率バケット方式が暗黙に持つ「五分五分の
  // プレーほど巧拙が効き、簡単/絶望的なプレーでは効きにくい」性質の近似。線形シフトだと極端な
  // pHitでも一律に効いてしまい非現実的だった）。
  const rangeR = fielderRangeFor ? fielderRangeFor(fielderPos) : 50;
  const effPHit = clamp(expit(logit(pHit) - ratingDelta(rangeR, cfg.tuning.field.rangeLogitSlope)), 0.01, 0.99);

  if (rng.next() >= effPHit) {
    bb.result = 'out';
    return { result: 'out', type, expOut, fielderPos, distanceM: bb.distanceM, xB1, xB2, xB3, xHR: 0 };
  }
  const base = decideBases(bb, type, cfg, rng);
  bb.result = base;
  return { result: base, type, expOut, fielderPos, distanceM: bb.distanceM, xB1, xB2, xB3, xHR: 0 };
}

// ============================================================================
// フェーズD3: 時代トレンドと王朝均衡（§11.3「集団・時代系」・多年運用）
//
//   computeEra(masterSeed, yearIndex, cfg) → EraState
//     … その年（yearIndex）の「時代」を (masterSeed, yearIndex) から純粋に決める。
//       投高打低↔打高投低の緩やかな揺れ（offenseWave→evBaseDelta）・平均球速の経年上昇
//       （veloBump）・世代の波（cohortQuality＝ドラフト当たり年/外れ年→黄金世代）を返す。
//   eraSeasonConfig(baseCfg, era) → cfg
//     … シーズンシムに使う「時代補正済み config」を作る（bb.evBase を evBaseDelta ぶん動かす）。
//   teamBalanceBoost(standings, cfg) → Map<teamId, number>
//     … 王朝均衡（戦力の平均回帰）: 前年に勝ち越した球団のドラフト新人を控えめに、負け越した
//       球団の新人を厚めにする再分配 boost（新人品質rating・weak teams ほど大）。
//
// 設計原則（phaseD_spec D3・厳守）:
//   - **1年目（yearIndex=0）は完全に identity**: computeEra は全成分ゼロを返し、eraSeasonConfig は
//     baseCfg を同一参照で返す＝1年目レギュラーシーズンは D3 前と byte 一致（既存50較正不変）。
//     ドリフトは 2年目以降にのみ効く。
//   - 決定論維持: 乱数は makeRng(hashSeed(masterSeed, ...)) のみ。Date.now/Math.random 非使用。
//     era は (masterSeed, yearIndex) の純関数＝live の advanceYear と load の replay で bit 一致。
//   - config集約: 揺れ幅・周期・球速上昇率・黄金世代確率・均衡強度は cfg.tuning.era のノブ。
//   - 揺れは位相0の正弦（sin(2π·yi/period)）で表現する。yi=0 で必ず 0（year0 identity の担保）。
//     周期は世界（masterSeed）ごとに少し散らす（時代の巡りが世界で違う）が位相0は保つ。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';

/** 1年目（identity）用の EraState。全成分ゼロ＝D3 前と完全一致。 */
function identityEra(yearIndex) {
  return { yearIndex, offenseWave: 0, evBaseDelta: 0, veloBump: 0, cohortQuality: 0, isGolden: false, isLean: false };
}

/**
 * その年の「時代」を (masterSeed, yearIndex) から決める（純関数・決定論）。
 * yearIndex<=0 は identity（1年目不変の担保）。cfg.tuning.era 未定義/無効時も identity。
 * @returns {{yearIndex:number, offenseWave:number, evBaseDelta:number, veloBump:number,
 *            cohortQuality:number, isGolden:boolean, isLean:boolean}}
 */
export function computeEra(masterSeed, yearIndex, cfg) {
  const E = cfg && cfg.tuning ? cfg.tuning.era : null;
  if (!E || E.enabled === false || yearIndex <= 0) return identityEra(yearIndex);

  // --- 得点環境の緩やかな揺れ（投高打低↔打高投低）---------------------------------
  // 周期は世界ごとに散らす（位相は0固定＝sin(0)=0 で year0 identity）。1世界で1回だけ引く。
  const period = Math.max(4, E.wavePeriod + makeRng(hashSeed(masterSeed, 'era-phase')).normal(0, E.wavePeriodSd));
  const offenseWave = Math.sin((2 * Math.PI * yearIndex) / period); // -1..+1（+=打高 / −=投高）
  const evBaseDelta = offenseWave * E.offenseAmpKmh; // EV中心の上下（km/h）＝得点環境の揺れ

  // --- 平均球速の経年上昇（新人世代が世代ごとに速くなる・約+0.5km/h/年）---------------
  const veloBump = Math.min(E.veloPerYear * yearIndex, E.veloBumpMax);

  // --- 世代の波（ドラフト当たり年/外れ年→黄金世代）--------------------------------
  const cr = makeRng(hashSeed(masterSeed, 'era-cohort', yearIndex));
  const u = cr.next();
  let cohortQuality = cr.normal(0, E.cohortSd); // 通常年の小さな揺れ
  let isGolden = false;
  let isLean = false;
  if (u < E.goldenProb) {
    cohortQuality += E.goldenBoost; // 当たり年（黄金世代・稀）
    isGolden = true;
  } else if (u > 1 - E.leanProb) {
    cohortQuality -= E.leanPenalty; // 外れ年
    isLean = true;
  }

  return { yearIndex, offenseWave, evBaseDelta, veloBump, cohortQuality, isGolden, isLean };
}

/**
 * シーズンシム用の「時代補正済み config」を返す（bb.evBase を evBaseDelta ぶん動かす）。
 * evBaseDelta=0（1年目 or 無効）なら baseCfg を**同一参照**で返す＝byte一致の担保。
 * それ以外は shallow spread で tuning.bb.evBase だけ差し替えた新オブジェクトを返す（他は共有＝
 * シムは読み取り専用で参照するため安全。leagueConstants はシムが都度導出し cfg を書き換えない）。
 */
export function eraSeasonConfig(baseCfg, era) {
  if (!era || !era.evBaseDelta) return baseCfg;
  return {
    ...baseCfg,
    tuning: {
      ...baseCfg.tuning,
      bb: { ...baseCfg.tuning.bb, evBase: baseCfg.tuning.bb.evBase + era.evBaseDelta },
    },
  };
}

/**
 * 王朝均衡（戦力の平均回帰）: 前年順位（勝率）から各球団のドラフト新人 boost を導く。
 * 勝ち越した球団（winPct>.500）は boost=0（既にウェーバー順で不利＝再分配で更に控えめに）、
 * 負け越した球団ほど新人品質を厚くする（弱い球団に良い人材が回る＝FA/ドラフト再分配の増幅）。
 * これで強い球団の連覇（王朝）が数年で崩れる振り子が生まれる（§11.3）。
 * 決定論: standings（勝率）は teamHistory 由来＝save/replay で同一。boost は純粋な算術。
 * @param {Array} standings 完了年の順位表行（w/l を持つ）
 * @param {Object} cfg cfg.tuning.era.balanceReversion / balanceMaxDev
 * @returns {Map<string, number>} teamId → 新人 rating boost（>=0）
 */
export function teamBalanceBoost(standings, cfg) {
  const E = cfg && cfg.tuning ? cfg.tuning.era : null;
  const boost = new Map();
  if (!E || E.enabled === false || !E.balanceReversion || !standings || !standings.length) return boost;
  for (const s of standings) {
    const dec = (s.w ?? 0) + (s.l ?? 0);
    const winPct = dec ? s.w / dec : 0.5;
    const deficit = Math.min(E.balanceMaxDev, Math.max(0, 0.5 - winPct)); // .500 未満ぶん（上限クランプ）
    boost.set(s.teamId, deficit * E.balanceReversion);
  }
  return boost;
}

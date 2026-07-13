// ============================================================================
// 故障ハザード（§10.5）— シム層（試合中の発生）とゲーム層（オフの後遺処理）の共有定義
//
// 発生は「試合中の露出イベント（打席・投球・守備機会）ごとのハザード」（R3）。壊れた選手はその場で
// 退き、以後の試合を離脱し、二軍から補充される（roster_moves の IL補充）。
//
// ★R6 再設計（文献調査 2026-07-13・thyroxin/research/injury_evidence.md）:
//
// 【旧実装の構造的誤り】故障歴1件ごとにハザードを加算していた（青天井 → 暫定で上限を付けて凌いだ）。
//   これは **因果効果と選択効果の二重計上** だった。
//   Wei et al., *Past Injury as a Risk Factor: An Illustrative Example Where Appearances Are
//   Deceiving*, Am J Epidemiol 2011;173(8):941（n=1,281）:
//     「故障回数が増えるほど故障率が上がる」という用量反応関係は、**個体の潜在的脆弱性(frailty)を
//       調整すると消失する**。＝観察される累積効果の大部分は「壊れやすい個体が繰り返し選ばれてくる」
//       選択効果であって、「故障したから壊れやすくなった」わけではない。
//   → 故障歴を足し算する根拠は存在しない。二層に分解するのが正しい。
//
// 【新しい構造】
//   ① 潜在durability（trueAbility.career.durability・生涯不変の真値）… 累積しない
//   ② 直近の故障の残債（指数減衰）                                  … 数か月〜2年で消える
//
//   h = base × durabilityMult × ageMult(role) × 役割/投球負荷 × (1 + recurW × decaySum)
//
//   decaySum = Σ_i exp(−(今年 − 故障年)/τ) は **幾何級数なので有限に収束する**（毎年壊れ続けても
//   頭打ち）。＝ **人為的な上限(clamp)が要らなくなる**。これが求めていた本質的な形。
//
// 【減衰の速さ】τ≈1.2年（半減期≈0.8年／3年でほぼ消滅）。根拠:
//   - Arthur (BP・MLB野手LASSO): 前年の故障日数の係数 0.18 / 2年前 0.10 / 3年前 0.02（≒無視できる）
//     → 相対 1 : 0.56 : 0.11 に exp(−t/τ) を当てると τ≈0.9-1.7年【導出】
//   - Green et al., BJSM 2020（メタ解析 78研究・n=71,324）: ハムストリング再受傷は「既往あり(ever)」
//     RR=2.7 に対し **「直近」RR=4.8** ＝ 時間減衰の直接証拠
//   - ランニング疫学: 直近12か月以内の既往のみが調整後に有意（それより古いものは有意性を失う）
//   ※野球特化の直接検証は **未確認**（隣接領域からの外挿）＝ config のノブとして露出し較正で詰める。
//
// 【球速の重みを下げた】Fleisig et al., OJSM 2025（**前向きコホート** n=305・UCL手術31例）:
//   球速とUCL損傷は **HR=1.02（95%CI 0.91-1.14）＝有意差なし**。代わりに肘内反トルクが有意
//   （10Nm差で HR=1.26）。支持側の Chalmers 2016 ですら説明力は分散の 7%。
//   → 「速球派ほど壊れる」は最良質のエビデンスに支持されていない。重みを大幅に下げた。
//
// 【捕手の割増は撤去済み】Guy et al. 2015（PubMed 26320222）: 捕手の負傷"頻度"は他ポジションより低い。
//
// 【入れなかったもの（エビデンス不足のため）】
//   - Verducci効果（前年比イニング急増）: 複数の独立分析が一致して否定（THT: 急増群のERAはむしろ良好）
//   - ACWR（急性:慢性ワークロード比）: 野球特化研究は n=9 の記述研究のみ。総説が「野球への適用は
//     problematic」と明記。「ACWR>1.27 で14.9倍」は一次論文を特定できず（未確認）
//
// 設計原則:
//   - 決定論: 乱数は試合の階層シード rng のみ。
//   - **真値はシーズン中に動かさない**: 試合中に決まるのは「離脱の事実」だけ。後遺と故障歴の
//     積み上げはオフに当季ログを消費して適用する（game/injury.mjs）。
//   - 三層構造: durability は真値。球団AI/起用AIが見られるのは「故障歴」というノイズの多い観測値だけ。
//     → Ramkumar 2019(OJSM,n=1,890): ドラフト前の故障歴は指名オッズを下げる(OR=0.738)のに指名後の
//       故障率は予測しない ＝ **実在する市場の非効率**（鉄則5「球団AIをわざと間違わせる」の実証的裏付け）。
// ============================================================================
import { clamp } from '../model/util.mjs';

/**
 * 年齢による故障リスク倍率（§10.5）。
 *   投手: **U字型**（21-22歳は高リスク → 24歳付近が谷 → 25歳以降は緩やかに上昇）
 *         Carroll & Silver, BP 2003「The Injury Nexus」※二次分析（確度中）
 *   野手: 緩やかな線形増加（1歳あたり欠場日数 +6.4%）
 * 旧実装の「30歳超から線形に増える」だけの形は、少なくとも投手については実証と乖離していた。
 */
function ageMult(p, inj) {
  const a = inj.age;
  if (p.role === 'pitcher') {
    const d = p.age - a.pitcherTroughAge; // 谷（≈24歳）からの距離
    return 1 + (d < 0 ? -d * a.pitcherYoungPerYear : d * a.pitcherOldPerYear);
  }
  return 1 + Math.max(0, p.age - a.fielderRampAge) * a.fielderPerYear;
}

/**
 * 直近の故障の残債（指数減衰）。幾何級数なので有限に収束する＝人為的な上限が要らない。
 * @param {?number} season 現在のシーズン（年）。null なら 0（生成直後/単体テスト）
 */
function recentLoad(p, inj, season) {
  const hist = p.trueAbility.career.injuryHistory ?? [];
  if (!hist.length || season == null) return 0;
  let sum = 0;
  for (const e of hist) {
    const dt = season - (e.year ?? season); // 経過年
    if (dt < 0 || dt > inj.recurMaxYears) continue; // 古すぎる故障は寄与ゼロ（3年でほぼ消滅）
    sum += (e.severity === 'major' ? inj.recurMajorW : 1) * Math.exp(-dt / inj.recurTauYears);
  }
  return sum;
}

/**
 * 1選手の「1シーズンあたり」故障ハザードのスケール（露出確率の倍率としても使う）。
 * @param {?number} season 現在のシーズン（省略時は再発の残債を考慮しない）
 */
export function injuryHazard(p, cfg, season = null) {
  const inj = cfg.tuning.injury;
  const t = p.trueAbility;
  let h = inj.base;
  // ① 潜在durability（生涯不変の真値・50中心）: 高いほど壊れにくい。累積しない。
  h *= clamp(
    1 + (50 - (t.career.durability ?? 50)) * inj.durabilityPerPt,
    inj.durabilityMultMin,
    inj.durabilityMultMax,
  );
  h *= ageMult(p, inj); // 年齢（投手U字／野手は緩やかな線形）
  if (p.role === 'pitcher') {
    h *= inj.pitcherMult; // 投手の上乗せ（件数比は 1.0-1.3:1 と穏やか＝NPB実測）
    // R6: 球速の重みは大幅に下げた（Fleisig 2025 で HR=1.02＝有意差なし）
    h *= 1 + Math.max(0, t.pitching.velocityKmh - inj.veloRef) * inj.veloPerKmh;
  }
  // ② 直近故障の残債（指数減衰・収束するので上限不要）
  h *= 1 + inj.recurW * recentLoad(p, inj, season);
  return clamp(h, 0, inj.cap);
}

/**
 * 露出イベント1回あたりの故障確率。
 *   kind: 'perPA'（打者の1打席＝スイング・走塁） / 'perBF'（投手の対戦打者1人＝肩肘の消耗）
 *       / 'perFieldPlay'（野手が処理した打球1つ） / 'perCatcherPA'（捕手の守備1打席）
 * @param {number} restMult 登板間隔の補正（投手のみ）。2024年研究（PubMed 39292010）:
 *   登板間隔5日超のチームは筋骨格系IL日数が **IRR=0.78（22%減）** ＝ 中4日以下は risk↑。
 */
export function exposureProb(p, kind, cfg, season = null, restMult = 1) {
  const IS = cfg.tuning.injury.inSeason;
  const base = IS[kind] ?? 0;
  if (!base) return 0;
  return base * (injuryHazard(p, cfg, season) / IS.refHazard) * restMult;
}

/**
 * 故障部位を引く。役割で分布が大きく違う（Posner et al., AJSM 2011・MLB DL 2002-2008）:
 *   投手は上肢 **67.0%** / 下肢 16.9%、野手は上肢 32.1% / 下肢 **47.5%**。
 * 再発（同一部位 > 同一運動連鎖 >> 無関係な部位≈0）は **同じ部位を引きやすくする** ことで表す
 * （ハザード本体は部位を持たず単純に保つ）。ハムストリング再受傷率 16.3%（Okoroha 2019, n=2,633）。
 */
export function drawInjurySite(p, cfg, prng) {
  const inj = cfg.tuning.injury;
  const table = p.role === 'pitcher' ? inj.sites.pitcher : inj.sites.fielder;
  const prior = new Set((p.trueAbility.career.injuryHistory ?? []).map((e) => e.site).filter(Boolean));
  let total = 0;
  const w = [];
  for (const s of table) {
    const weight = s.share * (prior.has(s.id) ? inj.siteRecurBias : 1);
    w.push(weight);
    total += weight;
  }
  let u = prng.next() * total;
  for (let i = 0; i < table.length; i++) {
    u -= w[i];
    if (u <= 0) return table[i];
  }
  return table[table.length - 1];
}

/**
 * 故障の部位・重さ・離脱試合数を引く。
 * 離脱期間は **右裾の重い分布**（Camp et al., AJSM 2018・n=49,955: 平均16日 / 中央値6日 ＝
 * 平均が中央値の2.6倍）。部位ごとに中央値が桁違い（ハムストリング 14.5日 ⇔ UCL損傷 274.9日）なので
 * **部位別の対数正規**で引く（分布族そのものの実証は未確認＝設計上の選択）。
 * severity は「シーズン規模の離脱か」で決める（シーズン絶望級は全故障の 8-11%・Esquivel 2019）。
 * @returns {{site:string, siteName:string, severity:'minor'|'major', gamesLost:number}}
 */
export function rollInjurySeverity(p, cfg, prng) {
  const inj = cfg.tuning.injury;
  const site = drawInjurySite(p, cfg, prng);
  const days = site.medianDays * Math.exp(prng.normal(0, inj.durationSigma)); // 対数正規
  const gamesLost = Math.max(inj.minGamesLost, Math.round(days / inj.daysPerGameLost));
  const severity = gamesLost >= inj.majorGamesThreshold ? 'major' : 'minor';
  return { site: site.id, siteName: site.name, severity, gamesLost };
}

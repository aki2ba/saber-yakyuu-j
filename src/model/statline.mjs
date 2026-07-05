// ============================================================================
// 統一スタットライン・スキーマ（§5 §6 §7 §9）
//
// 集計器が場当たり的に肥大しないよう、per-(player,season) / per-(team,season) の
// 器をここで一括確定する（自己レビュー M5）。フィールドはフェーズをまたいで段階的に
// 埋めてよいが、"箱"は最初に固定する。特に posAdj/UZR の土台となる
// 「ポジション別 守備アウト(=イニング)」勘定を最初から持たせる。
//
// 指標値（AVG/wOBA/FIP/WAR…）はここには持たない。生カウントだけを保持し、
// 指標は集計後にリーグ定数(1-6)と合わせて算出する（2パス構造・M2/F2）。
// ============================================================================
import { FIELD_POSITIONS } from './positions.mjs';
import { addNumeric } from './util.mjs';

/**
 * 打撃スプリット1器（§B3b）: AVG/OBP/SLG を出せる最小のスラッシュ器。
 * 対左/対右・得点圏(RISP)・ホーム/ビジターの各分割に用いる（通算集計では合算しない・vsFastball同様）。
 */
export function createSplitLine() {
  return { pa: 0, ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, so: 0, sf: 0 };
}

/** 打撃の生カウント（§5）。個人R(得点者)は保留、RBIのみ（§18）。 */
export function createBattingLine() {
  return {
    pa: 0,
    ab: 0,
    h: 0,
    b1: 0, // 単打
    b2: 0, // 二塁打
    b3: 0, // 三塁打
    hr: 0,
    bb: 0,
    ibb: 0, // 敬遠（wOBA/FIPで別扱いしうる）
    hbp: 0,
    so: 0,
    sf: 0, // 犠飛
    sh: 0, // 犠打
    ph: 0, // 代打打席数（S1で器を確定・計上はS2の代打導入で）
    gdp: 0, // 併殺打（wGDPの素, §6）
    sb: 0, // 盗塁（wSBの素, §6）
    cs: 0, // 盗塁死
    rbi: 0,
    // --- B1 一球ごとの生カウント（打者視点・§B1-2）。カウント状態機械の副産物。
    // pitches=見た球数, swings=スイング数, whiffs=空振り, fouls=ファウル, calledStrikes=見逃しストライク,
    // zonePitches=明確にゾーン内の球数（Zone%の分子・従来定義）。oZonePitches=ゾーン外の球数
    // （0.9.1-pitchband: FanGraphs O-Swing%定義整合のため 明確ボール=1.0＋ボーダー帯=0.5 の按分計上。
    //   ボーダー帯はゾーンの縁を跨ぐ＝半分ゾーン外とみなす。よって非整数になりうる）。
    // z/oSwings=各帯スイング, z/oWhiffs=各帯空振り（o側はボーダー0.5按分・同上）,
    // ballsInDirt=ワンバウンド球数。率(Zone%/O-Swing%/Contact%/SwStr%/CSW%)はこれらから metrics で算出。
    pitches: 0, swings: 0, whiffs: 0, fouls: 0, calledStrikes: 0,
    // lumpedPitches=状態機械を通さない打席（敬遠/犠打）の投球数。pitches に含めて恒等(§B1-2 Σ打者==Σ投手)を保つが、
    // 一球swing模型の率(Zone%/CSW%/SwStr%)の分母からは除外する（EV/LA非模型のため）＝機械球数=pitches−lumpedPitches。
    lumpedPitches: 0,
    zonePitches: 0, zSwings: 0, zWhiffs: 0, oZonePitches: 0, oSwings: 0, oWhiffs: 0, ballsInDirt: 0,
    firstPitchStrikes: 0, // 初球がストライク判定(見逃し/空振り/ファウル/インプレー)だった打席数（F-Strike%の分子）
    // 対球種スプリット（§4段階1）。※通算集計では合算しない（最新シーズンの内訳表示用）
    vsFastball: { pa: 0, ab: 0, h: 0, hr: 0, so: 0, bb: 0 },
    vsBreaking: { pa: 0, ab: 0, h: 0, hr: 0, so: 0, bb: 0 },
    // カウント別成績の圧縮版（§B1-2）: ahead/even/behind（打者視点 balls vs strikes）＋代表2セル 0-2/3-0。
    // 各セルは PA終端の直前カウントで分類し {pa,ab,h,hr,bb,so} を積む。通算集計では合算しない（ネスト）。
    byCount: {
      ahead: { pa: 0, ab: 0, h: 0, hr: 0, bb: 0, so: 0 }, // balls > strikes
      even: { pa: 0, ab: 0, h: 0, hr: 0, bb: 0, so: 0 }, // balls == strikes
      behind: { pa: 0, ab: 0, h: 0, hr: 0, bb: 0, so: 0 }, // balls < strikes
      c02: { pa: 0, ab: 0, h: 0, hr: 0, bb: 0, so: 0 }, // 0ボール2ストライクを通過
      c30: { pa: 0, ab: 0, h: 0, hr: 0, bb: 0, so: 0 }, // 3ボール0ストライクを通過
    },
    // --- B3a 追加集計（一球データ不要・打球イベントの副産物。§B3） ------------
    // 打球期待値アキュムレータ（xBA/xSLG/xwOBA）: resolveBattedBall の期待out率/塁打分布を
    // rng抽選の"前"に累積（モデル=シムゆえ リーグ xwOBA≈wOBA が恒等成立→較正チェックに使う）。
    xB1: 0, xB2: 0, xB3: 0, xHR: 0,
    // 打球分類（GB/LD/FB/PU%・被弾含む全インプレー打球）と方向（Pull/Cent/Oppo%）。
    // 分母 bbEvents = bbGB+bbLD+bbFB+bbPU = bbPull+bbCent+bbOppo。
    bbGB: 0, bbLD: 0, bbFB: 0, bbPU: 0, bbEvents: 0,
    bbPull: 0, bbCent: 0, bbOppo: 0,
    // 打球質（Barrel/HardHit/SweetSpot・分母=bbEvents）と打球速度（平均=evSum/bbEvents, 最大=evMax）。
    barrels: 0, hardHits: 0, sweetSpots: 0, evSum: 0, evMax: 0,
    // --- B2 文脈指標（RE24/WPA/LI・§B2。2パスでRE行列/WE表/LI表を焼いてから accumulate）------
    // 打者の打席プレーぶんの ΔRE(得点期待値変化＋得点) と ΔWE(勝率変化=WPA)、
    // liSum=打席状態レバレッジの合計（aLI = liSum/pa）、wpaLiSum=Σ(打席WPA/打席LI)（文脈中立WPA/LI）。
    // context無効時は 0 のまま（既存較正は不変）。
    re24: 0, wpa: 0, liSum: 0, wpaLiSum: 0,
    // --- B3b 打撃スプリット（対左/対右・得点圏・ホーム/ビジター・§B3b）。game.mjs で1打席ごとに計上。
    // 通算/リーグ集計では合算しない（addNumeric がネストを触らない＝最新シーズンの内訳表示用・vsFastball同様）。
    // 恒等: vsL.pa + vsR.pa = pa（全打席は左右いずれかの投手と対戦）／home.pa + away.pa = pa。
    splits: {
      vsL: createSplitLine(), // 対左投手
      vsR: createSplitLine(), // 対右投手
      risp: createSplitLine(), // 得点圏（打席開始時に走者二塁 or 三塁）
      home: createSplitLine(), // ホーム打席
      away: createSplitLine(), // ビジター打席
    },
  };
}

/** 投手の生カウント（§8 §9）。IPは outs で持つ（1/3イニングの丸め誤差回避）。 */
export function createPitchingLine() {
  return {
    g: 0, // 登板
    gs: 0, // 先発
    outs: 0, // 記録アウト（IP = outs/3）
    bf: 0, // 対戦打者
    h: 0,
    hr: 0,
    bb: 0,
    ibb: 0,
    hbp: 0,
    so: 0,
    r: 0, // 失点
    er: 0, // 自責点
    w: 0,
    l: 0,
    sv: 0, // セーブ
    hld: 0, // ホールド（監査B3で計上）
    bs: 0, // ブローンセーブ（監査B3で計上）
    cg: 0, // 完投（監査B4で計上）
    sho: 0, // 完封（監査B4で計上）
    pitches: 0, // 投球数
    lumpedPitches: 0, // 敬遠/犠打の投球数（打者側と対称・機械球数=pitches−lumpedPitches。率の分母から除外）
    // --- B1 一球ごとの生カウント（投手視点・§B1-2）。打者側と対称。被O-Swing等=「釣れる投手」の素。
    // oZonePitches/oSwings/oWhiffs はボーダー帯0.5按分（0.9.1・打者側コメント参照）＝非整数になりうる。
    swings: 0, whiffs: 0, fouls: 0, calledStrikes: 0,
    zonePitches: 0, zSwings: 0, zWhiffs: 0, oZonePitches: 0, oSwings: 0, oWhiffs: 0, ballsInDirt: 0,
    firstPitchStrikes: 0, // 初球ストライク数（F-Strike%の分子。被F-Strike＝奪ストライク先行）
    // --- B3a 追加集計: 被打球分類（被GB/LD/FB/PU%・HR/FB・xFIP用の被FB）とQS。§B3 ---
    bbGB: 0, bbLD: 0, bbFB: 0, bbPU: 0, bbEvents: 0,
    qs: 0, // クオリティスタート（先発が6IP=18アウト以上・自責3以下で降板）
    // --- B2 文脈指標（RE24/WPA/LI・§B2）------------------------------------------
    // 投手の被 ΔRE(−側)・被 WPA(−側)、liSum=対戦打者ぶんの状態レバレッジ合計（pLI = liSum/bf）、
    // gmLiSum/gmLiN=登板時レバレッジ（救援WARのレバレッジ加重に使用・gmLI = gmLiSum/gmLiN）、
    // wpaLiSum=Σ(被WPA/打席LI)（文脈中立WPA/LI）、sd/md=シャットダウン(≥+0.06)/メルトダウン(≤−0.06)。
    // context無効時は 0（既存較正は不変）。
    re24: 0, wpa: 0, liSum: 0, wpaLiSum: 0, gmLiSum: 0, gmLiN: 0, sd: 0, md: 0,
  };
}

/** 走塁（盗塁以外の進塁。§6 UBR/wGDPの素）。盗塁数自体は打撃側にも計上。 */
export function createBaserunningLine() {
  return {
    advOpp: 0, // 進塁機会（単打で2→本 / 二塁打で1→本 の判断が発生した回数。UBRの分母）
    advTaken: 0, // うち追加進塁（生還）を取った回数
    outsOnBase: 0, // 走塁死
    gdpOpp: 0, // 併殺機会（wGDPの分母）
    // --- B2 文脈指標（走塁イベントのRE24/WPA・§B2）: 盗塁/追加進塁は走者へ ΔRE/ΔWE を付与 ---
    re24: 0, wpa: 0,
  };
}

/** 守備（§7 §9）。posAdj/UZRの土台＝ポジション別 守備アウト勘定を必ず持つ。 */
export function createFieldingLine() {
  const positionOuts = {}; // ポジション -> 守備アウト数（イニング=outs/3）
  for (const p of FIELD_POSITIONS) positionOuts[p] = 0;
  return {
    positionOuts,
    chances: 0,
    po: 0, // 刺殺
    a: 0, // 補殺
    e: 0, // 失策
    oaaOuts: 0, // OAA（実アウト − 期待アウト、outs単位）§7.2。集計で加算
    framingRuns: 0, // フレーミング(捕手)。集計で加算
    // --- B3b UZR成分分解の素（ARM/DPR/rSB・§B3b）。game.mjs で乱数非消費のまま累積する。
    // これらは WAR用 uzrRuns には入れず、uzrComponents（分解表示）でのみ合成する（較正30指標が不変）。
    armOpp: 0, // 外野: 単打×二塁走者 / 二塁打×一塁走者 の追加進塁機会に相対した回数
    armRuns: 0, // 外野ARM run（(arm-50)×armRunPerOpp を機会ごとに累積・対平均）
    dpOpp: 0, // 二遊間: 併殺機会（GB×走者一塁×2死未満で当該ポジ在籍）
    dpTurned: 0, // うち併殺成立（DPR＝対リーグ平均転換率で metrics 側が run 換算）
    sbAllowed: 0, // 捕手: 許した盗塁（rSBの素）
    csMade: 0, // 捕手: 刺した盗塁死（rSBの素）
    // --- B1 捕手の一球ごとの創発（§B1-2）。フレーミング/ブロッキングを一球単位で計上。
    frameCalls: 0, // ボーダー球で獲得した見逃しストライク − 中立(borderCsBase) の累積（対リーグ平均）
    wp: 0, // 暴投（この捕手が受けた投手の暴投・走者進塁を許した数）
    pb: 0, // 捕逸（この捕手起因の後逸・走者進塁）
    blockOpp: 0, // ブロッキング機会（走者ありでのワンバウンド球数。wp+pb の分母）
  };
}

/** 選手×シーズンの器（layer2 観測成績の実体） */
export function createPlayerSeason(playerId, season) {
  return {
    playerId,
    season,
    teamId: null,
    batting: createBattingLine(),
    pitching: createPitchingLine(),
    baserunning: createBaserunningLine(),
    fielding: createFieldingLine(),
  };
}

/** チーム×シーズンの器（順位表の実体）。RS/RAはチーム得点＝個人R保留とは別（§18・F6）。 */
export function createTeamSeason(teamId, season) {
  return {
    teamId,
    season,
    g: 0,
    w: 0,
    l: 0,
    t: 0, // 引分（NPBは延長規定あり）
    rs: 0, // 得点（チーム）
    ra: 0, // 失点（チーム）
  };
}

// --- 集計ヘルパー（2パス集計・通算集計で使用） -------------------------------

/** バッティングを加算（dst に src を足し込む）。evMax のみ最大（通算集計での二重加算を防ぐ・B3a）。 */
export function addBattingLine(dst, src) {
  const em = Math.max(dst.evMax || 0, src.evMax || 0);
  addNumeric(dst, src);
  dst.evMax = em;
  return dst;
}

/** ピッチングを加算 */
export function addPitchingLine(dst, src) {
  return addNumeric(dst, src);
}

/** 走塁を加算 */
export function addBaserunningLine(dst, src) {
  return addNumeric(dst, src);
}

/** 守備を加算（positionOuts マップは個別に、他は数値加算） */
export function addFieldingLine(dst, src) {
  for (const p of Object.keys(src.positionOuts || {})) {
    dst.positionOuts[p] = (dst.positionOuts[p] || 0) + src.positionOuts[p];
  }
  for (const k of Object.keys(src)) {
    if (k !== 'positionOuts' && typeof src[k] === 'number') dst[k] = (dst[k] || 0) + src[k];
  }
  return dst;
}

/** 選手シーズンを別の器へ加算（通算/リーグ集計用） */
export function addPlayerSeason(dst, src) {
  addBattingLine(dst.batting, src.batting);
  addPitchingLine(dst.pitching, src.pitching);
  addBaserunningLine(dst.baserunning, src.baserunning);
  addFieldingLine(dst.fielding, src.fielding);
  return dst;
}

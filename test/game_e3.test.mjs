// ============================================================================
// フェーズE3: ストーブリーグUI（編成操作）の決定論テスト。
//   - 見込み計算（FA宣言予測/受諾見込み/AI提案）は純関数＝ゲーム状態を一切変えない
//     （UIを何度開いても・見込みを何度計算しても、セーブ内容が bit 一致）
//   - 同一介入列（bidFA＋proposeTrade）のセーブ→ロード→advanceYear が無セーブ通しと同一結果
//     （既存 c1a/c3b テストの流儀。介入は marketInterventions ログだけで再現される）
//   - FA宣言予測（stoveFaForecast）は runFA と同一ハッシュ座標＝実際のFA成立は必ず予測の部分集合
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, save, load, bidFA, proposeTrade } from '../src/game/index.mjs';
import { teamEvalProfile } from '../src/game/market.mjs';
import { stoveFaForecast, stoveTradeVerdict, stoveAiOffers } from '../src/ui/stove.mjs';

const cfg = createConfig();
const SEED = 20260701;

/** 1年目をシーズン終了まで回した状態（ストーブリーグ画面が開くタイミング）。 */
function mkSeasonEnd() {
  const s = newGame(SEED, 'T1', { cfg });
  advanceTo(s, 'seasonEnd');
  return s;
}

const BASE = mkSeasonEnd();
// 介入前・年送り前のFA宣言予測（自チーム込み全量）。後段の「予測⊇実績」検証に使う。
const FORECAST = stoveFaForecast(BASE);

test('E3: 見込み計算（宣言予測/受諾見込み/AI提案）はゲーム状態を一切変えない（純関数）', () => {
  const before = JSON.stringify(save(BASE));
  // ストーブリーグUIが描画時に行う計算をすべて実行する（乱数は makeRng(hashSeed(...)) の局所生成のみ）。
  stoveFaForecast(BASE);
  const profiles = new Map(BASE.league.teams.map((t) => [t.id, teamEvalProfile(BASE.masterSeed, t.id, cfg)]));
  stoveAiOffers(BASE, profiles);
  const mine = BASE.league.players.find((p) => p.teamId === 'T1' && p.role === 'fielder');
  const other = BASE.league.players.find(
    (p) => p.teamId !== 'T1' && p.role === 'fielder' && p.primaryPos === mine.primaryPos,
  );
  const v = stoveTradeVerdict(BASE, profiles, mine, other);
  assert.ok(Number.isFinite(v.gain) && typeof v.accept === 'boolean', '受諾見込みが算出される');
  assert.equal(JSON.stringify(save(BASE)), before, '見込み計算の前後でセーブ内容が bit 一致（状態不変）');
});

test('E3: 同一介入列（bidFA＋proposeTrade）— save→load→advanceYear が無セーブ通しと一致（決定論）', () => {
  // ストーブリーグUIと同じ順で介入を積む: FA宣言見込み（他球団）の先頭へ入札＋同型トレード起案。
  const fcOthers = FORECAST.filter((p) => p.teamId !== 'T1');
  assert.ok(fcOthers.length >= 1, `FA宣言見込み（他球団）がいる（seed固定・got ${fcOthers.length}）`);
  bidFA(BASE, fcOthers[0].id);
  // 起案対象は「主力級の若手×FA宣言予測外」に絞る。対象がオフに動く（引退/FA/淘汰/戦力外）と
  // 起案は無効化される仕様で、旧実装の「先頭の野手」は選手アイデンティティ刷新（2026-07-20）の
  // 世界引き直しで、ちょうどR7淘汰（低観測スコアの選手をドラフト枠確保のため放出）に
  // かかる選手を引いた（決定論照合そのものは一致＝世界依存の副条件だけの問題）。
  // 淘汰・戦力外は観測貢献の低い選手が対象＝真値上位の若手レギュラー級なら構造的にかからない。
  const fcIdSet = new Set(FORECAST.map((p) => p.id));
  const ability = (p) => {
    const b = p.trueAbility.batting;
    return b.ev + b.contact + b.eye + p.trueAbility.common.power;
  };
  const bestTradable = (pred) => BASE.league.players
    .filter((p) => p.role === 'fielder' && p.age <= 28 && !fcIdSet.has(p.id) && pred(p))
    .sort((a, b) => ability(b) - ability(a))[0];
  const mine = bestTradable((p) => p.teamId === 'T1');
  const other = bestTradable((p) => p.teamId !== 'T1' && p.primaryPos === mine.primaryPos);
  proposeTrade(BASE, mine.id, other.id);

  const blob = JSON.parse(JSON.stringify(save(BASE)));
  assert.equal(blob.marketInterventions.length, 2, 'FA入札＋トレード起案がセーブに載る');
  const restored = load(blob, { cfg });
  assert.equal(restored.marketInterventions.length, 2, '介入ログが復元される');

  // 年送り（オフシーズン処理）: FA/トレード/ドラフト/拾い上げの解決が両者で bit 同一。
  const offS = advanceYear(BASE);
  const offR = advanceYear(restored);
  const faSig = (off) => off.fa.map((f) => `${f.playerId}:${f.from}>${f.to}:${f.via}`).sort().join('|');
  const trSig = (off) => off.trades.map((t) => `${t.aPlayer}>${t.bPlayer}:${t.via}:${t.rejected ? 'x' : 'o'}`).sort().join('|');
  const rkSig = (off) => off.rookies.map((p) => `${p.id}:${p.teamId}`).sort().join('|');
  assert.equal(faSig(offR), faSig(offS), 'FA解決（入札介入込み）が一致');
  assert.equal(trSig(offR), trSig(offS), 'トレード解決（起案の受諾/拒否）が一致');
  assert.equal(rkSig(offR), rkSig(offS), 'ドラフト新人の割当が一致');
  assert.equal(offR.pickups.length, offS.pickups.length, '拾い上げ件数が一致');

  // 起案トレードは必ず記録に現れる（受諾 or 拒否。対象が動いた場合の無効はこのシードでは起きない）。
  assert.ok(
    offS.trades.some((t) => t.via === 'player' && t.aPlayer === mine.id && t.bPlayer === other.id),
    '起案トレードが via=player で記録される（受諾/拒否いずれでも）',
  );
  // FA宣言予測は runFA と同一ハッシュ座標 → 実際のFA成立は予測の部分集合（引退で流れる場合のみ減る）。
  const fcIds = new Set(FORECAST.map((p) => p.id));
  for (const f of offS.fa) assert.ok(fcIds.has(f.playerId), `FA成立 ${f.playerId} は宣言予測に含まれる`);

  // 2年目を1週回しても分岐しない（開幕状態＝真値/ロスター/ILの完全一致の帰結）。
  advanceTo(BASE, 'weekEnd');
  advanceTo(restored, 'weekEnd');
  const stSig = (s) => [...s.rt.standings.values()]
    .map((r) => `${r.teamId}:${r.w}-${r.l}-${r.t}:${r.rs}/${r.ra}`)
    .sort()
    .join('|');
  assert.equal(stSig(restored), stSig(BASE), 'load 後の2年目進行が無セーブ通しと bit 一致');
});

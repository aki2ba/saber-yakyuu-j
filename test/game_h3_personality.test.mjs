// ============================================================================
// フェーズH3: 性格タグ＋観測ベース評判ラベル（phaseH_fun_spec H3）のテスト。
//
//   H3-1 性格: assignPersonality(id) の決定論（純関数・id基準）／8種の分布が偏りすぎない／
//     旧セーブ（personality欠落）の load 時補完が新規生成と同式で一致する／
//     効果（ムラっ気=aging drift SD、お調子者=breakout上下確率）が config どおりに効き、
//     かつ期待値（平均）は動かさない（分散だけ増える）ことを統計的に検証する。
//   H3-2 評判ラベル: mediaReputation が合成フィクスチャの集計値と整合する（各タグの閾値境界）。
//     trueAbility を一切参照しない（真値を書き換えても結果が変わらない＝三層構造の直接証明）。
//   多年ドリフト帯不変（性格効果を含めても）は test/game_multiyear.test.mjs のPASSで代替する
//   （phaseH_fun_spec H3「多年ドリフト帯不変（gm分散変更の影響確認）」の指示どおり）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague, assignPersonality } from '../src/generate.mjs';
import { createPlayer, createTrueAbility, PERSONALITIES, PERSONALITY_LABELS } from '../src/model/player.mjs';
import { hashSeed } from '../src/rng.mjs';
import { applyAging } from '../src/game/aging.mjs';
import { applyBreakouts } from '../src/game/breakout.mjs';
import { newGame, save, load } from '../src/game/index.mjs';
import { mediaReputation, REPUTATION_LABELS, careerRispEdge } from '../src/game/awards.mjs';
import { createBattingLine, createPitchingLine, createBaserunningLine, createSplitLine } from '../src/model/statline.mjs';

const cfg = createConfig();
const SEED = 20260714;

// --- ヘルパー: 合成 careerStats 行（H1テストの statRow 流儀を踏襲）。 ------------------
function battingRow(playerId, season, over = {}) {
  const { splits: splitsOver, ...rest } = over;
  const b = { ...createBattingLine(), ...rest };
  if (splitsOver) b.splits = { ...b.splits, ...splitsOver };
  return { playerId, teamId: 'T1', season, batting: b, pitching: null, baserunning: createBaserunningLine(), fielding: null };
}
function pitchingRow(playerId, season, over = {}) {
  const p = { ...createPitchingLine(), ...over };
  return { playerId, teamId: 'T1', season, batting: null, pitching: p, baserunning: null, fielding: null };
}
function battingRowWithBaserunning(playerId, season, battingOver, baserunningOver) {
  const row = battingRow(playerId, season, battingOver);
  row.baserunning = { ...createBaserunningLine(), ...baserunningOver };
  return row;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const variance = (a) => { const m = mean(a); return mean(a.map((x) => (x - m) ** 2)); };

// ============================================================================
// H3-1: 性格タグの付与・決定論・分布
// ============================================================================

test('H3-1: assignPersonality は id 基準の純関数（同一idは常に同一結果・8種のいずれか）', () => {
  for (const id of ['T1P1', 'T5F12', 'T12D3', 'rookie-xyz']) {
    const a = assignPersonality(id);
    const b = assignPersonality(id);
    assert.equal(a, b, `${id} の性格は再計算しても不変`);
    assert.ok(PERSONALITIES.includes(a), `${a} は PERSONALITIES に含まれる`);
  }
});

test('H3-1: 性格は id だけに依存する（masterSeed に依らない）＝独立シードで生成ストリームを乱さない', () => {
  const leagueA = generateLeague(1, cfg);
  const leagueB = generateLeague(2, cfg);
  const pA = leagueA.players.find((p) => p.id === 'T1P1');
  const pB = leagueB.players.find((p) => p.id === 'T1P1');
  assert.ok(pA && pB, '両リーグに T1P1 が存在する（生成プランが同一のため）');
  assert.equal(pA.personality, pB.personality, '同じ id は別 masterSeed でも同じ性格（idのみに依存）');
});

test('H3-1: generateLeague は決定論（同一masterSeedなら全選手のpersonalityが完全一致）', () => {
  const l1 = generateLeague(SEED, cfg);
  const l2 = generateLeague(SEED, cfg);
  assert.equal(l1.players.length, l2.players.length);
  for (let i = 0; i < l1.players.length; i++) {
    assert.equal(l1.players[i].id, l2.players[i].id);
    assert.equal(l1.players[i].personality, l2.players[i].personality);
  }
});

test('H3-1: 性格の分布は8種すべてが現れ、偏りすぎない（4000件・一様乱数の期待どおり）', () => {
  const N = 4000;
  const counts = Object.fromEntries(PERSONALITIES.map((k) => [k, 0]));
  for (let i = 0; i < N; i++) counts[assignPersonality(`SYN${i}`)]++;
  const expect = N / PERSONALITIES.length; // 500
  for (const k of PERSONALITIES) {
    assert.ok(counts[k] > 0, `${k} が一度も出現しない（分布バグ）`);
    assert.ok(counts[k] > expect * 0.7 && counts[k] < expect * 1.3, `${k} の出現数 ${counts[k]} が期待値 ${expect} から大きく外れる`);
  }
});

test('H3-1: 新規生成の全選手・育成選手が personality を持つ（validatePlayer相当の網羅チェック）', () => {
  const league = generateLeague(SEED, cfg);
  for (const p of [...league.players, ...(league.farm ?? [])]) {
    assert.ok(PERSONALITIES.includes(p.personality), `${p.id} の personality が不正: ${p.personality}`);
  }
});

test('H3-1: 旧セーブ（personality欠落）は load 時に新規生成と同式で補完される', () => {
  const st = newGame(SEED, 'T1', { cfg });
  const original = new Map([...st.league.players, ...(st.league.farm ?? [])].map((p) => [p.id, p.personality]));
  const blob = JSON.parse(JSON.stringify(save(st))); // JSON往復（save/loadの実運用と同じ形）
  for (const p of blob.leagueSnapshot.players) delete p.personality; // 旧セーブを模擬
  for (const p of blob.leagueSnapshot.farm) delete p.personality;
  const restored = load(blob, { cfg });
  for (const p of [...restored.league.players, ...(restored.league.farm ?? [])]) {
    assert.equal(p.personality, assignPersonality(p.id), `${p.id}: load補完が assignPersonality と不一致`);
    assert.equal(p.personality, original.get(p.id), `${p.id}: load補完が新規生成時の値と不一致`);
  }
});

test('H3-1: PERSONALITY_LABELS は8種すべてに日本語ラベルを持つ', () => {
  for (const k of PERSONALITIES) {
    assert.equal(typeof PERSONALITY_LABELS[k], 'string');
    assert.ok(PERSONALITY_LABELS[k].length > 0);
  }
});

// ============================================================================
// H3-1: 性格の効果（オフシーズン処理限定・期待値保存・分散のみ変える）
// ============================================================================

test('H3-1（ムラっ気）: aging の年次ドリフトSDが streakyDriftMult 倍になる（平均は不変・分散だけ増える）', () => {
  const N = 4000;
  const peak = 27;
  const age = peak + 2; // 'hands'プロファイル(peakShift=2,declineOffset=3)で growEnd<=age<onset＝curveDelta=0
  const streaky = [];
  const base = [];
  for (let i = 0; i < N; i++) {
    const t1 = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
    streaky.push(createPlayer({ id: `S${i}`, age, role: 'fielder', trueAbility: t1, personality: 'streaky' }));
    const t2 = createTrueAbility({ career: { peakAge: peak, declineRate: 0.5 } });
    base.push(createPlayer({ id: `B${i}`, age, role: 'fielder', trueAbility: t2, personality: 'reticent' }));
  }
  applyAging(streaky, cfg, { seed: hashSeed(SEED, 'streakytest') });
  applyAging(base, cfg, { seed: hashSeed(SEED, 'streakytest') }); // 同一シード基盤（id違いで独立に派生・順序非依存）

  const dS = streaky.map((p) => p.trueAbility.common.hands - 50);
  const dB = base.map((p) => p.trueAbility.common.hands - 50);
  assert.ok(Math.abs(mean(dS)) < 0.15, `streaky平均が0から乖離しすぎ（期待値保存の違反）: ${mean(dS)}`);
  assert.ok(Math.abs(mean(dB)) < 0.15, `baseline平均が0から乖離しすぎ: ${mean(dB)}`);

  const varS = variance(dS);
  const varB = variance(dB);
  const ratio = varS / varB;
  const expectRatio = cfg.tuning.personality.streakyDriftMult ** 2; // 1.25^2=1.5625
  assert.ok(ratio > 1.2, `ムラっ気の分散が有意に大きくない（ratio=${ratio.toFixed(3)}）`);
  assert.ok(ratio > expectRatio * 0.75 && ratio < expectRatio * 1.3, `分散比 ${ratio.toFixed(3)} が期待 ${expectRatio.toFixed(3)} から大きく外れる`);
});

test('H3-1（お調子者）: breakout の上方/下方確率が showboatBreakoutMult 倍になる（発生数が有意に多い）', () => {
  const N = 15000;
  const age = cfg.tuning.breakout.youngAge + 1; // young/burnoutの補正が乗らない年齢帯
  const showboat = [];
  const base = [];
  for (let i = 0; i < N; i++) {
    const t1 = createTrueAbility({ career: { peakAge: 27, declineRate: 0.5 } });
    showboat.push(createPlayer({ id: `SB${i}`, age, role: 'fielder', trueAbility: t1, personality: 'showboat' }));
    const t2 = createTrueAbility({ career: { peakAge: 27, declineRate: 0.5 } });
    base.push(createPlayer({ id: `BB${i}`, age, role: 'fielder', trueAbility: t2, personality: 'reticent' }));
  }
  const evS = applyBreakouts(showboat, cfg, { seed: hashSeed(SEED, 'showboattest'), year: 5 });
  const evB = applyBreakouts(base, cfg, { seed: hashSeed(SEED, 'showboattest'), year: 5 });
  assert.ok(evS.length > 0 && evB.length > 0, '両群ともブレイクイベントが観測できる十分なサンプル');
  const ratio = evS.length / evB.length;
  const expectRatio = cfg.tuning.personality.showboatBreakoutMult; // 1.2
  assert.ok(evS.length > evB.length, `お調子者のブレイク発生数(${evS.length})がbaseline(${evB.length})を上回らない`);
  assert.ok(ratio > expectRatio * 0.75 && ratio < expectRatio * 1.35, `発生数比 ${ratio.toFixed(3)} が期待 ${expectRatio} から大きく外れる`);
  // §11.1: 下方≧上方の比は掛け算しても保たれる（インフレ方向のバイアスを追加しない）
  const upS = evS.filter((e) => e.dir === 'up').length;
  const downS = evS.filter((e) => e.dir === 'down').length;
  assert.ok(downS >= upS, '性格補正後も下方が上方以上（§11.1バランス維持）');
});

test('H3-1: 性格が無い（personality:null）選手には効果が乗らない（旧経路・単体呼び出しの後方互換）', () => {
  const t = createTrueAbility({ career: { peakAge: 27, declineRate: 0.5 } });
  const p = createPlayer({ id: 'NOPERS', age: 29, role: 'fielder', trueAbility: t, personality: null });
  assert.doesNotThrow(() => applyAging([p], cfg, { seed: hashSeed(SEED, 'nopers') }));
});

// ============================================================================
// H3-2: 評判ラベル「メディア評」— 集計値との整合・境界・真値非参照
// ============================================================================

test('H3-2: REPUTATION_LABELS は mediaReputation が返しうる全キーに日本語ラベルを持つ', () => {
  for (const k of ['clutch', 'drama', 'choke', 'glass', 'ironman', 'fireman', 'mopup']) {
    assert.equal(typeof REPUTATION_LABELS[k], 'string');
    assert.ok(REPUTATION_LABELS[k].length > 0);
  }
});

test('H3-2: 勝負師/劇場型 — RISP成績が通算より明確に高い野手にタグが付く（careerRispEdgeとの整合）', () => {
  const R = cfg.tuning.awards.reputation;
  const player = { id: 'CLUTCH1', role: 'fielder' };
  // overall: 打率.250程度、RISP: 打率.400超級（edge/rispShareともに閾値を明確に超える）
  const rows = [
    battingRow(player.id, 0, {
      pa: 500, ab: 450, h: 113, b1: 80, b2: 20, b3: 3, hr: 10, bb: 40, hbp: 5, so: 90, sf: 5,
      splits: { risp: { ...createSplitLine(), pa: 180, ab: 150, h: 75, b1: 40, b2: 15, b3: 3, hr: 8, bb: 25, hbp: 3, so: 20, sf: 2 } },
    }),
    battingRow(player.id, 1, {
      pa: 500, ab: 450, h: 113, b1: 80, b2: 20, b3: 3, hr: 10, bb: 40, hbp: 5, so: 90, sf: 5,
      splits: { risp: { ...createSplitLine(), pa: 180, ab: 150, h: 75, b1: 40, b2: 15, b3: 3, hr: 8, bb: 25, hbp: 3, so: 20, sf: 2 } },
    }),
  ];
  const re = careerRispEdge(rows, player.id);
  assert.ok(re.sampleAb >= R.minRispAb, 'サンプルABがゲート以上（テスト前提の確認）');
  assert.ok(re.edge >= R.clutchHot, `edge(${re.edge.toFixed(3)}) が clutchHot(${R.clutchHot}) 未満＝フィクスチャ設計ミス`);
  assert.ok(re.rispShare >= R.dramaRispShare, `rispShare(${re.rispShare.toFixed(3)}) が dramaRispShare(${R.dramaRispShare}) 未満＝フィクスチャ設計ミス`);
  const tags = mediaReputation(player, rows, [], cfg).map((t) => t.key);
  assert.ok(tags.includes('clutch'), '勝負師タグが付く');
  assert.ok(tags.includes('drama'), '劇場型タグが付く');
});

test('H3-2: 平凡なRISP成績の野手にはタグが付かない（閾値未満）', () => {
  const player = { id: 'AVG1', role: 'fielder' };
  const rows = [
    battingRow(player.id, 0, {
      pa: 500, ab: 450, h: 113, b1: 90, b2: 15, b3: 2, hr: 6, bb: 40, hbp: 5, so: 90, sf: 5,
      splits: { risp: { ...createSplitLine(), pa: 130, ab: 115, h: 29, b1: 23, b2: 4, b3: 0, hr: 2, bb: 10, hbp: 1, so: 25, sf: 2 } },
    }),
  ];
  const tags = mediaReputation(player, rows, [], cfg).map((t) => t.key);
  assert.ok(!tags.includes('clutch'), '平均的なRISP成績で勝負師は付かない');
  assert.ok(!tags.includes('drama'), '平均的なRISPシェアで劇場型は付かない');
  assert.ok(!tags.includes('choke'), '平均的な成績でブレーキは付かない');
});

test('H3-2: ブレーキ — 併殺率が高くRISPが低い野手にタグが付く', () => {
  const R = cfg.tuning.awards.reputation;
  const player = { id: 'BRAKE1', role: 'fielder' };
  const rows = [
    battingRowWithBaserunning(
      player.id, 0,
      {
        pa: 500, ab: 450, h: 108, b1: 90, b2: 14, b3: 1, hr: 3, bb: 35, hbp: 5, so: 80, sf: 5, gdp: 40,
        splits: { risp: { ...createSplitLine(), pa: 160, ab: 140, h: 20, b1: 18, b2: 1, b3: 0, hr: 1, bb: 8, hbp: 2, so: 40, sf: 2 } },
      },
      { gdpOpp: 90 },
    ),
  ];
  const gdpRate = 40 / 90;
  assert.ok(gdpRate >= R.gdpRateBrake, 'フィクスチャの併殺率がゲート以上（前提確認）');
  const tags = mediaReputation(player, rows, [], cfg).map((t) => t.key);
  assert.ok(tags.includes('choke'), 'ブレーキタグが付く');
});

test('H3-2: ガラスの体 — 通算離脱が多い選手にタグが付き、鉄人にはならない', () => {
  const R = cfg.tuning.awards.reputation;
  const player = { id: 'GLASS1', role: 'fielder' };
  const rows = [0, 1, 2].map((y) => battingRow(player.id, y, { pa: 300, ab: 270, h: 70 }));
  const injuryLog = [
    { id: player.id, year: 0, gamesLost: 60 },
    { id: player.id, year: 1, gamesLost: 60 },
    { id: player.id, year: 2, gamesLost: 40 },
  ];
  const sum = injuryLog.reduce((s, e) => s + e.gamesLost, 0);
  assert.ok(sum >= R.injuryGlassGames, '前提確認: 離脱合計がゲート以上');
  const tags = mediaReputation(player, rows, injuryLog, cfg).map((t) => t.key);
  assert.ok(tags.includes('glass'), 'ガラスの体タグが付く');
  assert.ok(!tags.includes('ironman'), 'ガラスの体と鉄人は同時に付かない（故障件数の条件が排他的）');
});

test('H3-2: 鉄人 — 長期在籍かつ故障ゼロの選手にタグが付く', () => {
  const R = cfg.tuning.awards.reputation;
  const player = { id: 'IRON1', role: 'pitcher' };
  const rows = [];
  for (let y = 0; y < R.ironManSeasons + 2; y++) rows.push(pitchingRow(player.id, y, { outs: 500, bf: 700, g: 25, gs: 25, er: 60, w: 12, l: 8 }));
  const tags = mediaReputation(player, rows, [], cfg).map((t) => t.key);
  assert.ok(tags.includes('ironman'), '鉄人タグが付く');
  assert.ok(!tags.includes('glass'), '故障ゼロなのでガラスの体は付かない');
});

test('H3-2: 火消し/敗戦処理 — 救援投手のセーブ+ホールド率で二分される', () => {
  const R = cfg.tuning.awards.reputation;
  const fireman = { id: 'FIRE1', role: 'pitcher' };
  const mopup = { id: 'MOP1', role: 'pitcher' };
  const reliefG = R.reliefMinG + 20;
  const fireRows = [pitchingRow(fireman.id, 0, { g: reliefG, gs: 0, sv: 30, hld: 40, outs: 300, bf: 400, er: 30 })];
  const mopRows = [pitchingRow(mopup.id, 0, { g: reliefG, gs: 0, sv: 0, hld: 2, outs: 300, bf: 420, er: 60 })];
  const fireRate = 70 / reliefG;
  const mopRate = 2 / reliefG;
  assert.ok(fireRate >= R.firemanSvHldRate, '前提確認: 火消しフィクスチャの率がゲート以上');
  assert.ok(mopRate <= R.mopupSvHldRate, '前提確認: 敗戦処理フィクスチャの率がゲート以下');
  const fireTags = mediaReputation(fireman, fireRows, [], cfg).map((t) => t.key);
  const mopTags = mediaReputation(mopup, mopRows, [], cfg).map((t) => t.key);
  assert.ok(fireTags.includes('fireman'), '火消しタグが付く');
  assert.ok(!fireTags.includes('mopup'), '火消しに敗戦処理は同時に付かない');
  assert.ok(mopTags.includes('mopup'), '敗戦処理タグが付く');
  assert.ok(!mopTags.includes('fireman'), '敗戦処理に火消しは同時に付かない');
});

test('H3-2: 先発投手（登板数が少ない）には火消し/敗戦処理どちらも付かない', () => {
  const player = { id: 'SP1', role: 'pitcher' };
  const rows = [pitchingRow(player.id, 0, { g: 25, gs: 25, outs: 700, bf: 900, er: 70, w: 14, l: 8 })];
  const tags = mediaReputation(player, rows, [], cfg).map((t) => t.key);
  assert.ok(!tags.includes('fireman') && !tags.includes('mopup'), '先発は救援専用タグの対象外（gs≒g で reliefG がゲート未満）');
});

test('H3-2: trueAbility を一切参照しない（真値を書き換えても・欠落させても結果が不変）', () => {
  const R = cfg.tuning.awards.reputation;
  const rows = [
    battingRow('P1', 0, {
      pa: 500, ab: 450, h: 113, b1: 80, b2: 20, b3: 3, hr: 10, bb: 40, hbp: 5, so: 90, sf: 5,
      splits: { risp: { ...createSplitLine(), pa: 180, ab: 150, h: 75, b1: 40, b2: 15, b3: 3, hr: 8, bb: 25, hbp: 3, so: 20, sf: 2 } },
    }),
    battingRow('P1', 1, {
      pa: 500, ab: 450, h: 113, b1: 80, b2: 20, b3: 3, hr: 10, bb: 40, hbp: 5, so: 90, sf: 5,
      splits: { risp: { ...createSplitLine(), pa: 180, ab: 150, h: 75, b1: 40, b2: 15, b3: 3, hr: 8, bb: 25, hbp: 3, so: 20, sf: 2 } },
    }),
  ];
  assert.ok(rows.length > 0 && R); // フィクスチャ生存確認
  const bare = { id: 'P1', role: 'fielder' }; // trueAbility フィールド自体が無い
  const decorated = { id: 'P1', role: 'fielder', trueAbility: { batting: { ev: 999, clutch: -999 }, career: { peakAge: 1 } } };
  const t1 = mediaReputation(bare, rows, [], cfg);
  const t2 = mediaReputation(decorated, rows, [], cfg);
  assert.deepEqual(t1.map((t) => t.key).sort(), t2.map((t) => t.key).sort(), 'trueAbilityの有無/内容で結果が変わってはならない');
});

// 多年ドリフト帯不変（性格による分散増を含めても得点環境がインフレしない）は
// test/game_multiyear.test.mjs のPASSで代替する（phaseH_fun_spec H3の指示どおり・§11.3参照）。

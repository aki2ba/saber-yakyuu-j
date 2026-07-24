// ============================================================================
// P0-1（thyroxin/reviews/game_review_20260724.md・p1_interactive_manager_spec §4）:
//   采配モーダル（src/ui.mjs showManagerDecisionModal）の候補行に判断材料を添える純関数群
//   （src/ui/watch.mjs）のユニットテスト。DOM(document)非依存の純関数のみを直接テストする
//   （watch_label.test.mjsと同型）。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { generateLeague } from '../src/generate.mjs';
import { simulateSeason } from '../src/sim/season.mjs';
import { deriveLeagueConstants } from '../src/sim/leagueConstants.mjs';
import {
  mgrBatSeasonText, mgrPitSeasonText, mgrPlatoonTag, mgrRoleTag, mgrRestTag,
} from '../src/ui/watch.mjs';

const cfg = createConfig();
const res = simulateSeason(generateLeague(2026, cfg), cfg, { season: 2026, seed: 2026 });
const lc = deriveLeagueConstants(res);

test('mgrBatSeasonText: 打席データが無い/未提供は「打席なし」（憶測を書かない）', () => {
  assert.equal(mgrBatSeasonText(null, lc), '打席なし');
  assert.equal(mgrBatSeasonText({ batting: { ab: 0 } }, lc), '打席なし');
  assert.equal(mgrBatSeasonText({ batting: undefined }, lc), '打席なし');
});

test('mgrBatSeasonText: 実データは「.xxx n本」形式（打率+HR・簡潔表記）', () => {
  const qual = res.playerSeasons.find((s) => s.batting.ab > 50);
  assert.ok(qual, '規定打席相当の選手が生成されていること（フィクスチャ前提）');
  const text = mgrBatSeasonText(qual, lc);
  assert.match(text, /^\.\d{3} \d+本$/, text);
});

test('mgrPitSeasonText: 登板データが無い/未提供は「登板なし」', () => {
  assert.equal(mgrPitSeasonText(null, lc), '登板なし');
  assert.equal(mgrPitSeasonText({ pitching: { outs: 0 } }, lc), '登板なし');
});

test('mgrPitSeasonText: 実データは「防x.xx K-BBn.n%」形式（防御率+K-BB%・簡潔表記）', () => {
  const qual = res.playerSeasons.find((s) => s.pitching.outs > 60);
  assert.ok(qual, '一定投球回の投手が生成されていること（フィクスチャ前提）');
  const text = mgrPitSeasonText(qual, lc);
  assert.match(text, /^防\d+\.\d{2} K-BB-?\d+\.\d%$/, text);
});

test('mgrPlatoonTag: 同投=不利・逆投=有利・両打=中立表示・情報不足は空文字', () => {
  assert.equal(mgrPlatoonTag('R', 'R'), '不利(同投)');
  assert.equal(mgrPlatoonTag('L', 'L'), '不利(同投)');
  assert.equal(mgrPlatoonTag('L', 'R'), '有利(逆投)');
  assert.equal(mgrPlatoonTag('R', 'L'), '有利(逆投)');
  assert.equal(mgrPlatoonTag('S', 'R'), '両打');
  assert.equal(mgrPlatoonTag('S', 'L'), '両打');
  assert.equal(mgrPlatoonTag(null, 'R'), '');
  assert.equal(mgrPlatoonTag('R', null), '');
});

test('mgrRoleTag: 先発(rotation)/クローザー/セットアップ/ロング/中継ぎ/該当なしを判別する', () => {
  const chart = {
    rotation: ['P1', 'P2'],
    bullpenRoles: { closer: 'C1', setup8: 'S8', setup7: 'S7', long: 'LG', middle: ['M1', 'M2'] },
  };
  assert.equal(mgrRoleTag(chart, 'P1'), '先発');
  assert.equal(mgrRoleTag(chart, 'C1'), 'クローザー');
  assert.equal(mgrRoleTag(chart, 'S8'), 'セットアップ(8)');
  assert.equal(mgrRoleTag(chart, 'S7'), 'セットアップ(7)');
  assert.equal(mgrRoleTag(chart, 'LG'), 'ロング');
  assert.equal(mgrRoleTag(chart, 'M1'), '中継ぎ');
  assert.equal(mgrRoleTag(chart, 'X9'), '', '未分類の投手は空文字（断定しない）');
  assert.equal(mgrRoleTag(null, 'P1'), '');
});

test('mgrRestTag: 前日/前々日の登板から連投状態を判定する', () => {
  const oneDayAgo = new Map([[9, 25]]);
  assert.equal(mgrRestTag(oneDayAgo, 10), '連投(前日25球)');
  assert.equal(mgrRestTag(oneDayAgo, 9), '', '登板日当日を起点に前日/前々日を見る＝自身の登板日はヒットしない');
  const twoDaysRunning = new Map([[8, 20], [9, 15]]);
  assert.equal(mgrRestTag(twoDaysRunning, 10), '連投3日目');
  const restedWell = new Map([[5, 30]]);
  assert.equal(mgrRestTag(restedWell, 10), '', '間隔が空いていれば連投タグは付かない');
  assert.equal(mgrRestTag(null, 10), '');
  assert.equal(mgrRestTag(oneDayAgo, null), '');
});

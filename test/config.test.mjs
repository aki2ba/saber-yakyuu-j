// 中央config（0-4）の単体テスト。較正の単一調整面と143試合媒介変数を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConfig,
  CALIBRATION_TARGETS,
  qualifiedPA,
  qualifiedIP,
  fieldingInningsFull,
  inRange,
} from '../src/config.mjs';

test('createConfig は独立したディープコピーを返す（較正ランが汚染しない）', () => {
  const a = createConfig();
  const b = createConfig();
  a.tuning.hrScale = 999;
  assert.notEqual(b.tuning.hrScale, 999);
  assert.equal(b.tuning.hrScale, createConfig().tuning.hrScale); // 値をハードコードせず新規既定と一致
});

test('createConfig は overrides を深くマージする', () => {
  const cfg = createConfig({ tuning: { hrScale: 1.2 }, league: { gamesPerSeason: 143 } });
  assert.equal(cfg.tuning.hrScale, 1.2);
  assert.equal(cfg.tuning.babipBase, 0.3, '未指定はデフォルト維持');
  assert.equal(cfg.league.gamesPerSeason, 143, 'override反映');
  assert.equal(cfg.league.numTeams, 6, '未指定はデフォルト維持');
});

test('リーグ設定は 6球団140試合・全球団DH有', () => {
  const cfg = createConfig();
  assert.equal(cfg.league.numTeams, 6);
  assert.equal(cfg.league.gamesPerSeason, 140);
  assert.equal(cfg.league.dh, 'all');
});

test('較正目標は古典寄り（打率.255-.262・ERA3.5-3.9・HR110-130）', () => {
  assert.deepEqual(CALIBRATION_TARGETS.batting.avg, [0.255, 0.262]);
  assert.deepEqual(CALIBRATION_TARGETS.pitching.era, [3.5, 3.9]);
  assert.deepEqual(CALIBRATION_TARGETS.batting.hrPerTeam, [110, 130]);
});

test('試合数依存の媒介変数は143試合基準（M3の再スケール）', () => {
  assert.equal(qualifiedPA(143), 443); // round(143×3.1)
  assert.equal(qualifiedIP(143), 143);
  assert.equal(fieldingInningsFull(143), 1287); // 143×9（MLBの1350を置換）
});

test('inRange は較正の合否判定に使える', () => {
  assert.equal(inRange(0.258, CALIBRATION_TARGETS.batting.avg), true);
  assert.equal(inRange(0.243, CALIBRATION_TARGETS.batting.avg), false);
});

test('deepAssign は null 上書きで例外を投げず、葉オブジェクトを複製する（A-8修正）', () => {
  const c = createConfig({ league: null, tuning: { bb: null } });
  assert.equal(c.league, null);
  assert.equal(c.tuning.bb, null);
  const arr = [1, 2];
  const c2 = createConfig({ targets: { batting: { avg: arr } } });
  arr.push(3);
  assert.equal(c2.targets.batting.avg.length, 2, 'override配列は複製され共有されない');
});

test('leagueConstants は 1-6 で埋める器（初期は null）', () => {
  const cfg = createConfig();
  assert.equal(cfg.leagueConstants.wobaScale, null);
  assert.equal(cfg.leagueConstants.rpw, null);
  assert.equal(cfg.leagueConstants.posAdjPer1350, null);
});

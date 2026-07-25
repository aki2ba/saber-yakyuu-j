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
  const cfg = createConfig({ tuning: { hrScale: 1.2 }, league: { gamesPerSeason: 99 } });
  assert.equal(cfg.tuning.hrScale, 1.2);
  assert.equal(cfg.tuning.babipBase, 0.3, '未指定はデフォルト維持');
  assert.equal(cfg.league.gamesPerSeason, 99, 'override反映');
  assert.equal(cfg.league.numTeams, 12, '未指定はデフォルト維持');
});

test('リーグ設定は 12球団143試合・2リーグ制（全リーグDH制）・ローテ6（フェーズA S1）', () => {
  const cfg = createConfig();
  assert.equal(cfg.league.numTeams, 12);
  assert.equal(cfg.league.gamesPerSeason, 143);
  assert.equal(cfg.league.rotationSize, 6);
  assert.equal(cfg.league.dh, undefined, "旧 dh:'all' は廃止（試合のDH有無=ホーム球団のリーグ規則）");
  assert.equal(cfg.league.leagues.length, 2);
  // 全リーグDH制（2026-07-25投手打席廃止のユーザー決定）: L1/L2とも dh:true。
  assert.equal(cfg.league.leagues[0].dh, true, 'L1は全リーグDH制でDH有り');
  assert.equal(cfg.league.leagues[1].dh, true, 'L2（パ系）はDH有り');
  for (const lg of cfg.league.leagues) {
    assert.ok(!/セントラル|パシフィック/.test(lg.name), 'リーグ名は完全架空の造語');
  }
});

test('新tuningノブ（platoon/bunt/ibb/sub/rest/fatigue/usage/depth）が揃っている（S1）', () => {
  const t = createConfig().tuning;
  assert.ok(t.platoon.kLogitSame > 0, '同利きでK増');
  assert.ok(t.platoon.bbLogitSame < 0, '同利きでBB減');
  assert.ok(t.platoon.evKmhSame < 0, '同利きでEV減');
  assert.ok(Math.abs(t.bunt.successProb + t.bunt.failProb + t.bunt.hitProb - 1) < 1e-9, '犠打の結果テーブルは合計1');
  for (const k of ['ibb', 'sub', 'rest', 'fatigue', 'usage', 'depth']) {
    assert.ok(t[k] && typeof t[k] === 'object', `tuning.${k} が存在`);
  }
  assert.equal(t.usage.reviewInterval, 25, '観測ベース見直しは25試合ごと（S3が消費）');
});

test('較正目標は古典寄り（打率.255-.262・ERA3.6-4.0・HR110-130）＋フェーズA新目標', () => {
  assert.deepEqual(CALIBRATION_TARGETS.batting.avg, [0.255, 0.262]);
  // ERA帯は全リーグDH制(2026-07-25)で[3.5,3.9]→[3.6,4.0]へ再アンカー（投手打席の自動アウト消滅で+0.1）
  assert.deepEqual(CALIBRATION_TARGETS.pitching.era, [3.6, 4.0]);
  assert.deepEqual(CALIBRATION_TARGETS.batting.hrPerTeam, [110, 130]);
  // フェーズA: 犠打 / WAR下限 / 正捕手出場（S4 calibrate が消費）
  // 2026-07-25 全リーグDH制化により runDiffDhMinusNoDh（セパ得点差）/ shPerTeamNoDh は削除済み
  // （DH無リーグが存在しなくなり概念が消滅。犠打は全リーグ共通の shPerTeam 帯で判定する）。
  assert.equal(CALIBRATION_TARGETS.batting.runDiffDhMinusNoDh, undefined, 'DH有無の対比リーグが無く概念が消滅');
  assert.ok(CALIBRATION_TARGETS.tactics.shPerTeam, '犠打は全リーグ共通帯');
  assert.equal(CALIBRATION_TARGETS.tactics.shPerTeamNoDh, undefined, '全リーグDH制でDH無区分は消滅');
  // WAR下限は2本立て（破局min>-4.0 ＋ 典型mean>-2.5）で「WAR-6の根絶」を判定
  assert.equal(CALIBRATION_TARGETS.war.floorCatastrophe, -4.0);
  assert.equal(CALIBRATION_TARGETS.war.floorTypical, -2.5);
  assert.ok(CALIBRATION_TARGETS.war.floorCatastrophe < CALIBRATION_TARGETS.war.floorTypical, '破局判定は典型判定より緩い');
  assert.deepEqual(CALIBRATION_TARGETS.war.totalLeague, [370, 430], '12球団×143試合');
  assert.deepEqual(CALIBRATION_TARGETS.usage.catcherStarterGames, [100, 135]);
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

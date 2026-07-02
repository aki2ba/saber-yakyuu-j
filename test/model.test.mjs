// コアデータ構造（0-3）の単体テスト。スキーマの形と集計ヘルパーを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlayer,
  createTrueAbility,
  createPitch,
  validatePlayer,
} from '../src/model/player.mjs';
import { createBattedBall, fenceDistanceAt, NEUTRAL_PARK } from '../src/model/battedball.mjs';
import {
  createPlayerSeason,
  createTeamSeason,
  addPlayerSeason,
} from '../src/model/statline.mjs';
import { FIELD_POSITIONS, POSITION_DIFFICULTY } from '../src/model/positions.mjs';

test('createPlayer は三層のコンテナを持つ（trueAbility / scoutSeed / career.seasons）', () => {
  const p = createPlayer({ id: 'p1', name: '架空 太郎', role: 'fielder' });
  assert.ok(p.trueAbility, 'layer1 trueAbility');
  assert.ok('scoutSeed' in p, 'layer3 基盤 scoutSeed');
  assert.deepEqual(p.career.seasons, {}, 'layer2 観測成績の器');
  assert.equal(validatePlayer(p).length, 0, 'validate passes');
});

test('投手系に Hold/クイックが存在する（wSBの入力・0-3で追加）', () => {
  const t = createTrueAbility();
  assert.equal(typeof t.pitching.hold, 'number');
  assert.equal(typeof t.pitching.velocityKmh, 'number');
});

test('能力素材は登録に依らず常時両方保持（野手でも投手系を持つ）', () => {
  const p = createPlayer({ role: 'fielder' });
  assert.ok(p.trueAbility.pitching);
  assert.ok(p.trueAbility.fielding.positionProf.SS !== undefined);
});

test('createTrueAbility は over で深くマージできる', () => {
  const t = createTrueAbility({ common: { speed: 75 }, batting: { ev: 70 } });
  assert.equal(t.common.speed, 75);
  assert.equal(t.batting.ev, 70);
  assert.equal(t.common.arm, 50, '未指定はデフォルト維持');
});

test('createPitch は空振り/被弾/コンタクト質の別プロファイルを持つ（§4）', () => {
  const pitch = createPitch('fork', { whiff: 70, hrSuppress: 60 });
  assert.equal(pitch.type, 'fork');
  assert.equal(pitch.whiff, 70);
  assert.equal(pitch.hrSuppress, 60);
  assert.equal(pitch.contactQuality, 50);
});

test('打球オブジェクトは3要素と幾何・塁状況フィールドを持つ', () => {
  const bb = createBattedBall({ evKmh: 160, laDeg: 25, sprayDeg: -20, baseState: 5 });
  assert.equal(bb.evKmh, 160);
  assert.equal(bb.landingX, null, '幾何は後段で埋める');
  assert.equal(bb.baseState, 5);
  assert.equal(bb.result, null);
});

test('fenceDistanceAt: 中堅が最長・ラインが最短', () => {
  const center = fenceDistanceAt(0, NEUTRAL_PARK);
  const line = fenceDistanceAt(45, NEUTRAL_PARK);
  assert.ok(center > line, `center ${center} > line ${line}`);
  assert.equal(center, 122);
  assert.equal(line, 100);
  assert.equal(fenceDistanceAt(-45), fenceDistanceAt(45), '中立球場は左右対称');
});

test('PlayerSeason は守備の positionOuts を全ポジション分持つ（posAdjの土台）', () => {
  const s = createPlayerSeason('p1', 2026);
  for (const pos of FIELD_POSITIONS) {
    assert.equal(s.fielding.positionOuts[pos], 0, `positionOuts.${pos}`);
  }
});

test('addPlayerSeason は打撃と守備イニングを正しく加算する', () => {
  const a = createPlayerSeason('p1', 2026);
  const b = createPlayerSeason('p1', 2026);
  a.batting.pa = 600; a.batting.h = 150; a.batting.hr = 20;
  a.fielding.positionOuts.SS = 3000;
  b.batting.pa = 50; b.batting.h = 10;
  b.fielding.positionOuts.SS = 200; b.fielding.positionOuts['2B'] = 100;
  addPlayerSeason(a, b);
  assert.equal(a.batting.pa, 650);
  assert.equal(a.batting.h, 160);
  assert.equal(a.batting.hr, 20);
  assert.equal(a.fielding.positionOuts.SS, 3200);
  assert.equal(a.fielding.positionOuts['2B'], 100, 'ユーティリティは複数ポジに分割計上');
});

test('TeamSeason は RS/RA を持つ（個人R保留とは別のチーム得点・§18/F6）', () => {
  const t = createTeamSeason('T1', 2026);
  assert.ok('rs' in t && 'ra' in t && 'w' in t && 'l' in t);
});

test('POSITION_DIFFICULTY は難→易の序列（先頭C, 末尾1B）', () => {
  assert.equal(POSITION_DIFFICULTY[0], 'C');
  assert.equal(POSITION_DIFFICULTY[POSITION_DIFFICULTY.length - 1], '1B');
});

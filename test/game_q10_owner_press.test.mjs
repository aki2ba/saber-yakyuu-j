// ============================================================================
// Q10: 開幕前「オーナー会見」演出（thyroxin/research/baseball_game_mechanics_research_20260723
//   Q10・OOTP press conference 翻案）のテスト。
//   ownerPressConference: 既存 state.ownerGoals（H5-B）を会見調の文章へ変換するだけの純関数
//   （新規判定/新規保存フィールド無し）。表示条件（yearIndex>=1・目標生成済み・開幕から
//   daysPerWeek日以内）と信任帯による文言分岐・決定論を実ゲームループで検証する。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.mjs';
import { newGame, advanceTo, advanceYear, advanceDay } from '../src/game/index.mjs';
import { ownerPressConference } from '../src/game/owner.mjs';

const SEED = 20260723;

test('Q10: 1年目（yearIndex=0）は常にnull', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  assert.equal(st.yearIndex, 0);
  assert.equal(ownerPressConference(st), null, '1年目は目標が無いのでnull');
});

test('Q10: 2年目開幕直後（daysPerWeek日以内）はカードを返す（信任行＋目標ぶんのlines）', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  advanceTo(st, 'seasonEnd');
  advanceYear(st);
  assert.equal(st.yearIndex, 1, '2年目開幕');
  assert.ok(st.ownerGoals && st.ownerGoals.goals.length, 'このシードでは目標が生成されている');
  const presser = ownerPressConference(st);
  assert.ok(presser, '開幕直後はカードを返す');
  assert.equal(presser.lines.length, 1 + st.ownerGoals.goals.length, '信任コメント1行＋目標ぶんのlines');
  assert.equal(presser.trust, st.ownerTrust);
  for (const g of st.ownerGoals.goals) {
    assert.ok(presser.lines.some((l) => l.includes(g.label)), `目標「${g.label}」の文言が会見に含まれる`);
  }
});

test('Q10: 開幕からdaysPerWeek日を過ぎると窓外でnullになる', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  advanceTo(st, 'seasonEnd');
  advanceYear(st);
  const span = st.cfg.game.daysPerWeek;
  for (let i = 0; i < span && !st.rt.finished; i++) advanceDay(st);
  assert.equal(ownerPressConference(st), null, 'daysPerWeek日を過ぎたら窓外＝null');
});

test('Q10: 信任帯で文言テンプレが分岐する（70以上/40以上/未満の3分岐）', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  advanceTo(st, 'seasonEnd');
  advanceYear(st);
  st.ownerTrust = 80;
  const hi = ownerPressConference(st).lines[0];
  st.ownerTrust = 50;
  const mid = ownerPressConference(st).lines[0];
  st.ownerTrust = 10;
  const lo = ownerPressConference(st).lines[0];
  assert.notEqual(hi, mid);
  assert.notEqual(mid, lo);
  assert.notEqual(hi, lo);
});

test('Q10: ownerGoals未生成/自チーム未設定なら常にnull', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  advanceTo(st, 'seasonEnd');
  advanceYear(st);
  const saved = st.ownerGoals;
  st.ownerGoals = { yearIndex: st.yearIndex, goals: [] };
  assert.equal(ownerPressConference(st), null, '目標0件はnull');
  st.ownerGoals = saved;
  assert.equal(ownerPressConference({ ...st, playerTeamId: null }), null, '自チーム未設定はnull');
});

test('Q10: 決定論 — 同一state入力は同一出力（純関数・stateを変更しない）', () => {
  const st = newGame(SEED, 'T1', { cfg: createConfig() });
  advanceTo(st, 'seasonEnd');
  advanceYear(st);
  const before = JSON.stringify({ trust: st.ownerTrust, goals: st.ownerGoals });
  const a = JSON.stringify(ownerPressConference(st));
  const b = JSON.stringify(ownerPressConference(st));
  assert.equal(a, b, '同一input同一output');
  const after = JSON.stringify({ trust: st.ownerTrust, goals: st.ownerGoals });
  assert.equal(after, before, 'ownerPressConferenceはstateを変更しない');
});

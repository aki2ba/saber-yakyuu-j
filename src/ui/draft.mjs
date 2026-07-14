// ============================================================================
// H2: プレイヤー参加型ドラフト会議室（phaseH_fun_spec H2）
//
// cfg.game.interactiveDraft=true（ui.mjs の startNewGame が既定でオーバーライド）のとき、
// advanceYear が自チームの指名番で中断し state.awaitingDraft を立てる
// （src/game/index.mjs driveOffseasonDraft/submitDraftPick・runDraft の pause/resume）。
// 本モジュールはその中断状態を1画面で見せ、指名を submitDraftPick へ送って解決を続ける。
//
// 設計原則:
//   - 真値は絶対に見せない: 表示はすべて draftScoutView（obsTool/evaluateProspect 由来の
//     等級・ツール別5段階・伸びしろ・経歴タグ・世代内評判）のみ。prospect.trueAbility には
//     一切触れない（state.awaitingDraft.pool は内部的に真値を持つが、本画面はそれを読まない）。
//   - 決定論に無干渉: 本画面の操作は submitDraftPick が積む marketInterventions ログのみが
//     ゲーム状態を変える（描画・ソートはすべて純関数＝draftScoutView/draftPreviewHeadlines）。
//   - バンドル: build.mjs が src/ui/*.mjs を ui.mjs と同一<script>へ前置concatする
//     （stove.mjs/team.mjs と同じ流儀。ui.mjs のヘルパーは u=draftDeps() 経由で受け取る）。
// ============================================================================
import { submitDraftPick, draftScoutView, draftPreviewHeadlines } from '../game/index.mjs';

const GRADE_ORDER = { S: 0, A: 1, B: 2, C: 3, D: 4 };

/** 型（role:primaryPos）の日本語表示（投手は「投手」・野手は守備位置そのまま）。 */
function typeLabel(v, u) {
  return v.role === 'pitcher' ? '投手' : u.posJP(v.primaryPos);
}

/** ツール別5段階のワンライナー表示（役割で軸が異なる）。 */
function toolsText(role, tools) {
  if (role === 'pitcher') return `球速${tools.velo} 制球${tools.control} スタミナ${tools.stamina} 球種${tools.stuff}`;
  return `打撃${tools.contact} パワー${tools.power} 走力${tools.speed} 守備${tools.defense} 肩${tools.arm}`;
}

/** 世代内評判のバッジ文言（無ければ '-'）。 */
function hypeText(hype) {
  return hype ?? '-';
}

/**
 * ドラフト会議室画面（H2）。u=ui.mjs 共有ヘルパー束（draftDeps()）。
 * state.awaitingDraft が無ければ何もできない（呼び出し側のバグ）＝ホームへフォールバック。
 */
export function renderDraftRoomScreen(u) {
  const { el, game } = u;
  const gs = game.gs;
  const aw = gs.awaitingDraft;
  const root = document.getElementById('app');
  root.innerHTML = '';
  if (!aw) { u.renderHub(); return; }

  root.append(el('div', { class: 'header' }, [
    el('h2', {}, [`${gs.year}年 ドラフト会議　`, el('span', { class: 'muted' }, `${u.tname(aw.teamId)}の指名番・${aw.round}巡目`)]),
  ]));

  const content = el('div', { id: 'content' });
  root.append(content);

  if (aw.contested) {
    content.append(el('div', { class: 'newsrow bad', style: 'margin:6px 0' },
      '前回指名した選手は競合くじで外れました。別の候補を再指名してください。'));
  }

  // ドラフト前ニュース「今年の目玉」（H2: draftPreviewHeadlines・世代内評判consensus上位）。
  if (aw.round === 1) {
    const headlines = draftPreviewHeadlines(gs);
    if (headlines.length) {
      content.append(el('h3', { class: 'leaguename' }, `📣 今年の目玉（${headlines.length}人）`));
      content.append(el('div', { class: 'awardlist' }, headlines.map((h) => {
        const pr = aw.pool.find((p) => p.id === h.prospectId);
        const name = pr ? pr.name : h.prospectId;
        return el('div', { class: 'awardrow' }, [
          el('span', {}, name),
          el('span', { class: 'muted' }, `　${typeLabel(h, u)}・${h.age}歳・${h.cohort}`),
        ]);
      })));
    }
  }

  // 指名済みボード（全球団・確定順）。
  if (aw.picksSoFar.length) {
    content.append(el('h3', { class: 'leaguename' }, `指名済み（${aw.picksSoFar.length}人）`));
    content.append(el('div', { class: 'awardlist' }, aw.picksSoFar.map((pk) => el('div', { class: 'awardrow' }, [
      el('span', { class: 'muted' }, `${pk.round}巡`),
      el('span', {}, u.tname(pk.teamId)),
      el('span', {}, pk.name ?? pk.prospectId),
      el('span', { class: 'muted' }, `　${pk.role === 'pitcher' ? '投手' : u.posJP(pk.primaryPos)}・${pk.age}歳${pk.contested ? '（くじ）' : ''}`),
    ]))));
  }

  // 自チームの指名候補（残り空き枠の型と一致するプールのみ＝「自番で選択」）。
  const vacTypes = new Set(aw.vacTypes.map((v) => `${v.role}:${v.primaryPos}`));
  const vacLabel = aw.vacTypes.map((v) => typeLabel(v, u)).join('・');
  content.append(el('div', { class: 'muted', style: 'margin:6px 0' }, `残り空き枠: ${vacLabel}`));

  const candidates = aw.pool.filter((p) => vacTypes.has(`${p.role}:${p.primaryPos}`));
  const rows = candidates
    .map((p) => ({ p, sv: draftScoutView(gs, p, aw.pool) }))
    .sort((a, b) => (GRADE_ORDER[a.sv.grade] - GRADE_ORDER[b.sv.grade]) || (b.sv.myPercentile - a.sv.myPercentile) || (a.p.id < b.p.id ? -1 : 1));

  content.append(el('h3', { class: 'leaguename' }, `指名候補（${rows.length}人）`));
  const headers = ['等級', '選手', '位置', '年齢', '経歴', '性格', 'ツール', '伸びしろ', '評判', '指名'];
  const trs = rows.map(({ p, sv }) => el('tr', {}, [
    el('td', {}, sv.grade),
    el('td', { class: 'left' }, p.name),
    el('td', { class: 'left' }, typeLabel(p, u)),
    el('td', {}, String(p.age)),
    el('td', { class: 'left' }, sv.cohort),
    el('td', { class: 'left' }, u.PERSONALITY_LABELS[sv.personality] ?? '-'), // H3-1: スカウトは性格を直接観察できる
    el('td', { class: 'left' }, toolsText(p.role, sv.tools)),
    el('td', { class: 'left' }, sv.upside),
    el('td', { class: 'left' }, hypeText(sv.hype)),
    el('td', { class: 'left' }, [el('button', { class: 'primary', onclick: () => handlePick(u, p.id) }, '指名する')]),
  ]));
  content.append(el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { class: 'left' }, h)))),
    el('tbody', {}, trs),
  ])]));
}

/** 指名ボタンのハンドラ: submitDraftPick で解決を進め、中断が続けば再描画・完了ならオフダイジェストへ。 */
function handlePick(u, prospectId) {
  const gs = u.game.gs;
  const off = submitDraftPick(gs, prospectId);
  u.autoSave(); // H2: 中断中も進捗を永続化（marketInterventions/offseasonStage は additive save field）
  if (off === null) {
    renderDraftRoomScreen(u); // 次の中断（再指名 or 次ラウンド・次球団の指名番へ）
    return;
  }
  u.onDraftComplete(off); // 全ラウンド解決＝オフシーズン確定（ストーブリーグと同じダイジェスト遷移）
}

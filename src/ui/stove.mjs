// ============================================================================
// フェーズE3: ストーブリーグ画面（FA市場・トレード・育成⇔支配下）＋オフシーズンダイジェスト
//
// ユーザーフィードバック（phaseE_spec）「トレードができない」への対応＝エンジンAPIの解放。
// シーズンリザルト→年送り（advanceYear）の間に挿入される操作ステップ（スキップも可）。
//
// 設計原則:
//   - 決定論: 本画面がゲーム状態に加える変更は bidFA/proposeTrade の介入ログ
//     （state.marketInterventions）のみ。宣言予測・受諾見込み・AI提案の計算はすべて
//     makeRng(hashSeed(...)) / evaluateProspect の純関数＝共有乱数ストリームを一切消費しない
//     （セーブ→ロード→リプレイで同一結果。介入の取消も「ログから消す」だけ＝適用前なので安全）。
//   - 三層構造: 表示する評価は「相手球団AIの査定」（evaluateProspect＝観測ツール＋球団の癖）と
//     「コーチの見立て」等級（team.mjs と同座標）のみ。真値そのものは出さない。
//   - 見込みと確定: FA宣言/AI受諾の最終判定はオフシーズン処理（advanceYear）が加齢後の値で行う。
//     宣言予測は runFA と同一ハッシュ座標（'fa-declare'）＝引退で流れる場合を除き確定。
//     受諾見込みは現時点（加齢前）の査定＝「見込み」表示。確定結果はダイジェストが
//     決定時と同一の査定（加齢後の値・同 ctx）を再計算して評価差の理由として示す。
//   - バンドル: build.mjs が src/ui/*.mjs を ui.mjs と同一<script>へ前置 concat（deps 流儀は
//     team.mjs / watch.mjs と同じ。ui.mjs のヘルパーは u=stoveDeps() 経由で受け取る）。
// ============================================================================
import { makeRng, hashSeed, playerBatting, playerPitching } from '../engine.mjs';
import { teamEvalProfile, evaluateProspect } from '../game/market.mjs';
import { bidFA, proposeTrade } from '../game/index.mjs';
import { teamScoutGrade } from './team.mjs';

// 画面内ビュー状態（UIローカル。セーブ非対象＝ゲーム状態を一切変えない）。
const stoveView = {
  tab: 'fa', // 'fa' | 'trade' | 'farm'
  pick: null, // トレード起案: 放出する自チーム選手の playerId
};

// --- 純関数ヘルパー（介入ログ以外に何も書かない） ------------------------------

/** 当年（現 yearIndex）の市場介入ログ。 */
function stoveIvs(gs) {
  return gs.marketInterventions.filter((iv) => (iv.yearIndex ?? 0) === gs.yearIndex);
}

/** ロスターの (role,primaryPos) 型キー（transactions.mjs の typeKey と同義・同型1:1の制約）。 */
function stoveTypeOf(p) {
  return `${p.role}:${p.primaryPos}`;
}

/** 位置の表示（投手は「投」）。 */
function stovePosLabel(p, u) {
  return p.role === 'pitcher' ? '投' : u.posJP(p.primaryPos);
}

/** 球団 profile による査定（runFA/runTrades の assess と同じ ctx 座標＝同じ値になる）。 */
function stoveAssessBy(gs, profile, p, yearIndex = gs.yearIndex) {
  return evaluateProspect(profile, p, gs.cfg, { masterSeed: gs.masterSeed, yearIndex, teamId: profile.teamId });
}

/** 全球団の評価プロファイル（キャリア中固定・§13）。純関数＝何度呼んでも同一。 */
function stoveProfiles(gs) {
  const m = new Map();
  for (const t of gs.league.teams) m.set(t.id, teamEvalProfile(gs.masterSeed, t.id, gs.cfg));
  return m;
}

/**
 * FA宣言見込み（E3・runFA と同一ハッシュ座標 'fa-declare' の純関数）。
 * オフシーズン処理では「加齢後の年齢」で資格判定されるため age+1 で帯を判定する。
 * 宣言のくじ自体は playerId 固定＝確定。ただし引退（retire 座標）で流れる場合がある。
 */
export function stoveFaForecast(gs) {
  const fa = gs.cfg.tuning.market.fa;
  const out = [];
  for (const p of gs.league.players.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (p.rosterStatus !== 'active') continue;
    const nextAge = p.age + 1; // オフの加齢後に判定される（offseasonTransition: 加齢→引退→FA）
    if (nextAge < fa.minAge || nextAge > fa.maxAge) continue;
    if (makeRng(hashSeed(gs.masterSeed, 'fa-declare', gs.yearIndex, p.id)).chance(fa.declareRate)) out.push(p);
  }
  return out;
}

/**
 * トレードの相手AI受諾見込み（runTrades のプレイヤー起案受諾と同じ式・現時点の値）。
 * mine=放出する自チーム選手 / theirs=獲得したい相手選手。gain=相手球団査定の（受け取る−手放す）。
 */
export function stoveTradeVerdict(gs, profiles, mine, theirs) {
  const profile = profiles.get(theirs.teamId);
  const gain = stoveAssessBy(gs, profile, mine) - stoveAssessBy(gs, profile, theirs);
  const margin = gs.cfg.tuning.market.trade.margin;
  return { gain, margin, accept: gain > margin };
}

/**
 * AIからのトレード提案（E3）。runTrades のAI-AI探索と同じ発想で、各球団の「余剰候補」
 * （自球団査定の下位＝非プロテクトの型別最低評価）同士を突き合わせ、相手AIが受諾ライン超で
 * 欲しがる（＝起案すれば受諾見込みの）組を提案として返す。純関数・gain 降順。
 */
export function stoveAiOffers(gs, profiles, limit = 8) {
  const my = gs.playerTeamId;
  const pc = gs.cfg.tuning.market.trade.protectCount;
  const byTeam = new Map(gs.league.teams.map((t) => [t.id, []]));
  for (const p of gs.league.players) {
    if (p.rosterStatus === 'active' && byTeam.has(p.teamId)) byTeam.get(p.teamId).push(p);
  }
  // 各球団の余剰候補: 自球団査定の降順で protectCount 位以下（非プロテクト）から型別に最低評価の1人。
  const surplus = new Map(); // teamId → Map(typeKey → player)
  for (const [tid, roster] of byTeam) {
    const prof = profiles.get(tid);
    const ranked = roster
      .slice()
      .sort((a, b) => stoveAssessBy(gs, prof, b) - stoveAssessBy(gs, prof, a) || (a.id < b.id ? -1 : 1));
    const m = new Map();
    const nonProt = ranked.slice(pc);
    for (let i = nonProt.length - 1; i >= 0; i--) {
      const p = nonProt[i]; // 末尾＝査定最低から先に置く＝型別の最低評価が残る
      if (!m.has(stoveTypeOf(p))) m.set(stoveTypeOf(p), p);
    }
    surplus.set(tid, m);
  }
  const offers = [];
  const mySurplus = surplus.get(my) ?? new Map();
  for (const [tk, mine] of [...mySurplus].sort()) {
    for (const tid of [...surplus.keys()].sort()) {
      if (tid === my) continue;
      const theirs = surplus.get(tid).get(tk);
      if (!theirs) continue;
      const v = stoveTradeVerdict(gs, profiles, mine, theirs);
      if (v.accept) offers.push({ mine, theirs, gain: v.gain });
    }
  }
  offers.sort((a, b) => b.gain - a.gain || (a.theirs.id < b.theirs.id ? -1 : 1));
  return offers.slice(0, limit);
}

/** FA入札介入の取消（適用前のログ削除＝決定論に無害）。 */
function stoveCancelFa(gs, playerId) {
  gs.marketInterventions = gs.marketInterventions.filter(
    (m) => !(m.phase === 'fa' && (m.yearIndex ?? 0) === gs.yearIndex && m.playerId === playerId),
  );
}

/** トレード起案介入の取消（適用前のログ削除＝決定論に無害）。 */
function stoveCancelTrade(gs, iv) {
  gs.marketInterventions = gs.marketInterventions.filter(
    (m) => !(m.phase === 'trade' && (m.yearIndex ?? 0) === gs.yearIndex && m.aPlayer === iv.aPlayer && m.bPlayer === iv.bPlayer),
  );
}

/** 今季成績の要約（観測のみ・無観測は '-'）。 */
function stoveSeasonBrief(p, u) {
  const s = u.state.res && u.state.res.statsById ? u.state.res.statsById.get(p.id) : null;
  if (!s) return '-';
  if (p.role === 'pitcher') {
    if (!(s.pitching.g > 0)) return '-';
    const m = playerPitching(s, u.state.lc, u.state.cfg);
    const era = Number.isFinite(m.era) ? m.era.toFixed(2) : '-';
    return `${m.g}登板 ${Number.isFinite(m.ip) ? m.ip.toFixed(0) : '-'}回 防${era}`;
  }
  if (!(s.batting.pa > 0)) return '-';
  const m = playerBatting(s, u.state.lc);
  const avg = Number.isFinite(m.avg) ? u.fmt3(m.avg) : '-';
  const ops = Number.isFinite(m.ops) ? u.fmt3(m.ops) : '-';
  return `打率${avg} ${m.hr}本 OPS${ops}`;
}

/** 一覧テーブル（stat スタイル・横スクロール枠）。 */
function stoveTable(u, headers, rows) {
  const { el } = u;
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { class: 'left' }, h)))),
    el('tbody', {}, rows),
  ])]);
}

// --- 画面本体 ---------------------------------------------------------------

/**
 * ストーブリーグ画面（E3）。c=なし（全画面）・u=ui.mjs の共有ヘルパー束（stoveDeps()）。
 * シーズンリザルトから遷移し、「オフシーズン処理を実行」で advanceToNextYearUI() へ渡す。
 */
export function renderStoveScreen(u) {
  const { el, game } = u;
  const gs = game.gs;
  u.refreshRes(); // 今季観測（state.res/state.lc）を最新化（成績要約に使う）
  const root = document.getElementById('app');
  root.innerHTML = '';
  const ivs = stoveIvs(gs);
  const nFa = ivs.filter((i) => i.phase === 'fa').length;
  const nTr = ivs.filter((i) => i.phase === 'trade').length;
  root.append(el('div', { class: 'header' }, [
    el('h2', {}, [`${gs.year}年 ストーブリーグ　`, el('span', { class: 'muted' }, `介入予定: FA入札${nFa}件・トレード起案${nTr}件`)]),
    el('div', { class: 'row' }, [
      el('button', { class: 'primary', onclick: () => u.advanceToNextYearUI() }, '▶ オフシーズン処理を実行（年送り）'),
      el('button', { class: 'link', onclick: () => u.renderSeasonResult() }, 'リザルトへ戻る'),
    ]),
  ]));
  const TABS = [['fa', 'FA市場'], ['trade', 'トレード'], ['farm', '育成・支配下']];
  root.append(el('div', { class: 'tabs' }, TABS.map(([k, label]) =>
    el('button', { class: 'tab' + (stoveView.tab === k ? ' active' : ''), onclick: () => { stoveView.tab = k; renderStoveScreen(u); } }, label))));
  const c = el('div', { id: 'content' });
  root.append(c);
  if (stoveView.tab === 'fa') stoveFaTab(c, u);
  else if (stoveView.tab === 'trade') stoveTradeTab(c, u);
  else stoveFarmTab(c, u);
}

/** FA市場タブ: 宣言見込み一覧 → bidFA 入札（介入ログ）。 */
function stoveFaTab(c, u) {
  const { el, game, state } = u;
  const gs = game.gs;
  const fa = gs.cfg.tuning.market.fa;
  const cands = stoveFaForecast(gs);
  const bids = new Set(stoveIvs(gs).filter((i) => i.phase === 'fa').map((i) => i.playerId));
  c.append(el('div', { class: 'muted', style: 'margin:6px 0' },
    `今オフにFA宣言が見込まれる選手（オフシーズン処理で確定・引退した場合は流れます。対象は加齢後${fa.minAge}〜${fa.maxAge}歳）。`
    + '入札すると獲得できますが、人的補償として同型（同じ役割・守備位置）の非プロテクト選手1人が相手球団へ移ります。'));
  const others = cands.filter((p) => p.teamId !== gs.playerTeamId);
  const mine = cands.filter((p) => p.teamId === gs.playerTeamId);
  const row = (p, own) => {
    let act;
    if (own) act = el('td', { class: 'left muted' }, '（自チーム・流出の恐れ）');
    else if (bids.has(p.id)) {
      act = el('td', { class: 'left' }, [el('button', { class: 'link', onclick: () => { stoveCancelFa(gs, p.id); u.autoSave(); renderStoveScreen(u); } }, '入札済み・取消')]);
    } else {
      act = el('td', { class: 'left' }, [el('button', { onclick: () => { bidFA(gs, p.id); u.autoSave(); renderStoveScreen(u); } }, '入札する')]);
    }
    return el('tr', {}, [
      el('td', { class: 'left' }, [u.playerLink(p.id)]),
      el('td', { class: 'left' }, u.tname(p.teamId)),
      el('td', { class: 'left' }, stovePosLabel(p, u)),
      el('td', {}, String(p.age)),
      el('td', { class: 'left' }, stoveSeasonBrief(p, u)),
      el('td', {}, teamScoutGrade(p, state.cfg, u)),
      act,
    ]);
  };
  c.append(el('h3', { class: 'leaguename' }, `FA宣言見込み・他球団（${others.length}人）`));
  if (!others.length) c.append(el('div', { class: 'muted' }, '今オフに宣言が見込まれる他球団の選手はいません。'));
  else c.append(stoveTable(u, ['選手', '球団', '位置', '年齢', '今季成績', '等級', '入札'], others.map((p) => row(p, false))));
  if (mine.length) {
    c.append(el('h3', { class: 'leaguename' }, `FA宣言見込み・自チーム（${mine.length}人）`));
    c.append(el('div', { class: 'muted' }, '他球団の入札が自球団評価を上回ると移籍します（人的補償として同型1人が入ります）。'));
    c.append(stoveTable(u, ['選手', '球団', '位置', '年齢', '今季成績', '等級', '入札'], mine.map((p) => row(p, true))));
  }
}

/** トレードタブ: 起案済み一覧 / AIからの提案 / 自分から起案（proposeTrade＝介入ログ）。 */
function stoveTradeTab(c, u) {
  const { el, game, state } = u;
  const gs = game.gs;
  const profiles = stoveProfiles(gs);
  const margin = gs.cfg.tuning.market.trade.margin;
  c.append(el('div', { class: 'muted', style: 'margin:6px 0' },
    `トレードは同じ役割・守備位置（同型）の1:1交換。相手球団AIは自前の査定（スカウト観測＋球団の癖）で受諾/拒否を判断します（受諾ライン: 評価差 +${margin} 超）。`
    + '最終判定はオフシーズン処理（加齢後の値）＝ここでの表示は見込みです。'));

  // 起案済み一覧（取消可）
  const queued = stoveIvs(gs).filter((i) => i.phase === 'trade');
  const proposedKey = new Set(queued.map((i) => `${i.aPlayer}|${i.bPlayer}`));
  if (queued.length) {
    c.append(el('h3', { class: 'leaguename' }, `起案済みトレード（${queued.length}件）`));
    c.append(el('div', { class: 'awardlist' }, queued.map((iv) => {
      const a = state.byId.get(iv.aPlayer);
      const b = state.byId.get(iv.bPlayer);
      let vtxt = '';
      if (a && b) {
        const v = stoveTradeVerdict(gs, profiles, a, b);
        vtxt = v.accept
          ? `受諾見込み（相手評価差 +${v.gain.toFixed(1)} > ${v.margin}）`
          : `拒否見込み（相手評価差 ${v.gain >= 0 ? '+' : ''}${v.gain.toFixed(1)} ≦ ${v.margin}）`;
      }
      return el('div', { class: 'awardrow' }, [
        el('span', {}, ['放出 ', u.playerLink(iv.aPlayer), ' ⇔ 獲得 ', u.playerLink(iv.bPlayer), `（${u.tname(iv.bTeam)}）`]),
        el('span', { class: 'muted' }, `　${vtxt}`),
        el('button', { class: 'link', onclick: () => { stoveCancelTrade(gs, iv); u.autoSave(); renderStoveScreen(u); } }, '取消'),
      ]);
    })));
  }

  // AIからの提案（受ける＝proposeTrade で介入ログへ）
  const offers = stoveAiOffers(gs, profiles);
  c.append(el('h3', { class: 'leaguename' }, `AIからのトレード提案（${offers.length}件）`));
  if (!offers.length) c.append(el('div', { class: 'muted' }, '現時点で受諾見込みの提案はありません。'));
  else c.append(el('div', { class: 'awardlist' }, offers.map((o) => {
    const done = proposedKey.has(`${o.mine.id}|${o.theirs.id}`);
    return el('div', { class: 'awardrow' }, [
      el('span', {}, [
        `${u.tname(o.theirs.teamId)}: 獲得 `, u.playerLink(o.theirs.id),
        `（${stovePosLabel(o.theirs, u)}・${o.theirs.age}歳・${teamScoutGrade(o.theirs, state.cfg, u)}） ⇔ 放出 `,
        u.playerLink(o.mine.id), `（${stovePosLabel(o.mine, u)}・${o.mine.age}歳・${teamScoutGrade(o.mine, state.cfg, u)}）`,
      ]),
      el('span', { class: 'muted' }, `　相手評価差 +${o.gain.toFixed(1)}`),
      done
        ? el('span', { class: 'muted' }, '起案済み')
        : el('button', { onclick: () => { proposeTrade(gs, o.mine.id, o.theirs.id); u.autoSave(); renderStoveScreen(u); } }, '受ける'),
    ]);
  })));

  // 自分から起案
  c.append(el('h3', { class: 'leaguename' }, '自分から起案する'));
  c.append(el('div', { class: 'muted' }, '1) 放出する自チーム選手を選ぶ:'));
  const myPlayers = gs.league.players
    .filter((p) => p.teamId === gs.playerTeamId)
    .sort((a, b) => {
      const ta = stoveTypeOf(a);
      const tb = stoveTypeOf(b);
      return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : 1;
    });
  c.append(el('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px' }, myPlayers.map((p) =>
    el('button', {
      class: 'subtab stovepick' + (stoveView.pick === p.id ? ' active' : ''),
      onclick: () => { stoveView.pick = p.id; renderStoveScreen(u); },
    }, `${p.name}（${stovePosLabel(p, u)}）`))));
  const mine = state.byId.get(stoveView.pick);
  if (!mine || mine.teamId !== gs.playerTeamId) return;
  const tk = stoveTypeOf(mine);
  const targets = gs.league.players
    .filter((p) => p.teamId !== gs.playerTeamId && p.rosterStatus === 'active' && stoveTypeOf(p) === tk)
    .map((p) => ({ p, v: stoveTradeVerdict(gs, profiles, mine, p) }))
    .sort((a, b) => b.v.gain - a.v.gain || (a.p.id < b.p.id ? -1 : 1));
  c.append(el('div', { class: 'muted', style: 'margin-top:8px' },
    `2) ${mine.name}（${stovePosLabel(mine, u)}）と交換する相手（同型のみ）を選んで打診:`));
  c.append(stoveTable(u, ['選手', '球団', '年齢', '今季成績', '等級', '受諾見込み', '打診'], targets.map(({ p, v }) => {
    const done = proposedKey.has(`${mine.id}|${p.id}`);
    return el('tr', {}, [
      el('td', { class: 'left' }, [u.playerLink(p.id)]),
      el('td', { class: 'left' }, u.tname(p.teamId)),
      el('td', {}, String(p.age)),
      el('td', { class: 'left' }, stoveSeasonBrief(p, u)),
      el('td', {}, teamScoutGrade(p, state.cfg, u)),
      el('td', { class: 'left' }, v.accept ? `受諾見込み +${v.gain.toFixed(1)}` : `拒否見込み ${v.gain >= 0 ? '+' : ''}${v.gain.toFixed(1)}`),
      el('td', { class: 'left' }, done ? '起案済み' : [el('button', { onclick: () => { proposeTrade(gs, mine.id, p.id); u.autoSave(); renderStoveScreen(u); } }, '打診する')]),
    ]);
  })));
}

/** 育成・支配下タブ: 昇格候補（自チーム育成）の可視化（判定はエンジンの自動昇格＝希望注入なし）。 */
function stoveFarmTab(c, u) {
  const { el, game, state } = u;
  const gs = game.gs;
  const mk = gs.cfg.tuning.market.farm;
  const farm = (gs.league.farm ?? [])
    .filter((p) => p.teamId === gs.playerTeamId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  c.append(el('div', { class: 'muted', style: 'margin:6px 0' },
    `育成→支配下の昇格はオフシーズン処理で自動判定されます: 育成選手の観測評価（二軍実成績ボーナス込み・F2-3）が昇格ライン（${mk.promoteThreshold}）を超え、`
    + `かつ自球団に同型の空き枠（引退）が出た場合に支配下登録（支配下枠は${gs.cfg.tuning.roster?.controlledPerTeam ?? 70}人）。${mk.maxAge}歳を超えた育成選手は解雇されます。`
    + '結果はオフシーズンのダイジェストに表示されます。'));
  c.append(el('h3', { class: 'leaguename' }, `昇格候補＝自チームの育成選手（${farm.length}人）`));
  if (!farm.length) {
    c.append(el('div', { class: 'muted' }, '育成選手はいません（育成契約はドラフト外＝オフシーズン処理で発生します）。'));
    return;
  }
  c.append(stoveTable(u, ['選手', '位置', '年齢', 'コーチの見立て', '見通し'], farm.map((p) => el('tr', {}, [
    el('td', { class: 'left' }, [u.playerLink(p.id)]),
    el('td', { class: 'left' }, stovePosLabel(p, u)),
    el('td', {}, String(p.age)),
    el('td', {}, teamScoutGrade(p, state.cfg, u)),
    el('td', { class: 'left muted' }, p.age + 1 > mk.maxAge ? '年齢超過＝今オフで解雇見込み' : '見立てが高いほど昇格に近い'),
  ]))));
}

// --- オフシーズン・ダイジェスト（E3: 引退/ドラフト/FA/トレード/拾い上げ/表彰の1画面） -------

/** FA入札が結果に現れなかった理由の言語化（宣言くじの再導出＝決定論・純関数）。 */
function stoveFaFailReason(gs, off, playerId, prevYi) {
  if ((off.retirees ?? []).some((r) => r.id === playerId)) return '引退により対象外';
  const p = gs.league.players.find((q) => q.id === playerId);
  if (!p) return '対象外';
  const fa = gs.cfg.tuning.market.fa;
  const declared = p.age >= fa.minAge && p.age <= fa.maxAge
    && makeRng(hashSeed(gs.masterSeed, 'fa-declare', prevYi, p.id)).chance(fa.declareRate);
  if (!declared) return 'FA宣言せず残留';
  return '人的補償（同型の非プロテクト）を用意できず不成立';
}

/** トレード決定時の相手評価差を再計算（決定時と同値・§E3「理由（評価差）を表示」）。 */
function stoveTradeGainAfter(gs, t, prevYi) {
  const a = gs.league.players.find((p) => p.id === t.aPlayer);
  const b = gs.league.players.find((p) => p.id === t.bPlayer);
  if (!a || !b) return null;
  // 受諾判定は加齢後・トレード実行前の値で行われた。加齢はオフで1度きり・以降 trueAbility/age は
  // 不変（移籍は teamId のみ）なので、同じ ctx（bTeam・完了年 yearIndex）での再計算は決定時と一致する。
  const profile = teamEvalProfile(gs.masterSeed, t.bTeam, gs.cfg);
  const ctx = { masterSeed: gs.masterSeed, yearIndex: prevYi, teamId: t.bTeam };
  return evaluateProspect(profile, a, gs.cfg, ctx) - evaluateProspect(profile, b, gs.cfg, ctx);
}

/**
 * オフシーズン・ダイジェスト（E3完全版）: advanceYear の返す off 要約を1画面に整理する。
 * 自チームの動き（FA入札結果/トレード受諾・拒否と評価差/拾い上げ/引退/新人/育成昇格）＋
 * リーグ全体（件数・FA/トレード成立一覧・表彰・マイルストーン）。選手名は playerLink で詳細へ。
 */
export function renderOffseasonDigestScreen(off, u) {
  const { el, game, state } = u;
  const gs = game.gs;
  const my = gs.playerTeamId;
  const prevYear = gs.year - 1;
  const prevYi = gs.yearIndex - 1;
  const root = document.getElementById('app');
  root.innerHTML = '';
  root.append(el('div', { class: 'header' }, [
    el('h2', {}, `${prevYear}年 オフシーズン ダイジェスト`),
    el('div', { class: 'row' }, [el('button', { class: 'primary', onclick: () => u.renderHub() }, `▶ ${gs.year}年シーズン開幕へ`)]),
  ]));
  const link = (id, name) => u.playerLink(id, name); // 引退者は byId 不在→素のテキスト（name必須）
  const margin = gs.cfg.tuning.market.trade.margin;

  // --- 自チームの動き -------------------------------------------------------
  const moves = [];
  const ivs = gs.marketInterventions.filter((iv) => (iv.yearIndex ?? 0) === prevYi);
  // FA入札の結果（成立＝via:'player' / 不成立＝理由）
  for (const iv of ivs.filter((i) => i.phase === 'fa')) {
    const hit = (off.fa ?? []).find((f) => f.playerId === iv.playerId && f.via === 'player');
    if (hit) {
      moves.push(el('div', { class: 'newsrow good' }, [
        'FA入札成立: ', link(hit.playerId), ' を獲得（人的補償: ', link(hit.comp), ` が ${u.tname(hit.from)} へ）`]));
    } else {
      moves.push(el('div', { class: 'newsrow' }, [
        'FA入札不成立: ', link(iv.playerId), `（${stoveFaFailReason(gs, off, iv.playerId, prevYi)}）`]));
    }
  }
  // AI入札による自チームのFA出入り
  for (const f of off.fa ?? []) {
    if (f.via === 'player') continue;
    if (f.to === my) moves.push(el('div', { class: 'newsrow good' }, ['FA獲得: ', link(f.playerId), `（${u.tname(f.from)}から・${f.years}年契約）　人的補償: `, link(f.comp), ' が流出']));
    else if (f.from === my) moves.push(el('div', { class: 'newsrow bad' }, ['FA流出: ', link(f.playerId), ` が ${u.tname(f.to)} へ　人的補償: `, link(f.comp), ' を獲得']));
  }
  // トレード（自チーム関与）: 受諾/拒否と評価差の理由
  const tradeRecKey = new Set((off.trades ?? []).map((t) => `${t.aPlayer}|${t.bPlayer}`));
  for (const t of off.trades ?? []) {
    if (t.aTeam !== my && t.bTeam !== my) continue;
    const gain = stoveTradeGainAfter(gs, t, prevYi);
    const gtxt = gain == null ? '' : `${gain >= 0 ? '+' : ''}${gain.toFixed(1)}`;
    if (t.rejected) {
      moves.push(el('div', { class: 'newsrow bad' }, [
        'トレード拒否: 放出 ', link(t.aPlayer), ' ⇔ 獲得 ', link(t.bPlayer),
        `（${u.tname(t.bTeam)}）　理由: 相手球団の評価差 ${gtxt} が受諾ライン +${margin} に届かず`]));
    } else {
      const partner = t.aTeam === my ? t.bTeam : t.aTeam;
      moves.push(el('div', { class: 'newsrow good' }, [
        `トレード成立（${t.via === 'player' ? 'あなたの起案' : 'AI間'}）: `, link(t.aPlayer), ' ⇔ ', link(t.bPlayer),
        `（相手: ${u.tname(partner)}${t.via === 'player' && gain != null ? `・相手評価差 ${gtxt} > +${margin}` : ''}）`]));
    }
  }
  // 起案したが記録にすら現れなかったトレード（対象選手が先に移籍/引退→無効）
  for (const iv of ivs.filter((i) => i.phase === 'trade')) {
    if (tradeRecKey.has(`${iv.aPlayer}|${iv.bPlayer}`)) continue;
    moves.push(el('div', { class: 'newsrow' }, [
      'トレード不成立: 放出 ', link(iv.aPlayer), ' ⇔ 獲得 ', link(iv.bPlayer), '（対象選手の移籍・引退により無効）']));
  }
  // 戦力外/拾い上げ（自チーム関与）
  for (const pu of off.pickups ?? []) {
    if (pu.to === my) moves.push(el('div', { class: 'newsrow good' }, ['拾い上げ: ', link(pu.playerId), `（${u.tname(pu.from)}が戦力外）を獲得`]));
    else if (pu.from === my) moves.push(el('div', { class: 'newsrow bad' }, ['戦力外→流出: ', link(pu.playerId), ` が ${u.tname(pu.to)} に拾われる`]));
  }
  // 自チームの引退（引退者に teamId は無い→完了年の careerStats から最終所属を引く）
  const finalTeam = new Map();
  for (const s of gs.careerStats) if (s.season === prevYear) finalTeam.set(s.playerId, s.teamId);
  for (const r of off.retirees ?? []) {
    if (finalTeam.get(r.id) !== my) continue;
    moves.push(el('div', { class: 'newsrow' }, [`引退: ${r.name}（${r.role === 'pitcher' ? '投手' : u.posJP(r.primaryPos)}・${r.finalAge}歳）`]));
  }
  // 自チームの育成昇格
  for (const pr of off.promotions ?? []) {
    if (pr.teamId !== my) continue;
    moves.push(el('div', { class: 'newsrow good' }, ['育成→支配下昇格: ', link(pr.playerId), `（${pr.role === 'pitcher' ? '投手' : u.posJP(pr.primaryPos)}・${pr.age}歳）`]));
  }
  root.append(el('div', { class: 'pspanel' }, [
    el('h3', { class: 'leaguename' }, `あなたの球団（${u.tname(my)}）の動き`),
    moves.length ? el('div', { class: 'newsfeed' }, moves) : el('div', { class: 'muted' }, 'FA・トレード・拾い上げ・引退の動きはありませんでした。'),
  ]));

  // 自チームの新加入（ドラフト新人）
  const myRookies = (off.rookies ?? []).filter((p) => p.teamId === my);
  if (myRookies.length) {
    root.append(el('h3', { class: 'leaguename' }, `自チームの新人（${myRookies.length}人）`));
    root.append(el('div', { class: 'awardlist' }, myRookies.map((p) => el('div', { class: 'awardrow' }, [
      u.playerLink(p.id),
      el('span', { class: 'muted' }, `　${p.role === 'pitcher' ? '投手' : u.posJP(p.primaryPos)}・${p.age}歳`),
    ]))));
  }
  const myFarm = (gs.league.farm ?? []).filter((p) => p.teamId === my);
  if (myFarm.length) {
    root.append(el('div', { class: 'muted', style: 'margin-top:8px' }, `育成（二軍）在籍: ${myFarm.length}人 — ホームの「チーム」タブ→二軍で確認できます。`));
  }

  // --- リーグ全体 ------------------------------------------------------------
  root.append(el('div', { class: 'pspanel' }, [
    el('h3', { class: 'leaguename' }, 'ストーブリーグ要約（リーグ全体）'),
    u.kv([
      ['引退', `${(off.retirees ?? []).length}人`],
      ['新人入団', `${(off.rookies ?? []).length}人`],
      ['育成昇格', `${(off.promotions ?? []).length}人`],
      ['FA移籍', `${(off.fa ?? []).length}件`],
      ['トレード成立', `${(off.trades ?? []).filter((t) => !t.rejected).length}件`],
      ['拾い上げ', `${(off.pickups ?? []).length}件`],
      ['故障（開幕IL）', `${(off.injuries ?? []).length}人`],
      ['ブレイク', `${(off.breakouts ?? []).length}人`],
    ]),
  ]));
  const faAll = off.fa ?? [];
  if (faAll.length) {
    root.append(el('h3', { class: 'leaguename' }, `FA移籍の成立（${faAll.length}件）`));
    root.append(el('div', { class: 'awardlist' }, faAll.map((f) => el('div', { class: 'awardrow' }, [
      link(f.playerId),
      el('span', { class: 'muted' }, `　${u.tname(f.from)} → ${u.tname(f.to)}（${f.years}年契約${f.via === 'player' ? '・あなたの入札' : ''}）`),
    ]))));
  }
  const trAll = (off.trades ?? []).filter((t) => !t.rejected);
  if (trAll.length) {
    root.append(el('h3', { class: 'leaguename' }, `トレード成立（${trAll.length}件）`));
    root.append(el('div', { class: 'awardlist' }, trAll.map((t) => el('div', { class: 'awardrow' }, [
      link(t.aPlayer), el('span', { class: 'muted' }, `（${u.tname(t.aTeam)}→${u.tname(t.bTeam)}）`),
      el('span', {}, ' ⇔ '),
      link(t.bPlayer), el('span', { class: 'muted' }, `（${u.tname(t.bTeam)}→${u.tname(t.aTeam)}）`),
    ]))));
  }
  // 表彰（完了シーズン・off.awards は advanceYear が算出済み）
  if (off.awards && off.awards.leagues) {
    root.append(el('h3', { class: 'leaguename' }, `🏅 ${prevYear}年 表彰ダイジェスト`));
    root.append(el('div', { class: 'awardlist' }, off.awards.leagues.map((lg) => el('div', { class: 'awardrow' }, [
      el('span', { class: 'awardyear' }, u.leagueNameOf(gs.cfg, lg.leagueId)),
      el('span', {}, ['MVP: ', lg.mvp ? link(lg.mvp.playerId) : '—']),
      el('span', { class: 'muted' }, '　新人王: '),
      el('span', {}, [lg.roty ? link(lg.roty.playerId) : '—']),
    ]))));
  }
  // 通算マイルストーン到達
  if ((off.milestones ?? []).length) {
    root.append(el('h3', { class: 'leaguename' }, `通算記録の到達（${off.milestones.length}件）`));
    root.append(el('div', { class: 'awardlist' }, off.milestones.map((m) => el('div', { class: 'awardrow' }, [
      el('span', { class: 'awardbadge' }, [link(m.playerId, m.name), `　${m.category} ${m.threshold}${m.unit}到達（通算${m.total}）`]),
    ]))));
  }
}

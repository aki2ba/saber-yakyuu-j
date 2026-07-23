// ============================================================================
// フェーズE4: ハブ「日程・結果」タブ — 自チーム全日程（月別区切り・スコア・勝敗・先発）
//              ＋試合クリックで簡易ボックススコア（両軍打者/投手の当日ライン）
//
// ユーザーフィードバック（phaseE_spec）「日程が見えない・過去の試合を振り返れない」への対応。
// 設計原則:
//   - 表示のみ: rt.schedule（全日程）と rt.playerGameLog（結果＋rec.box=当日集計行）を読むだけで
//     一切書かない（決定論・セーブ再現に無関係）。box は season_runtime が §17 準拠で集計済み。
//   - バンドル: build.mjs が src/ui/*.mjs を ui.mjs と同一<script>へ前置concat。ui.mjs のヘルパーは
//     deps オブジェクト u（ui.mjs の scheduleDeps()）で受け取る（トップレベル名は sched プレフィクス）。
// ============================================================================

// 月ラベル（NPB風: 開幕3月末〜10月・daysPerMonth=26 で約6分割）。
const SCHED_MONTHS = ['3・4月', '5月', '6月', '7月', '8月', '9月', '10月'];

function schedMonthLabel(m) {
  return SCHED_MONTHS[Math.min(m, SCHED_MONTHS.length - 1)];
}

// 疑似カレンダー（UI刷新4・表示専用）: エンジンの節(day・0始まり)を月日と曜日へ写像する。
//   月バケット（floor(day/26)＝上の SCHED_MONTHS）と必ず整合する設計:
//   バケット0「3・4月」= 3/29,3/30,3/31,4/1..4/23（3日+23日=26日・NPBの3月末開幕）、
//   バケット1以降 = 各月1日〜26日（27日以降は存在しない＝現実の日程の休日と同じく「無い日」）。
//   曜日は開幕=金曜（NPB慣例）から機械的に巡回。進行・セーブ・エンジンには一切不干渉の純関数。
const SCHED_WDAYS = ['金', '土', '日', '月', '火', '水', '木'];
export function schedDateLabel(day) {
  const m = Math.floor(day / 26);
  const d = day % 26;
  const wd = SCHED_WDAYS[day % 7];
  if (m === 0) return d < 3 ? `3/${29 + d}(${wd})` : `4/${d - 2}(${wd})`;
  const month = Math.min(m + 4, 11); // m=1→5月 … m=6→10月。以降は11月へ丸め（ポストシーズン安全弁）
  return `${month}/${d + 1}(${wd})`;
}

/** 投球回表示（アウト数→「6.1」形式）。 */
function schedIp(outs) {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

const SCHED_HALF_JP = { top: '表', bottom: '裏' };
const schedWpaVal = (v) => (v > 0 ? '+' : '') + (v ?? 0).toFixed(2);

/**
 * P2: 勝因/敗因カード（1行ぶんの表示パーツ）。box.wpaTop/wpaBottom（wpaSummary.mjs が
 * additive に付与する要約 {pid,inning,half,desc,wpa}）から組む純関数。旧セーブ等で
 * box.wpaTop/wpaBottom が無い試合は呼び出し側で丸ごとスキップする（additive・鉄則の後方互換）。
 */
export function schedWpaParts(item, u) {
  const { playerLink } = u;
  return [`${item.inning}回${SCHED_HALF_JP[item.half] ?? ''} `, playerLink(item.pid), `の${item.desc}（WPA ${schedWpaVal(item.wpa)}）`];
}

/** 自チーム視点の勝敗（'w'|'l'|'t'）。 */
function schedWl(rec, myId) {
  if (rec.tie) return 't';
  const my = rec.home === myId ? rec.homeScore : rec.awayScore;
  const opp = rec.home === myId ? rec.awayScore : rec.homeScore;
  return my > opp ? 'w' : 'l';
}

/** 「日程・結果」タブ本体。c=コンテンツ要素、u=ui.mjs の共有ヘルパー束（scheduleDeps()）。 */
export function renderScheduleTab(c, u) {
  const { el, td, game, tname, pendingDayOf } = u;
  const gs = game.gs;
  const rt = gs.rt;
  const myId = gs.playerTeamId;
  const dpm = gs.cfg.game.daysPerMonth ?? 26;
  // G7: 現在月（次にプレイされる日を含む月）だけ既定で開く。
  const curDay = pendingDayOf(rt) - 1;
  const curMonth = Math.floor(curDay / dpm);
  // Q3: 特別デー（day→1件・同日複数該当は検出順で先頭のみ）を⭐バッジ用に引けるようMap化。
  const specialByDay = new Map();
  for (const sd of u.specialDays ?? []) if (!specialByDay.has(sd.day)) specialByDay.set(sd.day, sd);
  // 自チーム全日程: schedule 順に走査し、消化済み（gi < cursor）は playerGameLog の対応行を引く
  // （playerGameLog は自チーム試合の消化順＝schedule 内の自チーム試合と 1:1 対応）。
  const rows = [];
  let k = 0;
  for (let gi = 0; gi < rt.schedule.length; gi++) {
    const g = rt.schedule[gi];
    if (g.home !== myId && g.away !== myId) continue;
    const rec = gi < rt.cursor ? rt.playerGameLog[k++] : null;
    rows.push({ g, rec, special: specialByDay.get(g.day) ?? null });
  }
  // 通算
  let W = 0; let L = 0; let T = 0;
  for (const r of rows) {
    if (!r.rec) continue;
    const wl = schedWl(r.rec, myId);
    if (wl === 'w') W++; else if (wl === 'l') L++; else T++;
  }
  c.append(el('div', { class: 'muted', style: 'margin:4px 0' },
    `自チームの全${rows.length}試合（消化 ${W + L + T}試合: ${W}勝${L}敗${T}分）。試合行のクリックで簡易ボックススコア。`));
  // G7: 次戦（未消化の最初の1試合）へのジャンプリンク。
  const nextRow = rows.find((r) => !r.rec);
  c.append(el('div', { class: 'nextjump' }, [
    el('button', {
      class: 'link',
      onclick: () => document.getElementById('schednext')?.scrollIntoView?.({ block: 'center' }),
    }, '▼ 次の試合へ'),
  ]));
  // 月別グループ
  const months = new Map();
  for (const r of rows) {
    const m = Math.floor(r.g.day / dpm);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(r);
  }
  for (const [m, list] of months) {
    let w = 0; let l = 0; let t = 0;
    for (const r of list) {
      if (!r.rec) continue;
      const wl = schedWl(r.rec, myId);
      if (wl === 'w') w++; else if (wl === 'l') l++; else t++;
    }
    const rec = w + l + t ? `　${w}勝${l}敗${t}分` : '';
    const trs = list.map((r) => schedGameRow(r, u, myId, r === nextRow));
    const table = el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, '日付'), el('th', { class: 'left' }, '相手'), el('th', {}, 'スコア'),
        el('th', {}, '勝敗'), el('th', { class: 'left' }, '先発'), el('th', { class: 'left' }, '相手先発'),
      ])),
      el('tbody', {}, trs),
    ])]);
    // G7: 月ブロックを折りたたみ化。現在月（次戦を含む月）だけ既定で開く。
    const detailsAttrs = { class: 'schedmonth' };
    if (m === curMonth) detailsAttrs.open = '';
    c.append(el('details', detailsAttrs, [
      el('summary', { class: 'leaguename' }, `${schedMonthLabel(m)}（${list.length}試合）${rec}`),
      table,
    ]));
  }
}

/** Q3: 特別デーの日付セル（⭐バッジ＋ラベルをtitle属性で）。special=null なら通常セル。 */
function schedDateCell(el, td, day, special) {
  if (!special) return td(schedDateLabel(day));
  return el('td', { title: special.label }, [`⭐${schedDateLabel(day)}`]);
}

/** 日程1試合ぶんの行（過去=結果＋クリックでボックススコア／未来=予定）。 */
function schedGameRow(r, u, myId, isNext = false) {
  const { el, td, tname, playerLink } = u;
  const { g, rec, special } = r;
  const isHome = g.home === myId;
  const oppId = isHome ? g.away : g.home;
  const oppCell = `${isHome ? 'vs' : '@'} ${tname(oppId)}`;
  const rowAttrs = isNext ? { id: 'schednext', class: 'schednext' } : {};
  if (special) rowAttrs.class = `${rowAttrs.class ? rowAttrs.class + ' ' : ''}schedspecial`;
  const oppCellContent = special
    ? [oppCell, el('div', { class: 'muted', style: 'font-size:11px' }, special.label)]
    : oppCell;
  if (!rec) {
    return el('tr', { ...rowAttrs, class: `${rowAttrs.class ? rowAttrs.class + ' ' : ''}schedfuture` }, [
      schedDateCell(el, td, g.day, special), el('td', { class: 'left' }, oppCellContent), td('予定'), td('—'), td('-', 'left'), td('-', 'left'),
    ]);
  }
  const my = isHome ? rec.homeScore : rec.awayScore;
  const opp = isHome ? rec.awayScore : rec.homeScore;
  const wl = schedWl(rec, myId);
  const mark = wl === 'w' ? '○' : wl === 'l' ? '●' : '△';
  const ext = rec.innings > 9 ? `（延長${rec.innings}回）` : '';
  const b = rec.box;
  const mySt = b ? (isHome ? b.starters.home : b.starters.away) : null;
  const oppSt = b ? (isHome ? b.starters.away : b.starters.home) : null;
  return el('tr', { ...rowAttrs, class: `${rowAttrs.class ? rowAttrs.class + ' ' : ''}clickable`, onclick: () => schedOpenBox(rec, u) }, [
    td(schedDateLabel(g.day)),
    td(oppCell, 'left'),
    td(`${my}-${opp}${ext}`),
    el('td', {}, [el('span', { class: 'wl wl' + wl }, mark)]),
    el('td', { class: 'left' }, mySt ? [playerLink(mySt)] : '-'),
    el('td', { class: 'left' }, oppSt ? [playerLink(oppSt)] : '-'),
  ]);
}

/** 簡易ボックススコアのモーダル（ラインスコア＋両軍打者/投手の当日ライン）。 */
function schedOpenBox(rec, u) {
  const { el, tname } = u;
  const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const box = el('div', { class: 'modal boxmodal' });
  box.append(el('div', { class: 'modalhead' }, [
    el('span', { class: 'pname' },
      `${schedDateLabel(rec.day)}　${tname(rec.away)} ${rec.awayScore} - ${rec.homeScore} ${tname(rec.home)}${rec.innings > 9 ? `（延長${rec.innings}回）` : ''}`),
    el('button', { class: 'link', onclick: () => overlay.remove() }, '✕'),
  ]));
  const b = rec.box;
  if (!b) {
    box.append(el('div', { class: 'muted' }, 'この試合のボックススコアは記録されていません（旧セーブの試合）。'));
  } else {
    // P2: 勝因/敗因カード（冒頭表示）。旧セーブの box には wpaTop/wpaBottom が無いので additive にスキップ。
    if (b.wpaTop && b.wpaBottom) {
      box.append(el('div', { class: 'newsfeed', style: 'margin-bottom:8px' }, [
        el('div', { class: 'newsrow good' }, ['勝因: ', ...schedWpaParts(b.wpaTop, u)]),
        el('div', { class: 'newsrow bad' }, ['敗因: ', ...schedWpaParts(b.wpaBottom, u)]),
      ]));
    }
    box.append(schedLineScore(rec, b, u));
    for (const side of ['away', 'home']) {
      const teamId = side === 'home' ? rec.home : rec.away;
      box.append(el('h3', { class: 'leaguename' }, `${tname(teamId)}　打撃`));
      box.append(schedBatterTable(b.batters[side], u));
      box.append(el('h3', { class: 'leaguename' }, `${tname(teamId)}　投手`));
      box.append(schedPitcherTable(b.pitchers[side], u));
    }
    box.append(el('div', { class: 'muted', style: 'margin-top:6px' },
      '当日集計の簡易ボックススコア（失点は在板中の得点＝継承走者は現投手へ帰属する近似。打点も公式規則の近似で、シーズン集計と±1差が出ることがあります）。選手名クリックで詳細。'));
  }
  overlay.append(box);
  document.getElementById('app').append(overlay);
}

/** ボックススコアのラインスコア（イニング別＋R/H/E）。観戦のスコアボードと同配色。 */
function schedLineScore(rec, b, u) {
  const { el, td, tname, game } = u;
  const innMax = Math.max(9, b.innings, b.line.reduce((a, x) => Math.max(a, x.i), 0));
  const head = el('tr', {}, [
    el('th', { class: 'left' }, ''),
    ...Array.from({ length: innMax }, (_, i) => el('th', {}, String(i + 1))),
    el('th', { class: 'rcol' }, 'R'), el('th', {}, 'H'), el('th', {}, 'E'),
  ]);
  const cell = (isHome, inn) => {
    const c = b.line.find((x) => x.i === inn + 1);
    const v = c ? (isHome ? c.b : c.t) : null;
    if (v == null) return isHome && inn + 1 === b.innings ? 'X' : ''; // サヨナラ勝ち等で裏なし
    return String(v);
  };
  const rowFor = (teamId, isHome, total, hits, errs) => el('tr', { class: teamId === game.gs.playerTeamId ? 'myteam' : '' }, [
    el('td', { class: 'left' }, tname(teamId)),
    ...Array.from({ length: innMax }, (_, i) => td(cell(isHome, i))),
    el('td', { class: 'rcol' }, String(total)), td(hits), td(errs),
  ]);
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat scoreboard' }, [
    el('thead', {}, head),
    el('tbody', {}, [
      rowFor(rec.away, false, rec.awayScore, b.hits.away, b.errs.away),
      rowFor(rec.home, true, rec.homeScore, b.hits.home, b.errs.home),
    ]),
  ])]);
}

/** 両軍打者の当日ライン表（打順/守/選手/打数/安打/本/打点/四死球/三振）。 */
function schedBatterTable(batters, u) {
  const { el, td, playerLink, posJP } = u;
  const list = batters.slice().sort((a, b) => (a.ord ?? 99) - (b.ord ?? 99));
  const trs = list.map((bt) => el('tr', {}, [
    td(bt.ord ?? '-'),
    td(bt.pos === '打' || bt.pos === '走' || bt.pos === '守' ? bt.pos : posJP(bt.pos || '-'), 'left'),
    el('td', { class: 'left' }, [playerLink(bt.pid)]),
    td(bt.ab), td(bt.h), td(bt.hr), td(bt.rbi), td(bt.bb), td(bt.k),
  ]));
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, '打順'), el('th', { class: 'left' }, '守'), el('th', { class: 'left' }, '選手'),
      el('th', {}, '打数'), el('th', {}, '安打'), el('th', {}, '本'), el('th', {}, '打点'), el('th', {}, '四死球'), el('th', {}, '三振'),
    ])),
    el('tbody', {}, trs),
  ])]);
}

/** 両軍投手の当日ライン表（選手/回/球数/被安/失点/四死球/奪三振）。 */
function schedPitcherTable(pitchers, u) {
  const { el, td, playerLink } = u;
  const trs = pitchers.map((pt) => el('tr', {}, [
    el('td', { class: 'left' }, [playerLink(pt.pid)]),
    td(schedIp(pt.outs)), td(pt.np), td(pt.h), td(pt.r), td(pt.bb), td(pt.k),
  ]));
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { class: 'left' }, '選手'), el('th', {}, '回'), el('th', {}, '球数'),
      el('th', {}, '被安'), el('th', {}, '失点'), el('th', {}, '四死球'), el('th', {}, '奪三振'),
    ])),
    el('tbody', {}, trs),
  ])]);
}

/**
 * E4: ニュース用「選手の活躍」見出し（直近試合のボックススコア集計から・自チーム選手のみ）。
 * 見出しの選手名は playerLink で詳細モーダルへ（「ニュースから該当選手へ」の導線）。
 * 集計行（rec.box）の純関数＝決定論・状態を変えない。
 */
export function schedPlayerHeadlines(rt, u, limit = 8) {
  const { playerLink, tname } = u;
  const myId = rt.playerTeamId;
  const out = [];
  for (const rec of rt.playerGameLog.slice(-12).reverse()) {
    const b = rec.box;
    if (!b) continue;
    const side = rec.home === myId ? 'home' : 'away';
    const oppId = rec.home === myId ? rec.away : rec.home;
    const at = `（${schedDateLabel(rec.day)} 対${tname(oppId)}）`;
    for (const bt of b.batters[side]) {
      if (bt.hr >= 2) out.push({ parts: [playerLink(bt.pid), ` が1試合${bt.hr}本塁打の固め打ち${at}`], cls: 'good' });
      else if (bt.h >= 3) out.push({ parts: [playerLink(bt.pid), ` が猛打賞（${bt.h}安打）${at}`], cls: 'good' });
    }
    for (const pt of b.pitchers[side]) {
      if (pt.k >= 10) out.push({ parts: [playerLink(pt.pid), ` が${pt.k}奪三振の快投${at}`], cls: 'good' });
      else if (pt.outs >= 21 && pt.r === 0) out.push({ parts: [playerLink(pt.pid), ` が${Math.floor(pt.outs / 3)}回無失点の好投${at}`], cls: 'good' });
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

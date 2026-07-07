# F4レビュー修正 実装仕様（sonnet向け・自己完結）

2026-07-07 の /code-review（対象: `6d4bc23..HEAD` = F4 UI磨き込みシリーズ）で CONFIRMED となった8指摘の修正設計。
**この文書だけで実装が完結するように書いてある。読了後、上から順に実装すること。**

## 前提（必読）

- 変更はすべて **表示層（src/ui.mjs, src/ui/watch.mjs）・ニュース層（src/game/news.mjs）・CSS（tools/build.mjs）・共有ヘルパー1個（src/sim/season.mjs）** のみ。シミュレーション結果・乱数消費は一切変えない。
- `dist/pennant.html` は生成物。**絶対に手編集しない**。tools/build.mjs を編集後 `npm run build` で再生成してコミットする。
- build は全モジュールの import 文を剥がして単一スコープに連結する（tools/build.mjs 参照）。**新しいトップレベル名はリポジトリ全体で一意にすること**（追加する名前: `gamesBehind`, `gbText`, `TEAM_ACCENTS`, `TEAM_COLORS`※ui.mjsから移設, `justAdvanced`※プロパティなので衝突なし）。実装前に `grep -rn "gamesBehind\|TEAM_ACCENTS\|gbText" src tools` で衝突ゼロを確認（2026-07-07時点でゼロ確認済み）。
- 各修正単位ごとに `npm test` を回し、全部終わったら最終ゲート（下記）を通す。

---

## 修正1: ゲーム差の共有ヘルパー化＋「-」表示バグ修正（最優先）

**指摘**: ①式 `((leader.w - t.w) + (t.l - leader.l)) / 2` が3箇所（src/game/news.mjs:112 / src/ui.mjs:226 / src/ui.mjs:1297）に重複。②表示 `gb <= 0 ? '-' : gb.toFixed(1)`（ui.mjs:231, 1301）は、勝率順ソート＋引分による消化決着数差で **首位以外でも gb=0（同率）や gb<0（例: 首位10勝4敗.714 vs 2位12勝5敗.706 → gb=-0.5）が到達可能**で、首位と同じ「-」になり区別不能。

### 1-a. ヘルパー追加 — src/sim/season.mjs

`winPct`（459行付近）の直下に追加:

```js
/** ゲーム差（NPB慣例: 首位との勝敗差の平均。首位行の「-」表記は表示側で行う）。負値もそのまま返す。 */
export function gamesBehind(leader, t) {
  return leader ? ((leader.w - t.w) + (t.l - leader.l)) / 2 : 0;
}
```

### 1-b. engine.mjs で再輸出

- 36行付近の `import { simulateSeason, buildSchedule, winPct } from './sim/season.mjs';` に `gamesBehind` を追加。
- 73行付近の export 集約（`simulateSeason, buildSchedule, winPct,`）にも `gamesBehind` を追加。

### 1-c. ui.mjs — インライン式を置換＋表示規則を「行インデックス」基準に

- 11行付近の engine.mjs からの import に `gamesBehind` を追加。
- 表示ヘルパーを1つ定義（`teamColor` 付近の「小物」セクションでよい）:

```js
// ゲーム差の表記（首位行のみ「-」。同率2位の0.0や負のゲーム差はそのまま数値表示＝首位と区別する）
const gbText = (i, gb) => (i === 0 ? '-' : gb.toFixed(1));
```

- **renderStandings**（226行付近）: `const gb = leader ? ((leader.w - t.w) + (t.l - leader.l)) / 2 : 0;` → `const gb = gamesBehind(leader, t);` に置換。231行付近 `td(gb <= 0 ? '-' : gb.toFixed(1))` → `td(gbText(i, gb))`。
- **renderHubHome**（1297行付近）: 同様に `const gb = gamesBehind(lgLeader, t);`、1301行付近 → `td(gbText(i, gb))`。
- 負値は `(-0.5).toFixed(1)` = `"-0.5"` と表示される。これは仕様（NPB でも勝率順と貯金が逆転した際に負のゲーム差は実在する）。

### 1-d. news.mjs — rankAndGb を共有ヘルパーに

- ファイル先頭に `import { gamesBehind } from '../sim/season.mjs';` を追加（news.mjs は現在 import ゼロだが、node のテスト実行・build 連結の両方で問題ない）。
- rankAndGb（112行付近）の `const gb = ((top.w - row.w) + (row.l - top.l)) / 2;` → `const gb = gamesBehind(top, row);`。

### 受け入れ基準

- `grep -rn "leader.w - t.w\|top.w - row.w\|lgLeader.w" src` の式重複が消えていること（gamesBehind 定義の1箇所のみ）。
- test/season.test.mjs あたりに単体テストを追加: `gamesBehind({w:10,l:4}, {w:12,l:5})` が `-0.5`、`gamesBehind({w:10,l:4}, {w:10,l:4})` が `0`、`gamesBehind(null, {w:1,l:0})` が `0`。
- 既存テストが全PASS（weeklyDigest のテスト test/game_c4.test.mjs は挙動不変のはず）。

---

## 修正2: 二軍順位表の「差」列 — 同一画面での意味二重化を解消

**指摘**: renderStandings の一軍表は今回「差=ゲーム差」「得失点差=rs-ra」に変わったが、同じ順位表画面の直下に出る renderFarmStandings（src/ui.mjs 263行付近）の「差」は得失点差のまま。同一ラベルが同一画面で別の指標を指す。

### 設計

renderFarmStandings のヘッダーと行を一軍表に合わせる:

- ヘッダー: `['順', '球団', '勝', '敗', '分', '勝率', '得点', '失点', '差']` → `['順', '球団', '勝', '敗', '分', '勝率', '差', '得点', '失点', '得失点差']`
- 行生成: リーグごとの `lgRows` の先頭行を leader とし、修正1のヘルパーで
  ```js
  const leader = lgRows[0];
  // 各行:
  const gb = gamesBehind(leader, t);
  // セル順: td(i+1), td(t.name,'left'), td(t.w), td(t.l), td(t.t), td(fmt3(winPct(t))), td(gbText(i, gb)), td(t.rs), td(t.ra), td((t.rs-t.ra>0?'+':'')+(t.rs-t.ra))
  ```
- lgRows は既に勝率→得失点差でソート済み（`rows` の sort を流用）なので並び替えは不要。

### 受け入れ基準

- ヘッダー列数とセル数が一致（10列）。
- `npm run smoke` PASS（順位表画面のヘッドレス描画が通ること）。

---

## 修正3: 先頭列固定の背景色をコンテナ追従に（モーダル内の縦縞解消）

**指摘**: tools/build.mjs 129行 `table.stat td:first-child { ... background:var(--bg); ... }` が全 stat 表にグローバル適用され、背景が `var(--panel)`（#123d2a）のモーダル（成績詳細 renderModalSplits / キャリア renderModalCareer / 観戦ボックスモーダル watch.mjs:762,778）では先頭列だけ `--bg`（#0f3d2e）の縦縞が**横スクロールの有無に関わらず常時**見える。

### 設計（CSS変数で1箇所オーバーライド）

tools/build.mjs のCSSを編集:

1. 129行付近: `background:var(--bg)` → `background:var(--sticky-bg, var(--bg))`
2. `.modal { ... }` の規則（135行付近）に `--sticky-bg:var(--panel);` を追加（モーダル内の全 stat 表の固定列がパネル色に揃う）。

これで新しい背景色のコンテナが増えても、そのコンテナに `--sticky-bg` を1行足すだけで済む（ケースごとの `td:first-child` 上書きを増やさない）。

### 受け入れ基準

- `npm run build` 後、dist/pennant.html に同じ変更が反映されている。
- `npm run smoke` PASS。
- （可能なら）Playwright 等で選手モーダルを開いたスクリーンショットを取り、先頭列の縦縞が消えていることを目視確認。できない環境ならCSSの適用関係の確認のみでよい。

---

## 修正4: tr.myteam の先頭セル上書きを順序非依存に

**指摘**: tools/build.mjs 183行 `tr.myteam td:first-child { background:#1c4a34; }` は 129行 `table.stat td:first-child`（詳細度 (0,2,2)）と**同点 (0,2,2)** で、ソース順でのみ勝っている。CSSの並べ替えで自チーム強調が先頭列だけ無音で消える。

### 設計

tools/build.mjs 182-183行の2規則:

```css
tr.myteam td { background:#1c4a34; font-weight:700; }
tr.myteam td:first-child { background:#1c4a34; }
```

を**1規則に統合**:

```css
table.stat tr.myteam td { background:#1c4a34; font-weight:700; } /* (0,2,3)で先頭列固定の(0,2,2)に順序非依存で勝つ */
```

- 全 `tr.myteam` は table.stat 内にのみ存在することを確認済み（ui.mjs table()ヘルパー / schedule.mjs:165 / watch.mjs:809 いずれも class に stat を含む）。実装時に `grep -rn "myteam" src` で再確認すること。
- `tr.clickable:hover td:first-child`（132行）は (0,3,2) で既に順序非依存なので**触らない**。

### 受け入れ基準

- `npm run smoke` PASS。順位表・日程画面で自チーム行の強調が先頭列含め全セルに効いていること（smoke またはPlaywright目視）。

---

## 修正5: 試合終了後の進行バーを sticky から外す（モバイル）

**指摘**: tools/build.mjs 345行（`@media (max-width:640px)` 内）の `.watchctrl { position:sticky; top:0; ... }` は、試合終了後は watchControls（src/ui/watch.mjs 883行付近）が同じ ctrl に最終スコア＋🎉ノータブル行（width:100%・猛打賞は3安打ごとに発火するため3行以上が現実的）＋ホームへ戻るボタンを append するため、**ブロック全体が画面上部に固定され小画面の1/3超を恒久占有**する。

### 設計

sticky は進行中（ボタン行が細い時）だけ必要。watch.mjs watchControls の ctrl 生成を:

```js
const ctrl = el('div', { class: 'row watchctrl', style: 'flex-wrap:wrap;margin:8px 0' });
```

から

```js
// 進行中のみ sticky（試合終了後はノータブル行等で肥大するため固定しない）
const ctrl = el('div', { class: 'row' + (done ? '' : ' watchctrl'), style: 'flex-wrap:wrap;margin:8px 0' });
```

に変更。CSS側は変更不要。

### 受け入れ基準

- `npm run smoke` PASS。
- 進行中はモバイル幅で進行ボタンが上部固定のまま／終了画面ではスクロールに追従しないこと。

---

## 修正6: 得点/HRパルス・🎉ポップの「1回だけ再生」を実装で保証

**指摘**: tools/build.mjs 194行付近の `.curabresult.ev-score, .curabresult.ev-hr { animation:pulseScore ... }` と `.notable { animation:notablePop ... }` は「決着の瞬間に1回だけ再生」とコメントするが、renderWatchScreen は毎回 `root.innerHTML=''` で全DOM再構築（watch.mjs:316）のため、**再生位置が進まない再描画**（サブタブ切替 watch.mjs:335 / 全球表示トグル watch.mjs:728 / 自動再生トグル watch.mjs:892）や終了画面での操作のたびにアニメが再発火して点滅する。

### 設計（「今回の描画は再生位置が進んだ描画か」フラグ + アニメを .fx クラスにオプトイン化）

**CSS（tools/build.mjs）**: アニメ規則を `.fx` 必須に変更。

```css
.curabresult.ev-score.fx, .curabresult.ev-hr.fx { animation: pulseScore .9s ease-out; }
.notable.fx { animation: notablePop .35s ease-out; }
```

コメントも実態に合わせて更新すること（「再生位置が進んだ描画(justAdvanced)でのみ .fx を付与＝タブ切替等の再描画では再発火しない」）。

**JS（src/ui/watch.mjs）**: watch状態 `w` にプロパティ `justAdvanced` を持たせる。

1. **セット（true）** — 再生位置が進む直前に必ず:
   - watchControls の `adv` 関数内: `const adv = (unit) => { w.unit = unit; w.justAdvanced = true; w.idx = watchAdvanceIdx(w, unit); renderWatchScreen(u); };`
   - 「⏩ 最後まで」の onclick: `w.justAdvanced = true;` を追加。
   - 自動再生の setTimeout コールバック（renderWatchScreen 末尾、watch.mjs:341-346）: `cw.idx = watchAdvanceIdx(...)` の前に `cw.justAdvanced = true;`。
   - 観戦開始時（ui.mjs renderWatch で game.watch を新規作成している箇所）: 初期値 `justAdvanced: true` を含める（初回描画で決着済みイベントがあれば1回だけ光る）。
2. **クリア（false）** — renderWatchScreen の**末尾**（自動再生の setTimeout 登録の後でよい。タイマー発火時に true に再設定されるため順序の問題はない）で `w.justAdvanced = false;`。
3. **付与** — 描画時に `.fx` を条件付きで足す:
   - watchCurrentAb（watch.mjs:611付近）: `box.append(el('div', { class: 'curabresult ' + (ab.result.cls || '') + (u.game.watch.justAdvanced ? ' fx' : '') }, ab.result.parts));`
   - watchControls のノータブル行（watch.mjs:900付近）: `class: 'newsrow good notable' + (w.justAdvanced ? ' fx' : '')`。

決定論には無関係（表示のみ・乱数不使用・Date不使用）。

### 受け入れ基準

- `npm test` / `npm run smoke` PASS。
- 手動確認（可能なら）: 得点打の直後にタブ切替・全球表示トグルを繰り返してもパルスが再発火しない／1球進めて新たな得点が決着した瞬間は光る。

---

## 修正7: TEAM_COLORS を generate.mjs の TEAM_NAMES とペア定義に移設

**指摘**: src/ui.mjs 1008行付近の TEAM_COLORS は generate.mjs の TEAM_NAMES（41-45行）と一字一句一致すべき日本語チーム名キーのシャドーコピー。generate.mjs 側で改名すると**エラーなくフォールバック色 `var(--clay)` に退化**し（セーブは masterSeed から replay 再構築のため既存セーブも影響）、テストも無い。なおチームID（T1..T12）は名前とインデックス非対応（リーグ割当がシード依存・generate.mjs:459-471）なので **IDキー化は不可**。名前と色を同じ場所で定義するのが正解。

### 設計

**src/generate.mjs** — TEAM_NAMES 定義（41-45行）の直下に追加:

```js
// 球団アクセントカラー（UI表示専用の識別色）。TEAM_NAMES とインデックス対応で定義し、
// 改名時に色マップだけ取り残される乖離を構造的に防ぐ。エンジンのロジックはこれを読まない。
const TEAM_ACCENTS = [
  '#e9e4d0', '#5ecbe0', '#4f8fe0', '#e0574a',
  '#e8c93a', '#9b8cd9', '#5fd694', '#d9a13d',
  '#b8c4c9', '#e0895a', '#8898a8', '#c65a86',
];
export const TEAM_COLORS = Object.fromEntries(TEAM_NAMES.map((n, i) => [n, TEAM_ACCENTS[i]]));
```

色の並びは TEAM_NAMES の並び（白鷺→疾風→蒼波→紅蓮→雷鳴→黒曜→翠嶺→金獅子→銀翼→暁→嵐山→夜叉）に対応させる。現行 ui.mjs の色割当と同一なので**見た目は不変**。

**src/engine.mjs** — generate.mjs からの import / export 集約に `TEAM_COLORS` を追加（`generateLeague` と同じ経路）。

**src/ui.mjs** — ローカルの `const TEAM_COLORS = {...}` ブロック（1007-1021行付近）を**削除**し、engine.mjs からの import に `TEAM_COLORS` を追加。`const teamColor = (id) => TEAM_COLORS[tname(id)] || 'var(--clay)';` はそのまま残す。

**test/generate.test.mjs** — ドリフト防止テストを追加:

```js
// TEAM_COLORS が全球団名を網羅している（改名時にここが落ちて乖離に気づける）
test('TEAM_COLORS covers all generated team names', () => {
  const league = generateLeague(createConfig({ seed: 1 })); // 既存テストの生成パターンに合わせる
  for (const t of league.teams) assert.ok(TEAM_COLORS[t.name], `color missing for ${t.name}`);
  assert.equal(Object.keys(TEAM_COLORS).length, 12);
});
```

（既存の generate.test.mjs の import・生成呼び出しの流儀に合わせて書くこと。）

### 受け入れ基準

- `npm test` PASS（新テスト含む）。`npm run verify` PASS（決定論不変 — 静的データ追加なので乱数消費ゼロ）。
- ui.mjs に球団名の文字列リテラルが残っていないこと: `grep -n "白鷺\|疾風\|蒼波" src/ui.mjs` がゼロ件。

---

## 実装順序と最終ゲート

**順序**: 修正1 → 2（1のヘルパーに依存）→ 7（import整理が近い）→ 3 → 4 → 5 → 6（watch.mjs集中）。
コミットは「修正1+2」「修正7」「修正3+4」「修正5+6」の4コミット程度に分け、メッセージは既存流儀（`fix(ui): ...` / 日本語サマリ）に従う。

**最終ゲート（全修正後・コミット前に必ず全部）**:

```bash
npm test           # 全テストPASS（追加テスト含む）
npm run verify     # Node↔ブラウザ同一性（決定論）— 表示層のみの変更なので不変のはず
npm run smoke      # UIヘッドレス描画
npm run calibrate  # 53指標PASS — 1つでも動いたら副作用バグ（表示層変更で動くはずがない）
npm run build      # dist/pennant.html 再生成 → コミットに含める
```

- calibrate が FAIL したら**即座に手を止めて原因調査**（エンジンに触れてしまっている）。
- 完了後 thyroxin/progress.md の先頭にエントリ追加（フォーマットは既存に倣う: 日時/やったこと/結果/次）。
- git はローカルコミットのみ。push しない。

## レビュー指摘との対応表

| 指摘（/code-review CONFIRMED） | 修正 |
|---|---|
| gb<=0 が首位以外でも「-」（ui.mjs:231,1301） | 修正1 |
| 同一画面で「差」が二重の意味（ui.mjs:263 二軍表） | 修正2 |
| sticky先頭列がモーダル内で縦縞（build.mjs:129） | 修正3 |
| 終了後のsticky進行バーが画面占有（build.mjs:345） | 修正5 |
| 演出が再描画のたびリプレイ（build.mjs:194） | 修正6 |
| ゲーム差の式が3箇所重複 | 修正1 |
| TEAM_COLORSが球団名のシャドーコピー | 修正7 |
| tr.myteam td:first-child が特異度同点の順序依存（build.mjs:183） | 修正4 |

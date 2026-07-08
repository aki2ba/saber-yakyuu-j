# フェーズG仕様 — UI再ゾーニング（スポナビ原則への全面改修）

> 根拠: thyroxin/research/ui_ux_review_20260707.md（全画面実測レビュー）。
> ユーザー要望: 「野球速報アプリはタブ切替で1画面完結。スクロールするタブでも共通ヘッダー以外は画面に映らない。
> 今のUIは1画面に情報がありすぎる」。
>
> **この仕様は実装担当モデル（Sonnet想定）がこの文書だけで作業を完遂できるよう書かれている。**
> 迷ったら本仕様の「決定」に従い、独自判断で構造を変えないこと。

## 0. 全体ルール（全作業項目に共通・厳守）

0. **前提**: `thyroxin/specs/f4_review_fixes_spec.md` の修正1〜7を**先に完遂**していること（未実装ならそちらが先）。
   本仕様は f4 修正後のコードを前提に書かれている（gamesBehind/gbText ヘルパー・TEAM_COLORS の generate.mjs 移設・
   justAdvanced/.fx 演出ガード）。f4 の修正5（試合終了時に watchctrl の sticky を外す）だけは G1a が
   固定下部バーで**上書き置換**する（G1a の注記参照）。
1. **エンジン非改変**: `src/sim/`・`src/game/`・`src/config.mjs` は変更しない。
   本フェーズは全項目が**表示レイヤーのみ**（`src/ui.mjs`・`src/ui/*.mjs`・`tools/build.mjs` の `<style>`・`tools/smoke-ui.mjs`）。
   唯一の例外: `src/generate.mjs` への**静的表示データ追加**（G1a の TEAM_ABBRS。f4 修正7 の TEAM_ACCENTS と
   同じ流儀＝TEAM_NAMES とペア定義・エンジンロジックは読まない・乱数消費ゼロ）。
   G2 も UI 側で `advanceDay` を分割呼び出しするだけ＝ゲーム層 API は既存のまま。
2. **決定論**: UI から乱数・`Date.now`・`Math.random` を使わない。観戦 UI はイベント列の再生位置（`game.watch.idx`）を
   動かすだけでゲーム状態を変えない（既存の原則を維持）。日次分割進行は `advanceDay` の逐次呼び出し＝
   `advanceTo` と同一結果（既存 `runToSeasonEnd` で実証済みのパターン）。
3. **検証**: 各コミット前に `npm test` → `npm run build` → `npm run smoke` → `npm run verify` → `npm run calibrate` を全部通す。
   UI 構造を変える項目は **同一コミットで tools/smoke-ui.mjs のアサーションも更新**する（壊れたまま次項目に進まない）。
   verify の ENGINE identity が変わったら即やり直し（エンジンに触った証拠）。
4. **コミット単位**: G1a〜G10 の各項目=1コミット。コミット後に thyroxin/progress.md へ1エントリ追記（新しいものを上）。
5. **CSSは tools/build.mjs の `<style>` ブロック（102行目付近〜）に追記**。クラス名は本仕様の指定どおりに。
6. **スタイルの流儀**: 日本語コメント・既存ヘルパー（`el()`/`td()`/`table()`）再利用・deps オブジェクト経由の参照
   （`src/ui/*.mjs` は ui.mjs を import しない）。
7. 実装順は G1a → G1b → G1c → G2 → G3 → G4a → G4b → G5a → G5b → G6 → G7 → G8 → G9 → G10。
   G1a/G4a が他項目の土台（略称マップ・フッター）なので順番を守る。
8. **ボタン文言は既存のまま変更しない**（レイアウト都合の短縮はしない）。理由: `tools/smoke-ui.mjs` の
   `btnByText(t)` は部分一致（`textOf(n).includes(t)`）でボタンを検索しており、文言を変えると
   無関係に見える箇所まで連鎖的に壊れる（実際に敵対的レビューで「▶ 1イニング」→「1回」等の短縮案が
   smoke破壊を引き起こすと複数回指摘された）。**幅が足りない場合は文言を削らずCSS（font-size/padding縮小）
   で収める**。これにより G1a の進行バー・G4a のフッターは、既存ボタンの文言・onclick 対象をそのまま
   移設するだけでよい（文言一覧は各項目内で「変更しない」と明記する）。
9. **行番号について**: 本仕様内の「○○行付近」はすべて **f4_review_fixes_spec.md 適用直後・G項目未着手時点**
   のソースを基準に記載している（2026-07-08 時点で実測済み）。G1a → G1b → … と進むにつれて実際の行番号は
   ずれていく。**行番号はあくまで着手時の目印**であり、一致しない場合は本文が指定するコード内容
   （関数名・クラス名・文言）を `grep` で探して特定すること。smoke-ui.mjs の更新も同様＝「この行を直せ」
   ではなく「このアサーションの内容をこう変えよ」という指示として読む。

## 0.1 新規共有部品（G1a で作る・以後の項目が参照）

**球団略称**。f4 修正7 で TEAM_COLORS が `src/generate.mjs` の TEAM_NAMES ペア定義に移設済みのはず。
略称も**同じ場所・同じ流儀**で定義する（ui.mjs にシャドーコピーを作らない — f4 レビュー指摘の再発防止）:

```js
// src/generate.mjs — TEAM_ACCENTS（f4修正7）の直下に追加
// 球団略称（UI表示専用・スコアボード/狭幅テーブル用）。TEAM_NAMES とインデックス対応。
const TEAM_ABBRS = [
  '白鷺', '疾風', '蒼波', '紅蓮', '雷鳴', '黒曜',
  '翠嶺', '金獅子', '銀翼', '暁', '嵐山', '夜叉',
];
export const TEAM_ABBR = Object.fromEntries(TEAM_NAMES.map((n, i) => [n, TEAM_ABBRS[i]]));
```

- `src/engine.mjs` の import / export 集約に `TEAM_ABBR` を追加（TEAM_COLORS と同じ経路）。
- `src/ui.mjs`: engine.mjs からの import に `TEAM_ABBR` を追加し、「小物」セクションに
  `const tabbr = (id) => TEAM_ABBR[tname(id)] || tname(id);` を定義。
- `test/generate.test.mjs`: f4 修正7 のドリフト防止テストに TEAM_ABBR 版を1本追加
  （全球団名にエントリがある・12件・値が非空）。
- `watchDeps()`（と後続で使う deps）に `tabbr` を追加して分割モジュールへ渡す。

---

# P0（最優先）

## G1. 観戦画面の再ゾーニング（3コミットに分割: G1a/G1b/G1c）

### 完成形（この構造以外の要素を観戦画面に常設しない）

```
┌─ ヘッダー行（既存 .header: 「観戦」+ ホームへ戻る）
├─ ① コンパクトスコアボード .scorebar（sticky top:0）
│     [紅蓮 3]  [3回表 / B●○○ S●○ O●○ / ◇◆◇塁]  [白鷺 3]   [▼]
│     （▼タップで .sblinescore=イニング別ラインスコアを開閉。既定閉）
├─ ② 観戦タブ .wtabs: 速報 | 対戦 | ボックス | スタメン（4種・既定=速報）
├─ ③ タブ本体（そのタブの内容**だけ**）
│     速報   = 現在の打席 .curab（球列+結果+指標変化）→ 実況フィード .pbp
│     対戦   = 盤面 .diamond（走者名付き）→ 対戦カード .matchup → 打球図 .fieldcol
│     ボックス = 既存 watchBoxTab のまま
│     スタメン = 既存 watchLineupTab（G1cでflexバグ修正）
└─ ④ 進行バー .watchctrl（fixed bottom・全幅・1行。ボタン文言は既存のまま変更しない＝§0ルール8）
      [▶ 1球(primary)] [▶ 1打席] [▶ 1イニング] [▶▶ 自動再生] [⏩ 最後まで]
      試合終了時: [ホームへ戻る(primary)] のみ＋スコアバー中央が「試合終了」（延長なら「延長X回」）
```

**廃止するもの**: `.nowpanel`（大スコア+大ダイヤ常設）・ラインスコア常設・`.duelpanel` 常設。
アウト/回の表示は①に一本化（「N アウト」テキスト・ダイヤ内の `0 OUT` 円・二重の回表示を撤去）。

### G1a: コンパクトスコアボード＋タブ4分割（src/ui/watch.mjs 大改修）

**変更**: `renderWatchScreen` の**組み立て部（root への append 順）だけ**を完成形の順に差し替える。
関数前半（`u.refreshRes()`・`w.beforeGame` 初期化・`watchReconstruct` 呼び出し・`root.innerHTML=''`）と、
関数末尾の自動再生 `setTimeout` ブロック（f4修正6 の `w.justAdvanced=false` クリア込み）は**そのまま維持**し、
新しい append 順の**最後**（自動再生タイマー登録の直後）に置く。

1. `TEAM_ABBR`/`tabbr` を ui.mjs に追加し `watchDeps()` へ（→ §0.1）。
2. **`lampRow` をモジュールレベルへ移設**: 現在 `watchNowPanel` 内のローカル関数（`const lampRow = (label, n, max, cls) => ...`）
   なので、`watchNowPanel` を削除する**前に** `watchDiamond` の直前あたりへ切り出しておく（削除後に
   `ReferenceError` を起こさないため）。
3. 新関数 `watchScorebar(v, u, w)`（`watchNowPanel` の置き換え。**`watchNowPanel` はこの関数の新設後に削除**）:

```
<div class="scorebar">
  <div class="sbteam away nowmy?" style="--team-accent:...">
    <span class="sbname">紅蓮</span><span class="sbscore">3</span></div>
  <div class="sbmid">
    <div class="sbinning">3回表</div>              … v.ended 時は「試合終了」＋延長なら「延長10回」
    <div class="sbbso bso">                         … v.ended 時はこの div ごと非表示
      …既存 .bso ラッパと同じ構造で lampRow×3（B3/S2/O2）を並べる…
    </div>
    <div class="sbbases">                           … v.ended 時はこの div ごと非表示（残塁走者の残留表示を防ぐ）
      <span class="sbbase b3 on?"/><span class="sbbase b2 on?"/><span class="sbbase b1 on?"/>
    </div>
  </div>
  <div class="sbteam home">…</div>
  <button class="sbexpand link">▼</button>         … w.lineOpen トグル（UIローカル）
</div>
```

   - チーム名は `tabbr()`（縦折れ解消）。自チームは `nowmy` クラス（金色）。
   - `w.lineOpen === true` のとき scorebar 直下に既存 `watchLineScore(v, u)` を `.sblinescore` ラッパで描画。既定 false。
   - **`.sbbso`（B-S-Oランプ）と `.sbbases`（塁表示）はどちらも `v.ended` で描画しない**
     （B-S-Oランプの残留点灯バグ・塁アイコンの残留表示を両方根治する）。
   - CSSは既存の `.bso`/`.bsorow`/`.lamp`/`.lb`/`.ls`/`.lo` をそのまま使う（`.sbbso` はラッパ用の追加クラス、
     内部構造は現行 `watchNowPanel` の `.bso` と同一にする）。
4. タブを4種に: `[['live','速報'],['duel','対戦'],['box','ボックス'],['lineup','スタメン']]`。
   - `live`: **`watchCurrentAb(v, u)` の先頭に現在の対戦者を1行足す**（下記5参照）→ 既存の球列・結果・
     指標変化ぶら下げ → `watchFeedTab(...)`。
   - `duel`: `watchDiamond(v, u)` → `watchMatchup(v, u)` → `watchFieldChart(v, u)`。
     `.duelpanel` ラッパは廃止し、`<div class="dueltab">` に縦積み。
   - `box`/`lineup`: 既存関数をそのまま。
5. **速報タブに現在の打者/投手名を出す（UX必須）**: 現行の `watchCurrentAb`（`.curabhead`「現在の打席」の下が
   投球テキストのみ）は、決着前は打者名・投手名がどこにも出ない。`watchMatchup` は対戦タブへ移るため、
   速報タブ既定表示だけでは「誰が打っているか」が分からなくなる。`watchCurrentAb` の `.curabhead` の直下に
   1行追加する:
   ```
   <div class="curabvs">打者 [playerLink(v.batterId)]（[利き腕]・今日X打数Y安打） 投手 [playerLink(v.curPitcherId)]（球数N）</div>
   ```
   - `v.batterId`/`v.curPitcherId`/`v.daily.get(v.batterId)`/`v.curPitchCount` から組む（`watchMatchup` と同じ
     データソース・利き腕表記は `watchBatsJP` を再利用）。`v.batterId` が null（試合開始前）なら1行丸ごと省略。
   - CSS: `.curabvs { font-size:12px; color:var(--chalk); margin-bottom:4px; }`
6. `watchDiamond` から下部のアウトカウント円3つ＋「N OUT」テキスト＋上部の「N回表」テキストを削除
   （scorebar に一本化。塁の菱形＋走者名だけ残す）。
7. 進行バー `watchControls` 改修（**ボタン文言は§0ルール8のとおり一切変更しない**）:
   - 生成部のインラインstyleを削除する:
     `el('div', { class: 'row watchctrl', style: 'flex-wrap:wrap;margin:8px 0' })` →
     `el('div', { class: 'row watchctrl' })`（レイアウトは下記CSSに一本化。インラインstyleを残すと
     新CSSの `flex-wrap:nowrap`/`margin:0`/`position:fixed` 系プロパティに要素側が勝ってしまい機能しない）。
   - 進行中の5ボタン（`▶ 1球`／`▶ 1打席`／`▶ 1イニング`／`▶▶ 自動再生`⇄`⏸ 自動再生を止める`／`⏩ 最後まで`）は
     **文言そのまま**、CSS（font-size縮小・padding縮小）で1行に収める。
   - 試合終了時: `.finalscore`（最終スコア行）は**削除**（scorebar が同じ情報を示す）。
     `🎉` 珍記録（notables）は**速報フィードの先頭**に移す（下記8）。「ホームへ戻る」ボタンは維持
     （文言・onclickとも変更なし）。
   - **f4 修正5/6 との整合**: 修正5 の「done 時に watchctrl クラスを外す」条件分岐は本改修（固定下部バー）で
     不要になるため削除してよい。修正6 の `w.justAdvanced`/`.fx` は**維持**する。
   - ヘッダー右上の「ホームへ戻る」は残す（終了前の離脱動線）。
8. **珍記録（notables）の移設**: `watchControls` の終了時ブロックから `detectGameNotables`/`notableHeadline` の
   呼び出しを削除し、`watchFeedTab` 側で `v.ended` のとき配列の先頭に足す。
   クラスは **`'pbpline newsrow good notable' + (w.justAdvanced ? ' fx' : '')`**、テキストは現行どおり
   `🎉 ${head}` プレフィックスを維持する（`.newsrow.good` の金枠スタイルを流用して祝祭感を保つ。
   `.pbpline` 単体では枠スタイルが無いため `newsrow good` を必ず併記すること）。
9. CSS 追加（build.mjs `<style>`）:

```css
/* G1a: 観戦コンパクトスコアボード（常設はこれだけ・sticky） */
.scorebar { position:sticky; top:0; z-index:6; display:flex; align-items:center; justify-content:space-between;
            gap:8px; background:#0d3526; border:1px solid var(--clay); border-radius:10px; padding:6px 10px; margin:8px 0; }
.sbteam { display:flex; align-items:baseline; gap:8px; min-width:0;
          border-top:3px solid var(--team-accent, transparent); padding-top:2px; }
.sbname { font-size:13px; font-weight:700; color:var(--chalk); white-space:nowrap; }
.sbteam.nowmy .sbname { color:var(--gold); }
.sbscore { font-size:26px; font-weight:800; line-height:1; }
.sbmid { text-align:center; flex:1; }
.sbinning { font-size:14px; font-weight:700; color:var(--gold); }
.sbmid .bso { justify-content:center; gap:8px; margin:2px 0 0; }
.sbmid .bsorow { gap:3px; } .sbmid .lamp { width:9px; height:9px; }
.sbbases { display:flex; justify-content:center; gap:10px; margin-top:3px; }
.sbbase { width:9px; height:9px; transform:rotate(45deg); background:#0c3122; border:1px solid var(--clay); display:inline-block; }
.sbbase.on { background:var(--gold); border-color:var(--gold); }
.sblinescore { margin:0 0 8px; }
.curabvs { font-size:12px; color:var(--chalk); margin-bottom:4px; }
.dueltab { display:flex; flex-direction:column; gap:10px; align-items:center; margin-top:8px; }
.dueltab .matchup { width:100%; }
.dueltab .curab { background:#0d3526; } /* 旧 .duelpanel .curab の背景を引き継ぐ（対戦タブでは curab は使わないが将来の統一のため） */
/* G1a: 進行バーを下部固定（親指到達域）。文言は変えずCSSだけで1行に収める */
.watchctrl { position:fixed; left:0; right:0; bottom:0; z-index:8; display:flex; gap:4px; flex-wrap:nowrap;
             background:var(--bg); border-top:1px solid var(--line); padding:8px; margin:0;
             box-shadow:0 -6px 8px -6px rgba(0,0,0,.5); }
.watchctrl button { flex:1; min-height:44px; min-width:0; padding:6px 1px; font-size:11px; white-space:nowrap; }
.watchspacer { height:68px; }
/* G1a: 観戦タブバー(.wtabs)もスコアバー直下にsticky化（ハブの.tabs同様・スクロール中も切替を失わない） */
.wtabs { position:sticky; top:56px; z-index:5; background:var(--bg); padding:4px 0; flex-wrap:nowrap; overflow-x:auto; }
@media (min-width:900px) {
  /* デスクトップでは対戦タブを2カラム横並びに戻す・進行バー/フッターのボタンを肥大させない */
  .dueltab { flex-direction:row; align-items:flex-start; justify-content:center; }
  .dueltab .matchup { width:auto; flex:1; max-width:520px; }
  .watchctrl { justify-content:center; }
  .watchctrl button { flex:none; min-width:110px; }
}
```

   - **既存の `@media(max-width:640px)` 内 `.watchctrl { position:sticky; top:0; … }` ブロックは削除**（上書きではなく除去。
     f4修正5でこの行が消えている場合は何もしない）。
   - **`.nowpanel` 系CSSの削除範囲を明記**: `.nowpanel`・`.nowscore`・`.nowteam`・`.nowtname`・`.nowtscore`・
     `.nowmid`・`.nowinning`・`.nowouts`・`.nowpanel .bso`・`.nowpanel svg.diamond` の各規則、および
     `@media` 内の連結セレクタ `.nowpanel, .duelpanel, .lineupbody, .sprayrow, .awardtop { flex-direction:column; }`
     からは `.nowpanel` と `.duelpanel` の2つだけを外す（`.lineupbody`/`.sprayrow`/`.awardtop` は他機能が使うため残す）。
     `@media` 内の `.nowpanel svg.diamond { width:170px; }` 等の個別規則も削除。
   - **削除しないもの**: `.bso`/`.bsorow`/`.bsolabel`/`.lamp`/`.lb`/`.ls`/`.lo`（scorebarが流用）・
     `.duelcol`（`watchFieldChart` の `fieldcol` が `class:'duelcol fieldcol'` で使用中・削除すると打球図が壊れる）・
     `.matchup`/`.curab`（対戦タブ/速報タブで引き続き使用）。
   - `renderWatchScreen` の最後（自動再生タイマー登録の直後）に `el('div', { class: 'watchspacer' })` を必ず append。
10. **smoke-ui.mjs 更新**（対象は「G5) 次の試合へ→観戦」〜「G6) セーブ/ロード」直前まで。
    2026-07-08時点の目印は 261〜459行）。**構造的な変更点ごとに以下を適用**:
    - **進行ボタンの文言は変更不要**（§0ルール8）。既存の `for (const b of ['1球','1打席','1イニング','自動再生'])`
      系・`btnByText('1打席')`・`btnByText('自動再生')`/`('止める')`・`btnByText('最後まで')` はそのまま動く。
    - **`.nowpanel` 系ブロック**（`hasClass('nowpanel')`・`.nowtscore`×2・回/アウトのテキスト・`.lamp`≥7・
      パネル内`.diamond`。目印269-278行）→ `.scorebar` 系に置換: `hasClass('scorebar')` 存在／
      `.sbscore`×2／`textOf(scorebar)` に「回」を含む（v.ended前）／`.sbbase`×3／scorebar内`.lamp`≥7。
    - **トップレベルの `diamond` assert（目印266行）**: 観戦開始直後は既定タブが `live` になり `diamond` は
      出ない。この assert は**削除し**、後述の「対戦タブ切替後」ブロックへ統合する。
    - **`.scoreboard` 常設 assert（目印267行）**: `.sbexpand` ボタンをクリックしてから
      `hasClass('scoreboard')` を検証する形に変更（クリック前は存在しない前提）。
    - **`.duelpanel`/`.matchup`/`.fieldchart` 系ブロック（目印289-308行）**: これらは**すべて対戦タブへの
      切替後**に検証するよう移動する。`.duelpanel` 存在 assert は `.dueltab` 存在に置換。手順:
      `allClass('wtab').find(n => textOf(n)==='対戦')._onclick()` してから diamond/matchup/handtag/fieldchart 系を検証。
    - **サブタブ**: `wtabs.length===3`→`4`、`['速報','ボックス','スタメン']`→`['速報','対戦','ボックス','スタメン']`
      （目印347-349行）。ボックス/スタメンタブへの遷移テストは既存のまま（対戦タブの検証を追加した後に続ける）。
    - **`.curab` assert（目印319行）**: 既定の速報タブで検証（文言「対戦カード直下」→「速報タブ先頭」）。
      新設の `.curabvs`（打者/投手名1行）が `v.batterId` セット後に存在することの assert も1つ追加する。
    - **ゾーニングの門番を追加**: 速報タブでは `diamond`/`fieldchart`/`matchup` が出ない・対戦タブでは `.pbp` が
      出ない・ボックスタブでは `.pbp` が出ない（既存）ことを assert する。
    - **`btnByText('1打席')`／`btnByText('1イニング')` 後の再描画確認（目印370-373行）**:
      現行は `hasClass('matchup')` で確認しているが matchup は対戦タブ限定になるため、
      「速報タブにいるまま」なら `hasClass('curab')`（存在し続けること）や `hasClass('pbp')` に置換する。
      対戦タブに切り替えたままこの検証を行いたい場合は、その旨を明記して `.matchup` のままでよい
      （どちらでも良いが、実装者はどちらか一方に統一しコメントすること）。
    - **打球フィールド図ループ（目印376-390行）**: `fieldchart` は対戦タブでのみ描画されるため、
      ループに入る前に対戦タブへ切り替える。加えて `fieldSvg` が見つかるまでのループ条件を
      **`fieldSvg` が `undefined` の間も続行できる形**に直す（現行 `(fieldSvg.className||'').includes('empty')` は
      `fieldSvg` が undefined だと例外になる — `!fieldSvg || fieldSvg.className.includes('empty')` に変更。
      これは G1b で `.empty` の枠自体を非描画にする変更とも整合させること）。
    - **`.finalscore` assert（目印427-429行）**: `.finalscore` は削除されるため、
      `hasClass('scorebar')` のテキストに「試合終了」が含まれることを assert する形に置換。
    - **試合終了時の対戦カード検証（目印441-445行）**: 対戦タブへ切り替えてから `.matchup`/`.reschip` を検証。
11. **受け入れ基準**: モバイル390px想定で「速報タブの現在の打席（打者/投手名込み）がスコアバー+タブ直下
    （≈150px以内）から始まる」「ボックス/スタメンタブに対戦カード・打球図・実況が一切出ない」
    「終了時にB-S-Oランプ・塁表示が出ない」。
    コミット例: `feat(ui): G1a 観戦再ゾーニング — コンパクトスコアボード＋タブ4分割＋下部進行バー`

### G1b: 観戦の重複表示・空表示の整理

- `watchFieldChart`: 結果ラベル `.fieldlabel` は残すが、打球なし打席（三振/四球等）では**図の枠ごと描画しない**
  （`.fieldchart.empty` の枠表示をやめ、`まだ打球なし` の1行だけに）。smoke の '.empty で薄表示' assert は
  「打球なし時は fieldchart 非描画＋ fieldlabel のみ」に置換。
  **注意**: G1a 手順10の打球フィールド図ループ修正（`!fieldSvg || …` への変更）と対になる変更である
  （`fieldchart` 自体が消えるため、ループの「見つかるまで進める」条件が undefined 安全である必要がある）。
  G1a と G1b は近接するコミットなので、smoke の該当ループはどちらのコミットで直してもよいが**両方の変更が
  揃うまでは smoke が通らない**ことを認識しておくこと（片方だけをコミットして smoke が壊れたまま放置しない）。
- `watchCurrentAb` の結果行と実況フィードの重複は**許容**（タブが分かれたため同時表示されない）。変更しない。
- scorebar の回表示と実況の回見出し行の重複も許容（フィードは履歴なので）。
- コミット例: `feat(ui): G1b 打球図の空枠を撤去（打球なし打席は1行表示）`

### G1c: スタメンタブ横はみ出しバグ修正（実測 scrollWidth 454/390）

- **原因**（実測特定済み）: `@media(max-width:640px)` で `.lineupbody` が `flex-direction:column` になるが
  `flex-wrap:wrap` が残るため、CSS仕様（column+wrap は交差軸=幅が内容サイズ）により `.lineupcol` が
  「今日」列 nowrap 文字列の幅（444px）へ広がり、`.tablewrap` の横スクロールが機能しない。
- **修正**: media 内に `.lineupbody { flex-wrap:nowrap; } .lineupcol { min-width:0; width:100%; }` を追加。
  `.benchbox` にも `min-width:0; width:100%;`。
- **検証**: tools/smoke-ui.mjs は幅を測れないため、Playwright での手動確認を progress.md に記録
  （`page.evaluate(() => document.body.scrollWidth) === 390` を試合終了+スタメンタブ状態で確認）。
  確認スクリプトの雛形はレビュー時のもの: スクラッチパッド `probe-overflow.mjs` 参照（無ければ同等を書く）。
- コミット例: `fix(ui): G1c スタメンタブのモバイル横はみ出し（column+wrapの交差軸拡張）を修正`

## G2. 「1週間・月末まで」のフリーズ解消（日次分割進行＋プログレスバー）

**現状**: `advanceChunk(until)` が `advanceTo(gs, until)` を同期実行 → 二軍込みで数十秒 UI が固まる。
**変更**: `src/ui.mjs` に `runAdvanceWithProgress(until)` を新設し、ホーム/フッターの
「1週間」「月末まで」をこれに差し替える（`advanceChunk` は削除。ボタン文言は §0ルール8のとおり変更しない）。

```js
// G2: 週/月の進行を日次分割で実行（runToSeasonEnd と同じチャンク進行パターン・決定論は advanceDay の逐次で不変）
// until: 'weekEnd' | 'monthEnd'。advanceTo と同じ停止条件を span 境界で再現する。
function runAdvanceWithProgress(until) {
  const gs = game.gs;
  const span = until === 'weekEnd' ? gs.cfg.game.daysPerWeek : gs.cfg.game.daysPerMonth;
  const startDay = pendingDayOf(gs.rt) - 1;                    // 0始まりの現在day
  const targetDay = Math.floor(startDay / span) * span + span; // 次の span 境界（advanceTo と同義）
  // 見出しは until から引く: 'weekEnd'→「1週間を進行中…」 / 'monthEnd'→「月末まで進行中…」
  // オーバーレイ: .overlay > .modal に h2（上記見出し）+ .pbtrack/.pbfill + .muted テキスト
  // step(): 1日ぶん advanceDay(gs) → 進捗 = (現在day - startDay) / (targetDay - startDay)
  //         rt.finished か day >= targetDay で終了 → autoSave() → overlay除去 →
  //         rt.finished ? renderSeasonResult() : renderHub()
  //         それ以外は setTimeout(step, 0)
}
```

- 注意: `advanceTo` の実際の境界計算は `src/game/index.mjs` の `advanceTo` 関数内（`weekEnd`/`monthEnd` 分岐）にある。
  実装前に必ず読み、上記 targetDay がズレる場合は **advanceTo 側の式に合わせる**（エンジンは変えない）。
- 進行完了後の挙動（renderHub へ戻る）は現状と同じ。1日=約11試合（一軍6+二軍4-5）なので1tickは体感瞬時。
- **smoke 更新（必須・軽微ではない）**: `tools/smoke-ui.mjs` は「月末まで」ボタンを**同期進行前提**でクリックしている
  箇所が2箇所ある（2026-07-08時点の目印: ①461行付近「G7) 進行（月末まで）→シーズン終了まで」ブロック、
  ②719行付近「2年目シーズン中の昇格・降格ニュース」ループ）。G2 で非同期チャンク化すると、クリック直後の
  アサーションは**まだ1日も進んでいない状態**で走ってしまう。
  - ①のブロックには既に `timers.length = 0;`（旧実装のタイマー残渣を**破棄**する行）があるが、これを
    「破棄」ではなく「**全部実行**」に変える: 同ファイル465-466行付近に既にある
    `let flush = 0; while (timers.length && flush++ < 100000) { const fn = timers.shift(); fn(); }`
    と同じパターンのヘルパーを、'月末まで' クリック直後にも適用する（`timers.length = 0` を削除し、
    同じ flush ループに差し替える）。
  - ②のループは `btnByText('月末まで')._onclick();` の直後に同じ flush ループを挿入しないと、
    5回ループしても1日も進まず `movesFound` が false のまま assert 失敗する。
  - 共通化したい場合は smoke 冒頭に `const flushTimers = () => { let n = 0; while (timers.length && n++ < 100000) timers.shift()(); };`
    を定義し、上記2箇所と既存の465-466行を差し替えてもよい（機能は同一）。
- 受け入れ: 「1週間」押下→即プログレスバー表示→完了までUI応答（ボタン連打不可のため overlay がクリックを遮る）。
- コミット例: `feat(ui): G2 週/月進行を日次分割＋プログレスバー化（同期フリーズ解消）`

## G3. 成績タブの規定閾値を消化試合比例に＋空状態メッセージ

**変更**: `src/ui.mjs` `renderBatting` / `renderPitching`。

1. 閾値関数を追加:

```js
// G3: 規定ライン（NPB: 打席=試合数×3.1 / 投球回=試合数×1.0）。シーズン途中は消化試合に比例させ、
// 通年では従来の固定フィルタ（打者100PA/投手20IP）と同値に収める＝通年の表示は従来と不変。
function qualifyPa(teamId) {
  const st = state.res.standings.find((t) => t.teamId === teamId);
  const g = st ? st.w + st.l + st.t : 0;
  return Math.min(100, Math.max(1, Math.ceil(g * 3.1)));
}
function qualifyIp(teamId) { …同様に Math.min(20, Math.max(1, Math.ceil(g * 1.0))) … }
```

2. `renderBatting` のフィルタ `s.batting.pa >= 100` → `s.batting.pa >= qualifyPa(s.teamId)`。
   `renderPitching` の `outs/3 >= 20` → `>= qualifyIp(s.teamId)`。
3. **空状態**: `statTable` のシグネチャに `opts = {}` を追加し `opts.emptyMsg` を持たせる
   （**この `opts` オブジェクトは G5a が `groups`/`getGroup`/`setGroup` を足して再利用する共通の拡張点**。
   G3 時点では `emptyMsg` のみでよい）:
   ```js
   function statTable(data, cols, fmtDec3, fmtPct, defaultSort, dec = 0, opts = {}) {
     const { emptyMsg } = opts;
     // render() の先頭、ソート・行構築の前に:
     //   if (!data.length) { wrap.innerHTML=''; wrap.append(el('div',{class:'emptybox'}, emptyMsg || '対象データがありません。')); return; }
   }
   ```
   呼び出し側（`renderBatting`/`renderPitching`）は7番目の引数に
   `{ emptyMsg: '規定到達者がまだいません（規定打席=消化試合×3.1・規定投球回=消化試合×1.0）。試合を進めると表示されます。' }`
   を渡す。
4. 通年（quick-sim/シーズン終了時）は g=143 → min で従来値に一致し**既存 smoke/表示は不変**。
5. CSS: `.emptybox { text-align:center; padding:24px 8px; color:var(--muted); }`
6. 受け入れ: 開幕直後（第2節）でも打撃/投手表に主力が並ぶ。0件時に列だけのヘッダーが出ない
   （列数は `BAT_COLS.length`/`PIT_COLS.length` に依存するため本仕様では固定数を書かない — 実装時に
   `console.log(BAT_COLS.length)` 等で確認すること。数値をハードコードした受け入れテキストを書かない）。
7. コミット例: `feat(ui): G3 成績タブの規定を消化試合比例に（序盤の空表解消・通年は従来と同値）`

---

# P1

## G4. ハブ再構成（2コミット: G4a フッター/sticky、G4b ホーム絞り込み）

### G4a: 全タブ共通の進行フッター＋stickyタブバー

1. `renderHub` の最後に**全タブ共通**の固定フッター `.hubfooter` を append。
   **ボタン文言は既存のまま（§0ルール8）**: `▶ 次の試合へ` / `1週間` / `月末まで` / `シーズン終了まで`。
   （短縮しない。4つ合計でも1行に収まる想定 — 収まらない場合はG1aの進行バーと同じくCSSで詰める。
   絵文字プレフィックス`⏩`等を新たに付け足すのも避ける＝既存ボタンをそのまま移設するだけにする。）
   - onclick は既存: `showNextGameChoices()` / `runAdvanceWithProgress('weekEnd')` /
     `runAdvanceWithProgress('monthEnd')` / `runToSeasonEnd()`。
   - `rt.finished` 時は `[シーズンリザルトへ(primary)]` の1ボタン。
   - 末尾に `.hubspacer`（height:68px）を append。
2. ホームの `.progressbar-wrap`（進行セクション）は**削除**（フッターへ一本化）。
3. `.tabs`（ハブのタブバー）を sticky 化＋モバイル1行スクロール:

```css
/* G4a: ハブタブバー sticky＋モバイル横スクロール1行。進行フッターは全タブ常設 */
.tabs { position:sticky; top:0; z-index:6; background:var(--bg); padding:6px 0; margin:6px 0;
        flex-wrap:nowrap; overflow-x:auto; }
.tabs .tab { white-space:nowrap; flex:none; }
.hubfooter { position:fixed; left:0; right:0; bottom:0; z-index:8; display:flex; gap:6px;
             background:var(--bg); border-top:1px solid var(--line); padding:8px;
             box-shadow:0 -6px 8px -6px rgba(0,0,0,.5); }
.hubfooter button { flex:1; min-height:44px; white-space:nowrap; padding:6px 2px; }
.hubspacer { height:68px; }
@media (min-width:900px) {
  /* デスクトップでは flex:1 のボタンが幅いっぱいに間延びするのを防ぐ（G1a .watchctrl と同じ配慮） */
  .hubfooter { justify-content:center; }
  .hubfooter button { flex:none; min-width:140px; }
}
```

   - 注意: クイックシミュレート側（`renderMain`）も `.tabs` を使う。sticky 化は共通で害がないためそのまま適用。
     フッターはキャリアモード（`renderHub`）のみ。観戦画面（`renderWatchScreen`）はフッターを出さない
     （`.watchctrl` が同位置にあるため）。
4. smoke: ボタン文言を変えていないため `btnByText('月末まで')`/`btnByText('シーズン終了まで')` 等の
   既存アサーションは無変更で動く（§0ルール8の設計判断により smoke 変更が不要になっている点を確認する）。
   フッター存在 assert（`hasClass('hubfooter')`）を1つ追加。
5. コミット例: `feat(ui): G4a 全タブ共通の進行フッター＋stickyタブバー`

### G4b: ホームの絞り込み（9セクション→4＋ヘッダー導線）

1. ホーム（`renderHubHome`）に残すもの・順序: **次戦カード → ニュース（3件+一覧へ） → 直近の結果（5件） → ミニ順位表 → 調子**。
2. **移動前に必須の下準備（ブロッカー回避）**: `renderManagerPanel()` と `renderSavePanel()` は
   現在どちらも内部の onclick が**引数なしの `renderHub()`（＝ホームタブ固定）を直接呼んでいる**
   （例: おまかせトグル・方針ボタン・スロット保存ボタン）。この2関数をホーム以外（チームタブの
   サブタブ・overlay モーダル）から呼ぶと、ボタンを押すたびに**呼び出し元から強制的にホームタブへ
   遷移する**（モーダルなら消滅する）回帰が起きる。移動の**前**に両関数を再描画コールバック引数化する:
   ```js
   // 変更前: function renderManagerPanel() { ... onclick: () => { ...; renderHub(); } ... }
   // 変更後:
   function renderManagerPanel(rerender = () => renderHub()) {
     // 内部の renderHub() 呼び出しをすべて rerender() に置換
   }
   function renderSavePanel(rerender = () => renderHub()) {
     // 同様に renderHub() 呼び出しをすべて rerender() に置換
   }
   ```
   デフォルト引数によりホームからの既存呼び出し（`renderManagerPanel()`）は無変更で動く。
3. 移動・削除:
   - **采配パネル**: チームタブへ。`src/ui/team.mjs` のサブタブを「一軍/二軍/采配」の3つに拡張し、
     采配サブタブで `u.renderManagerPanel(() => u.rerender())` を描く
     （`teamTabDeps()` に `renderManagerPanel` を追加して渡す。`u.rerender` は既存の
     `() => renderHub('team')` — これにより方針変更後もチームタブ・采配サブタブに留まる）。
   - **セーブパネル**: ハブヘッダーの「≡ タイトル」の隣に「💾 セーブ」リンクボタンを置き、
     クリックで overlay モーダル内に `renderSavePanel(rebuildModalBody)` を表示する
     （modalhead＋✕は選手モーダルの流儀。`rebuildModalBody` は「モーダルの中身だけ作り直す」関数
     ＝`renderHub()` を呼ばず overlay は保持したまま `box` の中身を `renderSavePanel(rebuildModalBody)` で
     再構築する。これによりスロット保存直後もモーダルが開いたままになり「→ロードN」ボタンへ進める）。
   - **故障者リスト**: ホームから削除（ニュースタブ・チームタブの状態列に既出＝三重表示の解消）。
     チームタブ冒頭に1行サマリ「離脱中: N名（→ニュース）」を追加（0名なら出さない。「→ニュース」部分は
     `link` ボタンにし `teamTabDeps()` に追加する `gotoNews: () => renderHub('news')` を呼ぶ。
     テキストのみだと到達手段が無くなる）。
4. ニュースは `renderNewsFeed` の見出し配列を **3件に slice** し「一覧へ →」導線は既存のまま。
5. smoke: ホームに采配/セーブ/故障者が無いこと・チームタブ采配サブタブで tendrow が描けること・
   **方針ボタンを押した後もチームタブ（采配サブタブ）に留まること**・セーブモーダルが開けて
   **スロット保存後もモーダル内で「→ロードN」に進めること**を assert
   （既存の采配/セーブ assert はホーム前提なら移動先に書き換え）。
6. 受け入れ: モバイル390pxでホーム全高 ≤ 約2画面（実測1311px→目標900px前後）。
7. コミット例: `feat(ui): G4b ホーム絞り込み（采配→チームタブ/セーブ→ヘッダー導線/故障者の重複解消）`

## G5. モバイル列整理（2コミット: G5a 成績列グループ、G5b 順位表詳細トグル）

### G5a: 成績タブの列グループ切替＋チーム略称

1. **`statTable` シグネチャ**（G3 が足した `opts` を拡張する。G3 実装後の形に `groups`/`getGroup`/`setGroup` を追加）:
   ```js
   function statTable(data, cols, fmtDec3, fmtPct, defaultSort, dec = 0, opts = {}) {
     const { emptyMsg, groups, getGroup, setGroup } = opts;
     // 表示列の決定（毎 render() 呼び出しで再評価）:
     //   groups が無ければ cols をそのまま使う。
     //   groups があれば groups.find(([k]) => k === getGroup()) を引き、
     //     その第3要素が null なら cols をそのまま使う（='全列'グループ）、
     //     配列なら「その配列の並び順」で cols から該当列を1つずつ探して並べる
     //     （BAT_COL_GROUPS 等のグループ配列の記載順=表示順。cols を Set でフィルタして
     //      cols 側の元の並びを使うのではない — 例えば saber 群は war を最後に置きたいので、
     //      グループ配列の順序をそのまま使うことが必須）。
     // ソート: render() の先頭で state.sort.key が「現在の表示列」に無ければ
     //   state.sort = { key: defaultSort, dir: -1 } にフォールバックする。
     // colgroups バー: groups があるとき、wrap の**外側**（呼び出し元が受け取る戻り値）に
     //   .colgroups セグメントを1つ追加する。ボタン onclick は setGroup(k) → render()（wrap内のrenderをそのまま
     //   再実行するだけでよく、statTable全体を呼び直す必要はない＝ソート状態はグループ切替をまたいで保持される）。
     //   戻り値は groups が無ければ従来どおり wrap（tablewrap div）単体、groups があれば
     //   el('div', {}, [colgroupsBar, wrap]) のようにバーとwrapをまとめた外側divにする
     //   （呼び出し側 renderBatting/renderPitching は戻り値をそのまま c.append() するだけなので、
     //   どちらの形でも呼び出し側の変更は不要）。
   }
   ```
2. 列グループ定義（打撃・投手）:

```js
// G5a: 列グループ（モバイルで多数列を一度に出さない）。キーは BAT_COLS/PIT_COLS のサブセット。
// 配列の並び順=表示順（cols側の元の並びではない）。
const BAT_COL_GROUPS = [
  ['basic',  '基本',   ['name','team','pos','war','pa','avg','hr','rbi','sb','obp','slg','ops']],
  ['saber',  'セイバー', ['name','team','woba','xwoba','wrcPlus','wrcPlusPF','opsPlus','iso','bsr','war']],
  ['batted', '打球',   ['name','team','barrelPct','hardHitPct','bbPct','kPct']],
  ['ctx',    '文脈',   ['name','team','wpa','clutch','sh','ibb','ph']],
  ['all',    '全列',   null], // null=BAT_COLS全体をそのまま使う
];
const PIT_COL_GROUPS = [
  ['basic', '基本',   ['name','team','role','war','w','l','sv','hld','ip','era','so','whip']],
  ['saber', 'セイバー', ['name','team','fip','eraMinusPF','fipMinusPF','xfip','siera','kwera','kPer9','kbbPct','bbPct','lobPct']],
  ['ctx',   '文脈',   ['name','team','qs','wpa','clutch']],
  ['all',   '全列',   null],
];
```

   - UIローカル状態: `let batColGroup = null; let pitColGroup = null;`（`null` は「未初期化」の意味で使い、
     初回描画時に下記の既定値へセットする）。
   - **`.colgroups` の見た目は `.subtabs` より一段軽くする**（成績タブは `.subtabs`＝打撃/投手/守備/WAR/球団比較
     の直下に `.colgroups`＝列フィルタが並ぶため、同じ見た目だと「タブ切替」と「列フィルタ」の階層が
     区別できない）。CSS例:
     ```css
     .colgroups { display:flex; gap:4px; margin:4px 0 8px; flex-wrap:wrap; }
     .colgroup { padding:3px 10px; font-size:11px; border-radius:999px; border:1px solid var(--line);
                 background:none; color:var(--muted); }
     .colgroup.active { border-color:var(--clay); color:var(--clay); font-weight:700; }
     ```
   - **既定グループ**: キャリアモード（`game.gs` が存在＝`renderHub` 経由）は `'basic'`。
     **クイックシミュレート（`game.gs` が null＝`renderMain` 経由・分析用途）は `'all'`**
     （G5b が順位表の詳細トグルをクイックシミュレートで既定ONにするのと同じ理由＝分析用途では全指標を
     即座に見たい）。`renderBatting`/`renderPitching` の冒頭で
     `if (batColGroup === null) batColGroup = game.gs ? 'basic' : 'all';` のように一度だけ初期化する。
3. team 列のセル値を `tabbr()` 略称＋`border-left:3px solid teamColor` のチップ表示に
   （順位表の球団名セルと同じ流儀。`statTable` 内で key==='team' の td に適用）。
   **`d.teamId` が存在する場合のみチップ化し、無ければ従来どおり `d.team` の文字列 td にフォールバックする**
   （守備タブ等 teamId を持たない呼び出し元でも壊れないためのガード）。そのうえで
   `renderBatting`/`renderPitching`**および `renderFielding`** の行オブジェクトに `teamId: s.teamId` を追加し、
   守備タブでもチップが効くようにする（統一のため）。
4. `renderFielding`（守備タブ）・`renderTeams`（チーム比較）は列グループ不要（`opts` に `groups` を渡さない＝
   現状維持）。守備タブは上記3のとおり teamId だけ足す。
5. smoke 更新（内容ベースで記述。目印はキャリアモードのチーム作成〜成績タブ検証部分の打撃/投手表アサーション群）:
   - 打撃タブ既定（`basic`）で `th` テキスト集合が `BAT_COL_GROUPS.find(([k])=>k==='basic')[2]` の各ラベルと
     一致すること。「全列」セグメントへ切り替えたときに `th` の個数が `BAT_COLS.length` に一致すること
     （固定数値をハードコードせず `BAT_COLS.length` を参照して比較する＝将来列が増減してもテストが腐らない）。
   - **既存の「列の存在」アサーション**（犠打・敬遠・代打・xwOBA・Barrel%・HardHit%・WPA・Clutch・wRC+PF・
     xFIP・SIERA・K-BB%・LOB%・QS・ERA-PF・FIP-PF 等、`basic` 群に含まれない列を探しているもの）は
     **「全列」セグメントへ切り替えてから**検証するよう移動する。打撃タブ・投手タブそれぞれで該当する。
   - クイックシミュレート経路（`renderMain`）の同種アサーションは、既定が `'all'` のため**無変更で通る**はず
     — 実装後に念のため確認すること。
6. コミット例: `feat(ui): G5a 成績タブの列グループ切替（基本/セイバー/打球/文脈/全列）＋球団略称チップ`

### G5b: 順位表の詳細トグル＋横スクロールアフォーダンス

1. `renderStandings` の列を2段階に:
   - 基本: 順/球団/勝/敗/分/勝率/差（「差」は f4 修正1 の `gamesBehind`/`gbText` を使用）
   - 詳細トグルON追加: 得点/失点/得失点差/期待勝率/運/交流戦
   - トグルは表の上の `link` ボタン「▶ 詳細列（得失点・期待勝率・運・交流戦）」（UIローカル・既定OFF。
     **クイックシミュレート（`game.gs` が null）では既定ON=分析用途**。G5aの列グループ既定と同じ判定基準）。
   - 二軍順位表（renderFarmStandings・f4 修正2 適用後は10列）にも同じトグル状態を適用
     （基本: 順/球団/勝/敗/分/勝率/差、詳細ON: 得点/失点/得失点差を追加）。
2. `.tablewrap` に横スクロールの気配を出す右端フェード。**設計上の注意**: `position:absolute` の
   擬似要素を `overflow-x:auto` コンテナ内に置くと、スクロール座標系の扱いがブラウザ実装依存になり
   「スクロールすると帯が中身と一緒に流れる／消える」ことがある。本仕様では**それを許容する**
   （目的は「初見時に列が隠れていると伝える」ことであり、スクロールを始めた後も帯が右端に追従し続ける
   必要はない — 一度スクロールした利用者はもう手掛かりを必要としていない）:

```css
/* G5b: 表の右にまだ列がある気配（初期表示時のヒント。スクロール後の追従は保証しない＝仕様） */
.tablewrap { position:relative; }
.tablewrap::after { content:''; position:absolute; top:0; right:0; bottom:0; width:14px;
  background:linear-gradient(270deg, rgba(0,0,0,.35), transparent); pointer-events:none;
  border-radius:0 8px 8px 0; }
```

   - JSでのスクロール連動化（`scroll` イベントで動的に出し分け）は本フェーズ対象外（付録Aへ）。
3. smoke: 順位表 th の「交流戦」列 assert は**クイックシミュレート経路**（`renderMain` の順位表タブ）に
   あり、そちらは既定ONのため**無変更で通る**（変更しないこと。誤って「詳細ON時のみ」に書き換えると
   既定表示と矛盾する）。**キャリアモード側**の順位タブ（`renderHub('standings')`）に、詳細トグルの
   新規 assert（OFF時に「交流戦」列が無い／トグルONで現れる）を追加する。
4. コミット例: `feat(ui): G5b 順位表の詳細トグル＋表の右端スクロールフェード`

---

# P2

## G6. 進行後の差分ダイジェスト

- `runAdvanceWithProgress`（G2）の開始前に snapshot を取り、完了後 overlay モーダルで表示してから hub へ:
  - 期間戦績: `rt.playerGameLog` の期間分（day >= startDay）から W-L-T
  - 順位変動: 自リーグ内順位 before → after（`currentStandings` から算出）
  - 見出し: `weeklyDigest` 上位3件＋`schedPlayerHeadlines(rt, deps, 3)`
  - 昇降格: `rt.rosterMoves` の期間分（`m.day >= startDay`）自チームのみ
- 「閉じる」で renderHub()。スキップ設定は持たない（1週間/月末のときだけ表示・次の試合へでは出さない）。
- **`rt.finished` で終わった場合はダイジェストを出さない**: G2 の `step()` は `rt.finished` で
  `renderSeasonResult()` へ直行する（G2 時点の挙動）。G6 のダイジェストはこの直行の**手前に割り込まない**
  — `rt.finished` なら差分ダイジェストをスキップしてそのまま `renderSeasonResult()` を呼ぶ
  （G2 の分岐をそのまま維持し、`rt.finished === false` のときだけダイジェストモーダルを挟む）。
- コミット例: `feat(ui): G6 週/月進行後の差分ダイジェスト（戦績・順位変動・見出し・昇降格）`

## G7. 日程・結果タブの現在月フォーカス

- 月ブロックを `<details class="schedmonth">` 化: **現在月（= `pendingDayOf(rt)-1` を含む月）だけ open**、他は閉。
  `<summary class="leaguename">` は現行の h3 文言（月名・試合数・月間成績）を**そのまま**移す
  （`class="leaguename"` を落とさないこと — smoke が月見出しを `.leaguename` ノードのテキストで収集して
  月間成績の表記を検証しているため、class を落とすとその assert が無音で見つからなくなる）。
- タブ描画直後に次戦行へ `id="schednext"` を振り、`.nextjump` リンク「▼ 次の試合へ」を表の上に置く
  （`onclick: () => document.getElementById('schednext')?.scrollIntoView({block:'center'})`）。
  次戦行に `.schednext { outline:1px solid var(--gold); }`。
- smoke: details/summary は smoke の最小DOMスタブに無い可能性 → スタブ El は汎用タグなので動くが、
  `open` 属性の有無で子の描画を変えない実装にする（CSSではなく attribute のみ。スタブ互換）。
- コミット例: `feat(ui): G7 日程タブを現在月フォーカス（月折りたたみ＋次の試合へジャンプ）`

## G8. シーズンリザルトの整理

- 表彰パネル: リーグごとに `<details>`（自チームのリーグを open）。MVP/新人王はバナー風のまま先頭。
- 日本シリーズ戦績: 長文1行 → `table(['戦','ホーム','スコア','ビジター','延長'], …)` の表に。
- ヘッダーのボタン4つ → 2行構成（1行目: ▶ストーブリーグへ(primary)・翌シーズンへ／2行目: 成績を見る・タイトルへ）。
  `.header .row { flex-wrap:wrap; }` を追加。
- コミット例: `feat(ui): G8 リザルト整理（表彰の折りたたみ・日本シリーズ表・ヘッダー2行）`

## G9. 選手モーダル磨き

1. `.modal { max-height:92vh; overflow:auto; }` ＋ `.modalhead { position:sticky; top:0; background:var(--panel);
   z-index:2; padding:4px 0; margin:-4px 0 10px; }`（✕が常に見える）。
2. `.modaltabs { flex-wrap:nowrap; overflow-x:auto; } .mtab { white-space:nowrap; flex:none; }`（2行折返し解消）。
3. 前後ナビ: `openModal(playerId, navIds?)` に省略可の第2引数（表示中テーブルのソート済みID配列）。
   渡されたとき modalhead に `◀ / ▶` ボタン（端では disabled）。呼び出し側で navIds を渡すのは
   `statTable`（sorted の id 列）と `renderWAR`（rows の id 列）と `teamRosterTable` の3箇所。
   ナビ時は overlay を作り直さず box の中身だけ再構築（overlay.remove→openModal でも可・実装が単純な方）。
4. smoke: モーダルを開いて `◀▶` で隣の選手へ移れる（pname が変わる）assert を1つ追加。
- コミット例: `feat(ui): G9 選手モーダル（stickyヘッダー・タブ1行化・前後ナビ）`

## G10. 凡例・用語集（タッチで見えない title 問題）

1. 共通の用語集モーダル `renderGlossary()`（ui.mjs）: `TIP` 全項目を `dt/dd` リストで表示＋観戦の色凡例
   （球判定 pc-*: ボール=白/見逃し=緑/空振り=赤/ファウル=黄/インプレー=青、結果 ev-*: 安打=青/HR・得点=赤/
   三振=灰/四死球=緑/失策=橙、ランプ B=緑 S=金 O=赤）を静的に列挙。overlay/modal は選手モーダルと同じ流儀。
2. 導線（挿入位置を具体的に指定）:
   - **観戦画面**: `watchDeps()`（`src/ui.mjs`）に `renderGlossary` を追加し、`src/ui/watch.mjs` の
     ヘッダー行（`el('div', { class: 'header' }, [...])` 内、既存の「ホームへ戻る」ボタンの隣）に
     `el('button', { class: 'link', onclick: () => u.renderGlossary() }, '?')` を追加する。
   - **成績タブ**: `renderStatsTab`（`src/ui.mjs`）の `.subtabs` 行の末尾に
     `el('button', { class: 'link', onclick: () => renderGlossary() }, '📖 用語集')` を追加する
     （成績タブには現行「説明行」は存在しない＝subtabs行に同居させる。WARサブタブの説明文
     `.muted` 行とは別物）。
3. コミット例: `feat(ui): G10 用語集・凡例モーダル（タッチ端末でも指標定義に到達できる導線）`

---

## 付録A: 変更しないと決めたもの（提案済みだが本フェーズ対象外）

- 下部ナビ（タブバー自体のボトム化）: 進行フッターと競合するため見送り。stickyタブ＋横スクロールで代替。
- 成績タブの選手名検索・リーグ別切替: G5a の効果を見てから次フェーズで判断。
- 表彰式の段階演出（1画面ずつのシーケンス）: G8 の折りたたみで一旦様子見。
- チームタブ「オーダー」ビュー（起用AIの現在スタメン表示）: エンジン側の公開APIが要るため別フェーズ
  （usage.mjs の読み取り整理が必要・本フェーズはエンジン非改変のため）。

## 付録B: 検証チェックリスト（各コミットで全部）

```
npm test               # 324+ テスト
npm run build          # dist 再生成（CSS変更もここで反映）。dist/pennant.html は git 管理下＝コミットに含める
npm run smoke          # UI構造の門番（本仕様の assert 更新込みで PASS）
npm run verify         # ENGINE identity 不変（変わったらエンジンに触っている＝即修正）
npm run calibrate      # 53+指標 PASS（UIのみの変更で動くはずがない＝動いたら即調査）
```

Playwright での目視確認（任意だが G1a/G1c/G4 は強く推奨）: スクラッチパッドの `shots.mjs` / `probe-overflow.mjs`
の流儀で該当画面を撮り、progress.md に結果を1行記録する。
```
node --experimental-default-type=module <script>  # playwright-core + ~/.cache/ms-playwright の chromium を使用
```

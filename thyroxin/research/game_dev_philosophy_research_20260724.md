# 優れたゲーム開発者は何を考えて作っているか — 作り手側の設計哲学と開発プロセス調査（2026-07-24）

> きっかけ: ユーザー「この調査結果をもとにゲーム開発レビューフローを組み、本ゲームをそのフローに沿って
> 継続レビューしていきたい」。既存2本の調査（`fun_theory_research_20260720.md`=プレイヤー心理側の
> 面白さ理論、`baseball_game_mechanics_research_20260723.md`=野球ゲームのメカニクス）とは重複させず、
> **作り手側（開発者本人）が何を判断基準に意思決定しているか**を体系化することが目的。
>
> 調査体制: 4並列（①日本の巨匠 ②海外の巨匠 ③開発文化・プロセス ④調整・レビューの実務）→本書で統合。
> 各クラスターの担当エージェントはWebSearch/WebFetchで一次情報（本人の講演・連載・インタビュー・GDC・
> ポストモーテム）を優先して収集した。

## 信頼性についての注記（重要・必読）

4本の調査すべてで共通して、**本セッションのWebFetchツールが一般的なWebサイト（Wikipedia・note.com・
famitsu.com・gamedeveloper.com・各種ブログ等）に対して一律403エラーを返し、原文ページへの直接アクセスが
できなかった**（プロキシ自体は稼働していることは確認済みで、サイト側/ツール側の制約と推測される）。
そのため本書の引用・要約は多くの場合、**WebSearchが返す検索エンジンの抜粋・スニペットを積み重ねて
再構成したもの**であり、一次資料そのものを精読して裏取りしたわけではない。

- 出典URLは可能な限り一次情報（本人の講演・公式インタビュー・GDC Vault・本人ブログ）を優先して明記して
  いるが、**リンク先の内容を直接確認できていない箇所が多く含まれる**。レビューの物差しとして実務で使う際は、
  特に重要な引用（名言・数値）は改めて原文で裏取りすることを推奨する。
- 誤帰属の疑いが判明したものは明示した（例: 宮本茂「A delayed game is eventually good, but a rushed
  game is forever bad」は複数の検証記事により本人発言ではない可能性が高いとされる）。
- 「判断基準の抽出」欄は調査エージェントによる翻案・要約であり、本人の言葉そのものではない。

---

# Part 1: 開発者別の思考法（出典付き）

## 1. 日本の巨匠

### 1-1. 宮本茂（任天堂）

**「アイデアとは複数の問題を一挙に解決するもの」**
この言葉は宮本本人の発言というより、岩田聡（元任天堂社長）が宮本の仕事ぶりを見て言語化し、ほぼ日刊イトイ
新聞「岩田さん」（2007年）で広めたもの。岩田は「問題となっている事象の根源を辿っていくと、いくつもの別の
症状に見える問題が、実は根っこでつながっていることがある。ひとつを変えると、いろんな問題がいっしょに
なくなったりする」と説明している。
出典: http://www.1101.com/iwata/2007-09-03.html 、https://scrapbox.io/miyamonz/アイデアというのは複数の問題を一気に解決するものである 、https://karaage.hatenadiary.jp/entry/2025/05/05/073000 、https://tech.unifa-e.com/entry/2020/12/23/090000
> **判断基準**: 変更案を評価する際「表面上の1つの不満だけでなく、他の一見無関係な課題も同時に解消しているか」を問う。局所対症療法より複数の根を同時に断つ案を優先する。

**「ちゃぶ台返し」の開発哲学**
発売直前・終盤であっても「面白くない」と判断すればストーリー・仕様全体を作り直させる。『星のカービィ』
（当時「ティンクルポポ」）は26,000本予約済みの状態から宮本の指摘で緊急発売中止・約3ヶ月再調整の末に
大ヒット、『メトロイドプライム』もTPSプロトタイプから宮本のちゃぶ台返しでFPS視点へ転換した。
出典: https://yurugame.doorblog.jp/archives/31267965.html 、https://switchsoku.com/nintendo/78896 、https://ja.wikipedia.org/wiki/宮本茂
> **判断基準**: スケジュールや既存投資額（サンクコスト）は「本質的に面白いか」の判断を上書きしない。発売直前でも仕様・視点レベルの変更を許容する。

**「肩越しの視線」**
呼称自体は岩田聡の命名。宮本が何も知らない人にいきなりコントローラーを渡し、何も説明せず背後（肩越し）
に立って黙って観察する手法。開発者の意図と実際のプレイヤー体験のギャップを短時間で発見する。
出典: http://www.1101.com/iwata/2007-09-03.html 、http://www.skuare.net/article/2015/07/14/thankyouiwata/ 、https://note.com/tsubasatada/n/n13cb57b74e3b
> **判断基準**: 新規・非熟練プレイヤーにゲームを渡し、開発者は説明せず背後から観察する。操作に迷った箇所・意図した仕掛けに気づかなかった箇所を記録し、UIより先にゲームデザイン自体を疑う。

**GDC2007基調講演「A Creative Vision」ほか**
Nintendo Life（2014）では「他社と同じ土俵で無難に売れるものを作らない」「市場的に理にかなっていても
"退屈（boring）"なら却下する」という趣旨の発言。『スーパーマリオギャラクシー』の「社長が訊く」では、
宮本自身がプレイして難易度・手触りの違和感を厳しく指摘し、チーム共通の品質基準として言語化する様子が
記録されている。
出典: https://game.watch.impress.co.jp/docs/20070309/miya.htm 、https://www.nintendolife.com/news/2014/11/shigeru_miyamoto_outlines_core_nintendo_philosophies_not_boring_alternatives 、https://www.nintendo.co.jp/wii/interview/rmgj/vol4/index3.html
> **判断基準**: 「他社と同じ土俵で無難に売れるもの」を作らない。難易度・手触りの違和感は感覚的でも即座に拾い、チームの共通言語として明文化する。
> （注意: 「遅れたゲームはいずれ良くなるが、急いだゲームはずっと悪いまま」という広く流布した名言は、複数の検証記事により誤帰属の可能性が高いとされる。出典: https://www.nintendolife.com/news/2022/03/random-is-miyamotos-most-famous-quote-not-his-after-all）

### 1-2. 桜井政博（HAL研究所／スマブラ）

**YouTube「桜井政博のゲーム作るには」**
2021年秋開始、全260本。目的は「これから世に出るゲームの面白さを少しだけ底上げすること」。約9000万円の
制作費を私費投入、利益ゼロで運営。
出典: https://news.denfaminicogamer.jp/interview/221228a 、https://www.itmedia.co.jp/news/articles/2410/23/news144.html

**「ゲーム性」＝リスクとリターン（駆け引き）**
2003年頃から「ゲーム性」を「駆け引き＝リスクとリターン」と定義。『スペースインベーダー』で砲台と
インベーダーの距離が離れているのは「ノーリスク・ノーリターン」、近づくとリスクとリターン双方が増す。
リスクとリターンは「適切な大きさで」「近い間隔で」配置すべき、とする。ただし「ゲーム性＝面白さの全て」
ではなく演出・世界観等も面白さの要素だと本人が留保している。
出典: https://news.denfaminicogamer.jp/kikakuthetower/171130b 、https://togetter.com/li/1960264 、https://senkohome.com/sakurai-game-dev-gameplay/
> **判断基準**: 「プレイヤーが負うリスクと、それに見合うリターンが明確に対応しているか」「リスクとリターンの距離（間隔）が近く、意思決定として機能しているか」を問う。

**仕様書・企画書の作り方**
「1ページに1項目、写真＋短い文章2行だけ」という徹底した簡潔さで作成（結果的に200ページ超）。
『カービィスーパーデラックス』企画書では「ヘルパーシステム」がどの課題（敵の能力活用とコピー能力の
重複回避等）を1つずつ解決しながら発想されたかがそのまま記録されている。
出典: https://nlab.itmedia.co.jp/cont/articles/3344478/ 、https://www.famitsu.com/news/201705/17132636.html
> **判断基準**: 仕様書は「1項目=1ページ=写真+2行」で誰でも一目で理解できる粒度に分解する。新機能追加時は「どの具体的な課題をこの1つの仕組みが解決するか」を企画書上に明示する。

### 1-3. 横井軍平（任天堂）

**「枯れた技術の水平思考」**
「枯れた技術」＝広く使われメリット/デメリットが出尽くし安定・低コスト化した技術、「水平思考」＝既存用途の
前提に捉われず別目的に転用すること。『ゲーム＆ウォッチ』（安価な電卓用液晶を娯楽玩具に転用）、光線銃SP
（太陽電池を光センサーとして転用）、『ゲームボーイ』（ライバル機の高性能カラー液晶に対し低スペック・
低コストの枯れた技術を選び電池寿命とコストで市場を制した）が代表例。「すごい商品をつくるな。売れる商品を
つくれ」という言葉が伝わる。
出典: 『横井軍平ゲーム館』（牧野武文、アスキー1997/ちくま文庫2015）、https://ascii.jp/elem/000/004/067/4067116/ 、https://ssaits.jp/promapedia/method/lateral-thinking-of-withered-technology.html
> **判断基準**: 「最新・最高性能だから」ではなく「枯れて安く・安定していて、別目的に転用したときに新しい遊びが生まれるか」を採用基準にする。「すごいものを作るな、届くものを作れ」を優先する。

### 1-4. 堀井雄二（ドラゴンクエスト）

**「親切設計」＝プレイヤーは説明書を読まない**
「みんな、マニュアルとか読まないでしょ。わかりやすくて、なんとなくやってみたくなるように」と発言。
自分自身がマニュアルを読まない前提を開発チーム全体に徹底させ、特にゲーム冒頭で初めてのプレイヤーが
迷わないよう繰り返し指示していたとされる。攻略本制作でも「ヒントは書くが答えは書かない」方針を貫き、
プレイヤーが自力で謎を解く喜びを守った。
出典: https://fujipon.hatenadiary.com/entry/20110404/p1 、https://dic.pixiv.net/a/堀井雄二 、https://game.watch.impress.co.jp/docs/news/312961.html 、新刊『堀井雄二のドラゴンクエストのつくりかた』（スクウェア・エニックス、2026年7月刊）
> **判断基準**: 「マニュアル・チュートリアルを読まなくても画面の情報だけで次にすべきことが直感的にわかるか」を新規要素追加のたびに問う。特にゲーム冒頭で初見プレイヤーが迷う要素がないか最優先で確認する。ヒント（気づきを与える）と答え（発見の喜びを奪う）を明確に区別する。

### 1-5. 任天堂の開発文化全般

スマブラ開発では、桜井政博と岩田聡の少人数チームが正式なキャラクター使用許諾を得る前に「4人対戦
アクション」のプロトタイプをまず動くものとして作り、宮本茂に見せて初めて話が進んだ（「口頭で聞けば
断られるかもしれないから、先に完成させたものを見せる」）。岩田聡は「良いゲームの本質を要素に分解し
再構成する宮本メソッド」を保存・継承しようとしていたとも語られる。
出典: https://shmuplations.com/smashbros/ 、https://www.gamedeveloper.com/design/new-iwata-interview-tackles-miyamoto-s-method-nintendo-history 、https://shmuplations.com/iwata/
> **判断基準**: 新企画は「正式な許諾・詳細な計画」より先に、動くプロトタイプで面白さを証明してから通す。仕上げ段階ではトップ自らが実際に触って違和感を拾い、チーム共通の品質基準として言語化する。

### 日本の巨匠に共通する判断基準トップ5
1. **言葉より先に手を動かして確かめる**（肩越しの視線／スマブラの先行プロトタイプ／宮本の実触チェック）
2. **1つの解決策で複数の問題を一気に消せているか**（宮本のアイデア論／桜井の企画書の課題分解）
3. **初見・非熟練者が迷わないかを最優先でチェックする**（肩越しの視線／堀井の親切設計）
4. **リスクとリターンが対応し、駆け引きとして機能しているか**（桜井のゲーム性定義）
5. **スケジュール・投資額・技術的目新しさより、面白いか／届くかを優先する**（宮本のちゃぶ台返し／横井の枯れた技術）

---

## 2. 海外の巨匠

### 2-1. Sid Meier（Civilization / Firaxis）

「ゲームとは一連の興味深い意思決定（a series of interesting decisions）である」（1989年来の定義）。
GDC2012講演では「面白い決定」の条件を、正解が不明瞭・複数の判断材料が異なる方向を指す・プレイヤーが
自分の判断力を働かせる必要がある選択、と精緻化。GDC2010「Everything You Know Is Wrong」では
ゲームプレイはプレイヤー心理（エゴ・パラノイア・自己欺瞞）に規定されると主張し、有名な格言
「Given the opportunity, players will optimize the fun out of a game（機会があればプレイヤーは
ゲームから楽しさを最適化して排除してしまう）」＝設計者はプレイヤーを自分自身から守る責務を持つ、と説く。
Soren Johnsonが要約した"Sid's Rules"では「倍にするか半分にするか（ハーフメジャーな微調整でなく体感できる
変更で反応を見る）」「1つの優れたゲーム＞2つの偉大な要素（噛み合わなければ入れない）」。続編開発の
「Rule of Thirds（1/3ルール）」＝新作は「1/3伝統的・1/3改良・1/3完全新規」の配分にする。
出典: https://www.gamedeveloper.com/design/gdc-2012-sid-meier-on-how-to-see-games-as-sets-of-interesting-decisions 、https://gdcvault.com/play/1012186/The-Psychology-of-Game-Design 、http://www.designer-notes.com/game-developer-column-5-sids-rules/ 、https://medium.com/@watsonwelch/sid-meier-s-rule-of-thirds-for-sequels-5a1c00ad5ae2 、https://www.sidmeiersmemoir.com/
> **判断基準**: 「この選択は面白い決定か（正解が自明でない／判断材料が拮抗する／プレイヤーの情報と判断力が結果を左右する）」を機能ごとに問う。「プレイヤーが最適化で楽しさを潰していないか」を確認する。続編・追加要素は「1/3旧来維持・1/3改良・1/3新規」配分になっているか機械的に点検する。

### 2-2. Will Wright（SimCity / The Sims / Spore）

**「トイ・ファースト（toy first）」**: ゲームである前に「勝ち負けのないおもちゃ」として自立させる。
`Raid on Bungeling Bay`のレベルエディタで遊ぶ方が本編より楽しかった原体験に由来。
**「可能性空間（possibility space）」**: システムが取りうる状態の総体。シンプルな部品（structure）から
創発（emergence）で大きな可能性空間を作る。GDC2005「The Future of Content」では「コンテンツ量と価値は
比例しない」「手作業コンテンツより創発的システムでの価値創出に開発努力を向けるべき」と主張し、
「所有感（Ownership）」がプレイヤー価値を大きく押し上げると指摘。
出典: https://www.gamedeveloper.com/design/video-will-wright-s-dynamics-for-designers-from-gdc-2003 、https://www.computerhistory.org/revolution/computer-games/16/201/2309 、https://www.gamedeveloper.com/design/gdc-2005-report-the-future-of-content
> **判断基準**: 「勝敗のゲームである前に、いじって楽しい"おもちゃ"として成立しているか」。「この機能はプレイヤーごとに異なる可能性空間（経路・結果）を生んでいるか」。

### 2-3. Mark Cerny（"The Cerny Method"）

開発を**プリプロダクションとプロダクションに明確分離**。プリプロダクションのゴールは
「パブリッシュ可能な最初のプレイアブル（publishable first playable）」＝実際には出さないが出しても
おかしくない品質のゲームの一部を先に完成させること。プリプロダクションは「vital chaos（活力ある混沌）」
の期間であり、終えたら「基礎部品で遊ぶ」から「コンテンツを量産する」へ切り替える。「マクロデザイン優先」
＝初期の詳細な100ページ設計書は最悪の一手、5ページ程度でマクロにまとめるべき。ファーストプレイアブルが
「出版する価値がない」と示した場合はその時点で**プロジェクトを中止すべき**。
出典: https://iterative.co.nz/mark-cerny-method 、https://www.scribd.com/presentation/636445139/020913-Cerny-Method 、https://gamedevnexus.com/guides/method-micro/
> **判断基準**: 「この機能/フェーズは"パブリッシュしてもおかしくない完成度の最小単位"として検証可能な形になっているか」。詳細設計書を先に書きすぎず、5ページ相当のマクロ設計＋試作を経てから肉付けし、ダメならこの段階で中止判定する。

### 2-4. Jonathan Blow（Braid / The Witness）

「Design Reboot」（2007）: ルールベースの挑戦で要求される学習は「それだけの価値があるもの」であるべきで、
報酬は依存性を煽るものであってはならない。「The Truth in Game Design」（GDC Europe 2011）:
システムを「科学的な計測器」のように扱い、あらかじめ決めたハイコンセプトに従わせるのではなく、
**システムに問いを投げかけ、その答え（プレイテストで出た予期しない挙動）に耳を傾けるべき**。
`The Witness`はチュートリアルなしでパズルの意味をプレイヤー自身に発見させ「プレイヤーを知的な存在として
扱う」ことを明言。ソーシャルゲーム/依存性設計への強い批判（「ソーシャルゲームデザイナーの目標はプレイヤー
の生活の質を下げることだ」）も倫理的な設計判断として語られる。
出典: https://gdcvault.com/play/329/Design 、https://www.gamedeveloper.com/design/gdc-europe-i-braid-i-s-blow-proposes-a-new-philosophy-of-game-design 、https://www.pcgamer.com/jonathan-blow-interview-social-game-designers-goal-is-to-degrade-the-players-quality-of-life/
> **判断基準**: 「この仕様は問いを立ててシステムの答えを観察した結果か、事前のハイコンセプトを無理やり押し付けた結果か」。「この報酬・チュートリアルはプレイヤーの知性を軽視・依存性で釣っていないか」。

### 2-5. Derek Yu（Spelunky）

エッセイ「Finishing a Game」: 完成させることを**それ自体が習得すべきスキル**として扱う。
- 締切を実在させる（Aquariaの締切が方向性・スケジュールを強制した）
- ツールに恋しない（開発ツールの完成度よりゲーム本体を優先）
- スコープ設定の指標は技術力ではなく「過去に完成させたゲームの規模」
- 磨き込み（ポリッシュ）は最後に取っておく
出典: https://makegames.tumblr.com/post/1136623767/finishing-a-game 、https://rampantgames.com/blog/?p=1288 、https://gamemaker.io/en/blog/derek-yu-gm25
> **判断基準**: 「この作業には実在する締切があり、スコープ・意思決定を強制しているか」。「スコープは過去に完成させた実績に見合っているか、ツール磨きに逃げていないか」。

### 2-6. Raph Koster（A Theory of Fun以外）

2025年最新エッセイ「Game design is simple, actually」: "Fun"の有用な定義は**「問題を習得すること
（mastery of problems）」**。「Game Grammar / Game Atoms」: デザインを最小単位の「アトム」に分解し
「動詞（verb）」「トークン」「アクション」を洗い出し、少し変えるだけでゲーム全体が変わりうることを示す
（"games nest"＝サブシステムの入れ子構造）。「Laws of Online World Design」ではコミュニティ設計の
経験則群（Koster's Law等）。「Practical Creativity」（GDCNext 2014）: 創造性は才能でなく訓練可能な
スキル。
出典: https://www.raphkoster.com/2025/11/03/game-design-is-simple-actually/ 、https://www.raphkoster.com/gaming/atof/grammarofgameplay.pdf 、https://www.raphkoster.com/games/laws-of-online-world-design/the-laws-of-online-world-design/
> **判断基準**: 「このシステムはプレイヤーに"習得すべき問題"を与えているか」。「新機能を最小の動詞に分解したとき、既存動詞の使い回しか新規動詞か、他システムと入れ子で連携しているか」。

### 海外の巨匠に共通する判断基準トップ5
1. **プレイヤーの選択に本当の緊張感・意味があるか**（Sid Meier interesting decisions／Blow meaningful choice／Koster mastery of problems）
2. **設計者の意図より、システムが生む挙動（創発）を観察して従う**（Wright possibility space／Blow「問いを投げて答えを聞く」／Meier「everything you know is wrong」）
3. **プロトタイプ／最初の完成品で継続可否を判定する**（Cerny publishable first playable／Yu 締切で骨組みを通す）
4. **プレイヤーを性善説だけで見ない——設計者は"守る"責務を持つ**（Meier「楽しさの最適化から守る」／Blowの依存性批判）
5. **完成させる／出荷することを創造性と同格の"訓練可能なスキル"として扱う**（Yu Finishing a Game／Cernyの中止判断／Koster Practical Creativity）

---

## 3. 開発文化・プロセス

### 3-1. Valve — 観察至上主義のプレイテスト

Mike Ambinder（Valve所属の実験心理学者）GDC2009「Valve's Approach to Playtesting」が中心資料。
プレイヤーの「発言」より「行動（無言の観察）」を絶対的に優先し、観察者はヒント・助言を一切与えず沈黙を
貫く。視線追跡・心拍・皮膚電位まで導入し「本人が自覚していない感情反応」まで定量化を試みた。
一方でMarc Laidlaw（Half-Life 2デザイナー）は「プレイテストで評判が良い＝良いゲームとは限らない」として
初期反応を意図的に無視した事例も語る。Portalでは「これはチュートリアル？本編はいつ始まるの？」という
反応の裏を読んでGLaDOSを追加した。
出典: https://cdn.akamai.steamstatic.com/apps/valve/2009/GDC2009_ValvesApproachToPlaytesting.pdf 、https://www.gdcvault.com/play/1013237/Valve-s-Design-Process-for 、https://www.gamedeveloper.com/production/-i-half-life-2-i-devs-explore-when-developers-should-ignore-playtester-feedback
> **判断基準**: プレイヤーの発言（アンケート・感想）ではなく行動・沈黙下の反応を一次データとして扱う。テスト中は一切誘導・解説をしない。ただし初見の心地よさだけを最適化すると体験の核（驚き）を殺すことがあるので盲目的にフィードバックへ迎合しない。

### 3-2. Supercell — セルフkillと失敗の儀式

全社を5人前後の「セル」に分割、プロジェクト続行・中止の決定権は現場の開発者に委ねる。「Gunshine」終了時
CEO Ilkka Paananenがシャンパンを買ってきた出来事が起源となり、以降「ゲームを殺したセル」は毎週金曜の
全社会議で失敗の理由と学びを共有し乾杯する儀式が定着。失敗を「実験」と呼び替え称賛可能にすることで
心理的安全性を作る。
出典: https://www.gdcvault.com/play/1025004/The-Cell-Structure-How-Supercell 、https://www.corporate-rebels.com/blog/failure-sessions-supercell 、https://supercell.com/en/news/learning-from-failures/
> **判断基準**: 意思決定権限をプロジェクトの最前線（当事者チーム）に置き、見込みのない企画は当事者自身が最速で「失敗」と認定できる仕組みを作る。失敗を隠す/罰するのでなく公開・言語化・称賛の対象にする。

### 3-3. Blizzard — Easy to Learn, Hard to Master / Concentrated Coolness

Rob Pardo（GDC2010）: 核心的原則は「Gameplay First」「Easy to Learn, Difficult to Master」
「Concentrated Coolness（凝縮されたカッコよさ）」。後者は機能を大量に足すのでなく、候補群から最高の
一部分だけを凝縮して1要素に統合する発想。WoWのWarriorクラスはWarcraft IIIの複数ユニットの「格好いい
部分」だけを統合して作られた。講演では失敗例（WoWの乗り物システム）も自己言及的に語られている。
出典: https://www.gdcvault.com/play/1012291/Making-a-Standard-(and-Trying 、https://www.gamedeveloper.com/game-platforms/gdc-blizzard-s-core-game-design-concepts 、https://www.gamespot.com/articles/blizzards-pardo-serves-up-game-design-secret-sauce/1100-6253464/
> **判断基準**: 新要素は「足す」前に、既存アイデア群から最も面白い部分だけを選び抜いて1つに凝縮できないか検討する（量ではなく密度）。基本操作の習得コストは最小化しつつ上達の天井は意図的に外さない。

### 3-4. GDCポストモーテム文化

GDC（1994年頃〜）で定着した「5 Things That Went Right / 5 Things That Went Wrong」形式。
開発チームが成功要因・失敗要因を各5点、具体的な数字・スケジュール・技術判断とともに公開する。
Microsoft Researchの学術分析（155件のポストモーテム分析）によれば、失敗を含めた率直な自己分析を
「恥」でなく「業界への貢献」として扱う文化を形成した。
出典: https://gdconf.com/article/don-t-miss-all-these-great-classic-game-postmortems-at-gdc-2019/ 、https://www.microsoft.com/en-us/research/wp-content/uploads/2016/06/washburn-icse-2016-2.pdf 、https://blog.codinghorror.com/game-development-postmortems/
> **判断基準**: プロジェクト完了後、成功5点・失敗5点を同じ重みで具体的な数字とともに言語化し公開する。評価軸は主観的満足度ではなく当初計画との差分（スケジュール・スコープ・品質）で測る。

### 3-5. design pillars（デザインピラー）

プロジェクト初期に定める3〜5個の「核となる原則」であり、以後のあらゆる機能追加・削除の判断をこれで
判定する「フィルター」。具体的な機能でなく、プレイヤーに与えたい体験・感情を言語化したもの。
`The Last of Us`は「Crafting」「Story」、`Rainbow Six Siege`は「teamwork, tactics, and tension」を柱とし、
この柱に基づき「リスポーンシステムの撤廃」という具体判断が下された。
出典: https://www.gamedeveloper.com/design/design-pillars-the-core-of-your-game 、https://www.gamedeveloper.com/business/agile-game-development-part-2-design-pillars
> **判断基準**: 新機能・変更のたび「これはどのピラーを強化するか」を問い、どのピラーにも寄与しない/矛盾するものは魅力的でも却下する。ピラーは3〜5個に絞り焦点をぼやけさせない。

### 3-6. vertical slice（バーティカルスライス）

ゲーム全体の「完成形の質」を体現する、小さいが完全に磨き込まれたプレイ可能な一断面。目的は、規模拡大
（本格的な予算・人員投入）の前にアート・UI・サウンド・技術基盤が「完成品として期待される品質」で統合的に
機能することを証明すること。プリプロダクション終了・プロダクション移行の合図となるマイルストーン。
出典: https://xsolla.com/blog/funding-101-the-impact-of-the-vertical-slice 、https://ninevastudios.com/blog/vertical-slice-game-development-guide
> **判断基準**: 本開発に入る前に、最終品質基準を満たす「1断面」を実際に作って見せられるか。見せられないなら、コアループが未検証でスケールする準備ができていないと判断する。

### 3-7. juice / game feel

Steve Swink『Game Feel』: ゲームフィールを「入力」「応答」「文脈」の三要素の関係性として定式化。
操作へのわずかな遅延・慣性・視聴覚フィードバックの質が「操作している実感（有能感）」を左右する。
Jonasson & Purho「Juice it or lose it」（GDC Europe 2012）: ブロック崩しにパーティクル・画面シェイク・
伸縮アニメーション等を段階的に加えるデモで、同一ゲームロジックでも視聴覚フィードバック量だけで満足度が
劇的に変わることを実演。ジュースはルールを変えず手触りだけを変える調味料であり、コアが面白くない場合の
代替にはならないが、コアが面白い場合はその面白さを増幅する。
出典: https://www.sciencedirect.com/book/monograph/9780123743282/game-feel 、https://www.gdcvault.com/play/1016487/Juice-It-or-Lose 、https://en.wikipedia.org/wiki/Game_feel
> **判断基準**: 同じ入力→同じ結果のゲームロジックでも、フィードバックの遅延・冗長性・演出量を意図的に増減させて操作感を検証する。「ルールは正しいのに手触りが悪い」を演出調整だけでどこまで改善できるか常に問う。

### 開発文化・プロセスに共通する判断基準トップ5
1. **「言葉」より「行動・数字」を一次証拠にする**（Valve観察／GDCポストモーテムの数字主義）
2. **意思決定権限は最前線・当事者に置き、失敗を早く安全に認定できる仕組みを作る**（Supercellセルフkill）
3. **「足す」前に「絞る」——少数の原則/柱に照らして取捨選択する**（Blizzard concentrated coolness／design pillars）
4. **本格投資の前に、最終品質の"断片"を実際に動かして証明する**（vertical slice）
5. **同じロジックでも「手触り」を独立変数として扱い、演出だけで検証・改善するループを回す**（juice/game feel）

---

## 4. 調整・レビューの実務

### 4-1. プレイテストの回し方

Mike Ambinder（Valve, GDC2009）が最も引用される一次資料。①直接観察 ②発話思考法(think-aloud)・
事後インタビュー ③統計/テレメトリ ④デザイン実験（A/B比較） ⑤生理指標、を併用するが核心は
「観察者は黙って見る。ヒント・誘導・回答を与えない」という規律。「グループにレベルが難しいか聞くと、
最初に答えた人が場を支配する」と合意バイアスを指摘。Riot Gamesは70人規模のInsights部門と専用プレイ
テストラボを運用し、UXリサーチャーをプロダクトチームに埋め込む。学術的には「think-aloud protocol」が
標準手法として確立。
出典: https://cdn.akamai.steamstatic.com/apps/valve/2009/GDC2009_ValvesApproachToPlaytesting.pdf 、https://gmtk.substack.com/p/valves-secret-weapon 、https://medium.com/riot-games-ux-design 、https://www.nngroup.com/articles/game-user-research/
> **判断基準**: プレイテスターの感想（面白かった/難しかった）は最初の発言者に流されるバイアスがあるため単独では採用しない。どこで手が止まった・繰り返した・沈黙したかという行動ログだけを見て、何が本当に欠けていたかを分析者側が推論する。

### 4-2. difficulty curve（難易度曲線）設計

理論的支柱はCsikszentmihalyiのフロー理論（挑戦とスキルの拮抗）。実務では直線でなく「鋸歯状
（saw-tooth）」（緊張を上げて直後に一息つかせ成長を実感させ、また上げる）に設計するのが定石。
任天堂（『スーパーマリオ3Dランド』ディレクター小泉歓晃）の「4ステップ構造」（導入→発展→展開→結論、
和的な起承転結）は、新メカニクスを①安全に提示②応用させる③意外な組み合わせで試す④集大成として使わせ
手放す、という約5分単位の「教える単位」に分解する。宮崎英高（FromSoftware）: 「難しいゲームと不当に
理不尽なゲームは違う」——判断基準は「プレイヤーが死んだ理由を即座に理解でき納得できるか」。
Celeste（Matt Thorson）: 「理解するのが簡単な画面は実行が難しく、理解するのが難しい画面は実行を簡単に
する」（認知負荷と操作負荷を同時に高くしない）。Assist Modeは既定値にせず、開発者が意図した既定難易度
を守りつつ「速度20%減」「エアダッシュ追加」等の微調整的オプションを最も重視した。
出典: https://www.gamedeveloper.com/design/the-structure-of-fun-learning-from-i-super-mario-3d-land-i-s-director 、https://www.gamesradar.com/games/action-rpg/fromsoftware-head-hidetaka-miyazaki-says-games-like-elden-ring-and-dark-souls-arent-about-simply-cranking-up-the-difficulty-its-doing-so-fairly/ 、https://www.nintendolife.com/news/2018/01/feature_conquering_the_indie_mountain_with_celeste_creator_matt_makes_games 、https://celeste.ink/wiki/Assist_Mode
> **判断基準**: 難易度は鋸歯状（緊張→緩和→再緊張）で設計されているか。プレイヤーが失敗した場面で、原因を1秒以内に自分で説明できるか（できなければ理不尽=バグ）。新要素は「安全な導入→応用→意外な組み合わせ→集大成としての卒業」の順で提示されているか。

### 4-3. onboarding設計・「最初の5分問題」

「最初の3〜5分で混乱・圧倒されるとほとんど戻ってこない」という経験則。モバイルゲームDay1離脱率73%、
良好なD1継続率の目安45%以上、といった統計。チュートリアル導線最適化だけでD1継続率+18%・初回コア
ミッション完了率+25%の報告例。Celia Hodent（元Fortnite UX責任者、著書『The Gamer's Brain』, GDC2016）:
核心は「プレイヤーの注意（attention）をどう管理するか」であり、多くのゲームがNPCの発話中に操作を教える等
複数入力を同時要求し認知過多（cognitive overload）を招く。実務手順は「学ぶべきこと全てをリストアップ→
ゲームの核（pillars）に基づいて優先順位づけ→教える順序と深さを定義する」。
出典: https://celiahodent.com/gamers-brain-ux-onboarding/ 、https://archive.org/details/GDC2016Hodent 、https://blog.playio.co/player-churn-in-mobile-games-strategies
> **判断基準**: オンボーディングは「教えるべき全項目」を洗い出した上で核となる楽しさに直結する順に優先順位づけされているか。1つの場面で同時に要求する新規学習・入力は常に1つだけか。チュートリアルはスキップ可能で5分以内に核心へ到達できるか。

### 4-4. UIテキスト・情報密度（progressive disclosure＝段階的開示）

「その瞬間にプレイヤーが必要とする情報だけを表示し、副次情報は求められるまで隠す」という規律がゲームHUD
設計の標準原則。一般UX研究では段階的開示インターフェースは全露出型に比べ初回タスク完了が30〜50%速いという
調査結果もある（ゲーム特化の一次資料ではない点に留意）。Hodentの認知負荷理論もこの項目と直結する。
出典: https://www.algolia.com/blog/ux/information-density-and-progressive-disclosure-search-ux 、https://ixdf.org/literature/topics/progressive-disclosure 、https://celiahodent.com/gamers-brain-ux-onboarding/
> **判断基準**: その画面で「今この瞬間に行動に必要な情報」以外は初期表示から外されているか。情報は求められたとき・関連行動が可能になったときにだけ追加露出されているか。

### 調整・レビュー実務に共通する判断基準トップ5
1. **発言より行動ログ**（Valve原則）: 感想は採用せず、手が止まった・繰り返した・沈黙した箇所から原因を逆算する
2. **フェアネス・テスト**（宮崎英高／Celeste）: 失敗原因を1秒以内に自己説明できるか。できなければ「難しい」のではなく「設計のバグ」
3. **教える単位の分解**（任天堂4ステップ）: 新要素は「安全な提示→応用→意外な組み合わせ→卒業」の4段階か
4. **注意資源の予算管理**（Hodent原則）: 同時に要求する初見の入力・情報は常に1つだけか
5. **鋸歯状の緊張管理**（フロー理論の実務変換）: 難易度・情報量は単調増加でなく波を描いているか

---

# Part 2: 判断基準の体系化（物差し）

Part 1の全判断基準を、レビューで実際に問う「軸」として10個に集約する。

| # | 軸 | 出典（誰の思考法） | 一言で言うと |
|---|---|---|---|
| ① | **コアの発見と保護** | design pillars／桜井「ゲーム性」／Will Wright「toy first」／Blizzard「concentrated coolness」 | 面白さの核を少数の言葉に絞り、あらゆる判断をそれで濾す |
| ② | **初見・非熟練者優先** | 宮本「肩越しの視線」／堀井「親切設計」／Hodent「注意資源管理」／任天堂「4ステップ」 | 説明なしで触った初見プレイヤーが迷わないかを最優先で見る |
| ③ | **意思決定の質（リスク/リターン）** | Sid Meier「interesting decisions」／桜井「リスクとリターン」／Koster「mastery of problems」／Blow「meaningful choice」 | プレイヤーの選択に本当の緊張感・判断材料の拮抗があるか |
| ④ | **観察・創発の優先（言葉より行動）** | Valve観察至上主義／Blow「問いを立てて答えを聞く」／Meier「everything you know is wrong」 | 設計者の思い込みより、実測された行動・想定外の挙動を信じる |
| ⑤ | **フィードバック・手触り** | Swink/Jonasson & Purho「juice」／宮本の実触チェック | ルールが同じでも手触り（即時性・演出）だけで満足度が変わる |
| ⑥ | **公平な失敗・難易度カーブ** | 宮崎英高「フェアな難しさ」／Celeste／フロー理論の鋸歯状カーブ | 失敗の原因を1秒で自己説明できるか。緊張は波形で設計する |
| ⑦ | **プロトタイプでのGo/No-Go判定** | Cerny「publishable first playable」／vertical slice／宮本「ちゃぶ台返し」／Derek Yu「締切」 | 本格投資の前に最終品質の断片を動かして証明・判定する |
| ⑧ | **スコープ規律と撤退判断** | Supercell「セルフkill」／Sid Meier「double or cut in half」／Derek Yu「実績スコープ」 | 見込みのない案を当事者が最速で安全に「失敗」認定できるか |
| ⑨ | **情報設計（段階的開示）** | progressive disclosure／桜井「1項目1ページ」／Hodent認知負荷 | 判断に必要な情報だけを、必要な瞬間・場所に出す |
| ⑩ | **言語化・自己検証の文化** | GDCポストモーテム「5 good/5 bad」／宮本「複数問題の同時解決」 | 成功も失敗も具体的な数字とともに言語化し公開する規律を持つ |

---

# Part 3: 本ゲーム向け「ゲーム開発レビューフロー」の提案

## 0. 前提— 本ゲームの現況と既存の検査基盤

本ゲームはシングルプレイ・ブラウザの12球団2リーグ育成ペナントシム。三原則（`req_2.md`）＝
①セイバー指標の網羅 ②NPB近似・采配妥当性 ③やきゅつく的な楽しさ、を目的関数とし、既に以下の
検査基盤が稼働している（Part 3はこれに**接続**する形で設計する。新しい検査基盤をゼロから作らない）:

- `npm test`（決定論・構造・不変量テスト）／`npm run verify`（Node↔ブラウザ同一性）／
  `npm run calibrate`（NPB目標帯53指標のPASS/FAIL機械判定）／`npm run realism`（打球イベント単位の
  現実不変量ゲート）／`npm run smoke`（`dist/pennant.html`のヘッドレスDOM描画検証）
- `thyroxin/research/ui_ux_review_20260707.md`: **Playwright（デスクトップ1280×900・モバイル390×844）
  で全画面スクリーンショット＋scrollHeight/scrollWidth実測＋ソース読解**という前例が既にある
  （フェーズGのUI再ゾーニングの根拠になった）。本フローの「初見体験」「情報設計」観点はこの手法を
  そのまま再利用する。
- `thyroxin/progress.md`: 自走開発ジャーナル（新しいものが上）。GDCポストモーテム的な言語化の器として
  拡張可能（現状は「やったこと・ゲート結果」中心で「良かった点/課題点」の明示的な自己評価が薄い）。
- `thyroxin/research/fun_theory_research_20260720.md` / `baseball_game_mechanics_research_20260723.md`:
  プレイヤー心理側・メカニクス側の既存診断。本フローはこれらの**上位**に位置する「作り手の判断基準」の
  レイヤーであり、両者の弱点仮説・提案リストは⑥長期ループ観点の入力として使う。

これらの数値ゲート（test/verify/calibrate/realism/smoke）は**シムの正しさ・決定論・較正**を保証するが、
「面白いか」「初見で迷わないか」「触って気持ちいいか」は保証しない。本フローはその隙間を埋める。

## 1. 観点リスト（15項目）

凡例: 出典は Part 2 の軸番号（①〜⑩）に対応する開発者思考を短縮表記。

| # | 観点 | 出典 | 本ゲームでの検査方法 | 合否の目安 |
|---|---|---|---|---|
| 1 | **面白さの核は3行で言えるか** | ①design pillars／桜井 | 新機能に着手する前に「三原則(`req_2.md`)のどれを強化するか」「既存の弱点仮説（fun_theory/baseball_mechanics調査）のどれを埋めるか」を3行以内で言語化する。言えなければ着手しない | 3行で言える／言えないものは保留・再設計 |
| 2 | **単体で"おもちゃ"として成立するか** | ①Will Wright toy-first | 勝敗・目標を無視して当該画面単体を触る（例: GMボードのヒートマップ・成績タブのソート・スプレーチャートを、目的なしで5分いじれるか） | 目的（勝つため）を外しても眺めて/操作して楽しいか |
| 3 | **初見5分で何が起きるか** | ②肩越しの視線／堀井 | `npm run build`→`dist/pennant.html`をブラウザで開き、セーブなしの新規状態から**操作説明を一切見ずに**ハブ→最初の試合まで触る（可能なら開発者以外の人・別セッションのClaudeに「肩越し」役をさせる） | 迷わず次の行動が分かる。5分以内に「采配/育成」という核の面白さに触れられる |
| 4 | **教える単位が分解されているか** | ②任天堂4ステップ／④Hodent | 新規UI・新規モーダルの初出箇所で「安全な提示→応用→組み合わせ→卒業」になっているか。介入観戦モーダル・ドラフト会議室などの初回導線を確認 | 1画面・1タイミングで同時に要求する新規学習要素が1つ以下 |
| 5 | **意思決定にリスク/リターンの提示があるか** | ③桜井／Sid Meier | 采配介入・トレード・育成方針・週次目標の各選択画面で「選択肢間にトレードオフ・情報の非対称があるか」を列挙。ドミナント戦略（常にこれを選べば良い）が無いかを`npm run calibrate`の犠打帯・盗塁帯等の分布で裏付ける | 「常に同じ選択が最適」という自明な構造になっていない |
| 6 | **失敗の自己帰属性（フェアな難しさ）** | ⑥宮崎英高／Celeste | 敗因/勝因カード（WPA表示）・GM分析コラムを見て「なぜ負けたか1秒で言えるか」を自己チェック。介入観戦で人間采配が裏目に出た試合を意図的に再生し、原因が画面内で追えるか確認 | 「なんとなく負けた」で終わらず、采配ミスや相手の好プレーとして説明できる |
| 7 | **観察を優先し思い込みで蓋をしない** | ④Valve／Blow | 数値ゲート（calibrate/realism）PASSだけで満足せず、**最低1回は実プレイ・実況ログを目視確認**する運用をレビューに必須組み込みする。想定外の采配パターン・不自然な選手起用が無いかを行動ログ（介入ログ・playerGameLog）から見る | ゲートPASSに加え、実プレイ目視で「あれ？」と思う挙動が無い |
| 8 | **触った瞬間に手触りが伝わるか** | ⑤juice/game feel | 介入観戦モーダルの選択→結果反映（コーチ経過報告・投手心情コメント・特別デーバッジ等）を実プレイで確認。選択と結果の間にワンテンポの演出・文言があるか | 選択→結果の因果が1アクション以内に画面内で見える（数値だけでなく文言/色/バッジで伝わる） |
| 9 | **1つの機能が複数の弱点を同時に解決しているか** | ①宮本のアイデア論 | 新機能提案時、`fun_theory_research`/`baseball_mechanics_research`の弱点仮説リストと照合し「この1機能で何個の弱点仮説が消えるか」をカウントする（progress.mdの実装ログはこの形式に近い＝Q1のように既に実践例あり） | 1機能が2つ以上の弱点仮説に効いている（局所対症療法の連打になっていない） |
| 10 | **情報は判断に必要な時に必要な場所にあるか** | ⑨progressive disclosure | `ui_ux_review_20260707.md`と同じ手法（Playwrightスクリーンショット＋scrollHeight実測）を主要タブに対して再実行する。UI大改修（phaseG等）の節目ごとに実施 | モバイル390px幅で各タブが1〜2画面以内。判断に不要な情報が常設されていない |
| 11 | **同時に教える新規情報は1つか** | ②④Hodent | 新規モーダル・新規タブの初出時、画面内の「初見の数値/用語」を数える（`tools/smoke-ui.mjs`のフロー確認と併用） | 初見の新規要素（用語・数値・操作）が画面内で同時に2つ以上出ていない |
| 12 | **プロトタイプでGo/No-Go判定してから本実装したか** | ⑦Cerny／vertical slice | 大きい機能（新モジュール新設級）は、本実装前に「1シナリオだけ最終品質で通しで動かす」ステップをspecに明記する。既存の`thyroxin/specs/*.md`の書き方（実装担当がこれだけで完遂できる詳細さ）を踏襲しつつ、着手前チェックとして明記する | specに"最小の1本を通してから横展開する"順序が明示されている |
| 13 | **スコープはセルフkillできる規律があるか** | ⑧Supercell／Sid Meier | `progress.md`の「次にやること」欄が、三原則・弱点仮説への寄与で機械的に優先度付けされているか確認。着手後に`calibrate`/`realism`ゲートを壊す変更は既存の運用どおり即修正・フラグ既定OFFで安全に撤退できているか | 「着手したが効果が薄い/リスクが高い」と判断した機能を、サンクコストに関係なく中止・OFFフラグ化できている |
| 14 | **波形の緊張管理になっているか** | ⑥フロー理論の鋸歯状 | 特別デー（Q3 `specialDaysOf`）・週次目標・介入観戦の発火頻度をシーズン通しでログ確認。「同じ強度のイベントが単調に続く」区間の有無を見る | 山場（特別デー・接戦カード）と平常運転が交互に来る。均質な日々が長く続かない |
| 15 | **成功・失敗を数字とともに言語化しているか（ポストモーテム化）** | ⑩GDCポストモーテム | `progress.md`の各エントリに「良かった点/課題点」を明示的に書くフォーマットへ拡張する（現状は「やったこと・ゲート結果」中心）。大きな機能追加後は5点/5点形式の簡易ふりかえりを追記する | 「やったこと」の列挙で終わらず、うまくいった理由・次に疑うべき点が言語化されている |

## 2. フローの構成案

### 2.1 回す順序（6フェーズ）

新機能・大きな変更を実装する際は、以下の順で観点を通す。①②は**着手前**、③④⑤は**実装直後**、
⑥は**継続的・定期**に回す。

```
①コア検査（観点1,2）
   └ 着手前。三原則・弱点仮説への寄与を3行で言語化できるか／単体でおもちゃとして成立するか
        ↓
②初見体験（観点3,4,11）
   └ 実装直後・UI初出時。肩越しの視線で5分触る／教える単位の分解／同時新規情報1つ以下
        ↓
③意思決定の質（観点5,6,9）
   └ 采配・育成・トレード等の判断系機能。リスクリターン・失敗の自己帰属・複数弱点への同時寄与
        ↓
④フィードバック/演出（観点7,8）
   └ 表示直後。触った瞬間の手触り／数値ゲートだけでなく実プレイ目視確認
        ↓
⑤情報設計（観点10）
   └ UI大改修の節目（phaseG等）ごとに定期実施。Playwrightスクショ+実測の再現調査
        ↓
⑥長期ループ（観点12,13,14,15）
   └ 継続的・自走サイクルごと。プロトタイプGo/No-Go・スコープ規律・波形管理・ポストモーテム言語化
```

### 2.2 頻度と接続先（既存ゲートとの対応）

| フェーズ | 頻度 | 主な実施者/タイミング | 接続する既存ツール・資産 |
|---|---|---|---|
| ①コア検査 | 機能着手ごと（1機能=1回） | spec作成前・`thyroxin/specs/*.md`着手前 | `req_2.md`三原則／fun_theory・baseball_mechanics調査の弱点仮説リスト |
| ②初見体験 | 新規UI/新規モーダル導入ごと | 実装直後・smoke通過後 | `npm run build`→`dist/pennant.html`実プレイ／`tools/smoke-ui.mjs`のフロー |
| ③意思決定の質 | 采配・育成・市場系の機能ごと | 実装直後 | `npm run calibrate`（分布の偏り検出）／`npm run realism`（采配妥当性） |
| ④フィードバック/演出 | 表示層の機能ごと | 実装直後 | 実プレイ目視／`news.mjs`等のテンプレ文言レビュー |
| ⑤情報設計 | UI大改修の節目（数フェーズに1回） | phaseG級のUI改修完了時 | `ui_ux_review_20260707.md`と同一手法（Playwright実測）を再実行 |
| ⑥長期ループ | 自走サイクル（週次/月次相当） | `progress.md`更新のたび軽量チェック、大機能後は重めのふりかえり | `progress.md`フォーマット拡張／`git log`による中止・撤退判断の追跡 |

### 2.3 実務での使い方（テンプレ）

新機能のspec冒頭、または`progress.md`の実装エントリに以下を追記する運用を推奨する（既存のspecの
簡潔さ・progress.mdの日本語コメント文化を壊さない範囲で）:

```
## レビューチェック（着手前）
- 観点1: 三原則のどれに効くか／弱点仮説のどれを埋めるか → （3行以内）
- 観点12: 最小の1本をどう通しで確認するか → （1〜2行）

## レビューチェック（実装後）
- 観点3/4/11: 初見体験は何分で核心に到達するか・同時新規要素は1つ以下か
- 観点5/6: 意思決定にリスクリターンがあるか・失敗を1秒で説明できるか
- 観点8: 選択→結果の因果は1アクション以内で見えるか
- 観点15: 良かった点2-3・課題点1-2（数字つき）
```

## 3. 本ゲームに特に効きそうな観点（統合メッセージの根拠）

- 本ゲームは「データ表示が厚い・意思決定は年数回に偏りがち」という既存2調査の共通診断（fun_theory調査の
  核心診断「選ぶ→結果に責任を負う場面が年に数回」、baseball_mechanics調査の「関係性が一方通行」）を持つ。
  これに直接効くのは**観点5（リスク/リターンの提示）・観点6（失敗の自己帰属）・観点9（複数弱点の同時解決）**。
- UIが「1画面に情報がありすぎる」という既往のUI/UXレビュー（`ui_ux_review_20260707.md`）の反省を継続監視
  するには**観点10・11（情報設計）**が直接対応する。
- 「触って気持ちいいか」は数値ゲート（test/calibrate/realism）が保証しない領域であり、**観点3（初見5分）・
  観点8（フィードバックの即時性）**が唯一の砦になる。

---

# 参照

## 各調査担当エージェントの一次出典
Part 1の各節に個別記載（宮本茂〜横井軍平〜堀井雄二〜Sid Meier〜Will Wright〜Mark Cerny〜Jonathan Blow〜
Derek Yu〜Raph Koster〜Valve〜Supercell〜Blizzard〜GDCポストモーテム〜design pillars〜vertical slice〜
juice/game feel〜プレイテスト〜difficulty curve〜onboarding〜progressive disclosure）。

## 本リポジトリ内参照ファイル
- `CLAUDE.md`（三原則・鉄則）
- `thyroxin/requirements/req_1.md`（設計思想）／`req_2.md`（三原則・目的関数）
- `thyroxin/progress.md`（自走開発ジャーナル）
- `thyroxin/research/fun_theory_research_20260720.md`（プレイヤー心理側の面白さ理論・既存診断）
- `thyroxin/research/baseball_game_mechanics_research_20260723.md`（野球ゲームメカニクス調査・既存診断）
- `thyroxin/research/ui_ux_review_20260707.md`（Playwright実測によるUI/UXレビューの前例・手法）
- `thyroxin/specs/phaseG_spec.md`（UI再ゾーニング仕様・観点10/11と直接関係）
- `tools/{build,verify-identity,smoke-ui,calibrate,realism-check}.mjs`（既存の数値ゲート体系）

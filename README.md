# home

ボタンはひとつ。押すと **現在地から家まで** の経路だけを出す、iPhone 向けのアプリです。
Safari で開いて「ホーム画面に追加」するとアプリのように使えます。

## しくみ

```
iPhone ──▶ Cloudflare Worker ──▶ 現在地の住所・最寄り駅（国土地理院 / HeartRails）
                              └─▶ Yahoo!乗換案内（住所 → 家）
```

- 経路の取得・解析、前後の便（前後のダイヤ）は [のりかえ](https://github.com/weakestandstrongest-sketch/norikae) の仕組みをそのまま使っています
- 現在地の住所から家まで探し、見つからなければ近い駅（2 つまで）から探します
- 家の場所（駅名・バス停・住所）は端末の中（localStorage）にだけ保存します

## 使い方

1. 「帰る」を押す（はじめてのときは家の場所を聞かれます）
2. 家に着く時刻・出発までの残り時間・乗る電車がタイムラインで出ます
3. 電車・バスの本文を押すと、途中で止まる駅と時刻が開く
4. 電車・バスのアイコン（または「前後の便」）を押すと、その駅から家までの前後の便が一覧で出る。選ぶとその便の経路に変わる
   - 駅の時刻表が読めれば、普通・快速なども含めた全部の便を出し、1 本ずつ家に何時に着くかを調べる
   - 乗換駅なら、そこに着く前に出る便は「乗り継げません」になる
5. 調べた経路は端末に保存され、「帰る」を押し直すまで残る
6. 開いたとき（アプリに戻ってきたときも）は、move と同じ流れのアニメーション：丸が出て、家を一筆で描き、扉が入って、波が広がってからアプリへ（約2秒・タップで飛ばせる・設定でオフにできる）。アイコンと同じ形
7. 結果の「ひび手帳に追加」で、その経路をひび手帳の予定に入れられる（ひび手帳と同じGoogleアカウントでログインして使う。はじめて押すとログインに進み、戻ってきたら自動で送る）
   - 経路は Google ドライブの「アプリ専用の場所」の `hibi-inbox.json` に置き、ひび手帳（2.27.0 以降）が開いたときに読んで予定に入れる
   - ログインは ひび手帳・move と同じく乗換案内の Worker（`/hibi-auth/`）を通す。この URL の `ie.` を `norikae.` にしたところを使う
8. 右上の歯車で、家の場所と検索条件（表示順・特急の席・歩く速さ・運賃・使う乗り物）を変えられる

## 公開方法（Cloudflare Workers・無料）

1. Cloudflare ダッシュボードの **Workers & Pages → 作成 → Import a repository** でこのリポジトリを選ぶ
2. 設定はそのままで **Deploy**（デプロイコマンドは `npx wrangler deploy`）
3. 表示された `https://ie.<サブドメイン>.workers.dev` を iPhone の Safari で開き、共有 →「ホーム画面に追加」

## 開発

```sh
npm install
npm test      # テスト
npm run dev   # http://localhost:8787
```

- `public/` … 画面（HTML / CSS / JS）
- `src/index.js` … Worker（`/api/home` `/api/search` `/api/timetable` `/api/train` `/api/suggest` `/api/where`）
- `public/dia.js` … 前後の便
- `public/drive.js` … Google ログインと、ひび手帳への経路の受け渡し
- `src/yahoo.js` `src/suggest.js` `src/nearest.js` `src/timetable.js` `src/train.js` `public/timeshift.js` … のりかえから流用

個人利用を前提にしています。URL を広く公開しないでください。

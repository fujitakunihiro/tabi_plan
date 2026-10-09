# tabi. — 旅のスケジューラー

行き先・旅行期間・旅のペース・興味のあることから、OpenAI API（`gpt-6-luna`）で日ごとの旅程を自動生成するWebアプリです。Google Maps Routes APIから予定間の経路・所要時間を取得し、移動手段（電車・バス／徒歩／車）を選べます。旅程の追加・編集・削除、日程の追加・削除、並べ替え、SQLiteデータベースへの保存、テキストコピーに対応しています。

## Dockerで起動

Docker Desktopを起動し、`.env.example` を `.env` にコピーして `OPENAI_API_KEY` にOpenAI APIキーを設定してから、プロジェクトのディレクトリで実行してください。

```sh
cp .env.example .env
# .env の OPENAI_API_KEY を設定
docker compose -p tabi up --build -d
```

ブラウザーで <http://localhost:8082> を開きます。`.env` はGitに登録されないため、APIキーが公開リポジトリに含まれることはありません。ポートを変える場合は `.env` の `PORT` を変更します。

PowerShellの場合、`.env` の作成は `Copy-Item .env.example .env` で行えます。

経路検索を使う場合は、Google CloudでRoutes APIを有効にし、請求先を設定したうえで `.env` の `GOOGLE_MAPS_API_KEY` も設定してください。Google Maps PlatformのAPI利用料が発生する場合があります。旅程の下書きは自動的にSQLiteへ保存され、「保存する」を押した旅程は「保存した旅」から開けます。DBファイルはDockerの名前付きボリューム `tabi_tabi-data` に置かれ、コンテナの再作成後も残ります。データを削除する場合は `docker compose -p tabi down -v` を実行してください。

## 旅程の生成について

入力した行き先、日程、興味、旅のペースをOpenAI APIに送信して旅程を生成します。APIの利用料金はOpenAIアカウントに請求されます。移動時間はGoogle Maps Routes APIの検索時点における経路・運行情報です。旅行当日の交通や時刻表は変わるため、出発前に再確認してください。営業状況・天気は取得しません。以前ブラウザーに保存していた下書きと旅程は、アプリを開いたときにSQLiteへ移行します。

# tabi. — 旅のスケジューラー

行き先・旅行期間・旅のペース・興味のあることから、OpenAI API（`gpt-6-luna`）で日ごとの旅程を自動生成するWebアプリです。Google Mapsを使わず、OpenStreetMapの地点検索とOSRMの道路経路を参考に移動時間を概算します。場所が特定できない区間はOpenAI APIで概算します。旅程の追加・編集・削除、日程の追加・削除、並べ替え、SQLiteデータベースへの保存、テキストコピーに対応しています。

## Dockerで起動

Docker Desktopを起動し、`.env.example` を `.env` にコピーして `OPENAI_API_KEY` にOpenAI APIキーを設定してから、プロジェクトのディレクトリで実行してください。

```sh
cp .env.example .env
# .env の OPENAI_API_KEY を設定
docker compose -p tabi up --build -d
```

ブラウザーで <http://localhost:8082> を開きます。`.env` はGitに登録されないため、APIキーが公開リポジトリに含まれることはありません。ポートを変える場合は `.env` の `PORT` を変更します。

PowerShellの場合、`.env` の作成は `Copy-Item .env.example .env` で行えます。

移動時間は概算です。位置を特定できた区間ではOSRMの道路経路を車移動の参考にし、徒歩・電車・バスは距離から推定します。待ち時間や駐車の余裕を加え、後の予定時刻を必要に応じて調整します。時刻表・運行状況・渋滞は反映しません。場所を特定できない区間はOpenAI APIで推定し、区間ごとに根拠を表示します。公共のOpenStreetMap NominatimとOSRMデモサーバーに接続するため、サービスの混雑時は概算を表示できない場合があります。地点検索はキャッシュし、Nominatimへのリクエストは毎秒1回以内に制限しています。Google Maps APIキーやGoogle Cloudの請求設定は不要です。旅程の下書きは自動的にSQLiteへ保存され、「保存する」を押した旅程は「保存した旅」から開けます。同じ行き先・日付でも別の旅程として保存できます。DBファイルはDockerの名前付きボリューム `tabi_tabi-data` に置かれ、コンテナの再作成後も残ります。データを削除する場合は `docker compose -p tabi down -v` を実行してください。

## 旅程の生成について

入力した行き先、日程、興味、旅のペースをOpenAI APIに送信して旅程を生成します。APIの利用料金はOpenAIアカウントに請求されます。移動時間の概算では予定の場所と行き先をNominatimへ、取得した座標をOSRMへ送信します。場所を特定できない場合は行き先と予定名をOpenAI APIへ送信します。正確な経路、交通状況、時刻表、営業状況、天気は保証しません。出発前に地図や交通機関でご確認ください。以前ブラウザーに保存していた下書きと旅程は、アプリを開いたときにSQLiteへ移行します。

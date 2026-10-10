const test = require("node:test");
const assert = require("node:assert/strict");
const { safeWebsiteURL, verifiedSites, lookupOfficialSites } = require("../website-search");

const events = [{ index: 0, name: "美術館を見学", place: "対象美術館" }];
function responseFor(sites, urls = [], annotations = []) {
  return { output: [
    { type: "web_search_call", action: { sources: urls.map((url) => ({ url })) } },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ sites }), annotations }] },
  ] };
}

test("外部リンクにスクリプト、資格情報、ローカルアドレスを使わせない", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,<script>", "https://user:password@example.org/", "http://localhost:3000/", "http://127.0.0.1/", "http://192.168.1.1/", "http://[::1]/", "https://museum.local/", "https://example.org:8080/"]) {
    assert.equal(safeWebsiteURL(url), "", url);
  }
  assert.equal(safeWebsiteURL("https://museum.example.org/visit#hours"), "https://museum.example.org/visit");
});

test("AIが推測したURLは検索結果にない限り表示しない", () => {
  const result = verifiedSites(responseFor([{ index: 0, title: "美術館", url: "https://guessed.example.org/", official: true }], ["https://real.example.org/"]), events);
  assert.equal(result[0].status, "not_found");
  assert.equal(result[0].url, "");
});

test("検索結果にあっても公式と判断できないURLは表示しない", () => {
  const result = verifiedSites(responseFor([{ index: 0, url: "https://reviews.example.org/", official: false }], ["https://reviews.example.org/"]), events);
  assert.equal(result[0].url, "");
});

test("ホームページの表記差は検索元のindexページを採用し、推測した下層ページは採用しない", () => {
  const home = verifiedSites(responseFor([{ index: 0, url: "https://museum.example.org/", official: true }], ["https://museum.example.org/index.htm"]), events);
  assert.equal(home[0].url, "https://museum.example.org/index.htm");
  const guessed = verifiedSites(responseFor([{ index: 0, url: "https://museum.example.org/tickets", official: true }], ["https://museum.example.org/index.htm"]), events);
  assert.equal(guessed[0].url, "");
});

test("公式と判断され検索で参照されたURLを予定のindexに照合する", () => {
  const result = verifiedSites(responseFor([{ index: 0, title: "公式美術館", url: "https://museum.example.org/", official: true }], ["https://museum.example.org/"]), events);
  assert.deepEqual(result[0], { index: 0, title: "公式美術館", url: "https://museum.example.org/", status: "found" });
});

test("引用付きの公式ページも確認対象にし、未回答の予定は未確認にする", () => {
  const result = verifiedSites(responseFor([{ index: 0, title: "公式美術館", url: "https://museum.example.org/visit", official: true }], [], [{ type: "url_citation", url: "https://museum.example.org/visit" }]), [...events, { index: 1, name: "公園" }]);
  assert.equal(result[0].status, "found");
  assert.equal(result[1].status, "not_found");
  assert.equal(result[1].url, "");
});

test("指定モデルでWeb検索を必須にし、検索元を取得して照合する", async () => {
  const result = await lookupOfficialSites({ destination: "秋田", events, apiKey: "test-key", model: "configured-model", fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "configured-model");
    assert.equal(body.tool_choice, "required");
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    assert.deepEqual(body.include, ["web_search_call.action.sources"]);
    assert.deepEqual(JSON.parse(body.input), { destination: "秋田", events });
    return { ok: true, json: async () => responseFor([{ index: 0, title: "美術館", url: "https://museum.example.org/", official: true }], ["https://museum.example.org/"]) };
  } });
  assert.equal(result[0].status, "found");
});

test("検索サービスへの接続失敗は未確認URLを返さずに通知する", async () => {
  await assert.rejects(lookupOfficialSites({ destination: "秋田", events, apiKey: "test-key", model: "configured-model", fetchImpl: async () => { throw new Error("network_failure"); } }), /公式サイトの検索に接続できませんでした/);
});

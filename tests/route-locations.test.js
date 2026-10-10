const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePlace, selectLocation, isReasonableRoad, createGeocoder } = require("../route-locations");

const akita = { name: "秋田市", display_name: "秋田市, 秋田県, 日本", addresstype: "city", lat: "39.7200", lon: "140.1020", address: { country_code: "jp" } };
const museum = { name: "秋田市民俗芸能伝承館", display_name: "秋田市民俗芸能伝承館, 秋田市, 日本", lat: "39.7220", lon: "140.1160", address: { country_code: "jp" } };
const nanjing = { name: "秋天元宝故事店", display_name: "秋天元宝故事店, 南京市, 中国", lat: "32.0166760", lon: "118.7822004", address: { country_code: "cn" } };
const context = { lat: 39.72, lon: 140.102, countryCode: "jp", radiusKm: 150 };

test("場所が曖昧な表現は地域・駅の目安として扱う", () => {
  assert.deepEqual(normalizePlace("秋田市中心部"), { query: "秋田市", precision: "area" });
  assert.deepEqual(normalizePlace("秋田駅周辺"), { query: "秋田駅", precision: "area" });
  assert.deepEqual(normalizePlace("千秋公園"), { query: "千秋公園", precision: "place" });
  assert.equal(normalizePlace("稲庭うどんなど"), null);
  assert.equal(normalizePlace("昼食"), null);
});

test("5,624分の原因となった南京市のカフェは秋田の地点として採用しない", () => {
  assert.equal(selectLocation([nanjing], "秋田市中心部"), null);
  assert.equal(selectLocation([nanjing], "秋田市", context), null);
  const wrongCountry = { ...nanjing, name: "秋田市", display_name: "秋田市, 中国" };
  assert.equal(selectLocation([wrongCountry], "秋田市", context), null);
});

test("短い旅行先名と一致する市を解決し、名前の違う施設は拒否する", () => {
  assert.equal(selectLocation([akita], "秋田").countryCode, "jp");
  assert.equal(selectLocation([museum], "秋田市民俗芸能伝承館", context).lat, 39.722);
  assert.equal(selectLocation([museum], "千秋公園", context), null);
});

test("国が一致しても旅行先から遠い候補と不正な座標は拒否する", () => {
  const far = { ...museum, lat: "35.6", lon: "139.7" };
  assert.equal(selectLocation([far], museum.name, context), null);
  assert.equal(selectLocation([{ ...museum, lon: "181" }], museum.name), null);
  assert.equal(selectLocation([{ ...museum, lat: null }], museum.name), null);
});

test("市内の地点検索を旅行先の範囲と国に制限する", async () => {
  const queries = [];
  const geocode = createGeocoder({ userAgent: "test", intervalMs: 0, fetchImpl: async (input) => {
    const url = new URL(input); queries.push(url);
    return { ok: true, json: async () => url.searchParams.get("q") === "秋田" ? [akita] : [museum] };
  } });
  const point = await geocode(museum.name, "秋田");
  assert.equal(point.countryCode, "jp");
  assert.equal(queries[1].searchParams.get("bounded"), "1");
  assert.equal(queries[1].searchParams.get("countrycodes"), "jp");
  assert.ok(queries[1].searchParams.get("viewbox"));
});

test("範囲制限を無視した検索結果も捨て、未確認の場所を返さない", async () => {
  const geocode = createGeocoder({ userAgent: "test", intervalMs: 0, fetchImpl: async (input) => ({ ok: true, json: async () => new URL(input).searchParams.get("q") === "秋田" ? [akita] : [nanjing] }) });
  assert.equal(await geocode("秋田市中心部", "秋田"), null);
});

test("同名施設のキャッシュは旅行先ごとに分ける", async () => {
  const tokyo = { ...akita, name: "東京都", display_name: "東京都, 日本", lat: "35.68", lon: "139.76" };
  const geocode = createGeocoder({ userAgent: "test", intervalMs: 0, fetchImpl: async (input) => {
    const params = new URL(input).searchParams;
    let item;
    if (params.get("q") === "秋田") item = akita;
    else if (params.get("q") === "東京") item = tokyo;
    else { const north = Number(params.get("viewbox").split(",")[1]) > 39; item = { name: "中央公園", lat: north ? "39.72" : "35.68", lon: "140.1", address: { country_code: "jp" } }; }
    return { ok: true, json: async () => [item] };
  } });
  assert.equal((await geocode("中央公園", "秋田")).lat, 39.72);
  assert.equal((await geocode("中央公園", "東京")).lat, 35.68);
});

test("明示された往路の出発駅は旅行先から離れていても解決できる", async () => {
  const station = { name: "東京駅", lat: "35.681", lon: "139.767", address: { country_code: "jp" } };
  const geocode = createGeocoder({ userAgent: "test", intervalMs: 0, fetchImpl: async (input) => ({ ok: true, json: async () => new URL(input).searchParams.get("q") === "秋田" ? [akita] : [station] }) });
  assert.equal(await geocode("東京駅", "秋田"), null);
  assert.equal((await geocode("東京駅", "秋田", { unrestricted: true })).lat, 35.681);
});

test("近隣地点を結ぶ異常な道路経路と遠い道路への補正を拒否する", () => {
  const a = { lat: 39.72, lon: 140.1 }, b = { lat: 39.73, lon: 140.12 };
  assert.equal(isReasonableRoad(a, b, { distance: 2797500, duration: 126240 }), false);
  assert.equal(isReasonableRoad(a, b, { distance: 3000, duration: 600 }, [{ distance: 5000 }]), false);
  assert.equal(isReasonableRoad(a, b, { distance: 3000, duration: 600 }, [{ distance: 100 }]), true);
  assert.equal(isReasonableRoad({ lat: 35.68, lon: 139.76 }, { lat: 35.01, lon: 135.76 }, { distance: 480000, duration: 22000 }), true);
});

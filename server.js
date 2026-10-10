const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const initSqlJs = require("sql.js");
const { lookupOfficialSites, searchedURLs, safeWebsiteURL } = require("./website-search");
const { createGeocoder, distanceKm, isReasonableRoad } = require("./route-locations");
const { travelRange, durationMinutes } = require("./itinerary-utils");

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-6-luna";
const API_KEY = process.env.OPENAI_API_KEY || "";
const ROOT = __dirname;
const DB_FILE = process.env.DB_PATH || path.join(ROOT, "data", "tabi.sqlite");
let db;
const routeEstimateCache = new Map();
const roadCache = new Map();
const websiteRequests = new Map();
const GEO_USER_AGENT = "tabi-plan/1.0 (https://github.com/fujitakunihiro/tabi_plan)";
const geocode = createGeocoder({ userAgent: GEO_USER_AGENT });
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/itinerary-utils.js", ["itinerary-utils.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/terms.html", ["terms.html", "text/html; charset=utf-8"]],
  ["/privacy.html", ["privacy.html", "text/html; charset=utf-8"]],
]);
const interestNames = { culture: "文化・歴史", food: "グルメ", nature: "自然・景色", shopping: "ショッピング", art: "アート" };
const paceNames = { relaxed: "ゆったり", balanced: "ちょうどいい", active: "たっぷり満喫" };
const itinerarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: { type: "string" },
    days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          foodRecommendations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                specialty: { type: "string" },
                place: { type: "string" },
                nearbyTo: { type: "string" },
                reason: { type: "string" },
                url: { type: "string" },
              },
              required: ["name", "specialty", "place", "nearbyTo", "reason", "url"],
            },
          },
          events: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                time: { type: "string" },
                name: { type: "string" },
                kind: { type: "string" },
                duration: { type: "string" },
                emoji: { type: "string" },
                place: { type: "string" },
                origin: { type: "string" },
                journeyRole: { type: "string", enum: ["outbound", "return", "local"] },
              },
              required: ["time", "name", "kind", "duration", "emoji", "place", "origin", "journeyRole"],
            },
          },
        },
        required: ["summary", "events", "foodRecommendations"],
      },
    },
  },
  required: ["category", "days"],
};

function sendJSON(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(payload));
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateTrip(input) {
  if (!input || typeof input !== "object") return "旅行の条件を読み取れませんでした。";
  if (typeof input.destination !== "string" || input.destination.trim().length < 1 || input.destination.trim().length > 80) return "行き先は1〜80文字で入力してください。";
  if (input.departurePoint !== undefined && (typeof input.departurePoint !== "string" || input.departurePoint.length > 100)) return "出発地は100文字以内で入力してください。";
  if (!isRealDate(input.startDate) || !isRealDate(input.endDate)) return "出発日と帰着日を正しく入力してください。";
  const start = Date.parse(`${input.startDate}T00:00:00Z`);
  const end = Date.parse(`${input.endDate}T00:00:00Z`);
  const days = Math.round((end - start) / 86400000) + 1;
  if (days < 1 || days > 21) return "旅行日数は1〜21日の範囲で設定してください。";
  if (!Object.hasOwn(paceNames, input.pace)) return "旅のペースを選び直してください。";
  if (!Array.isArray(input.interests) || input.interests.some((item) => !Object.hasOwn(interestNames, item))) return "興味の選択を確認してください。";
  return null;
}

async function readJSON(req, maxBytes = 24 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function persistDatabase() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function getState(key) {
  const statement = db.prepare("SELECT value FROM app_state WHERE key = ?");
  statement.bind([key]);
  const value = statement.step() ? statement.getAsObject().value : null;
  statement.free();
  return value === null ? null : JSON.parse(value);
}

function setState(key, value) {
  db.run("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(value)]);
  persistDatabase();
}

function listSavedTrips(deleted = false) {
  const statement = db.prepare(`SELECT id, value FROM itineraries WHERE deleted_at IS ${deleted ? "NOT " : ""}NULL ORDER BY ${deleted ? "deleted_at" : "updated_at"} DESC`);
  const trips = [];
  while (statement.step()) {
    const row = statement.getAsObject();
    trips.push({ ...JSON.parse(row.value), id: row.id });
  }
  statement.free();
  return trips;
}

function validateStoredTrip(trip) {
  if (!trip || typeof trip !== "object" || typeof trip.destination !== "string" || !trip.destination.trim() || trip.destination.length > 80) return false;
  if (trip.departurePoint !== undefined && (typeof trip.departurePoint !== "string" || trip.departurePoint.length > 100)) return false;
  if (!isRealDate(trip.startDate) || !isRealDate(trip.endDate) || !Array.isArray(trip.days) || trip.days.length < 1 || trip.days.length > 21) return false;
  return trip.days.every((day) => day && typeof day === "object" && Array.isArray(day.events) && day.events.length <= 100 && day.events.every((event) => event && typeof event.name === "string" && typeof event.time === "string"));
}

function saveStoredTrip(trip) {
  if (!validateStoredTrip(trip)) return false;
  const id = typeof trip.id === "string" && trip.id.length > 0 && trip.id.length <= 160 ? trip.id : crypto.randomUUID();
  const stored = { ...trip, id, destination: trip.destination.trim() };
  const value = JSON.stringify(stored);
  db.run("INSERT INTO itineraries (id, destination, start_date, updated_at, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET destination = excluded.destination, start_date = excluded.start_date, updated_at = excluded.updated_at, value = excluded.value, deleted_at = NULL", [id, trip.destination.trim(), trip.startDate, new Date().toISOString(), value]);
  persistDatabase();
  return stored;
}

function initializeDatabase() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const SQL = initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
  return SQL.then((sqlite) => {
    db = fs.existsSync(DB_FILE) ? new sqlite.Database(fs.readFileSync(DB_FILE)) : new sqlite.Database();
    db.run("CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS itineraries (id TEXT PRIMARY KEY, destination TEXT NOT NULL, start_date TEXT NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL)");
    if (!db.exec("PRAGMA table_info(itineraries)")[0].values.some((column) => column[1] === "deleted_at")) db.run("ALTER TABLE itineraries ADD COLUMN deleted_at TEXT");
    persistDatabase();
  });
}

function getOutputText(response) {
  return (response.output || []).filter((item) => item.type === "message")
    .flatMap((item) => item.content || []).filter((item) => item.type === "output_text")
    .map((item) => item.text).join("");
}

async function createItinerary(req, res) {
  if (!API_KEY) return sendJSON(res, 503, { error: "APIキーが未設定です。.env に OPENAI_API_KEY を設定してDockerを再起動してください。" });
  let trip;
  try {
    trip = await readJSON(req);
  } catch (error) {
    const status = error.message === "request_too_large" ? 413 : 400;
    return sendJSON(res, status, { error: status === 413 ? "入力が大きすぎます。" : "入力内容を読み取れませんでした。" });
  }
  const validationError = validateTrip(trip);
  if (validationError) return sendJSON(res, 400, { error: validationError });

  const dayCount = Math.round((Date.parse(`${trip.endDate}T00:00:00Z`) - Date.parse(`${trip.startDate}T00:00:00Z`)) / 86400000) + 1;
  const interestText = trip.interests.length ? trip.interests.map((key) => interestNames[key]).join("、") : "特に指定なし。全体のバランスをとる";
  const instructions = [
    "あなたは日本語の旅行プランナーです。行き先、日付、ペース、興味に合わせて実用的なたたき台を作成してください。",
    "旅行日数と同じ日数だけ days を返し、各日の予定は時間順に並べてください。時刻は24時間表記のHH:MMにしてください。",
    "出発地departurePointが指定されている場合、初日に出発地から旅行先への移動、最終日に出発地への帰路を含めてください。所要時間と到着後の余裕を考慮して観光の開始時刻を決め、帰着日までに帰れる計画にしてください。日帰りでも往復を含めてください。未指定の場合は旅行先から開始してください。",
    "extension=trueの場合は既存の旅行に追加する1日の計画です。出発地からの往路は再作成しないでください。帰路を含める場合はjourneyRoleをreturnにしてください。",
    "ゆったりは1日3件、ちょうどいいは1日4件、たっぷり満喫は1日5件を目安にしてください。食事や休憩、現実的な移動の余裕を含め、予定を詰め込みすぎないでください。",
    "選択された移動手段に合わせて、予定名に移動が含まれる区間の所要時間を現実的に見積もってください。電車・バスは駅までの徒歩、待ち時間、乗換、車は駐車や道路状況の余裕も考慮し、その時間を予定の開始時刻と所要時間に反映してください。",
    "各予定のplaceには施設名か地名だけを入れてください。移動予定ではplaceに到着地、originに出発地を入れ、通常の予定ではoriginを空文字にしてください。実在が曖昧な場所は地区名にしてください。",
    "journeyRoleは出発地からの往路をoutbound、出発地への帰路をreturn、それ以外の予定をlocalにしてください。往路と帰路は独立した移動予定にしてください。",
    "興味に合う場所や体験を優先してください。よく知られた観光地は候補として提案できますが、実在を確信できない施設名、住所、営業時間、予約状況は作らないでください。確かな施設名がない場合は、地区や体験の種類を予定名にしてください。",
    "グルメが興味に含まれる場合はweb_searchで調べ、各日のfoodRecommendationsに名物料理・地元で評判の店を3件ずつ提案してください。その日の観光予定から立ち寄りやすい実在店舗を選び、店名、名物、近くの観光予定、選んだ理由を具体的に書いてください。placeには店舗の正式名称と市区町村・エリアを入れ、nearbyToにはその日に訪れる近くの観光地を入れてください。urlは検索結果に実際に含まれる店舗公式サイト、自治体または公式観光協会のページのURLだけをそのまま記入してください。確認できる出典URLがない候補は出さないでください。営業時間や営業日、予約可否は断定しないでください。グルメが選ばれていない場合はfoodRecommendationsを空配列にしてください。",
    "リアルタイムの天気、営業日、料金、交通、予約情報を確認したとは言わないでください。日本語で簡潔に書いてください。",
  ].join("\n");
  const travelModeNames = { TRANSIT: "電車・バス", WALK: "徒歩", DRIVE: "車" };
  const userInput = { departurePoint: (trip.departurePoint || "").trim(), destination: trip.destination.trim(), startDate: trip.startDate, endDate: trip.endDate, days: dayCount, pace: paceNames[trip.pace], interests: interestText, travelMode: travelModeNames[trip.travelMode] || travelModeNames.TRANSIT, extension: trip.extension === true };

  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        instructions,
        input: JSON.stringify(userInput),
        ...(trip.interests.includes("food") ? { tools: [{ type: "web_search" }], tool_choice: "required", include: ["web_search_call.action.sources"] } : {}),
        text: { format: { type: "json_schema", name: "travel_itinerary", strict: true, schema: itinerarySchema } },
        max_output_tokens: 8000,
      }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (error) {
    console.error("OpenAI request failed:", error.name);
    return sendJSON(res, 502, { error: "OpenAI APIに接続できませんでした。ネットワークを確認して、もう一度お試しください。" });
  }

  if (!upstream.ok) {
    console.error("OpenAI API returned status", upstream.status);
    const message = upstream.status === 401 ? "APIキーを確認してください。"
      : upstream.status === 429 ? "APIの利用上限に達したか、混み合っています。時間をおいて再度お試しください。"
        : "旅程を生成できませんでした。APIの設定を確認して、もう一度お試しください。";
    return sendJSON(res, 502, { error: message });
  }

  try {
    const response = await upstream.json();
    const result = JSON.parse(getOutputText(response));
    if (!Array.isArray(result.days) || result.days.length !== dayCount) throw new Error("invalid_day_count");
    const sourceURLs = trip.interests.includes("food") ? searchedURLs(response) : new Set();
    for (const day of result.days) {
      if (!Array.isArray(day.events) || day.events.length < 1 || day.events.length > 8) throw new Error("invalid_event_count");
      for (const event of day.events) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.time) || !event.name.trim()) throw new Error("invalid_event");
      }
      if (!Array.isArray(day.foodRecommendations)) throw new Error("invalid_food_recommendations");
      const seen = new Set();
      day.foodRecommendations = day.foodRecommendations.filter((item) => {
        if (!item || ["name", "specialty", "place", "nearbyTo", "reason"].some((key) => typeof item[key] !== "string" || !item[key].trim())
          || ["name", "specialty", "place", "nearbyTo", "reason"].some((key) => item[key].length > 160)) return false;
        const url = safeWebsiteURL(item.url);
        if (!url || !sourceURLs.has(url)) return false;
        const normalized = item.name.trim().toLocaleLowerCase("ja");
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        item.url = url;
        return true;
      }).slice(0, 3);
    }
    return sendJSON(res, 200, result);
  } catch (error) {
    console.error("OpenAI response could not be parsed:", error.message);
    return sendJSON(res, 502, { error: "旅程の形式を読み取れませんでした。もう一度生成してください。" });
  }
}

async function estimateRoutesWithAI(destination, events) {
  const cacheKey = JSON.stringify([destination.trim().toLocaleLowerCase("ja"), events.map((event) => [event.name, event.kind || "", event.duration || "", event.place || "", event.origin || ""].map((value) => value.trim().toLocaleLowerCase("ja")))]);
  const cached = routeEstimateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.estimates;
  if (cached) routeEstimateCache.delete(cacheKey);
  if (!API_KEY) throw new Error("移動時間の概算には .env の OPENAI_API_KEY が必要です。");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            index: { type: "integer" },
            transitMinutes: { type: "integer" },
            walkMinutes: { type: "integer" },
            driveMinutes: { type: "integer" },
          },
          required: ["index", "transitMinutes", "walkMinutes", "driveMinutes"],
        },
      },
      transfers: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: { index: { type: "integer" }, transitMinutes: { type: "integer" }, walkMinutes: { type: "integer" }, driveMinutes: { type: "integer" } },
          required: ["index", "transitMinutes", "walkMinutes", "driveMinutes"],
        },
      },
    },
    required: ["segments", "transfers"],
  };
  const instructions = [
    "あなたは旅行の移動時間を概算するアシスタントです。地図、経路検索、時刻表、リアルタイム情報は使わず、場所の一般知識から控えめな目安を出してください。",
    "入力された順番で各予定間の移動時間を分単位で推定し、電車・バス、徒歩、車の3種類を返してください。場所同士が近い場合と離れている場合の差を反映し、すべての区間を同じ値にそろえないでください。",
    "各区間の基本的な移動所要時間を見積もってください。駅までの徒歩、待ち時間、乗換、駐車などの余裕時間はアプリ側で別に加算します。",
    "予定名・種類に「移動」や「戻る」とあり、その予定の所要時間に長距離移動が含まれている場合は、その移動を隣の区間でも二重に加算しないでください。到着後または出発前の近距離移動だけを見積もってください。予定の種類と所要時間を考慮してください。",
    "移動そのものが予定になっている場合、transfersにその予定のindexと、3つの移動手段ごとの予定全体の所要分数を返してください。通常の観光・食事予定はtransfersに含めないでください。",
    "正確な場所や距離が分からない場合は、行き先の市街地内の一般的な目安を出してください。根拠のない距離や経路、乗換、時刻表を作らないでください。各値は5〜240分の整数にしてください。",
  ].join("\n");
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        instructions,
        input: JSON.stringify({ destination, events, segments: events.slice(1).map((event, index) => ({ index, from: events[index], to: event })) }),
        text: { format: { type: "json_schema", name: "approximate_travel_times", strict: true, schema } },
        max_output_tokens: 2000,
      }),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new Error("移動時間の概算を作れませんでした。ネットワークを確認して再度お試しください。");
  }
  if (!response.ok) {
    const message = response.status === 401 ? "OpenAI APIキーを確認してください。"
      : response.status === 429 ? "OpenAI APIの利用上限に達したか、混み合っています。時間をおいて再度お試しください。"
        : "AIによる移動時間の概算を作れませんでした。時間をおいて再度お試しください。";
    throw new Error(message);
  }
  const result = JSON.parse(getOutputText(await response.json()));
  if (!Array.isArray(result.segments) || result.segments.length !== events.length - 1 || !Array.isArray(result.transfers)) throw new Error("移動時間の概算結果が不完全でした。もう一度お試しください。");
  const estimates = result.segments.map((segment, index) => {
    if (segment.index !== index || ![segment.transitMinutes, segment.walkMinutes, segment.driveMinutes].every((minutes) => Number.isInteger(minutes) && minutes >= 5 && minutes <= 240)) {
      throw new Error("移動時間の概算結果を読み取れませんでした。もう一度お試しください。");
    }
    return {
      index,
      estimates: {
        TRANSIT: Math.min(240, segment.transitMinutes + 15),
        WALK: Math.min(240, segment.walkMinutes + 5),
        DRIVE: Math.min(240, segment.driveMinutes + 10),
      },
    };
  });
  if (routeEstimateCache.size >= 100) routeEstimateCache.delete(routeEstimateCache.keys().next().value);
  const transfers = result.transfers.filter((item) => Number.isInteger(item.index) && item.index >= 0 && item.index < events.length)
    .map((item) => ({ index: item.index, estimates: { TRANSIT: item.transitMinutes, WALK: item.walkMinutes, DRIVE: item.driveMinutes }, source: "ai" }))
    .filter((item) => Object.values(item.estimates).every((minutes) => Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440));
  const answer = { segments: estimates.map((item) => ({ ...item, source: "ai" })), transfers };
  routeEstimateCache.set(cacheKey, { estimates: answer, expiresAt: Date.now() + 30 * 60 * 1000 });
  return answer;
}

function eventPlace(event, destination) {
  if (event.place?.trim()) return event.place.trim();
  const title = event.name.trim();
  const returnPlace = title.split(/[、,]/).at(-1).match(/^(.+?)へ戻る/);
  if (returnPlace) return returnPlace[1].trim();
  const movement = title.match(/(?:から|より)(.+?)(?:へ|に)(?:移動|戻る|向かう)/);
  if (movement) return movement[1].trim();
  const cleaned = title.split(/[・、（(]/)[0].replace(/(?:周辺|付近)?(?:で|を|に).+$/, "").replace(/(?:へ移動|に移動|を散策|を見学|を鑑賞|で昼食|で夕食|で休憩)$/, "").trim();
  return cleaned && cleaned.length <= 50 ? cleaned : "";
}

function eventOrigin(event) {
  if (event.origin?.trim()) return event.origin.trim();
  return event.name.match(/^(.+?)(?:から|より).+?(?:へ|に)(?:移動|戻る|向かう)/)?.[1]?.trim() || "";
}

async function roadEstimate(a, b) {
  const key = `${a.lon},${a.lat};${b.lon},${b.lat}`;
  if (roadCache.has(key)) return roadCache.get(key);
  try {
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${key}?overview=false`, { headers: { "User-Agent": GEO_USER_AGENT }, signal: AbortSignal.timeout(8000) });
    const result = response.ok ? await response.json() : null;
    const route = result?.routes?.[0];
    if (!isReasonableRoad(a, b, route, result?.waypoints || [])) return null;
    const estimate = { km: route.distance / 1000, driveMinutes: Math.ceil(route.duration / 60) };
    roadCache.set(key, estimate);
    return estimate;
  } catch { return null; }
}

function minutesFromLocation(a, b, road, transfer = false) {
  const direct = distanceKm(a, b);
  const km = road?.km ?? direct * 1.3;
  const drive = road?.driveMinutes ?? km / 35 * 60;
  const buffer = transfer ? 20 : 10;
  return {
    TRANSIT: Math.max(5, Math.ceil(km / 30 * 60 + (transfer ? 30 : 20))),
    WALK: Math.max(5, Math.ceil(direct * 1.25 / 4.5 * 60 + (transfer ? 10 : 5))),
    DRIVE: Math.max(5, Math.ceil(drive + buffer)),
  };
}

async function estimateFromLocations(destination, events) {
  const positions = await Promise.all(events.map((event) => geocode(eventPlace(event, destination), destination, { unrestricted: Boolean(eventOrigin(event)) || /移動|戻る|向かう/.test(event.name) })));
  const origins = await Promise.all(events.map((event) => {
    const origin = eventOrigin(event);
    return origin ? geocode(origin, destination, { unrestricted: true }) : Promise.resolve(null);
  }));
  const segments = [];
  const transfers = [];
  for (let index = 0; index < events.length; index++) {
    if (index > 0 && positions[index - 1] && (origins[index] || positions[index])) {
      const from = positions[index - 1], to = origins[index] || positions[index];
      const road = await roadEstimate(from, to);
      const coarse = from.precision === "area" || to.precision === "area";
      segments.push({ index: index - 1, estimates: minutesFromLocation(from, to, road), source: coarse ? "area" : road ? "road" : "distance" });
    }
    if (origins[index] && positions[index]) {
      const road = await roadEstimate(origins[index], positions[index]);
      const estimates = minutesFromLocation(origins[index], positions[index], road, true);
      const duration = String(events[index].duration || "");
      const plannedMinutes = durationMinutes(duration);
      const intercityTransit = /新幹線|飛行機|航空|フライト|特急|フェリー/.test(events[index].name)
        || distanceKm(origins[index], positions[index]) > 100;
      if (events[index].durationMode === "TRANSIT" && intercityTransit && plannedMinutes > 0) estimates.TRANSIT = plannedMinutes;
      transfers.push({ index, estimates, source: road ? "road" : "distance" });
    }
  }
  return { segments, transfers };
}

async function getRouteEstimates(req, res) {
  let input;
  try {
    input = await readJSON(req, 64 * 1024);
  } catch {
    return sendJSON(res, 400, { error: "経路検索の条件を読み取れませんでした。" });
  }
  if (typeof input.destination !== "string" || !input.destination.trim() || input.destination.length > 80 || !Array.isArray(input.events) || input.events.length > 21 || !["TRANSIT", "WALK", "DRIVE"].includes(input.travelMode)) {
    return sendJSON(res, 400, { error: "経路検索の条件を確認してください。" });
  }
  if (input.events.some((event) => !event || typeof event.name !== "string" || !event.name.trim() || event.name.length > 160
    || (event.kind !== undefined && (typeof event.kind !== "string" || event.kind.length > 100))
    || (event.duration !== undefined && (typeof event.duration !== "string" || event.duration.length > 40))
    || (event.place !== undefined && (typeof event.place !== "string" || event.place.length > 100))
    || (event.origin !== undefined && (typeof event.origin !== "string" || event.origin.length > 100)))) return sendJSON(res, 400, { error: "予定名・場所・所要時間を確認してください。" });
  if (input.events.some((event) => event.durationMode !== undefined && !["TRANSIT", "WALK", "DRIVE"].includes(event.durationMode))) return sendJSON(res, 400, { error: "移動時間の条件を確認してください。" });
  try {
    const locations = await estimateFromLocations(input.destination, input.events);
    let ai = { segments: [], transfers: [] };
    if ((locations.segments.length < input.events.length - 1 || locations.transfers.length < input.events.filter((event) => eventOrigin(event)).length) && API_KEY) {
      try { ai = await estimateRoutesWithAI(input.destination, input.events); } catch (error) { if (!locations.segments.length && !locations.transfers.length) throw error; }
    }
    const segments = input.events.slice(1).map((_, index) => locations.segments.find((item) => item.index === index) || ai.segments.find((item) => item.index === index) || { index, available: false, reason: "場所を特定できません" })
      .map((item) => ({ ...item, ranges: item.estimates ? Object.fromEntries(Object.entries(item.estimates).map(([mode, minutes]) => [mode, travelRange(minutes, item.source)])) : {}, available: item.available !== false, estimated: true }));
    const transfers = [...locations.transfers, ...ai.transfers.filter((item) => !locations.transfers.some((found) => found.index === item.index))];
    return sendJSON(res, 200, { estimated: true, travelMode: input.travelMode, segments, transfers });
  } catch (error) {
    return sendJSON(res, 502, { error: error.message || "移動時間の概算を作成できませんでした。" });
  }
}

function websiteCacheKey(destination, event) {
  return `official-site:${crypto.createHash("sha256").update(JSON.stringify([destination.trim(), event.name.trim(), event.place?.trim() || ""])).digest("hex")}`;
}

async function getOfficialSites(req, res) {
  let input;
  try { input = await readJSON(req, 64 * 1024); }
  catch { return sendJSON(res, 400, { error: "公式サイトを検索する条件を読み取れませんでした。" }); }
  if (!input || typeof input.destination !== "string" || !input.destination.trim() || input.destination.length > 80
    || !Array.isArray(input.events) || input.events.length > 21
    || input.events.some((event) => !event || typeof event.name !== "string" || !event.name.trim() || event.name.length > 160
      || ["place", "origin", "kind"].some((key) => event[key] !== undefined && (typeof event[key] !== "string" || event[key].length > 100)))) {
    return sendJSON(res, 400, { error: "予定名と場所を確認してください。" });
  }
  const sites = [];
  const missing = [];
  input.events.forEach((event, index) => {
    if (event.origin || /移動|戻る|向かう|帰路|往路/.test(event.name)) {
      sites.push({ index, url: "", title: "", status: "skipped" });
      return;
    }
    const cached = getState(websiteCacheKey(input.destination, event));
    if (cached?.expiresAt > Date.now() && !(input.refresh === true && cached.site.status !== "found")) sites.push({ ...cached.site, index });
    else missing.push({ index, name: event.name, place: event.place || "" });
  });
  if (!missing.length) return sendJSON(res, 200, { sites });
  if (!API_KEY) return sendJSON(res, 503, { error: "公式サイトの検索には .env の OPENAI_API_KEY が必要です。" });
  const requestKey = JSON.stringify([input.destination, missing]);
  let work = websiteRequests.get(requestKey);
  if (!work) {
    work = (async () => {
      const found = [];
      for (let offset = 0; offset < missing.length; offset += 8) {
        found.push(...await lookupOfficialSites({ destination: input.destination, events: missing.slice(offset, offset + 8), apiKey: API_KEY, model: MODEL }));
      }
      for (const site of found) {
        const value = { site, expiresAt: Date.now() + (site.status === "found" ? 7 * 86400000 : 12 * 3600000) };
        db.run("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [websiteCacheKey(input.destination, input.events[site.index]), JSON.stringify(value)]);
      }
      persistDatabase();
      return found;
    })();
    websiteRequests.set(requestKey, work);
  }
  try { return sendJSON(res, 200, { sites: [...sites, ...await work] }); }
  catch (error) { return sendJSON(res, 502, { error: error.message || "公式サイトを検索できませんでした。" }); }
  finally { if (websiteRequests.get(requestKey) === work) websiteRequests.delete(requestKey); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/storage" && req.method === "GET") return sendJSON(res, 200, { draft: getState("draft"), saved: listSavedTrips(), deleted: listSavedTrips(true) });
  if (url.pathname === "/api/storage/draft" && req.method === "PUT") {
    try {
      const body = await readJSON(req, 1024 * 1024);
      if (body.draft !== null && !validateStoredTrip(body.draft)) return sendJSON(res, 400, { error: "保存する旅程の内容を確認してください。" });
      setState("draft", body.draft);
      return sendJSON(res, 200, { ok: true });
    } catch (error) {
      return sendJSON(res, error.message === "request_too_large" ? 413 : 400, { error: "旅程を保存できませんでした。" });
    }
  }
  if (url.pathname === "/api/storage/saved" && req.method === "POST") {
    try {
      const body = await readJSON(req, 1024 * 1024);
      const stored = saveStoredTrip(body.trip);
      if (!stored) return sendJSON(res, 400, { error: "保存する旅程の内容を確認してください。" });
      return sendJSON(res, 200, { trip: stored, saved: listSavedTrips(), deleted: listSavedTrips(true) });
    } catch (error) {
      return sendJSON(res, error.message === "request_too_large" ? 413 : 400, { error: "旅程を保存できませんでした。" });
    }
  }
  if (url.pathname === "/api/storage/saved" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || id.length > 160) return sendJSON(res, 400, { error: "削除する旅程を特定できません。" });
    db.run("UPDATE itineraries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", [new Date().toISOString(), id]);
    persistDatabase();
    return sendJSON(res, 200, { saved: listSavedTrips(), deleted: listSavedTrips(true) });
  }
  if (url.pathname === "/api/storage/saved/restore" && req.method === "POST") {
    try {
      const body = await readJSON(req);
      if (typeof body.id !== "string" || !body.id || body.id.length > 160) return sendJSON(res, 400, { error: "復元する旅程を特定できません。" });
      db.run("UPDATE itineraries SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL", [new Date().toISOString(), body.id]);
      persistDatabase();
      return sendJSON(res, 200, { saved: listSavedTrips(), deleted: listSavedTrips(true) });
    } catch { return sendJSON(res, 400, { error: "旅程を復元できませんでした。" }); }
  }
  if (url.pathname === "/api/status" && req.method === "GET") return sendJSON(res, 200, { configured: Boolean(API_KEY), model: MODEL });
  if (url.pathname === "/api/itinerary" && req.method === "POST") return createItinerary(req, res);
  if (url.pathname === "/api/routes" && req.method === "POST") return getRouteEstimates(req, res);
  if (url.pathname === "/api/official-sites" && req.method === "POST") return getOfficialSites(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD, POST" });
    return res.end();
  }
  const file = files.get(url.pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, {
    "Content-Type": file[1],
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(path.join(ROOT, file[0])).pipe(res);
});

if (require.main === module) initializeDatabase().then(() => server.listen(PORT, "0.0.0.0", () => console.log(`tabi server listening on ${PORT} (${MODEL})`)))
  .catch((error) => { console.error("Could not initialize the itinerary database:", error); process.exitCode = 1; });
module.exports = { server, initializeDatabase };

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const initSqlJs = require("sql.js");
const { createGeocoder, distanceKm, isReasonableRoad } = require("./route-locations");
const { travelRange, durationMinutes } = require("./itinerary-utils");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_FILE = process.env.DB_PATH || path.join(ROOT, "data", "tabi.sqlite");
let db;
const roadCache = new Map();
const GEO_USER_AGENT = "tabi-plan/1.0 (https://github.com/fujitakunihiro/tabi_plan)";
const geocode = createGeocoder({ userAgent: GEO_USER_AGENT });
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/itinerary-utils.js", ["itinerary-utils.js", "text/javascript; charset=utf-8"]],
  ["/chatgpt-import.js", ["chatgpt-import.js", "text/javascript; charset=utf-8"]],
  ["/day-map.js", ["day-map.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/terms.html", ["terms.html", "text/html; charset=utf-8"]],
  ["/privacy.html", ["privacy.html", "text/html; charset=utf-8"]],
]);
function sendJSON(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(payload));
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
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

function listSavedTrips() {
  const statement = db.prepare("SELECT id, value FROM itineraries WHERE deleted_at IS NULL ORDER BY updated_at DESC");
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
    db.run("DELETE FROM itineraries WHERE deleted_at IS NOT NULL");
    persistDatabase();
  });
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
    const segments = input.events.slice(1).map((_, index) => locations.segments.find((item) => item.index === index) || { index, available: false, reason: "場所を特定できません" })
      .map((item) => ({ ...item, ranges: item.estimates ? Object.fromEntries(Object.entries(item.estimates).map(([mode, minutes]) => [mode, travelRange(minutes, item.source)])) : {}, available: item.available !== false, estimated: true }));
    const transfers = locations.transfers;
    return sendJSON(res, 200, { estimated: true, travelMode: input.travelMode, segments, transfers });
  } catch (error) {
    return sendJSON(res, 502, { error: error.message || "移動時間の概算を作成できませんでした。" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/storage" && req.method === "GET") return sendJSON(res, 200, { draft: getState("draft"), saved: listSavedTrips() });
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
      return sendJSON(res, 200, { trip: stored, saved: listSavedTrips() });
    } catch (error) {
      return sendJSON(res, error.message === "request_too_large" ? 413 : 400, { error: "旅程を保存できませんでした。" });
    }
  }
  if (url.pathname === "/api/storage/saved" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || id.length > 160) return sendJSON(res, 400, { error: "削除する旅程を特定できません。" });
    db.run("DELETE FROM itineraries WHERE id = ?", [id]);
    persistDatabase();
    return sendJSON(res, 200, { saved: listSavedTrips() });
  }
  if (url.pathname === "/api/status" && req.method === "GET") return sendJSON(res, 200, { configured: false, mode: "chatgpt-json", openaiEnabled: false });
  if (["/api/itinerary", "/api/destinations", "/api/food-recommendations", "/api/official-sites"].includes(url.pathname)) return sendJSON(res, 410, { error: "GPT APIは無効です。ChatGPTへの依頼文をコピーし、回答JSONを取り込んでください。" });
  if (url.pathname === "/api/routes" && req.method === "POST") return getRouteEstimates(req, res);
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

if (require.main === module) initializeDatabase().then(() => server.listen(PORT, "0.0.0.0", () => console.log(`tabi server listening on ${PORT} (ChatGPT JSON import; GPT API disabled)`)))
  .catch((error) => { console.error("Could not initialize the itinerary database:", error); process.exitCode = 1; });
module.exports = { server, initializeDatabase };

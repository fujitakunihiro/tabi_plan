const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-6-luna";
const API_KEY = process.env.OPENAI_API_KEY || "";
const ROOT = __dirname;
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
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
              },
              required: ["time", "name", "kind", "duration", "emoji"],
            },
          },
        },
        required: ["summary", "events"],
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
  if (!isRealDate(input.startDate) || !isRealDate(input.endDate)) return "出発日と帰着日を正しく入力してください。";
  const start = Date.parse(`${input.startDate}T00:00:00Z`);
  const end = Date.parse(`${input.endDate}T00:00:00Z`);
  const days = Math.round((end - start) / 86400000) + 1;
  if (days < 1 || days > 21) return "旅行日数は1〜21日の範囲で設定してください。";
  if (!Object.hasOwn(paceNames, input.pace)) return "旅のペースを選び直してください。";
  if (!Array.isArray(input.interests) || input.interests.some((item) => !Object.hasOwn(interestNames, item))) return "興味の選択を確認してください。";
  return null;
}

async function readJSON(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 24 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
    "ゆったりは1日3件、ちょうどいいは1日4件、たっぷり満喫は1日5件を目安にしてください。食事や休憩、現実的な移動の余裕を含め、予定を詰め込みすぎないでください。",
    "興味に合う場所や体験を優先してください。よく知られた観光地は候補として提案できますが、実在を確信できない施設名、住所、営業時間、予約状況は作らないでください。確かな施設名がない場合は、地区や体験の種類を予定名にしてください。",
    "リアルタイムの天気、営業日、料金、交通、予約情報を確認したとは言わないでください。日本語で簡潔に書いてください。",
  ].join("\n");
  const userInput = { destination: trip.destination.trim(), startDate: trip.startDate, endDate: trip.endDate, days: dayCount, pace: paceNames[trip.pace], interests: interestText };

  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        instructions,
        input: JSON.stringify(userInput),
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
    for (const day of result.days) {
      if (!Array.isArray(day.events) || day.events.length < 1 || day.events.length > 8) throw new Error("invalid_event_count");
      for (const event of day.events) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.time) || !event.name.trim()) throw new Error("invalid_event");
      }
    }
    return sendJSON(res, 200, result);
  } catch (error) {
    console.error("OpenAI response could not be parsed:", error.message);
    return sendJSON(res, 502, { error: "旅程の形式を読み取れませんでした。もう一度生成してください。" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/status" && req.method === "GET") return sendJSON(res, 200, { configured: Boolean(API_KEY), model: MODEL });
  if (url.pathname === "/api/itinerary" && req.method === "POST") return createItinerary(req, res);
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

server.listen(PORT, "0.0.0.0", () => console.log(`tabi server listening on ${PORT} (${MODEL})`));

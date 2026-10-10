function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const lat = (b.lat - a.lat) * rad, lon = (b.lon - a.lon) * rad;
  const x = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(lon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(x)));
}

function normalizePlace(value) {
  const original = String(value || "").normalize("NFKC").trim();
  if (!original || /^(?:昼食|夕食|食事|休憩|自由時間|散策|観光|ランチ|バス|電車)$/.test(original)
    || /など$/.test(original)) return null;
  const query = original.replace(/(?:の)?(?:中心部|中心エリア|周辺|付近|近辺|近郊|エリア|市内)$/, "").trim();
  if (!query) return null;
  return { query, precision: query !== original || /[都道府県市区町村]$/.test(query) ? "area" : "place" };
}

function comparisonText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ja").replace(/[\s・、,()（）「」『』ー-]/g, "");
}

function selectLocation(results, query, context = null) {
  const needle = comparisonText(query);
  if (!needle || !Array.isArray(results)) return null;
  const candidates = results.flatMap((item) => {
    if (!item || item.lat === undefined || item.lon === undefined || item.lat === null || item.lon === null || item.lat === "" || item.lon === "") return [];
    const lat = Number(item.lat), lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
    const names = [item.name, item.display_name, ...Object.values(item.namedetails || {})].map(comparisonText);
    const matching = names.some((name) => name === needle || needle.length >= 3 && name.includes(needle)
      || ["市", "町", "村", "県", "都", "府"].some((suffix) => name === needle + suffix)
      || ["station", "halt"].includes(item.type) && /駅$/.test(needle) && name === needle.slice(0, -1));
    if (!matching) return [];
    const point = { lat, lon, label: item.display_name || item.name || query, countryCode: item.address?.country_code || "" };
    const distance = context ? distanceKm(context, point) : 0;
    if (context && (distance > context.radiusKm || context.countryCode && point.countryCode && context.countryCode !== point.countryCode)) return [];
    const exact = names.some((name) => name === needle);
    const areaScore = ["city", "town", "village", "municipality"].includes(item.addresstype) ? 50 : ["state", "country"].includes(item.addresstype) ? 20 : 0;
    return [{ ...point, score: (exact ? 100 : 0) + (!context ? areaScore : 0) - distance / 1000 }];
  });
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  const { score, ...point } = candidates[0];
  return point;
}

function searchBounds(anchor, radiusKm = 150) {
  const latitude = radiusKm / 111;
  const longitude = radiusKm / (111 * Math.max(0.1, Math.cos(anchor.lat * Math.PI / 180)));
  return [Math.max(-180, anchor.lon - longitude), Math.min(90, anchor.lat + latitude), Math.min(180, anchor.lon + longitude), Math.max(-90, anchor.lat - latitude)].join(",");
}

function isReasonableRoad(a, b, route, waypoints = []) {
  if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration) || route.distance < 0 || route.duration < 0) return false;
  if (waypoints.some((waypoint) => Number.isFinite(waypoint.distance) && waypoint.distance > 2000)) return false;
  const direct = distanceKm(a, b), km = route.distance / 1000;
  if (direct < 100 && km > Math.max(25, direct * 5 + 10)) return false;
  return true;
}

function createGeocoder({ userAgent, fetchImpl = fetch, intervalMs = 1100 } = {}) {
  const cache = new Map();
  let queue = Promise.resolve(), nextRequestAt = 0;
  async function lookup(query, context = null) {
    const key = JSON.stringify([query.toLocaleLowerCase("ja"), context && [context.lat, context.lon, context.countryCode, context.radiusKm]]);
    const work = queue.catch(() => {}).then(async () => {
      const existing = cache.get(key);
      if (existing?.expiresAt > Date.now()) return existing.point;
      const delay = Math.max(0, nextRequestAt - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      nextRequestAt = Date.now() + intervalMs;
      let point = null;
      try {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("q", query);
        url.searchParams.set("format", "jsonv2");
        url.searchParams.set("limit", "5");
        url.searchParams.set("addressdetails", "1");
        url.searchParams.set("namedetails", "1");
        if (context) {
          url.searchParams.set("viewbox", searchBounds(context, context.radiusKm));
          url.searchParams.set("bounded", "1");
          if (context.countryCode) url.searchParams.set("countrycodes", context.countryCode);
        }
        const response = await fetchImpl(url, { headers: { "User-Agent": userAgent, "Accept-Language": "ja" }, signal: AbortSignal.timeout(8000) });
        if (response.ok) point = selectLocation(await response.json(), query, context);
      } catch { /* Uncertain locations are left unresolved. */ }
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, { point, expiresAt: Date.now() + (point ? 6 * 3600000 : 10 * 60000) });
      return point;
    });
    queue = work;
    return work;
  }
  return async function geocode(place, destination, { unrestricted = false } = {}) {
    const normalized = normalizePlace(place);
    if (!normalized) return null;
    if (unrestricted) {
      const point = await lookup(normalized.query);
      return point && { ...point, precision: normalized.precision };
    }
    const region = normalizePlace(destination);
    if (!region) return null;
    const anchor = await lookup(region.query);
    if (!anchor) return null;
    if (comparisonText(normalized.query) === comparisonText(region.query)) return { ...anchor, precision: "area" };
    const point = await lookup(normalized.query, { ...anchor, radiusKm: 150 });
    return point && { ...point, precision: normalized.precision };
  };
}

module.exports = { distanceKm, normalizePlace, selectLocation, searchBounds, isReasonableRoad, createGeocoder };

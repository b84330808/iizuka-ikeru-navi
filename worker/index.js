const ALLOWED_AREAS = new Set([
  "頴田", "鯰田", "幸袋", "鎮西", "二瀬", "穂波", "筑穂",
  "飯塚東", "庄内", "菰田", "立岩", "飯塚・片島", "位置情報周辺"
]);
const ALLOWED_CATEGORIES = new Set(["hospital", "life", "city", "community"]);
const ALLOWED_OUTCOMES = new Set(["served", "reservation", "friction", "gap"]);
const ALLOWED_REASONS = new Set([
  "fixed_route", "on_demand_available", "registration_required", "booking_expired",
  "service_closed", "no_matching_service", "wagon_schedule", "unknown"
]);

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function withRequestOrigin(response, url) {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return response;
  const html = (await response.text()).replaceAll("__SITE_ORIGIN__", url.origin);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

async function createDemandEvent(request, env) {
  if (!env.DB) return json({ error: "demand store unavailable" }, 503);
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const event = {
    id: crypto.randomUUID(),
    originArea: cleanText(payload.originArea, 24),
    destinationName: cleanText(payload.destinationName, 80),
    category: cleanText(payload.category, 24),
    requestedDate: cleanText(payload.requestedDate, 10),
    hourBucket: Number(payload.hourBucket),
    outcome: cleanText(payload.outcome, 24),
    reason: cleanText(payload.reason, 40),
    journeyType: cleanText(payload.journeyType, 32) || "unknown"
  };

  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(event.requestedDate);
  if (!ALLOWED_AREAS.has(event.originArea) ||
      !event.destinationName ||
      !ALLOWED_CATEGORIES.has(event.category) ||
      !validDate ||
      !Number.isInteger(event.hourBucket) || event.hourBucket < 0 || event.hourBucket > 47 ||
      !ALLOWED_OUTCOMES.has(event.outcome) ||
      !ALLOWED_REASONS.has(event.reason)) {
    return json({ error: "invalid demand event" }, 400);
  }

  try {
    await env.DB.prepare(`
      INSERT INTO demand_events
        (id, origin_area, destination_name, category, requested_date, hour_bucket, outcome, reason, journey_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.id, event.originArea, event.destinationName, event.category,
      event.requestedDate, event.hourBucket, event.outcome, event.reason, event.journeyType
    ).run();
    return json({ ok: true, id: event.id }, 201);
  } catch (error) {
    console.error("demand insert failed", error);
    return json({ error: "demand event could not be saved" }, 500);
  }
}

async function listDemandEvents(url, env) {
  if (!env.DB) return json({ events: [], persistence: false });
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 300));
  try {
    const result = await env.DB.prepare(`
      SELECT id, created_at, origin_area, destination_name, category,
             requested_date, hour_bucket, outcome, reason, journey_type
      FROM demand_events
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(limit).all();
    return json({ events: result.results || [], persistence: true });
  } catch (error) {
    console.error("demand query failed", error);
    return json({ events: [], persistence: false, error: "demand events unavailable" }, 503);
  }
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/demand-events") {
      if (request.method === "POST") return createDemandEvent(request, env);
      if (request.method === "GET") return listDemandEvents(url, env);
      return json({ error: "method not allowed" }, 405);
    }
    if (url.pathname === "/api/health") {
      return json({ ok: true, demandStore: Boolean(env.DB) });
    }

    if (url.pathname === "/") url.pathname = "/index.html";
    const response = await env.ASSETS.fetch(new Request(url, request));
    if (response.status !== 404) return withRequestOrigin(response, url);
    if (!url.pathname.includes(".")) {
      url.pathname = url.pathname.replace(/\/$/, "") + ".html";
      return withRequestOrigin(await env.ASSETS.fetch(new Request(url, request)), url);
    }
    return response;
  }
};

export default worker;

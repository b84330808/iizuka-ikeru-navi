import { readFileSync } from "node:fs";
import worker from "../worker/index.js";

const html = readFileSync(new URL("../app/dashboard.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../app/dashboard.js", import.meta.url), "utf8");
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
const usedIds = new Set([...js.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map((match) => match[1]));
const missingIds = [...usedIds].filter((id) => !ids.has(id));
if (missingIds.length) throw new Error(`Missing dashboard ids: ${missingIds.join(", ")}`);

const rows = [];
const DB = {
  prepare() {
    return {
      bind(...args) {
        return {
          async run() {
            rows.push({
              id: args[0], created_at: new Date().toISOString(), origin_area: args[1],
              destination_name: args[2], category: args[3], requested_date: args[4],
              hour_bucket: args[5], outcome: args[6], reason: args[7], journey_type: args[8]
            });
          },
          async all() { return { results: rows }; }
        };
      }
    };
  }
};
const ASSETS = { fetch: async () => new Response("missing", { status: 404 }) };
const payload = {
  originArea: "菰田", destinationName: "飯塚記念病院", category: "hospital",
  requestedDate: "2026-07-23", hourBucket: 20, outcome: "gap",
  reason: "wagon_schedule", journeyType: "wagon"
};
const post = await worker.fetch(new Request("https://example.test/api/demand-events", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
}), { DB, ASSETS });
if (post.status !== 201) throw new Error(`Demand API POST failed: ${post.status} ${await post.text()}`);
const get = await worker.fetch(new Request("https://example.test/api/demand-events"), { DB, ASSETS });
const data = await get.json();
if (data.events.length !== 1) throw new Error("Demand API GET did not return the inserted event");

const htmlAssets = {
  fetch: async () => new Response('<meta property="og:image" content="__SITE_ORIGIN__/og.png">', {
    headers: { "content-type": "text/html; charset=utf-8" }
  })
};
const page = await worker.fetch(new Request("https://mobility.example/index.html"), { DB, ASSETS: htmlAssets });
if (!(await page.text()).includes("https://mobility.example/og.png")) {
  throw new Error("HTML social metadata did not receive the request origin");
}

console.log(`PASS dashboard DOM contract (${usedIds.size} ids)`);
console.log("PASS demand API POST/GET contract");
console.log("PASS request-origin social metadata contract");

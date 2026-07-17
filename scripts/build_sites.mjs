import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const client = resolve(dist, "client");
const server = resolve(dist, "server");

await rm(dist, { recursive: true, force: true });
await mkdir(client, { recursive: true });
await mkdir(server, { recursive: true });
await cp(resolve(root, "app"), client, { recursive: true });

const worker = `const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") url.pathname = "/index.html";
    const response = await env.ASSETS.fetch(new Request(url, request));
    if (response.status !== 404) return response;
    if (!url.pathname.includes(".")) {
      url.pathname = url.pathname.replace(/\\/$/, "") + ".html";
      return env.ASSETS.fetch(new Request(url, request));
    }
    return response;
  }
};

export default worker;
`;

await writeFile(resolve(server, "index.js"), worker, "utf8");
console.log("Built IIZUKA LIFE TWIN for Sites.");

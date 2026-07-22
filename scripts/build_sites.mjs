import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const client = resolve(dist, "client");
const server = resolve(dist, "server");

await rm(dist, { recursive: true, force: true });
await mkdir(client, { recursive: true });
await mkdir(server, { recursive: true });
await cp(resolve(root, "app"), client, { recursive: true });
await cp(resolve(root, "worker", "index.js"), resolve(server, "index.js"));
console.log("Built IIZUKA LIFE TWIN for Sites.");

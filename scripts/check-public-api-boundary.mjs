import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["TypeScript", "WeirgateKit"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".swift", ".json"]);
const ignored = new Set(["node_modules", "dist", ".build"]);
const forbidden = [
  [/(?:^|[/'\"])(?:src\/)?request-plane(?:[/'\"]|$)/i, "server request-plane import"],
  [/(?:^|[/'\"])(?:src\/)?management-plane(?:[/'\"]|$)/i, "server management-plane import"],
  [/(?:^|[/'\"])(?:src\/)?money-plane(?:[/'\"]|$)/i, "server money-plane import"],
  [/(?:^|[/'\"])(?:src\/)?db(?:[/'\"]|$)/i, "server database import"],
  [/@neondatabase|\bpostgres(?:ql)?\b|\bneon[_-](?:serverless|connection)\b/i, "database dependency"],
  [/NEON_CONNECTION_STRING|DATABASE_URL/i, "database credential access"],
];

const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if (sourceExtensions.has(extname(entry.name))) files.push(child);
  }
}

for (const root of roots) await walk(root);

const violations = [];
for (const file of files) {
  const contents = await readFile(file, "utf8");
  for (const [pattern, label] of forbidden) {
    if (pattern.test(contents)) violations.push(`${file}: ${label}`);
  }
}

if (violations.length) {
  console.error(`Public API boundary violations:\n${violations.join("\n")}`);
  process.exit(1);
}
console.log(`Public API boundary passed (${files.length} files; no internal imports or DB access).`);

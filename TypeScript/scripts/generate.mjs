import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputFlag = process.argv.indexOf("--input");
const input = resolve(inputFlag >= 0 ? process.argv[inputFlag + 1] : "../../weirgate/openapi.yaml");
const yaml = readFileSync(input, "utf8");
const version = yaml.match(/const:\s*['\"]?(\d{4}-\d{2}-\d{2})/)?.[1];
if (!version) throw new Error("Could not read Weirgate API version from the source spec");

execFileSync(resolve(packageRoot, "node_modules/.bin/openapi-typescript"), [
  input,
  "--output",
  resolve(packageRoot, "src/generated/schema.ts"),
], { stdio: "inherit" });

const sourceCommit = execFileSync("git", ["-C", dirname(input), "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
writeFileSync(resolve(packageRoot, "spec-provenance.json"), `${JSON.stringify({
  api_version: version,
  source_repository: "https://github.com/weirgate/weirgate",
  source_path: "openapi.yaml",
  source_commit: sourceCommit,
  generator: "openapi-typescript",
}, null, 2)}\n`);

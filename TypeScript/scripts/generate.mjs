import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputFlag = process.argv.indexOf("--input");
const input = resolve(inputFlag >= 0 ? process.argv[inputFlag + 1] : "../../weirgate-platform/openapi.yaml");
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
const provenance = {
  api_version: version,
  source_repository: "https://github.com/weirgate/weirgate-platform",
  source_path: "openapi.yaml",
  source_commit: sourceCommit,
};
writeFileSync(resolve(packageRoot, "spec-provenance.json"), `${JSON.stringify({
  ...provenance,
  generator: "openapi-typescript",
}, null, 2)}\n`);

// WeirgateKit records the same provenance, in its bundled resource and in WeirgateKitInfo,
// so the two SDKs cannot drift apart.
const kitRoot = resolve(packageRoot, "../WeirgateKit/Sources/WeirgateKit");
writeFileSync(resolve(kitRoot, "Resources/spec-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
const kitInfoPath = resolve(kitRoot, "WeirgateKit.swift");
let kitInfo = readFileSync(kitInfoPath, "utf8");
for (const [name, value] of [["apiVersion", version], ["specSourceCommit", sourceCommit]]) {
  const pattern = new RegExp(`(public static let ${name} = )"[^"]*"`);
  if (!pattern.test(kitInfo)) throw new Error(`Could not find WeirgateKitInfo.${name} in ${kitInfoPath}`);
  kitInfo = kitInfo.replace(pattern, `$1"${value}"`);
}
writeFileSync(kitInfoPath, kitInfo);

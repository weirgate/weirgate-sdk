// Both SDKs must name the same spec source, and WeirgateKitInfo must match WeirgateKit's
// bundled provenance. TypeScript/scripts/generate.mjs writes all three.
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const typescript = JSON.parse(read("TypeScript/spec-provenance.json"));
const kit = JSON.parse(read("WeirgateKit/Sources/WeirgateKit/Resources/spec-provenance.json"));
const kitInfo = read("WeirgateKit/Sources/WeirgateKit/WeirgateKit.swift");
const kitConstant = (name) => kitInfo.match(new RegExp(`public static let ${name} = "([^"]*)"`))?.[1];

const problems = [];
for (const field of ["api_version", "source_repository", "source_path"]) {
  if (kit[field] !== typescript[field]) {
    problems.push(`${field}: TypeScript has ${typescript[field]}, WeirgateKit has ${kit[field]}`);
  }
}
if (kitConstant("apiVersion") !== kit.api_version) {
  problems.push(`WeirgateKitInfo.apiVersion is ${kitConstant("apiVersion")}, provenance has ${kit.api_version}`);
}
if (kitConstant("specSourceCommit") !== kit.source_commit) {
  problems.push(`WeirgateKitInfo.specSourceCommit is ${kitConstant("specSourceCommit")}, provenance has ${kit.source_commit}`);
}

if (problems.length) {
  console.error(`Spec provenance drift:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("Spec provenance agrees across both SDKs.");

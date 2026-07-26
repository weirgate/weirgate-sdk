import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const typescript = join(repository, "TypeScript");
const temporary = await mkdtemp(join(tmpdir(), "weirgate-sdk-proof-"));
const usePublishedArtifacts = process.argv.includes("--published");

try {
  await proveTypeScript();
  await proveSwift();
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function proveTypeScript() {
  const consumer = join(temporary, "typescript");
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "weirgate-sdk-consumer-proof",
    private: true,
    type: "module",
  }, null, 2));

  let dependency = "@weirgate/sdk@0.1.0";
  if (!usePublishedArtifacts) {
    run("npm", ["run", "build"], typescript);
    const packed = run("npm", ["pack", "--ignore-scripts", "--pack-destination", consumer, "--json"], typescript);
    const packResult = JSON.parse(packed).at(0);
    if (!packResult?.filename) throw new Error("npm pack did not return a tarball filename");
    dependency = join(consumer, packResult.filename);
  }
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", dependency], consumer);

  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      outDir: "dist",
    },
    include: ["health.ts"],
  }, null, 2));
  await writeFile(join(consumer, "health.ts"), `import { Weirgate } from "@weirgate/sdk";

const result = await new Weirgate().health();
if (!result.data.ok) throw new Error("production health was not OK");
if (result.apiVersion !== "2026-07-18") throw new Error(\`unexpected API version \${result.apiVersion}\`);
console.log(JSON.stringify({
  package: "@weirgate/sdk",
  api_version: result.apiVersion,
  request_id: result.requestId,
  status: result.status,
}));
`);
  run(join(typescript, "node_modules/.bin/tsc"), ["--project", "tsconfig.json"], consumer);
  const proof = run("node", ["dist/health.js"], consumer);
  console.log(`TypeScript clean-consumer proof: ${proof.trim()}`);
}

async function proveSwift() {
  const consumer = join(temporary, "swift");
  await mkdir(join(consumer, "Sources/Proof"), { recursive: true });
  const dependency = usePublishedArtifacts
    ? `.package(url: "https://github.com/weirgate/weirgate-sdk.git", exact: "0.1.0")`
    : `.package(path: ${JSON.stringify(repository)})`;
  await writeFile(join(consumer, "Package.swift"), `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WeirgateSDKConsumerProof",
    platforms: [.macOS(.v14)],
    dependencies: [${dependency}],
    targets: [
        .executableTarget(
            name: "Proof",
            dependencies: [.product(name: "WeirgateKit", package: "weirgate-sdk")]
        )
    ]
)
`);
  await writeFile(join(consumer, "Sources/Proof/main.swift"), `import WeirgateKit

@main
struct Proof {
    static func main() async throws {
        let client = WeirgateClient(configuration: .init(appID: "clean-consumer-proof"))
        let result = try await client.health()
        guard result.value.ok, result.metadata.apiVersion == "2026-07-18" else {
            fatalError("unexpected production health response")
        }
        print("Swift clean-consumer proof: api_version=\\(result.metadata.apiVersion) request_id=\\(result.metadata.requestID) status=\\(result.metadata.statusCode)")
    }
}
`);
  const proof = run("swift", ["run", "Proof"], consumer);
  const line = proof.split("\n").find((value) => value.startsWith("Swift clean-consumer proof:"));
  if (!line) throw new Error(`Swift proof output missing: ${proof}`);
  console.log(line);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

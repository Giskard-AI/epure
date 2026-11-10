import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const actionTargets = [
  {
    entryPoint: resolve(rootDir, "actions/epure-contract/index.ts"),
    outFile: resolve(rootDir, "dist/actions/epure-contract/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/authorize-command/index.ts"),
    outFile: resolve(rootDir, "dist/actions/authorize-command/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/verify-app-role/index.ts"),
    outFile: resolve(rootDir, "dist/actions/verify-app-role/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/publish-agent-output/index.ts"),
    outFile: resolve(rootDir, "dist/actions/publish-agent-output/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/run-sandboxed/index.ts"),
    outFile: resolve(rootDir, "dist/actions/run-sandboxed/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/audit-ifixai/index.ts"),
    outFile: resolve(rootDir, "dist/actions/audit-ifixai/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/check-impeccable/index.ts"),
    outFile: resolve(rootDir, "dist/actions/check-impeccable/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "actions/orchestrate-issue/index.ts"),
    outFile: resolve(rootDir, "dist/actions/orchestrate-issue/index.mjs")
  },
  {
    entryPoint: resolve(rootDir, "src/bootstrap/cli.ts"),
    outFile: resolve(rootDir, "dist/cli/setup-repo.mjs")
  }
];

for (const target of actionTargets) {
  mkdirSync(dirname(target.outFile), { recursive: true });
  await build({
    entryPoints: [target.entryPoint],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outfile: target.outFile,
    minify: false,
    legalComments: "inline"
  });
}

// Pi ships a self-contained bundle: copied as published, never re-bundled.
const piPackageDir = resolve(rootDir, "node_modules/@earendil-works/pi-coding-agent");
const piVendorDir = resolve(rootDir, "dist/vendor/pi");
const piPackage = JSON.parse(readFileSync(resolve(piPackageDir, "package.json"), "utf8"));
rmSync(piVendorDir, { recursive: true, force: true });
cpSync(resolve(piPackageDir, "dist/bundle"), piVendorDir, { recursive: true });
// Pi reads its name and config dir from the nearest package.json, which must not be EPURE's.
writeFileSync(
  resolve(piVendorDir, "package.json"),
  `${JSON.stringify(
    {
      name: piPackage.name,
      version: piPackage.version,
      license: piPackage.license,
      type: piPackage.type,
      piConfig: piPackage.piConfig
    },
    null,
    2
  )}\n`
);
for (const vendoredPackage of ["pi-mcp", "pi-schema"]) {
  cpSync(
    resolve(rootDir, "node_modules/@earendil-works", vendoredPackage, "LICENSES"),
    resolve(piVendorDir, "LICENSES", vendoredPackage),
    { recursive: true }
  );
}
writeFileSync(resolve(piVendorDir, "THIRD_PARTY_LICENSES"), piThirdPartyLicenses());

// Platform-specific packages (lockfile `os`/`cpu`) are native binaries outside the JS bundle; skipping
// them keeps the output identical on every build host.
function piThirdPartyLicenses() {
  const lockPackages = JSON.parse(readFileSync(resolve(rootDir, "package-lock.json"), "utf8")).packages;
  const resolveDependency = (fromPath, name) => {
    let base = fromPath;
    for (;;) {
      if (lockPackages[`${base}/node_modules/${name}`]) return `${base}/node_modules/${name}`;
      const parent = base.lastIndexOf("/node_modules/");
      if (parent === -1) return lockPackages[`node_modules/${name}`] ? `node_modules/${name}` : undefined;
      base = base.slice(0, parent);
    }
  };

  const closure = new Set();
  const pending = ["node_modules/@earendil-works/pi-coding-agent"];
  while (pending.length > 0) {
    const lockPath = pending.pop();
    if (closure.has(lockPath)) continue;
    const entry = lockPackages[lockPath];
    if (entry.os || entry.cpu) continue;
    closure.add(lockPath);
    const names = Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies
    });
    for (const name of names) {
      const dependencyPath = resolveDependency(lockPath, name);
      if (dependencyPath) pending.push(dependencyPath);
    }
  }

  const packages = [...closure]
    .map((lockPath) => {
      const name = lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length);
      const entry = lockPackages[lockPath];
      const packageDir = resolve(rootDir, lockPath);
      const texts = readdirSync(packageDir, { withFileTypes: true })
        .filter((dirent) => dirent.isFile() && /^(licen[cs]e|notice|copying)/i.test(dirent.name))
        .map((dirent) => dirent.name)
        .sort()
        .map((file) => readFileSync(resolve(packageDir, file), "utf8").trim());
      return { id: `${name}@${entry.version}`, license: entry.license ?? "UNKNOWN", text: texts.join("\n\n") };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const byText = new Map();
  for (const pkg of packages) {
    const group = byText.get(pkg.text) ?? [];
    group.push(pkg);
    byText.set(pkg.text, group);
  }
  const rule = "=".repeat(80);
  const sections = [...byText.entries()].map(([text, group]) =>
    [
      rule,
      ...group.map((pkg) => `${pkg.id} (${pkg.license})`),
      "-".repeat(80),
      text || "No license file is shipped in these packages; the license field above applies.",
      ""
    ].join("\n")
  );
  return [
    `Third-party software in dist/vendor/pi (${piPackage.name} ${piPackage.version} and its dependency closure).`,
    "Generated by scripts/build-actions.mjs from package-lock.json; do not edit.",
    "",
    ...sections
  ].join("\n");
}

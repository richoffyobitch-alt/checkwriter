/*
 * Places the correct better-sqlite3 binary for a target platform.
 *
 * better-sqlite3 contains compiled C++. The copy npm installs is built for
 * the machine doing the installing — here, Linux — but the shipped artifact
 * has to run on Windows or macOS under Electron's ABI, not Node's.
 *
 * Cross-compiling would mean a full MSVC or Xcode toolchain. There is no
 * need: the project publishes prebuilt binaries for every supported Electron
 * ABI, platform and architecture, so this fetches the right one and drops it
 * where require() will find it.
 *
 * Only one binary can sit in node_modules at a time, so a build targeting
 * two architectures runs this once per architecture and packages in between.
 * scripts/build-mac.mjs does that, and the afterPack hook re-checks the
 * binary actually inside each produced bundle — a mismatch here would
 * otherwise surface only as a crash on the user's machine.
 *
 * Usage: node scripts/fetch-native.mjs <platform> <arch>
 *   e.g. node scripts/fetch-native.mjs win32 x64
 *        node scripts/fetch-native.mjs darwin arm64
 */

import { createWriteStream } from "node:fs";
import { mkdir, rm, readFile, copyFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const platform = process.argv[2];
const arch = process.argv[3] || "x64";
if (!platform) {
  console.error("usage: node scripts/fetch-native.mjs <platform> <arch>");
  process.exit(1);
}
if (!["win32", "darwin", "linux"].includes(platform)) {
  console.error(`unsupported platform: ${platform}`);
  process.exit(1);
}
if (!["x64", "arm64"].includes(arch)) {
  console.error(`unsupported arch: ${arch}`);
  process.exit(1);
}

const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const sqliteVersion = pkg.dependencies["better-sqlite3"].replace(/^[\^~]/, "");
const electronVersion = pkg.devDependencies.electron.replace(/^[\^~]/, "");

const { getAbi } = await import("node-abi");
const abi = getAbi(electronVersion, "electron");

const asset = `better-sqlite3-v${sqliteVersion}-electron-v${abi}-${platform}-${arch}.tar.gz`;
const url =
  `https://github.com/WiseLibs/better-sqlite3/releases/download/` +
  `v${sqliteVersion}/${asset}`;

const workDir = path.join(ROOT, ".native-cache", `${platform}-${arch}`);
const tarball = path.join(workDir, asset);
const target = path.join(
  ROOT,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);

console.log(`better-sqlite3 ${sqliteVersion}`);
console.log(`electron       ${electronVersion} (ABI ${abi})`);
console.log(`target         ${platform}-${arch}`);

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });

console.log(`fetching       ${asset}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(
    `\nNo prebuilt binary published at:\n  ${url}\n\n` +
      `HTTP ${res.status}. Electron ${electronVersion} (ABI ${abi}) may be ` +
      `newer than the newest release better-sqlite3 ${sqliteVersion} ` +
      `supports. Pin Electron to a version with a published ABI.`,
  );
  process.exit(1);
}
await pipeline(res.body, createWriteStream(tarball));

await run("tar", ["-xzf", tarball, "-C", workDir]);

/* Archive layout is build/Release/better_sqlite3.node */
const extracted = path.join(workDir, "build", "Release", "better_sqlite3.node");
await stat(extracted);
await copyFile(extracted, target);

const { size } = await stat(target);
console.log(`installed      ${target} (${(size / 1024 / 1024).toFixed(1)} MB)`);

/* Confirm the binary really is for the requested platform AND architecture
   rather than the host's. A silently wrong binary produces an installer that
   fails only on the user's machine, which is the worst place to find out —
   and on macOS an arm64/x64 mix-up is particularly easy to make, because
   both are Mach-O and both are current shipping architectures.

   The header is parsed directly rather than shelling out to file(1), which
   does not exist on a Windows build runner. A check that silently does
   nothing on one platform is worse than no check at all. */
const { assertTarget } = createRequire(import.meta.url)("./binary-target.cjs");

const found = assertTarget(
  target,
  platform,
  arch,
  `The prebuilt binary downloaded from ${url} is not what it claims to be.`,
);
console.log(`verified       ${found.description}`);

/*
 * Places the correct better-sqlite3 binary for a target platform.
 *
 * better-sqlite3 contains compiled C++. The copy npm installs is built for
 * the machine doing the installing — here, Linux — but the shipped artifact
 * has to run on Windows under Electron's ABI, not Node's.
 *
 * Compiling a Windows binary on Linux would mean a full MSVC cross-toolchain.
 * There is no need: the project publishes prebuilt binaries for every
 * supported Electron ABI and platform, so this fetches the right one and
 * drops it where require() will find it.
 *
 * Usage: node scripts/fetch-native.mjs <platform> <arch>
 *   e.g. node scripts/fetch-native.mjs win32 x64
 */

import { createWriteStream } from "node:fs";
import { mkdir, rm, readFile, copyFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const platform = process.argv[2];
const arch = process.argv[3] || "x64";
if (!platform) {
  console.error("usage: node scripts/fetch-native.mjs <platform> <arch>");
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

/* Confirm the binary really is for the requested platform rather than the
   host's. A silently wrong architecture here produces an installer that
   fails only on the user's machine, which is the worst place to find out. */
const { stdout } = await run("file", ["-b", target]).catch(() => ({ stdout: "" }));
if (stdout) {
  console.log(`verified       ${stdout.trim()}`);
  const expectWindows = platform === "win32";
  const looksWindows = /PE32\+?|MS Windows/i.test(stdout);
  if (expectWindows !== looksWindows) {
    console.error(
      `\nBinary does not match the requested platform.\n` +
        `Expected ${platform}, but file(1) reports: ${stdout.trim()}`,
    );
    process.exit(1);
  }
}

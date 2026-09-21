/*
 * Builds the macOS application for both current architectures.
 *
 * This exists because of one constraint that cannot be configured away:
 * better-sqlite3 is a compiled binary, npmRebuild is off, and exactly one
 * copy of that binary can sit in node_modules at a time. Asking
 * electron-builder for `--mac --arm64 --x64` in a single invocation would
 * therefore stamp the same binary into both bundles, and one of the two
 * would be an application that installs, launches, and then dies the
 * instant it opens the check register.
 *
 * So each architecture is a separate cycle: place the right binary, package,
 * verify (scripts/after-pack.cjs inspects what actually landed inside the
 * bundle), move on.
 *
 * The second consequence is latest-mac.yml, the file electron-updater reads
 * to discover new versions. Each invocation overwrites it with only its own
 * architecture, so the two are merged at the end. Without that merge, half
 * the Macs in the world would never see an update — and would never be told
 * why.
 *
 * Usage: node scripts/build-mac.mjs [--publish never|always]
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RELEASE = path.join(ROOT, "release");
const FEED = path.join(RELEASE, "latest-mac.yml");

const ARCHES = ["arm64", "x64"];

const publishIndex = process.argv.indexOf("--publish");
const publish = publishIndex === -1 ? "never" : process.argv[publishIndex + 1];

/* A .dmg is made with hdiutil, which exists only on macOS, and code signing
   needs the macOS security framework. Both are simply unavailable on a Linux
   or Windows build host — so rather than failing half-way through, this
   narrows the target list to zip and says plainly that the result is a
   smoke test, not a release. The real artifacts come off a macOS runner. */
const onMac = process.platform === "darwin";
const targets = onMac ? [] : ["zip"];

function heading(text) {
  console.log(`\n${"─".repeat(64)}\n${text}\n${"─".repeat(64)}`);
}

/* Output is streamed rather than buffered: an electron-builder run is long
   enough that silence looks like a hang, and its failures are usually
   explained somewhere in the middle of the log. */
function exec(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `${label} failed (${signal ? `signal ${signal}` : `exit code ${code}`})`,
        ),
      );
    });
  });
}

/**
 * Merge per-architecture update feeds.
 *
 * electron-updater picks an entry out of `files` by matching the running
 * architecture against the filename, falling back to `path`. So the merged
 * feed must list every architecture's zip, and `path` should point at the
 * one most Macs need — Apple Silicon — so that an old client with no
 * architecture matching still lands somewhere sensible.
 */
function mergeFeeds(feeds) {
  const base = feeds[feeds.length - 1].doc;
  const byUrl = new Map();
  for (const { doc } of feeds) {
    for (const file of doc.files ?? []) byUrl.set(file.url, file);
  }
  const files = [...byUrl.values()].sort((a, b) => {
    /* arm64 first, so it is the natural default. */
    const rank = (u) => (u.includes("arm64") ? 0 : 1);
    return rank(a.url) - rank(b.url) || a.url.localeCompare(b.url);
  });

  const primary = files[0];
  return {
    ...base,
    files,
    path: primary.url,
    sha512: primary.sha512,
  };
}

if (!onMac) {
  console.warn(
    `\n!  Building on ${process.platform}, not macOS.\n` +
      "!  No .dmg and no code signature can be produced here: hdiutil and\n" +
      "!  the signing tools are macOS-only. This run yields unsigned .zip\n" +
      "!  bundles, useful for checking the packaging and nothing else.\n" +
      "!  Release builds must come from a macOS host — see\n" +
      "!  .github/workflows/release-mac.yml.\n",
  );
}

if (!onMac && publish !== "never") {
  throw new Error(
    "Refusing to publish a non-macOS build of the macOS application.\n" +
      "The artifacts would be unsigned, incomplete (no .dmg) and would " +
      "overwrite a good release feed.",
  );
}

heading("Recording build metadata");
await exec("node", [path.join("scripts", "write-build-info.mjs")], "build-info");

/* A stale feed from a previous run would be merged into this one and could
   advertise an artifact that no longer exists. */
await rm(FEED, { force: true });

const collected = [];

for (const arch of ARCHES) {
  heading(`macOS ${arch}: placing native database binary`);
  await exec(
    "node",
    [path.join("scripts", "fetch-native.mjs"), "darwin", arch],
    `fetch-native darwin ${arch}`,
  );

  heading(`macOS ${arch}: packaging`);
  await exec(
    path.join(ROOT, "node_modules", ".bin", "electron-builder"),
    ["--mac", ...targets, `--${arch}`, "--publish", publish],
    `electron-builder --mac --${arch}`,
  );

  if (!existsSync(FEED)) {
    throw new Error(
      `electron-builder produced no latest-mac.yml for ${arch}.\n` +
        "Automatic updates depend on it, and the zip target is what " +
        "generates it — check that mac.target still includes zip.",
    );
  }
  collected.push({ arch, doc: yaml.load(await readFile(FEED, "utf8")) });
  await rm(FEED, { force: true });
}

heading("Merging update feed");
const merged = mergeFeeds(collected);
await writeFile(FEED, yaml.dump(merged, { lineWidth: -1 }));

for (const file of merged.files) {
  console.log(`  ${file.url}`);
}
console.log(`\nwrote ${FEED}`);
console.log(`\nArtifacts in ${RELEASE}`);

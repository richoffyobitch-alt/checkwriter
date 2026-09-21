/*
 * Records facts about a build that the running application needs to know
 * about itself and cannot work out at runtime.
 *
 * Right now that is one fact: whether the macOS bundle carries an Apple
 * Developer ID signature. The updater has to know, because Squirrel.Mac
 * refuses to replace an unsigned application, and an app that keeps
 * downloading updates it can never install is worse than one that admits it
 * needs a manual download.
 *
 * Signing state is inferred from the environment electron-builder itself
 * reads, so the flag cannot drift from reality: if no certificate was
 * provided to the build, nothing here can claim there was one.
 *
 * Usage: node scripts/write-build-info.mjs
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/* electron-builder signs a macOS build when it is given a certificate, by
   any of these routes. CSC_IDENTITY_AUTO_DISCOVERY=false disables signing
   outright regardless of the rest. */
const autoDiscoveryOff =
  String(process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "").toLowerCase() ===
  "false";
const hasCertificate = Boolean(
  process.env.CSC_LINK ||
    process.env.CSC_NAME ||
    process.env.CSC_KEY_PASSWORD ||
    process.env.MAC_CSC_LINK,
);
const macSigned = hasCertificate && !autoDiscoveryOff;

async function gitCommit() {
  try {
    const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));

const info = {
  version: pkg.version,
  builtAt: new Date().toISOString(),
  commit: await gitCommit(),
  /* Read by updater.cjs. A missing or false value means notify-only
     updates on macOS. */
  macSigned,
  /* Notarization is separate from signing and is what clears Gatekeeper on
     first launch. Recorded for the installation notes, not used in code. */
  macNotarized: Boolean(
    process.env.APPLE_ID || process.env.APPLE_API_KEY || process.env.APPLE_TEAM_ID,
  ),
};

await mkdir(path.join(ROOT, "build"), { recursive: true });
await writeFile(
  path.join(ROOT, "build", "build-info.json"),
  JSON.stringify(info, null, 2) + "\n",
);

console.log(
  `build-info    v${info.version} ${info.commit ?? "(no git)"}  ` +
    `macSigned=${info.macSigned} macNotarized=${info.macNotarized}`,
);

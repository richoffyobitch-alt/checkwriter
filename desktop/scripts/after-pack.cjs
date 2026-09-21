"use strict";

/**
 * Packaging guard.
 *
 * better-sqlite3 is a compiled binary and npmRebuild is off, so whatever
 * scripts/fetch-native.mjs last placed in node_modules is what gets packaged.
 * That is fine when the build is driven correctly and catastrophic when it is
 * not: an arm64 binary inside an Intel bundle produces an application that
 * installs cleanly, launches, and then dies the moment it opens the check
 * register. On macOS the mistake is easy to make, because arm64 and x64 are
 * both current and both Mach-O.
 *
 * So rather than trusting the build order, this inspects the binary that is
 * actually inside the bundle and fails the build if it is wrong.
 */

const path = require("node:path");
const fs = require("node:fs");
const { assertTarget } = require("./binary-target.cjs");

/** electron-builder's Arch enum, which arrives as a number. */
const ARCH_NAMES = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // darwin | win32 | linux
  const arch = ARCH_NAMES[context.arch] ?? String(context.arch);
  const out = context.appOutDir;

  const resources =
    platform === "darwin"
      ? path.join(out, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(out, "resources");

  const nativeModule = path.join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );

  if (!fs.existsSync(nativeModule)) {
    throw new Error(
      `afterPack: the database module is missing from the ${platform}-${arch} ` +
        `bundle.\nExpected it at:\n  ${nativeModule}\n\n` +
        "Without it the application cannot open its database. Check the " +
        "asarUnpack and files globs in electron-builder.yml.",
    );
  }

  const found = assertTarget(
    nativeModule,
    platform,
    arch,
    "afterPack: the packaged database module does not match the target.\n" +
      `Run  node scripts/fetch-native.mjs ${platform} ${arch}  before ` +
      "packaging this architecture. Two architectures cannot be built in " +
      "one electron-builder invocation, because only one binary exists in " +
      "node_modules at a time — use scripts/build-mac.mjs.",
  );

  console.log(
    `  • verified native module  ${platform}-${arch}  (${found.description})`,
  );
};

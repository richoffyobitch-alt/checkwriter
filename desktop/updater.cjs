"use strict";

/**
 * Automatic updates, via electron-updater against the GitHub releases feed.
 *
 * Two deliberate choices about how intrusive this is allowed to be.
 *
 * Updates download in the background but are never installed underneath the
 * user. Installing means restarting the application, and this application is
 * used to write cheques: restarting it unannounced could land in the middle
 * of a print run or a half-finished cheque. So a downloaded update waits,
 * and the user picks the moment — either straight away or on next quit.
 *
 * Automatic checks also fail silently. A laptop with no connection is the
 * normal case, not an error worth a dialog. Only a check the user explicitly
 * asked for reports back when nothing is found or something goes wrong.
 *
 * And on macOS there is a hard platform constraint. Squirrel.Mac refuses to
 * apply an update to an application that is not code-signed — it validates
 * the running bundle's signature before swapping it, and an unsigned build
 * fails with "Could not get code signature for running application". There
 * is no flag that turns that off, and there should not be: it is the only
 * thing standing between an update feed and arbitrary code execution.
 *
 * So an unsigned Mac build downgrades to notify-only. It still checks, and
 * it still tells the user a new version exists, but it sends them to the
 * releases page instead of downloading an update it could never install.
 * Pretending otherwise would mean a silent failure loop and a user who
 * believes they are up to date when they are not. The moment the build is
 * signed with a Developer ID, build-info.json says so and full automatic
 * updates switch on with no code change.
 */

const { app, dialog, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const fs = require("node:fs");

const RELEASES_URL =
  "https://github.com/richoffyobitch-alt/checkwriter/releases/latest";

/**
 * Written by the build scripts. Absent in development and in any build made
 * before this file existed, so every read has to tolerate that.
 */
function readBuildInfo() {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, "build", "build-info.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * True when this build cannot install its own updates and must instead point
 * the user at the download page.
 *
 * Defaulting to notify-only when build-info.json is missing is deliberate:
 * an unknown signing state on macOS is far more likely to be unsigned, and
 * being wrong in that direction costs one extra click, while being wrong the
 * other way costs a download that always fails.
 */
function isNotifyOnly() {
  if (process.platform !== "darwin") return false;
  return readBuildInfo().macSigned !== true;
}

/** Re-check roughly twice a day while the app stays open. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Let the window settle before spending bandwidth on an update check. */
const FIRST_CHECK_DELAY_MS = 12 * 1000;

let getWindow = () => null;
/** True while a check the user explicitly requested is in flight. */
let userRequested = false;
/** Guards against stacking dialogs if several events land together. */
let promptOpen = false;
let timer = null;

function log(...args) {
  console.log("[updater]", ...args);
}

function windowOrUndefined() {
  const w = getWindow();
  return w && !w.isDestroyed() ? w : undefined;
}

/**
 * Offer the update once it is on disk. Installing quits and relaunches, so
 * this always asks first, and the default button is the non-disruptive one.
 */
async function offerInstall(info) {
  if (promptOpen) return;
  promptOpen = true;
  try {
    const { response } = await dialog.showMessageBox(windowOrUndefined(), {
      type: "info",
      buttons: ["Install on next quit", "Restart and install now", "Release notes"],
      defaultId: 0,
      cancelId: 0,
      title: "Update ready",
      message: `CheckWriter ${info.version} is ready to install.`,
      detail:
        "Installing restarts CheckWriter. If you are part-way through a " +
        "cheque or a print run, choose the first option and it will be " +
        "applied next time you quit.\n\nYour businesses, cheques, payees " +
        "and encryption key are stored outside the application and are not " +
        "touched by an update.",
    });

    if (response === 2) {
      await shell.openExternal(RELEASES_URL);
      promptOpen = false;
      return;
    }
    if (response === 1) {
      /* isSilent false so the installer is visible; isForceRunAfter true so
         the user lands back where they were. */
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
    /* Option 0 needs no action: autoInstallOnAppQuit applies it on exit. */
  } finally {
    promptOpen = false;
  }
}

/**
 * The notify-only path. Nothing is downloaded, because nothing downloaded
 * could be installed; the user is offered the releases page instead.
 */
async function offerDownload(info) {
  if (promptOpen) return;
  promptOpen = true;
  try {
    const { response } = await dialog.showMessageBox(windowOrUndefined(), {
      type: "info",
      buttons: ["Open download page", "Not now"],
      defaultId: 0,
      cancelId: 1,
      title: "Update available",
      message: `CheckWriter ${info.version} is available.`,
      detail:
        `You are running ${app.getVersion()}.\n\n` +
        "This copy cannot update itself. macOS only allows an application " +
        "to replace itself if it carries an Apple Developer ID signature, " +
        "and this build is unsigned — so the download and install have to " +
        "be done by hand.\n\nYour businesses, checks, payees and " +
        "encryption key live outside the application and are not affected " +
        "by installing a new version over the old one.",
    });
    if (response === 0) await shell.openExternal(RELEASES_URL);
  } finally {
    promptOpen = false;
  }
}

function wire() {
  autoUpdater.on("checking-for-update", () => log("checking"));

  autoUpdater.on("update-available", (info) => {
    log("available:", info.version);
    if (isNotifyOnly()) {
      userRequested = false;
      offerDownload(info);
      return;
    }
    /* Otherwise downloading starts on its own. Saying nothing here keeps a
       background check invisible until there is something to act on. */
  });

  autoUpdater.on("update-not-available", () => {
    log("up to date");
    if (!userRequested) return;
    userRequested = false;
    dialog.showMessageBox(windowOrUndefined(), {
      type: "info",
      title: "No update available",
      message: `CheckWriter ${app.getVersion()} is the latest version.`,
      buttons: ["OK"],
    });
  });

  autoUpdater.on("error", (err) => {
    log("error:", err == null ? "unknown" : String(err.message ?? err));
    if (!userRequested) return;
    userRequested = false;
    dialog.showMessageBox(windowOrUndefined(), {
      type: "warning",
      title: "Could not check for updates",
      message: "CheckWriter could not reach the update service.",
      detail:
        "This is usually a network or firewall problem, and it does not " +
        "affect the copy you are running.\n\nYou can always download the " +
        "latest release manually from the project's releases page.\n\n" +
        String(err == null ? "" : err.message ?? err),
      buttons: ["OK"],
    });
  });

  autoUpdater.on("download-progress", (p) => {
    log(`downloading ${Math.round(p.percent)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    log("downloaded:", info.version);
    userRequested = false;
    offerInstall(info);
  });
}

/** A check the user asked for, which always reports an outcome. */
function checkNow() {
  if (!app.isPackaged) {
    dialog.showMessageBox(windowOrUndefined(), {
      type: "info",
      title: "Updates unavailable",
      message: "This is a development build.",
      detail: "Automatic updates only run in an installed copy of CheckWriter.",
      buttons: ["OK"],
    });
    return;
  }
  userRequested = true;
  autoUpdater.autoDownload = !isNotifyOnly();
  autoUpdater.checkForUpdates().catch(() => {
    /* Reported through the error event. */
  });
}

/**
 * Start background checking. Safe to call once at startup; does nothing in a
 * development build, where there is no release feed to compare against.
 */
function start(getMainWindow) {
  getWindow = getMainWindow;

  if (!app.isPackaged) {
    log("development build — automatic updates disabled");
    return;
  }

  const notifyOnly = isNotifyOnly();
  if (notifyOnly) {
    log("unsigned macOS build — notify-only updates");
  }

  /* Downloading an update that Squirrel.Mac will refuse to install would
     spend the user's bandwidth to reach a dead end. */
  autoUpdater.autoDownload = !notifyOnly;
  /* If the user declines an immediate restart, apply it on the way out. */
  autoUpdater.autoInstallOnAppQuit = !notifyOnly;
  /* Never move someone from a stable release onto a pre-release. */
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  wire();

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, FIRST_CHECK_DELAY_MS);

  timer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL_MS);
  /* Do not let the timer alone keep the process alive. */
  if (typeof timer.unref === "function") timer.unref();
}

module.exports = { start, checkNow };

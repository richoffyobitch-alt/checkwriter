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
 */

const { app, dialog, shell } = require("electron");
const { autoUpdater } = require("electron-updater");

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
      await shell.openExternal(
        "https://github.com/richoffyobitch-alt/checkwriter/releases/latest",
      );
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

function wire() {
  autoUpdater.on("checking-for-update", () => log("checking"));

  autoUpdater.on("update-available", (info) => {
    log("available:", info.version);
    /* Downloading starts on its own. Saying nothing here keeps a background
       check invisible until there is actually something to act on. */
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

  autoUpdater.autoDownload = true;
  /* If the user declines an immediate restart, apply it on the way out. */
  autoUpdater.autoInstallOnAppQuit = true;
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

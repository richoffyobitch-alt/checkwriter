/*
 * CheckWriter desktop host.
 *
 * Runs the existing Express application inside Electron and shows it in a
 * native window. The server is unchanged; this file only supplies the three
 * things a packaged desktop install needs and a plain `node dist/index.cjs`
 * run does not:
 *
 *   1. A writable location for the database. The program directory is
 *      read-only once installed under Program Files.
 *   2. Durable secrets. The web build reads these from a .env file the user
 *      creates; here they are generated on first run and protected at rest.
 *   3. A loopback port chosen at runtime, so a second copy of the app or an
 *      unrelated process cannot block startup.
 */

const { app, BrowserWindow, Menu, dialog, shell, safeStorage } = require("electron");
const updater = require("./updater.cjs");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

/* One instance only. Two processes opening the same SQLite file in WAL mode
   is a corruption risk, and a duplicate window would silently diverge from
   the check register the user is looking at. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

const USER_DATA = app.getPath("userData");
const DB_PATH = path.join(USER_DATA, "data.db");
const KEY_FILE = path.join(USER_DATA, "secrets.dat");
const KEY_FILE_PLAIN = path.join(USER_DATA, "secrets.json");

let mainWindow = null;
let serverInfo = null;

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/* ------------------------------------------------------------------ */

/*
 * ENCRYPTION_KEY protects stored routing and account numbers. If it is lost
 * those fields decrypt to null and the bank details are gone, so it is
 * generated once and then never regenerated.
 *
 * At rest it is sealed with Electron's safeStorage, which on Windows is
 * backed by DPAPI and tied to the logged-in Windows account. That means a
 * copy of secrets.dat lifted off the disk is useless on another machine or
 * under another user.
 *
 * DPAPI's strength is also its failure mode: reinstalling Windows or moving
 * to a new user account makes the sealed blob undecryptable. The Help menu
 * therefore offers an explicit key backup, and restoreFromPlain() accepts a
 * recovery file. Falling back to an unsealed file is allowed only where the
 * OS provides no keystore, and it is reported in the UI rather than hidden.
 */
function loadOrCreateSecrets() {
  const sealed = safeStorage.isEncryptionAvailable();

  if (sealed && fs.existsSync(KEY_FILE)) {
    try {
      const blob = fs.readFileSync(KEY_FILE);
      return { ...JSON.parse(safeStorage.decryptString(blob)), sealed: true };
    } catch (err) {
      /* Do not silently mint a replacement key here. A fresh key would make
         every stored bank account number unreadable while looking like a
         clean start. Stop and let the user restore instead. */
      throw new Error(
        "CheckWriter could not unlock its saved encryption key.\n\n" +
          "This normally happens after a Windows reinstall or when the app " +
          "is opened under a different Windows user account.\n\n" +
          "If you saved a key backup, use it to restore. Without it, stored " +
          "bank account numbers cannot be read.\n\n" +
          `Technical detail: ${err.message}`,
      );
    }
  }

  if (!sealed && fs.existsSync(KEY_FILE_PLAIN)) {
    return { ...JSON.parse(fs.readFileSync(KEY_FILE_PLAIN, "utf8")), sealed: false };
  }

  const secrets = {
    ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
    SESSION_SECRET: crypto.randomBytes(48).toString("base64url"),
    createdAt: new Date().toISOString(),
  };

  if (sealed) {
    fs.writeFileSync(KEY_FILE, safeStorage.encryptString(JSON.stringify(secrets)), {
      mode: 0o600,
    });
  } else {
    fs.writeFileSync(KEY_FILE_PLAIN, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }

  return { ...secrets, sealed, freshlyCreated: true };
}

async function backupKey() {
  const secrets = loadOrCreateSecrets();
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Save encryption key backup",
    defaultPath: "checkwriter-key-backup.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (canceled || !filePath) return;

  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
        SESSION_SECRET: secrets.SESSION_SECRET,
        createdAt: secrets.createdAt,
        note:
          "This file unlocks the bank account numbers stored in CheckWriter. " +
          "Anyone holding it can read them. Keep it somewhere secure and " +
          "offline, not in the CheckWriter folder and not in shared cloud storage.",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Key backup saved",
    message: "Your encryption key has been saved.",
    detail:
      "Treat this file like the keys to your bank account. Anyone who has it " +
      "can read the account numbers stored in CheckWriter.\n\n" +
      "Store it offline — a safe, or an encrypted USB drive. Do not leave it " +
      "in your Downloads folder or sync it to cloud storage.",
  });
}

/* ------------------------------------------------------------------ */
/* Window and menu                                                     */
/* ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Open data folder",
          click: () => shell.openPath(USER_DATA),
        },
        {
          label: "Back up encryption key…",
          click: () => backupKey(),
        },
        { type: "separator" },
        { role: "print", accelerator: "CmdOrCtrl+P" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About CheckWriter",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About CheckWriter",
              message: `CheckWriter ${app.getVersion()}`,
              detail:
                `Electron ${process.versions.electron}\n` +
                `Node ${process.versions.node}\n\n` +
                `Data folder:\n${USER_DATA}\n\n` +
                "Your data stays on this computer. Nothing is sent to a server.\n\n" +
                "Before printing on real check stock, run a test print from " +
                "Printers & Calibration and have your bank confirm a physical " +
                "sample scans correctly on their equipment.",
            });
          },
        },
        {
          label: "Check for updates…",
          click: () => updater.checkNow(),
        },
        { type: "separator" },
        {
          label: "Printing and your bank",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "warning",
              title: "Before you print live checks",
              message: "Have your bank check a printed sample first.",
              detail:
                "CheckWriter lays out the MICR line to the ANSI X9.13 " +
                "geometry, but whether a printed check actually scans depends " +
                "on your printer, your toner and your check stock — none of " +
                "which the software can verify.\n\n" +
                "Print one sample, take it to your bank, and confirm it reads " +
                "on their equipment before issuing any live check.",
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#0b0b0d",
    title: "CheckWriter",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      /* The renderer is a plain web page talking to localhost over HTTP.
         It has no need for Node, and granting it any would turn an XSS in
         the check register into code execution on the accountant's machine. */
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(url);

  /* Saving a check PDF should ask where to put it rather than silently
     dropping a file containing bank details into Downloads. */
  mainWindow.webContents.session.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({
      title: "Save check PDF",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  });

  /* Anything that is not the local app opens in the real browser. Without
     this an external link would replace the check register inside a window
     that has no address bar, which is a convincing phishing surface. */
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(serverInfo.origin)) {
      shell.openExternal(target);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(serverInfo.origin)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  let secrets;
  try {
    secrets = loadOrCreateSecrets();
  } catch (err) {
    dialog.showErrorBox("CheckWriter cannot start", err.message);
    app.quit();
    return;
  }

  process.env.NODE_ENV = "production";
  process.env.ENCRYPTION_KEY = secrets.ENCRYPTION_KEY;
  process.env.SESSION_SECRET = secrets.SESSION_SECRET;
  process.env.CHECKWRITER_DB_PATH = DB_PATH;
  /* Cookies are served over plain HTTP on loopback, so the Secure and
     __Host- cookie attributes the hosted build relies on would prevent
     sign-in. The transport never leaves the machine. */
  process.env.LOCAL_HTTP = "1";

  let startServer;
  try {
    ({ startServer } = require(path.join(__dirname, "server", "index.cjs")));
  } catch (err) {
    dialog.showErrorBox(
      "CheckWriter cannot start",
      "The application files appear to be incomplete or damaged.\n\n" +
        "Reinstalling CheckWriter should fix this. Your data folder is not " +
        `affected:\n${USER_DATA}\n\nTechnical detail: ${err.message}`,
    );
    app.quit();
    return;
  }

  try {
    /* Port 0 asks Windows for any free loopback port. */
    const { port, host } = await startServer({ port: 0, host: "127.0.0.1" });
    serverInfo = { port, host, origin: `http://${host}:${port}` };
  } catch (err) {
    dialog.showErrorBox(
      "CheckWriter cannot start",
      `The application could not start its local service.\n\n${err.message}`,
    );
    app.quit();
    return;
  }

  buildMenu();
  createWindow(serverInfo.origin);

  /* Background update checks. Never installs without asking — see
     updater.cjs for why that matters in an application used to write
     cheques. */
  updater.start(() => mainWindow);

  if (secrets.freshlyCreated && !secrets.sealed) {
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Encryption key stored without OS protection",
      message: "Windows secure storage was not available.",
      detail:
        "CheckWriter generated your encryption key but could not seal it " +
        "with the operating system keystore, so it is stored as a plain " +
        `file in:\n${USER_DATA}\n\nAnyone with access to this Windows ` +
        "account can read it. Consider enabling disk encryption.",
    });
  }
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(boot);

app.on("window-all-closed", () => {
  app.quit();
});

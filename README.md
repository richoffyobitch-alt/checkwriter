# CheckWriter

A business check writer, check designer and print-preparation application for
Windows. Multiple businesses, multiple bank accounts, payees, templates,
approvals, audit trail, positive-pay export.

Everything runs on the machine it is installed on. There is no server, no
account to create with anyone, and no network call carrying your data. The
check register lives in a SQLite file in your Windows user profile.

---

## Install

Download `CheckWriter-Setup-<version>.exe` from the
[Releases](../../releases) page and run it. No prerequisites — Node.js is not
required, because the runtime is bundled.

The installer is **not code-signed**, so Windows SmartScreen will warn the
first time it runs. See [Code signing](#code-signing) below.

### Where your data lives

| What | Path |
| --- | --- |
| Check register, businesses, payees | `%APPDATA%\CheckWriter\data.db` |
| Encryption key | `%APPDATA%\CheckWriter\secrets.dat` |

Reach both from **File → Open data folder** inside the app.

Uninstalling does **not** delete these. Removing business records has to be a
deliberate act.

### Back up two things

1. `data.db` — your businesses, payees, checks and audit history.
2. Your encryption key — **File → Back up encryption key…**

Stored routing and account numbers are encrypted with that key. Without it
they cannot be read back, even from a perfectly good `data.db`. The key is
sealed with Windows DPAPI and tied to your Windows account, which means a
Windows reinstall or a new user account can make it unrecoverable. Take the
backup and keep it offline.

---

## Before you print live checks

The MICR line is laid out to the ANSI X9.13 clear-band and pitch geometry, and
the E-13B glyphs are embedded in the generated PDF rather than substituted
with a lookalike font.

That is not the same as being bank-approved. Whether a printed check actually
scans depends on your printer, your toner and your check stock — none of which
software can verify.

**Print one sample, take it to your bank, and confirm it reads on their
equipment before issuing a live check.** Printers & Calibration has a test
print mode that marks output VOID.

---

## Building from source

Two independent pieces:

- `checkwriter/` — the application: Express + SQLite backend, React client.
- `desktop/` — the Electron shell and Windows packaging.

### 1. Build the application

```bash
cd checkwriter
npm install
npm run build          # -> dist/index.cjs and dist/public
```

Verification:

```bash
npm run verify:micr        # MICR geometry and E-13B font metrics
npm run verify:template    # template normalisation (34 checks)
npx tsc --noEmit
```

### 2. Build the Windows installer

```bash
cd desktop
npm install
cp -r ../checkwriter/dist/. server/

# Fetch the better-sqlite3 binary matching Electron's ABI for the target.
# This is a download, not a compile — no MSVC toolchain needed, and it
# cross-builds from Linux or macOS.
node scripts/fetch-native.mjs win32 x64

npx electron-builder --win --x64 --publish never
# -> release/CheckWriter-Setup-<version>.exe
```

Building a Windows installer on Linux additionally needs `wine` on PATH;
electron-builder uses it to stamp icons and version metadata into the
executables.

### Why the native binary is fetched rather than compiled

`better-sqlite3` is compiled C++. The copy `npm install` produces is built for
the build machine and for Node's ABI, but the shipped app needs Windows and
*Electron's* ABI, which differ. The project publishes prebuilt binaries for
every supported combination, so `scripts/fetch-native.mjs` resolves the right
one and verifies with `file(1)` that what it placed really is a Windows PE
binary. `npmRebuild: false` in `electron-builder.yml` stops electron-builder
from helpfully rebuilding it back to the wrong platform.

---

## Tests

`tests/` holds the API regression suite — 289 checks across authentication,
roles and permissions, businesses, bank accounts, payees, check lifecycle,
numbering and reconciliation, templates and assets, positive pay, audit,
session revocation, and the check designer.

Run against a server on port 5050 with a clean database:

```bash
cd checkwriter
npm run build
# start the server with ENCRYPTION_KEY, SESSION_SECRET, LOCAL_HTTP=1, PORT=5050
cd ../tests
for f in qa1 qa2 qa3 qa4 qa5 qa6; do python3 $f.py; done
```

They are order-dependent: `qa1` seeds the accounts and businesses the rest
rely on, so run them in sequence against a fresh database.

---

## Code signing

Release binaries are unsigned. On first run Windows SmartScreen shows
"Windows protected your PC" and the publisher reads as unknown; the app runs
after **More info → Run anyway**.

Removing that warning requires an Organisation Validation or Extended
Validation code-signing certificate issued to a verified legal entity. OV
certificates still accumulate SmartScreen reputation over time; EV
certificates are trusted immediately. Once a certificate exists, signing slots
into the `win` block of `desktop/electron-builder.yml`.

This matters more than usual for financial software: a signature is how a user
distinguishes the real installer from a tampered copy.

---

## Security notes

- The server binds `127.0.0.1` only. It is never reachable from the network.
- The renderer runs with `nodeIntegration: false`, `contextIsolation: true`
  and `sandbox: true`.
- Routing and account numbers are encrypted at rest; masked in normal views;
  revealing one requires step-up re-authentication and writes an audit entry.
- Session tokens carry an epoch, so changing a password or revoking sessions
  invalidates tokens already issued.
- Rate limits on login, registration and step-up are keyed per identity.
- Content-Security-Policy is set via Helmet with no `unsafe-eval`.

## Licence

Proprietary. © 2026 RichCo Enterprises LLC.

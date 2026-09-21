# CheckWriter

A business check writer, check designer and print-preparation application for
**Windows and macOS**. Multiple businesses, multiple bank accounts, payees,
templates, approvals, audit trail, positive-pay export.

Everything runs on the machine it is installed on. There is no server, no
account to create with anyone, and no network call carrying your data. The
check register lives in a SQLite file in your own user profile.

---

## Install

No prerequisites on either platform — Node.js is not required, because the
runtime is bundled.

| Platform | Download | Notes |
| --- | --- | --- |
| Windows 10/11 x64 | `CheckWriter-Setup-<version>.exe` | Per-user install, no admin prompt |
| macOS 11+ Apple Silicon | `CheckWriter-<version>-arm64.dmg` | M1 and later |
| macOS 11+ Intel | `CheckWriter-<version>-x64.dmg` | |

Everything is on the [Releases](../../releases) page. Not sure which Mac you
have? **Apple menu → About This Mac**: "Apple M…" means arm64, "Intel" means
x64.

Builds are **not code-signed**, so both operating systems object the first
time. Windows shows SmartScreen. macOS is blunter and claims the app is
"damaged", which it is not — see [INSTALL-MACOS.md](INSTALL-MACOS.md) for the
fix, and [Code signing](#code-signing) for why it happens at all.

### Where your data lives

| What | Windows | macOS |
| --- | --- | --- |
| Check register, businesses, payees | `%APPDATA%\CheckWriter\data.db` | `~/Library/Application Support/CheckWriter/data.db` |
| Encryption key | `%APPDATA%\CheckWriter\secrets.dat` | `~/Library/Application Support/CheckWriter/secrets.dat` |

Reach both from **File → Open data folder**, which reads **File → Reveal Data
Folder in Finder** on macOS.

Uninstalling does **not** delete these. Removing business records has to be a
deliberate act.

### Back up two things

1. `data.db` — your businesses, payees, checks and audit history.
2. Your encryption key — **File → Back up encryption key…**

Stored routing and account numbers are encrypted with that key. Without it
they cannot be read back, even from a perfectly good `data.db`. The key is
sealed by the operating system keystore — DPAPI on Windows, the login
Keychain on macOS — and tied to your user account. A Windows reinstall, a
migration to a new Mac without your Keychain, or opening the app under a
different account can each make it unrecoverable. Take the backup and keep it
offline.

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
- `desktop/` — the Electron shell and the Windows and macOS packaging.

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

### 2. Build the installers

```bash
cd desktop
npm install
cp -r ../checkwriter/dist/. server/

npm run dist:win     # -> release/CheckWriter-Setup-<version>.exe
npm run dist:mac     # -> release/CheckWriter-<version>-{arm64,x64}.dmg + .zip
```

**The macOS build must run on a Mac.** A `.dmg` is assembled with `hdiutil`
and a code signature is made with the macOS security framework; neither tool
exists on any other operating system. Running `npm run dist:mac` elsewhere
prints a warning, skips the `.dmg`, and produces unsigned `.zip` bundles that
are useful for checking the packaging and nothing else. A Windows installer
built on Linux additionally needs `wine` on PATH, which electron-builder uses
to stamp icons and version metadata into the executables.

In practice neither is done by hand:
[.github/workflows/release.yml](.github/workflows/release.yml) builds both on
their own operating systems and attaches the results — including the
`latest.yml` and `latest-mac.yml` update feeds — to a release.

### Why the macOS build runs one architecture at a time

`better-sqlite3` is compiled C++. The copy `npm install` produces is built for
the build machine and for Node's ABI, but the shipped app needs the target
platform and *Electron's* ABI, which differ. The project publishes prebuilt
binaries for every supported combination, so `scripts/fetch-native.mjs`
resolves the right one and verifies it by reading the binary's own header —
Mach-O cputype, PE machine field, ELF e_machine — rather than trusting the
filename. `npmRebuild: false` in `electron-builder.yml` stops electron-builder
from helpfully rebuilding it back to the build host's platform.

The consequence is that exactly one such binary exists in `node_modules` at a
time. Asking electron-builder for `--mac --arm64 --x64` in one invocation
would stamp the same binary into both bundles, and one of the two would be an
application that installs, launches, and dies the moment it opens the check
register. `scripts/build-mac.mjs` therefore runs a full place-package-verify
cycle per architecture, and `scripts/after-pack.cjs` re-reads the binary
*inside* each finished bundle so a mistake fails the build instead of the
user's Mac.

It also merges the two `latest-mac.yml` files the two runs produce. Without
that merge, only one architecture would ever be offered an update — silently.

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

Release binaries are unsigned on both platforms, and the two operating
systems react differently.

**Windows** shows SmartScreen — "Windows protected your PC", publisher
unknown — and runs after **More info → Run anyway**. Removing it requires an
Organisation Validation or Extended Validation code-signing certificate
issued to a verified legal entity. OV certificates accumulate SmartScreen
reputation over time; EV certificates are trusted immediately.

**macOS** is stricter, and has become more so. Gatekeeper reports an unsigned
downloaded app as "damaged and can't be opened", which sounds like a
corrupt download and is not. Clearing it requires a Developer ID Application
certificate (Apple Developer Program, 99 USD/year) plus notarization, which
is a separate automated review Apple runs on the uploaded build.

macOS signing has a second consequence that Windows does not:

> **An unsigned macOS build cannot update itself.** Squirrel.Mac validates
> the running application's signature before replacing it, and refuses when
> there is none. There is no flag to disable that, and there should not be —
> it is what stops an update feed from becoming arbitrary code execution.

The app handles this rather than failing at it. `scripts/write-build-info.mjs`
records whether a certificate was present at build time, and `updater.cjs`
reads it: an unsigned Mac build still checks for updates and still tells the
user a new version exists, but sends them to the releases page instead of
downloading something it could never install. Sign the build and full
automatic updates switch on with no code change.

To sign, add these repository secrets and re-run the release workflow. Absent
secrets simply produce an unsigned build:

| Secret | What it is |
| --- | --- |
| `MAC_CERTIFICATE_P12` | base64 of the Developer ID `.p12` export |
| `MAC_CERTIFICATE_PASSWORD` | its export password |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password, not the account password |
| `APPLE_TEAM_ID` | 10-character team identifier |

This matters more than usual for financial software: a signature is how a
user distinguishes the real installer from a tampered copy — and, once
automatic updates exist, how their computer distinguishes a real update from
an attacker's.

---

## Security notes

- The server binds `127.0.0.1` only. It is never reachable from the network.
- The macOS bundle requests no camera, microphone, contacts or location
  permission, and carries no `com.apple.security.network.server` entitlement
  — binding loopback needs none, and granting it would permit exactly what a
  check register must not do.
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

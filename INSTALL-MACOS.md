# Installing CheckWriter on a Mac

Requires macOS 11 Big Sur or later. Nothing else — no Node.js, no Homebrew,
no Terminal. The runtime is inside the app.

---

## 1. Get the right download

Two builds, one per Mac processor. Installing the wrong one either refuses to
open or runs slowly through translation.

**Apple menu → About This Mac.**

| What it says | Download |
| --- | --- |
| Apple M1 / M2 / M3 / M4 | `CheckWriter-<version>-arm64.dmg` |
| Intel | `CheckWriter-<version>-x64.dmg` |

Both are on the [Releases](../../releases) page.

---

## 2. Install

1. Double-click the `.dmg`.
2. Drag **CheckWriter** onto the **Applications** folder shown beside it.
3. Eject the disk image — drag it to the Trash, or press **⌘E**.

Put it in Applications rather than running it from the disk image or from
Downloads. The updater looks for the app there, and macOS treats an app run
from a mounted image as read-only.

---

## 3. The first launch, and the warning you will get

CheckWriter is not yet signed with an Apple Developer ID. So the first time
you open it, macOS will say something like:

> **"CheckWriter" is damaged and can't be opened. You should move it to the
> Trash.**

**It is not damaged.** That message is Gatekeeper's response to an app that
arrived from the internet without an Apple signature, and it is the same
message you would get if the file really were corrupt — which is exactly
what makes it unhelpful. Recent macOS versions have made this stricter, so
you may hit it even if other unsigned apps have opened for you before.

If you would rather not take that on faith, verify the download first — see
[Checking you got the real file](#checking-you-got-the-real-file) below. That
is the responsible order of operations, because the whole point of a
signature is to save you from having to trust the person who sent you the
link.

### Opening it anyway

Try this first:

1. Open **Applications** in Finder.
2. **Control-click** CheckWriter (or right-click) → **Open**.
3. Click **Open** in the dialog.

macOS remembers the decision; afterwards it opens normally.

If the dialog offers only **Move to Trash** and **Cancel**, Gatekeeper has
refused outright. Open **Terminal** (⌘Space, type "Terminal") and run:

```bash
xattr -cr /Applications/CheckWriter.app
```

Then open the app normally. That command removes the `com.apple.quarantine`
flag macOS attaches to downloaded files. It changes nothing else, and it
grants no permissions.

Be clear-eyed about what you are doing: you are telling macOS to stop
checking this one application, and you are doing it on the strength of where
you got the file. Do it for a build you downloaded yourself from the releases
page. Do not do it for an installer that arrived by email or chat.

### Making the warning go away permanently

Only an Apple Developer ID signature plus notarization removes it, and only
the developer can do that — it costs 99 USD a year. See
[Code signing](README.md#code-signing).

---

## 4. First run

CheckWriter opens a setup wizard: create your administrator account and your
first business. There are no pre-made accounts and no sample data.

Then, before entering any bank account:

**File → Back up encryption key…**

Save it somewhere offline — not iCloud Drive, not the Downloads folder.

Your routing and account numbers are encrypted with that key, and the key is
sealed in your login Keychain. That protects it well, and it also means it
does not necessarily survive a migration to a new Mac, a macOS reinstall, or
opening the app under a different macOS account. Without the key, stored
account numbers cannot be read back — the app shows them blank rather than
erroring, so a backup of the database alone will look fine right up until the
moment you need it.

The other side of that: anyone holding the key file can read those account
numbers. Keep it as carefully as you would keep the checkbook.

---

## Where your data lives

```
~/Library/Application Support/CheckWriter/
    data.db        businesses, payees, checks, audit history
    secrets.dat    the encryption key, sealed with your login Keychain
```

**File → Reveal Data Folder in Finder** opens it. That folder is deliberately
left behind if you delete the app — removing a check register should be a
decision, not a side effect. To remove everything, drag the app to the Trash
and delete that folder.

---

## Updates

CheckWriter checks for new versions and will tell you when one exists, but an
**unsigned build cannot install its own updates**. macOS only lets an
application replace itself if it carries a Developer ID signature, and there
is no way around that — nor should there be, since it is what stops an
update channel from becoming a way to run arbitrary code on your Mac.

So on macOS the update prompt sends you to the download page, and you install
the new `.dmg` over the old app. Your businesses, checks, payees and
encryption key live outside the application and are untouched by this.

**Help → Check for Updates** (in the CheckWriter menu) checks on demand.

---

## Printing

The same caveat as every platform, and it is the one that matters:

The MICR line is laid out to ANSI X9.13 geometry with genuine embedded E-13B
glyphs. Whether a printed check actually **scans** depends on magnetic MICR
toner, your check stock and your printer's calibration — none of which any
software can verify.

Print one sample from **Printers & Calibration**, take it to your bank, and
confirm it reads on their equipment before issuing a live check. Calibration
offsets are saved per printer, so a Mac and a Windows PC printing to the same
device each keep their own.

---

## Checking you got the real file

Each release publishes a SHA-256 for every download. Compare it:

```bash
shasum -a 256 ~/Downloads/CheckWriter-*.dmg
```

It should match the value on the release page character for character. If it
does not, delete the file and download it again — and do not bypass
Gatekeeper for it.

---

## If something goes wrong

**"CheckWriter is damaged"** — covered above. Not damage; Gatekeeper.

**The app opens and the window stays blank.** The app runs a small local
server on 127.0.0.1 and loads it in the window. If it never appears, quit
(⌘Q) and reopen. A VPN or firewall that intercepts loopback traffic is the
usual culprit.

**"CheckWriter could not unlock its saved encryption key."** The sealed key
cannot be read by this macOS account — typically after a migration, a macOS
reinstall, or opening the app under a different user. Restore from your key
backup. There is no way around this without it; that is the point of sealing
the key to your account.

**The app is not in the Dock after closing the window.** Closing the window
on macOS does not quit the app, by design — the icon stays in the Dock and
clicking it brings the window back. **⌘Q** quits properly.

**Nothing happens when you double-click the `.dmg`.** The download is likely
incomplete. Check the SHA-256 above.

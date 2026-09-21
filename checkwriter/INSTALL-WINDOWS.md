# Installing CheckWriter on your Windows PC

Running it on your own computer means your bank account numbers, payees and
check register live on your machine rather than on a web server, and printing
goes straight to your own printer.

---

## What you need first

**Node.js** — this is the engine the app runs on. It is free and takes about two
minutes to install.

1. Go to [nodejs.org](https://nodejs.org)
2. Download the button labelled **LTS** (the recommended version)
3. Run the installer and accept the defaults
4. Restart your computer if the installer asks you to

You only ever do this once.

---

## Installing the app

1. **Unzip** the `checkwriter` folder somewhere permanent — `Documents` is a
   good choice. Do not run it from inside the zip file, and avoid leaving it in
   `Downloads` where it might get cleared out.

2. **Double-click `setup.bat`**

   A black window opens and prints progress. It checks Node.js, downloads the
   components, generates private keys for this computer, and builds the app.
   The first run takes a few minutes. Wait for `Setup complete`.

3. **Double-click `start-checkwriter.bat`**

   Two things happen: a window titled *CheckWriter server* opens, and your
   browser opens to the app.

   **That server window must stay open while you use CheckWriter.** Closing it
   shuts the app down. Minimize it.

4. **Sign in** with the account you create in the setup wizard.

   On first launch, the app shows a setup wizard that creates your
   administrator account and first business. This only runs once —
   after that, `start-checkwriter.bat` takes you straight to sign-in.

   You can add bank accounts, payees, and check templates after signing in.

From then on, `start-checkwriter.bat` is the only file you need. Right-click it
and pick *Pin to taskbar* if you want it handy.

---

## Windows may warn you about the .bat files

Because these files came from the internet, Windows SmartScreen or Defender may
show *"Windows protected your PC"*. Click **More info** then **Run anyway**. All
three `.bat` files are plain text — open any of them in Notepad to see exactly
what they do.

---

## Your data, and backing it up

Two files inside the folder matter:

| File      | Contains                                          |
| --------- | ------------------------------------------------- |
| `data.db` | Your businesses, bank accounts, payees and checks  |
| `.env`    | Your encryption key and session key                |

**Back up both together.** Double-click `backup.bat` any time — it copies both
into a dated folder under `backups\`. Copy that to a USB drive or a private
cloud folder.

Two things worth understanding:

- **Losing `.env` means losing access to stored bank account numbers.** Routing
  and account numbers are encrypted with the key in that file. Without the key
  they cannot be decrypted, and the app will show them as blank rather than
  reporting an error. `data.db` alone is not a complete backup.
- **`.env` plus `data.db` together are sensitive.** Anyone holding both can read
  your stored bank account numbers. Keep backups somewhere private.

---

## Adding the rest of your team

Go to **Settings → Authorized users → Add user**. You enter their name, email,
an initial password, and the role they should hold. You will be asked to
re-enter your own password first, because changing who can move money is a
high-risk action and gets recorded in the audit log.

**This step is optional.** As the owner you can prepare, approve, sign and
print your own checks at any amount — there is no second-approver requirement.
Add users only when you want to hand work off: a bookkeeper who writes checks
without approving them, or an approver who signs off without seeing bank
numbers.

Roles: owner and admin can do everything; bookkeeper handles payees, prepares
and prints checks; approver approves; signer signs; viewer only reads reports
and the audit log. You can change someone's role or remove them at any time —
their past checks and audit history stay intact.

---

## Printing

The app produces a print-ready page sized to standard check stock, with the MICR
line positioned per the ANSI X9.13 geometry shown on the print screen.

For real check printing you still need, on your side:

- **Blank check stock** that matches the layout you selected
- **Magnetic MICR toner** — ordinary toner is not magnetically readable, so
  standard printing will look correct to the eye but may be rejected by
  automated bank processing
- **Printer calibration** — use the Offset X / Offset Y fields on the print
  screen, and the *Save test print* button, to nudge the layout until it lines up
  with your stock. Each printer keeps its own saved profile.
- **Your bank's test deck** — banks generally want to run sample checks through
  their reader before you issue live checks from a new setup

The MICR E-13B font is bundled with the app, so you do not need to install a
font separately. The correct glyph shapes appear in the on-screen preview, in
PDFs you save, and when you print directly.

What the app cannot supply is the magnetic ink. A MICR line is only readable by
a bank's sorter if it is printed with **MICR toner** on the correct stock with a
calibrated printer. Whether your particular printer, toner and stock combination
passes is something only your bank's test deck can confirm.

---

## If something goes wrong

**`setup.bat` fails while installing components**

Usually the database component could not find a prebuilt version matching your
Node.js release. Install the current **LTS** from
[nodejs.org](https://nodejs.org), then run `setup.bat` again.

**The browser opens but the page will not load**

The server needs a few seconds to start. Wait, then refresh. If it still fails,
look at the *CheckWriter server* window for a red error message.

**"Port 5000 is already in use"**

Another program has that port. Open `.env` in Notepad, change `PORT=5000` to
`PORT=5050`, save, and start the app again at `http://localhost:5050`.

**"node is not recognized"**

Node.js is not installed, or the computer has not been restarted since
installing it. Install the LTS release and restart.

**You forget the sign-in password**

There is no email reset on a local install. Delete `data.db` to start over with
the setup wizard — but that erases every check you have entered, so back it up
first.

---

## Using it on more than one computer

This install keeps its data in one file on one machine. Copying the folder to a
second PC gives you two separate registers that do not sync, which is how
duplicate check numbers happen. If you need several people working from the same
register, that needs the shared-database setup instead — ask and it can be built.

---

## Updating later

Replace the app files with a newer copy, but **keep your existing `.env` and
`data.db`**, then run `setup.bat` again. It will not overwrite an existing
`.env`, and the app adds any new database columns automatically on startup
without touching your existing records.

# CheckWriter

A multi-entity business check writer, designer, and print-preparation app.

> **Status: production-oriented prototype — not bank-certified.**
> Server-side authorization, audit logging, step-up authentication, and
> immutable issued-check versions are implemented. This is **not** a substitute
> for bank certification, hosted secret management, MFA, backups, or a
> penetration test. See [Before live issuance](#before-live-issuance).

## Stack

| Layer    | Choice                                                  |
| -------- | ------------------------------------------------------- |
| Client   | React + Vite, wouter (hash routing), Tailwind, shadcn/ui |
| Server   | Express, express-session                                 |
| Database | SQLite via Drizzle ORM (auto-migrating)                  |
| Build    | esbuild (server) + Vite (client)                        |

## Quick start

```bash
npm install
cp .env.example .env      # then fill in SESSION_SECRET and ENCRYPTION_KEY
npx tsx server/index.ts   # dev server on http://localhost:5000
```

Production:

```bash
npm run build
NODE_ENV=production node dist/index.cjs
```

The SQLite file (`data.db`) is created and migrated on first boot. A fresh
install starts empty and shows a setup wizard to create the first admin
account and business. Demo/sample data is only loaded when `SEED_DEMO=1` is
set, for development and testing.

## First-run setup

On first launch the app shows a setup wizard that creates the initial
administrator account and first business. This runs once; afterwards the app
goes straight to sign-in.

## Authorized users and approval tiers

Settings → Authorized users is where you add the other people who work on
payments. Each person holds one role per business, and roles are enforced on the
server, not just hidden in the UI:

| Role | Can do |
| --- | --- |
| owner / admin | everything, including bank accounts and authorized users |
| bookkeeper | payees, prepare checks, print, reprint, mark cleared, reports |
| approver | approve checks, reports, audit log |
| signer | sign checks, reports |
| viewer | reports and audit log only |

**You can approve your own checks.** An owner or admin holds every permission
and is a complete approval chain on their own: prepare, approve, sign, print. No
second person is required at any amount. Adding other users is optional and is
about delegating work, not unlocking it.

Amount bands are advisory labels only. A check is tagged Standard (under
$1,000), Elevated ($1,000 and up) or High value ($10,000 and up) so a large
payment is easy to spot in the register. The tag does not block anything.

Self-approval stays fully traceable: the check records both who prepared it and
who approved it, and the audit entry marks the approval as self-approved when
they are the same person. Adding, re-roling, or removing a user requires
re-entering your own password, and every change is written to the audit log. The
last remaining owner cannot be demoted or removed.

Roles that can print can also read the routing and account numbers needed to
render the MICR line, because those numbers are printed on the check itself.
Approver, signer and viewer cannot see them at all.

## Modules

Businesses · bank accounts · payees · authorized users and roles · check
creation with line items · check numbering and reconciliation · drag-and-drop
check designer · print output with MICR · approval workflows · positive pay
export · reports · audit log.

## MICR geometry (ANSI X9.13)

MICR placement is derived from the standard rather than hand-tuned, in
`client/src/lib/micr.ts` and rendered by `client/src/components/micr-line.tsx`.

- **Clear band** — bottom 5/8 in of the document must stay free of ink.
- **Print band** — 1/4 in tall, from 3/16 in to 7/16 in above the aligning
  (bottom) edge; character baseline sits at 3/16 in.
- **Horizontal** — 65 character positions of 1/8 in each. **Position 1 is
  rightmost**, 5/16 in from the right edge; position 65 ends at 8 7/16 in.
  So `leftEdge(p) = checkWidth - 0.3125 - p * 0.125`.
- **Fields** — Amount 1–12 (bank-printed, left blank), On-Us 13–32, Routing
  33–43 (transit symbol at 33 and 43 bracketing 9 digits), EPC 44, Auxiliary
  On-Us 45–65 (serial bracketed by On-Us symbols; only on checks wider than 6 in).

Each field is positioned independently — never as one run of text — so an
unexpected glyph advance cannot shift the whole line.

### Font mapping

The embedded face is *MICR E13B Normal*. It has **no glyphs at the Unicode MICR
codepoints U+2446–U+244A**; those silently fall back to a non-MICR face. Use the
font's own ASCII mapping instead:

| Char | Symbol  |
| ---- | ------- |
| `A`  | Transit |
| `B`  | Amount  |
| `C`  | On-Us   |
| `D`  | Dash    |

Every glyph advances 1536/2048 em = 0.75 em, so a font size of 1/6 in (12 pt)
yields exactly the required 1/8 in pitch.

The face is declared twice, by necessity: `client/src/index.css` carries a CSS
`@font-face` for the on-screen preview and the browser print path, and
`client/src/lib/e13b-font.ts` carries the same bytes so `pdf-lib` can embed the
font program into generated PDFs. `npm run verify:micr` asserts the two copies
are byte-identical, that all 14 emitted glyphs are mapped, and that their
advances are uniform — if they ever drift, the preview and the PDF would
disagree about what a check looks like.

### What the app can and cannot guarantee

Machine readability has two independent requirements:

1. **Correct glyph shapes at correct positions.** The app handles this, in the
   preview, the browser print path, and the generated PDF alike.
2. **Magnetic ink.** This is a property of the toner and the printer, not of the
   document. No file the app produces can supply it.

So a generated PDF is geometrically and typographically a real MICR line, but it
is only magnetically readable if it is printed with MICR toner on a calibrated
printer with the correct stock. Confirm your own bank's requirements and pass
their test deck before issuing live checks; nothing here is a substitute for
that validation.

### Verifying

`client/src/lib/micr.ts` exports `buildMicrLayout` and `summarizeMicr`; the
print screen's **Show MICR guides** toggle overlays the clear band, print band,
per-field tints, baseline, and a position ruler. Geometry is asserted against the
standard in the layout tests, and the ABA routing checksum is validated on input.
`npm run verify:micr` re-asserts the geometry, the checksum, per-cell
uniqueness and in-band placement, and the embedded font's integrity from the
command line.

## Before live issuance

Independent of this codebase, you must validate with your bank:

1. Bank-approved MICR font and magnetic toner.
2. Check stock compatible with your bank's specification.
3. Printer calibration — run the test-print page and the alignment offsets in
   **Printers & Calibration**.
4. A **test deck** submitted to and accepted by your bank.

Do not treat any output from this app as bank compliant until that validation is
complete.

## Scope limits

By design this app does not reproduce security backgrounds, imitate a bank's
official forms, or allow silent editing of issued checks. Post-issuance
corrections go through void, reissue, replacement, or adjustment workflows, each
of which writes an audit record.

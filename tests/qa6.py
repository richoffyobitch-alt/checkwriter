#!/usr/bin/env python3
"""QA part 6: check fraction numbers, template design + background persistence,
template asset library (logos / background images), and in-use delete guards.

Runs after qa1-qa5 against the same server and reuses qa-state.json."""
import base64
import json
import struct
import urllib.error
import urllib.request
import zlib

B = "http://localhost:5050"
P = F = 0
NOTES = []
S = json.load(open("/home/user/workspace/qa-state.json"))
OWNER, APPROVER, BIZ, BIZ2, ACCT = S["OWNER"], S["APPROVER"], S["BIZ"], S["BIZ2"], S["ACCT"]


def call(method, path, body=None, token=OWNER, raw=False):
    req = urllib.request.Request(B + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=25) as r:
            t = r.read().decode(errors="replace")
            if raw:
                return r.status, t
            try:
                return r.status, (json.loads(t) if t else None)
            except Exception:
                return r.status, t
    except urllib.error.HTTPError as e:
        t = e.read().decode(errors="replace")
        try:
            return e.code, (t if raw else json.loads(t))
        except Exception:
            return e.code, t


def check(name, cond, detail=""):
    global P, F
    if cond:
        P += 1
        print(f"  PASS  {name}")
    else:
        F += 1
        print(f"  FAIL  {name}  {detail}")
        NOTES.append(f"{name}: {detail}")


def png_bytes(w=8, h=8):
    """Build a real, minimal PNG so MIME sniffing and pdf-lib both accept it."""
    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    rows = b"".join(b"\x00" + b"\x20\x40\x80" * w for _ in range(h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


PNG_B64 = base64.b64encode(png_bytes()).decode()

# qa5 rotates the owner password and revokes sessions, then writes a fresh token
# back to qa-state.json. Use it if it still works. Only fall back to logging in
# when it does not, because logins are rate limited per email on purpose and
# burning that budget here would fail the run for the wrong reason.
def _login():
    r = urllib.request.Request(B + "/api/auth/login", method="POST")
    r.add_header("Content-Type", "application/json")
    payload = json.dumps({"email": "owner@richco.test", "password": "strongpass123"}).encode()
    try:
        with urllib.request.urlopen(r, payload, timeout=25) as x:
            return json.loads(x.read().decode()).get("sessionToken")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise SystemExit(
            f"qa6 could not obtain an owner session ({e.code}): {body[:200]}\n"
            "If this is a 429, the login limiter is doing its job — restart the "
            "server (the limiter is in-memory) and re-run qa6."
        )


_probe, _ = call("GET", f"/api/businesses/{BIZ}/bank-accounts", token=OWNER)
if _probe != 200:
    OWNER = _login()
call.__defaults__ = (None, OWNER, False)


def step_up():
    """Step up only when the server actually asks. The credential endpoints are
    rate limited on purpose, so calling this speculatively burns the budget and
    locks the account out mid-run."""
    return call("POST", "/api/auth/step-up", {"password": "strongpass123"})


def guarded(method, path, body=None):
    """Perform a step-up-protected write, elevating once if challenged."""
    s, d = call(method, path, body)
    if s == 403 and isinstance(d, dict) and d.get("code") == "REAUTH_REQUIRED":
        step_up()
        s, d = call(method, path, body)
    return s, d


print("=" * 70)
print("CHECK FRACTION NUMBER")
print("=" * 70)

# The account seeded by qa1 has a known routing number. The fraction is
# PP-YYYY/XXXX where YYYY = routing digits 5-8 and XXXX = routing digits 1-4,
# leading zeros stripped. PP is geographic and cannot be derived, so it must be
# supplied before any fraction is shown at all.
s, lst = call("GET", f"/api/businesses/{BIZ}/bank-accounts")
acct = next((a for a in (lst or []) if a.get("id") == ACCT), None) if isinstance(lst, list) else None
s = 200 if acct else 500
check("bank account is readable", s == 200 and isinstance(acct, dict), f"{s} {str(acct)[:150]}")

# Clear the prefix first so this holds on a re-run, not just a virgin database.
# The point being proved is that the fraction is never invented from the
# routing number alone — the ABA prefix has to come from the user.
guarded("PATCH", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}", {"fractionPrefix": ""})
_, lst0 = call("GET", f"/api/businesses/{BIZ}/bank-accounts")
bare = next((a for a in (lst0 or []) if a.get("id") == ACCT), {}) if isinstance(lst0, list) else {}
check(
    "fraction number is absent until a prefix is supplied",
    (bare or {}).get("fractionNumber") in (None, ""),
    f"got={(bare or {}).get('fractionNumber')!r}",
)
check(
    "bank account exposes a fractionNumber field",
    "fractionNumber" in (acct or {}),
    f"keys={sorted((acct or {}).keys())[:20]}",
)

s, d = guarded("PATCH", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}", {"fractionPrefix": "11"})
check("fraction prefix can be saved", s == 200, f"{s} {str(d)[:200]}")

fraction = (d or {}).get("fractionNumber")
check("fraction number is derived once the prefix exists", bool(fraction), f"got={fraction!r}")
if fraction:
    check(
        "fraction is formatted PP-YYYY/XXXX",
        fraction.count("-") == 1 and fraction.count("/") == 1,
        f"got={fraction!r}",
    )
    prefix, rest = fraction.split("-", 1)
    institution, routing_symbol = rest.split("/", 1)
    check("fraction keeps the supplied prefix", prefix == "11", f"got={prefix!r}")
    check(
        "fraction parts are numeric with no leading zeros",
        institution.isdigit()
        and routing_symbol.isdigit()
        and not institution.startswith("0")
        and not routing_symbol.startswith("0"),
        f"got={institution!r}/{routing_symbol!r}",
    )

    # Cross-check the derivation against the routing number itself rather than
    # against a hardcoded expectation, so this survives a reseed.
    s2, full = guarded("POST", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}/reveal", {})
    routing = (full or {}).get("routingNumber") if s2 == 200 else None
    if routing and len(routing) == 9:
        check(
            "institution digits come from routing digits 5-8",
            institution == str(int(routing[4:8])),
            f"routing={routing} inst={institution}",
        )
        check(
            "routing symbol comes from routing digits 1-4",
            routing_symbol == str(int(routing[0:4])),
            f"routing={routing} sym={routing_symbol}",
        )

for bad in ["0", "100", "abc", "-5"]:
    s, d = guarded("PATCH", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}", {"fractionPrefix": bad})
    # Coercion is the dangerous outcome here: "100" quietly becoming "10" would
    # print a wrong-but-plausible fraction on real stock. Demand an outright
    # rejection, and confirm nothing was written.
    check(f"invalid fraction prefix {bad!r} is rejected", s == 400, f"{s} {str(d)[:160]}")
    _, lst2 = call("GET", f"/api/businesses/{BIZ}/bank-accounts")
    cur = next((a for a in (lst2 or []) if a.get("id") == ACCT), {}) if isinstance(lst2, list) else {}
    check(
        f"invalid fraction prefix {bad!r} leaves the stored fraction untouched",
        (cur.get("fractionNumber") or "").startswith("11-"),
        f"got={cur.get('fractionNumber')!r}",
    )

# Restore a good prefix for the rest of the run.
guarded("PATCH", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}", {"fractionPrefix": "11"})

print()
print("=" * 70)
print("TEMPLATE ASSET LIBRARY")
print("=" * 70)

s, assets = call("GET", f"/api/businesses/{BIZ}/assets")
check("asset library lists", s == 200 and isinstance(assets, list), f"{s} {str(assets)[:150]}")

s, logo = call(
    "POST",
    f"/api/businesses/{BIZ}/assets",
    {"name": "Company mark", "kind": "business_logo", "mimeType": "image/png", "data": PNG_B64},
)
check("business logo uploads", s == 200 and (logo or {}).get("id"), f"{s} {str(logo)[:200]}")
LOGO = (logo or {}).get("id")

check(
    "asset metadata records a byte size",
    bool((logo or {}).get("byteSize")),
    f"got={(logo or {}).get('byteSize')!r}",
)
check(
    "asset listing never returns raw image bytes",
    isinstance(logo, dict) and LOGO and "data" not in logo,
    f"keys={sorted((logo or {}).keys())}",
)

s, listed = call("GET", f"/api/businesses/{BIZ}/assets")
check(
    "listed assets also omit raw bytes",
    s == 200 and all("data" not in a for a in (listed or [])),
    f"{s}",
)

if LOGO:
    s, body = call("GET", f"/api/assets/{LOGO}", raw=True)
    check("asset bytes are downloadable by id", s == 200 and len(body or "") > 0, f"{s}")

# A bank's logo is the bank's mark. The product must not make it a one-click
# paste, so an explicit statement of written authorization is required.
s, d = call(
    "POST",
    f"/api/businesses/{BIZ}/assets",
    {"name": "Bank mark", "kind": "bank_logo", "mimeType": "image/png", "data": PNG_B64},
)
check(
    "bank logo without an authorization attestation is refused",
    400 <= s < 500 and s not in (401, 403),
    f"{s} {str(d)[:200]}",
)

s, banklogo = call(
    "POST",
    f"/api/businesses/{BIZ}/assets",
    {
        "name": "Bank mark",
        "kind": "bank_logo",
        "mimeType": "image/png",
        "data": PNG_B64,
        "rightsAttested": True,
    },
)
check("bank logo with an attestation is accepted", s == 200 and (banklogo or {}).get("id"), f"{s} {str(banklogo)[:200]}")
check(
    "the attestation is timestamped on the record",
    bool((banklogo or {}).get("rightsAttestedAt")),
    f"got={(banklogo or {}).get('rightsAttestedAt')!r}",
)

s, d = call("GET", "/api/audit")
attested = [
    a
    for a in (d or [])
    if isinstance(a, dict) and "asset" in str(a.get("action", "")).lower()
]
check("asset creation is written to the audit log", len(attested) > 0, f"matches={len(attested)}")

s, d = call(
    "POST",
    f"/api/businesses/{BIZ}/assets",
    {"name": "Bad type", "kind": "business_logo", "mimeType": "image/svg+xml", "data": PNG_B64},
)
check("disallowed image types are refused", s == 400, f"{s} {str(d)[:200]}")

s, d = call(
    "POST",
    f"/api/businesses/{BIZ}/assets",
    {"name": "Not base64", "kind": "business_logo", "mimeType": "image/png", "data": "!!!!"},
)
check("non-base64 payloads are refused", s == 400, f"{s} {str(d)[:200]}")

s, d = call(
    "POST",
    f"/api/businesses/{BIZ}/assets",
    {"name": "Empty", "kind": "business_logo", "mimeType": "image/png", "data": ""},
)
check("empty payloads are refused", s == 400, f"{s} {str(d)[:200]}")

oversize = base64.b64encode(b"\x00" * (2 * 1024 * 1024 + 4096)).decode()
s, d = call(
    "POST",
    f"/api/businesses/{BIZ}/assets",
    {"name": "Huge", "kind": "business_logo", "mimeType": "image/png", "data": oversize},
)
check("oversized images are refused with 413", s == 413, f"{s} {str(d)[:200]}")

s, d = call("GET", f"/api/businesses/{BIZ2}/assets")
ids = [a.get("id") for a in (d or [])] if isinstance(d, list) else []
check(
    "another business cannot see this business's assets",
    LOGO is not None and (s in (403, 404) or (s == 200 and LOGO not in ids)),
    f"{s} ids={ids}",
)

print()
print("=" * 70)
print("TEMPLATE DESIGN AND BACKGROUND")
print("=" * 70)

design_elements = [
    {
        "id": "e-payee",
        "type": "field",
        "field": "payee",
        "x": 12,
        "y": 34,
        "w": 120,
        "h": 8,
        "z": 1,
        "fontFamily": "sans",
        "fontSize": 11,
        "bold": False,
        "visible": True,
    },
    {
        "id": "e-note",
        "type": "text",
        "text": "OPERATING ACCOUNT",
        "x": 12,
        "y": 8,
        "w": 60,
        "h": 6,
        "z": 2,
        "fontFamily": "serif",
        "fontSize": 9,
        "bold": True,
        "visible": True,
    },
    {"id": "e-rule", "type": "line", "x": 12, "y": 50, "w": 100, "h": 0.4, "z": 3, "visible": True},
    {"id": "e-box", "type": "rect", "x": 150, "y": 8, "w": 40, "h": 14, "z": 4, "visible": True},
]
if LOGO:
    design_elements.append(
        {"id": "e-logo", "type": "image", "assetId": LOGO, "x": 12, "y": 6, "w": 24, "h": 12, "z": 5, "visible": True}
    )

s, tpl = call(
    "POST",
    f"/api/businesses/{BIZ}/templates",
    {
        "name": "QA6 designed template",
        "layoutType": "business",
        "stockType": "blank",
        "elements": design_elements,
        "background": {"mode": "color", "color": "#eef4ff"},
    },
)
check("a designed template saves", s == 200 and (tpl or {}).get("id"), f"{s} {str(tpl)[:250]}")
TPL = (tpl or {}).get("id")

if TPL:
    s, got = call("GET", f"/api/businesses/{BIZ}/templates")
    row = next((t for t in (got or []) if t.get("id") == TPL), None)
    check("the saved template comes back", row is not None, f"{s}")
    if row:
        els = row.get("elements")
        if isinstance(els, str):
            els = json.loads(els)
        kinds = sorted({e.get("type") for e in (els or [])})
        check(
            "every element type round-trips",
            {"field", "text", "line", "rect"}.issubset(set(kinds)),
            f"kinds={kinds}",
        )
        note = next((e for e in (els or []) if e.get("id") == "e-note"), None)
        check(
            "text content and styling round-trip",
            note
            and note.get("text") == "OPERATING ACCOUNT"
            and note.get("bold") is True
            and note.get("fontFamily") == "serif"
            and note.get("fontSize") == 9,
            f"got={note}",
        )
        bg = row.get("background")
        if isinstance(bg, str):
            bg = json.loads(bg)
        check(
            "the background round-trips",
            isinstance(bg, dict) and bg.get("mode") == "color" and bg.get("color") == "#eef4ff",
            f"got={bg}",
        )
        if LOGO:
            img = next((e for e in (els or []) if e.get("type") == "image"), None)
            check("an image element keeps its asset reference", img and img.get("assetId") == LOGO, f"got={img}")

    # Background modes must all persist, including a pattern and an image with
    # an opacity, which is what the "how visible" control writes.
    for bg in [
        {"mode": "none"},
        {"mode": "pattern", "pattern": "diagonal", "color": "#d8d8d8", "opacity": 0.3},
        {"mode": "image", "assetId": LOGO, "opacity": 0.15} if LOGO else {"mode": "none"},
    ]:
        s, d = call("PATCH", f"/api/businesses/{BIZ}/templates/{TPL}", {"background": bg})
        back = (d or {}).get("background")
        if isinstance(back, str):
            back = json.loads(back)
        check(
            f"background mode {bg['mode']!r} persists",
            s == 200 and isinstance(back, dict) and back.get("mode") == bg["mode"],
            f"{s} got={back}",
        )
    if LOGO:
        s, d = call("GET", f"/api/businesses/{BIZ}/templates")
        row = next((t for t in (d or []) if t.get("id") == TPL), None)
        back = (row or {}).get("background")
        if isinstance(back, str):
            back = json.loads(back)
        check(
            "background image opacity survives the round trip",
            isinstance(back, dict) and abs(float(back.get("opacity", 0)) - 0.15) < 1e-6,
            f"got={back}",
        )

print()
print("=" * 70)
print("IN-USE DELETE GUARDS")
print("=" * 70)

# An asset placed on a template cannot vanish out from under it.
if LOGO and TPL:
    call("PATCH", f"/api/businesses/{BIZ}/templates/{TPL}", {"background": {"mode": "image", "assetId": LOGO, "opacity": 0.2}})
    s, d = guarded("DELETE", f"/api/assets/{LOGO}")
    check("an asset still used by a template cannot be deleted", s == 409, f"{s} {str(d)[:200]}")
    check("the refusal explains why", bool((d or {}).get("message")), f"got={str(d)[:200]}")

    call("PATCH", f"/api/businesses/{BIZ}/templates/{TPL}", {"background": {"mode": "none"}, "elements": []})
    s, d = guarded("DELETE", f"/api/assets/{LOGO}")
    check("an unused asset deletes cleanly", s in (200, 204), f"{s} {str(d)[:200]}")
    s, d = call("GET", f"/api/assets/{LOGO}")
    check("a deleted asset is gone", s == 404, f"{s}")

# A template attached to a bank account cannot vanish either.
if TPL:
    s, d = guarded("PATCH", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}", {"defaultTemplateId": TPL})
    check("a template can be set as an account default", s == 200, f"{s} {str(d)[:200]}")

    s, d = guarded("DELETE", f"/api/businesses/{BIZ}/templates/{TPL}")
    check("a template in use by an account cannot be deleted", s == 409, f"{s} {str(d)[:200]}")

    guarded("PATCH", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}", {"defaultTemplateId": None})
    s, d = guarded("DELETE", f"/api/businesses/{BIZ}/templates/{TPL}")
    check("an unreferenced template deletes cleanly", s in (200, 204), f"{s} {str(d)[:200]}")

print()
print("=" * 70)
print(f"PART 6: {P} passed, {F} failed")
print("=" * 70)
if NOTES:
    for n in NOTES:
        print(" -", n)

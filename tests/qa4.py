#!/usr/bin/env python3
"""QA part 4: reconciliation, positive pay, exports, templates, printers, permissions."""
import json, urllib.request, urllib.error, csv, io as _io

B = "http://localhost:5050"
P = F = 0
NOTES = []
S = json.load(open("/home/user/workspace/qa-state.json"))
OWNER, APPROVER, BIZ, ACCT = S["OWNER"], S["APPROVER"], S["BIZ"], S["ACCT"]

def call(method, path, body=None, token=OWNER, raw=False):
    req = urllib.request.Request(B + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=25) as r:
            t = r.read().decode()
            return r.status, (t if raw else (json.loads(t) if t else None))
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, (t if raw else json.loads(t))
        except Exception:
            return e.code, t

def check(name, cond, detail=""):
    global P, F
    if cond:
        P += 1; print(f"  PASS  {name}")
    else:
        F += 1; print(f"  FAIL  {name}  {detail}"); NOTES.append(f"{name}: {detail}")

print("=" * 70); print("CHECK NUMBER RECONCILIATION"); print("=" * 70)

s, d = call("GET", f"/api/businesses/{BIZ}/check-number-reconciliation/{ACCT}")
check("reconciliation screen returns data", s == 200 and isinstance(d, dict), f"{s} {str(d)[:150]}")
if s == 200:
    blob = json.dumps(d)
    check("reconciliation reports the expected next number",
          "nextNumber" in blob or "expectedNext" in blob, f"keys={list(d.keys())}")
    check("reconciliation reports issued/used numbers",
          any(k in blob for k in ["used", "issued", "checks", "numbers"]), f"keys={list(d.keys())}")
    check("reconciliation reports voided numbers",
          any(k in blob for k in ["voided", "voids"]), f"keys={list(d.keys())}")
    check("reconciliation reports gaps",
          any(k in blob for k in ["gaps", "missing", "skipped"]), f"keys={list(d.keys())}")

print(); print("=" * 70); print("POSITIVE PAY EXPORT"); print("=" * 70)

s, d = call("POST", f"/api/businesses/{BIZ}/positive-pay/{ACCT}", {})
if s == 403:
    call("POST", "/api/auth/step-up", {"password": "strongpass123"}, token=OWNER)
    s, d = call("POST", f"/api/businesses/{BIZ}/positive-pay/{ACCT}", {})
check("positive pay export requires step-up then succeeds", s == 200, f"{s} {str(d)[:200]}")
if s == 200:
    csv_text = d.get("csv") or d.get("content") or ""
    check("export returns CSV content", bool(csv_text), f"keys={list(d.keys())}")
    check("export records a checksum", bool(d.get("fileChecksum") or (d.get("export") or {}).get("fileChecksum")),
          f"keys={list(d.keys())}")
    rows = list(csv.reader(_io.StringIO(csv_text)))
    header = rows[0] if rows else []
    body = [r for r in rows[1:] if r]
    check("CSV has a header row", "check_number" in ",".join(header), str(header))
    check("CSV has at least one item", len(body) >= 1, f"{len(body)} rows")
    check("CSV never contains a full account number",
          "9876543210" not in csv_text, "FULL ACCOUNT NUMBER LEAKED INTO BANK FILE")
    check("CSV never contains a routing number",
          "121000358" not in csv_text, "ROUTING NUMBER LEAKED INTO BANK FILE")
    types = [r[6] for r in body if len(r) > 6]
    check("voided checks are reported as VOID records so the bank rejects them",
          "VOID" in types, f"issue types present: {sorted(set(types))}")
    check("payable checks are reported as ISSUE records", "ISSUE" in types, f"{sorted(set(types))}")
    # no draft/unprinted check may appear in a bank file
    s2, allc = call("GET", f"/api/businesses/{BIZ}/checks")
    drafts = {str(c["checkNumber"]) for c in allc if c["status"] in ("draft", "approved", "ready_to_print")}
    in_file = {r[2] for r in body if len(r) > 2}
    check("checks that were never printed are excluded from the bank file",
          not (drafts & in_file), f"leaked unprinted: {sorted(drafts & in_file)}")

s, d = call("GET", f"/api/businesses/{BIZ}/positive-pay")
check("export history is recorded", s == 200 and len(d) >= 1, f"{s} {len(d) if isinstance(d,list) else d}")

print(); print("=" * 70); print("CSV EXPORTS (user owns their data)"); print("=" * 70)

for name, path, needle in [
    ("checks", f"/api/businesses/{BIZ}/export/checks", "check_number"),
    ("payees", f"/api/businesses/{BIZ}/export/payees", "name"),
    ("audit", f"/api/businesses/{BIZ}/export/audit", "action"),
]:
    s, d = call("GET", path, raw=True)
    check(f"{name} export downloads as CSV", s == 200 and needle in (d or ""), f"{s} {str(d)[:80]}")
    if s == 200:
        check(f"{name} export contains no routing/account numbers",
              "121000358" not in d and "9876543210" not in d, "SENSITIVE DATA IN EXPORT")

print(); print("=" * 70); print("CHECK TEMPLATES / DESIGNER"); print("=" * 70)

s, d = call("GET", f"/api/businesses/{BIZ}/templates")
check("templates list loads", s == 200 and isinstance(d, list), f"{s}")
base_count = len(d) if isinstance(d, list) else 0
check("a default template exists out of the box", base_count >= 1, f"{base_count} templates")

s, d = call("POST", f"/api/businesses/{BIZ}/templates", {
    "name": "Voucher — Payroll", "stockType": "blank", "layoutType": "voucher"})
check("a new template can be created", s == 200 and d.get("id"), f"{s} {d}")
TPL = d.get("id")
if TPL:
    elements = d.get("elements")
    check("new template starts with positioned elements",
          bool(elements) and len(elements if isinstance(elements, list) else json.loads(elements)) > 0,
          f"elements={str(elements)[:80]}")
    s, d = call("PATCH", f"/api/businesses/{BIZ}/templates/{TPL}", {"name": "Voucher — Payroll v2"})
    check("a template can be renamed", s == 200 and d.get("name") == "Voucher — Payroll v2", f"{s} {d}")
    s, d = call("PATCH", f"/api/businesses/{BIZ}/templates/{TPL}",
                {"elements": [{"key": "payeeName", "x": 20, "y": 30, "w": 90, "h": 6, "fontSize": 11}]})
    check("element positions can be saved from the designer", s == 200, f"{s} {str(d)[:120]}")

print(); print("=" * 70); print("PRINTER PROFILES / CALIBRATION"); print("=" * 70)

s, d = call("GET", f"/api/businesses/{BIZ}/printers")
check("printer profiles list loads", s == 200 and isinstance(d, list), f"{s}")
s, d = call("POST", f"/api/businesses/{BIZ}/printers", {
    "name": "Front office HP", "stockType": "blank", "offsetX": 2, "offsetY": -3})
check("a printer profile can be created", s == 200 and d.get("id"), f"{s} {d}")
PR = d.get("id")
if PR:
    check("calibration offsets are stored",
          d.get("offsetX") == 2 and d.get("offsetY") == -3,
          f"x={d.get('offsetX')} y={d.get('offsetY')}")
    s, d = call("PATCH", f"/api/businesses/{BIZ}/printers/{PR}", {"offsetY": 1})
    check("calibration can be adjusted", s == 200 and d.get("offsetY") == 1, f"{s} {d}")

print(); print("=" * 70); print("ROLE PERMISSIONS ENFORCED SERVER-SIDE"); print("=" * 70)

# The approver role must not be able to manage bank accounts or create payees.
s, d = call("POST", f"/api/businesses/{BIZ}/bank-accounts", {
    "bankName": "Rogue Bank", "nickname": "Rogue", "routingNumber": "021000021",
    "accountNumber": "1111111111", "accountType": "checking"}, token=APPROVER)
check("approver cannot create a bank account", s >= 400, f"got {s} {str(d)[:120]}")
s, d = call("GET", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}/reveal", token=APPROVER)
check("approver cannot reveal bank details", s >= 400, f"got {s} {str(d)[:120]}")
s, d = call("POST", f"/api/businesses/{BIZ}/positive-pay/{ACCT}", {}, token=APPROVER)
check("approver cannot export positive pay", s >= 400, f"got {s} {str(d)[:120]}")

print(); print("=" * 70); print("BOOKKEEPER CAN ACTUALLY PRINT (permissions must not break the job)"); print("=" * 70)

call("POST", "/api/auth/step-up", {"password": "strongpass123"}, token=OWNER)
s, d = call("POST", f"/api/businesses/{BIZ}/members",
            {"email": "keeper@richco.test", "name": "Kim Keeper",
             "role": "bookkeeper", "password": "keeperpass123"}, token=OWNER)
check("a bookkeeper can be added", s in (200, 409), f"{s} {str(d)[:120]}")
s, d = call("POST", "/api/auth/login", {"email": "keeper@richco.test", "password": "keeperpass123"})
KEEP = d.get("sessionToken") if s == 200 else None
check("bookkeeper can sign in", bool(KEEP), f"{s} {str(d)[:120]}")
if KEEP:
    call("POST", "/api/auth/step-up", {"password": "keeperpass123"}, token=KEEP)
    s, d = call("GET", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}/reveal", token=KEEP)
    check("bookkeeper can read MICR data needed to print a check",
          s == 200 and d.get("routingNumber"), f"{s} {str(d)[:120]}")
    s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
        "bankAccountId": ACCT, "checkDate": "2026-08-22", "payeeName": "Office Supply Co",
        "amount": "125.00", "memo": "Paper"}, token=KEEP)
    check("bookkeeper can prepare a check", s == 200 and d.get("id"), f"{s} {str(d)[:120]}")
    BK = d.get("id")
    if BK:
        s, d = call("POST", f"/api/businesses/{BIZ}/checks/{BK}/approve", {}, token=KEEP)
        check("bookkeeper cannot approve their own check", s >= 400, f"got {s} {str(d)[:120]}")
        call("POST", "/api/auth/step-up", {"password": "approverpass123"}, token=APPROVER)
        s, d = call("POST", f"/api/businesses/{BIZ}/checks/{BK}/approve", {}, token=APPROVER)
        check("approver can approve the bookkeeper's check", s == 200, f"{s} {str(d)[:120]}")
        s, d = call("POST", f"/api/businesses/{BIZ}/checks/{BK}/print", {"testMode": False}, token=KEEP)
        check("bookkeeper can print the approved check", s == 200, f"{s} {str(d)[:150]}")
    s, d = call("POST", f"/api/businesses/{BIZ}/bank-accounts", {
        "bankName": "X", "nickname": "X", "routingNumber": "021000021",
        "accountNumber": "222", "accountType": "checking"}, token=KEEP)
    check("bookkeeper still cannot add bank accounts", s >= 400, f"got {s} {str(d)[:120]}")

print(); print("=" * 70); print("REPORTS"); print("=" * 70)

s, d = call("GET", f"/api/businesses/{BIZ}/checks?status=printed")
check("register can filter by status", s == 200 and all(c["status"] == "printed" for c in d),
      f"{s} statuses={sorted({c['status'] for c in d}) if isinstance(d,list) else d}")
s, d = call("GET", f"/api/businesses/{BIZ}/checks")
if isinstance(d, list) and d:
    total = sum(c["amountCents"] for c in d)
    check("register amounts are stored as integer cents (no float drift)",
          all(isinstance(c["amountCents"], int) for c in d), "non-integer cents found")
    check("register returns every check for the business", len(d) >= 10, f"{len(d)} checks")

print(); print("=" * 70)
print(f"PART 4: {P} passed, {F} failed")
if NOTES:
    print("\nFailures:")
    for n in NOTES: print("  -", n)
print("=" * 70)

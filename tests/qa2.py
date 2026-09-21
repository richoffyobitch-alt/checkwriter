#!/usr/bin/env python3
"""Functional QA part 2: payees, checks, written amount, line items, numbering."""
import json, urllib.request, urllib.error

B = "http://localhost:5050"
P = F = 0
NOTES = []
S = json.load(open("/home/user/workspace/qa-state.json"))
OWNER, BIZ, BIZ2, ACCT = S["OWNER"], S["BIZ"], S["BIZ2"], S["ACCT"]

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
            return e.code, json.loads(t)
        except Exception:
            return e.code, t

def check(name, cond, detail=""):
    global P, F
    if cond:
        P += 1; print(f"  PASS  {name}")
    else:
        F += 1; print(f"  FAIL  {name}  {detail}"); NOTES.append(f"{name}: {detail}")

print("=" * 70); print("PAYEES"); print("=" * 70)

s, d = call("POST", f"/api/businesses/{BIZ}/payees", {
    "name": "Apex Materials Co.", "type": "business",
    "addressLine1": "1200 Industrial Rd", "city": "Las Vegas", "state": "NV",
    "zip": "89102", "defaultMemo": "Materials invoice", "category": "Supplies",
    "internalNotes": "SECRET-INTERNAL-NOTE"})
check("create business payee", s == 200 and d.get("id"), f"{s} {d}")
PAYEE = d.get("id")

s, d = call("POST", f"/api/businesses/{BIZ}/payees", {
    "name": "Sarah Chen", "type": "individual", "city": "Reno", "state": "NV"})
check("create individual payee", s == 200 and d.get("id"), f"{s} {d}")
PAYEE2 = d.get("id")

s, d = call("POST", f"/api/businesses/{BIZ}/payees", {
    "name": "Apex Materials Co", "type": "business"})
check("near-duplicate payee is allowed (not auto-merged)", s == 200, f"{s}")
DUP = d.get("id")

s, d = call("GET", f"/api/businesses/{BIZ}/payees/duplicates")
found = False
if s == 200 and isinstance(d, list):
    for grp in d:
        ids = grp if isinstance(grp, list) else grp.get("ids", [])
        if PAYEE in ids and DUP in ids:
            found = True
check("duplicate detection groups the two Apex payees", found, f"{s} {json.dumps(d)[:200]}")
check("duplicates are only reported, never auto-merged",
      call("GET", f"/api/businesses/{BIZ}/payees")[1].__len__() == 3, "payee count changed")

s, d = call("GET", f"/api/businesses/{BIZ}/payees")
check("payee list returns all 3", s == 200 and len(d) == 3, f"{s} {len(d) if isinstance(d,list) else d}")

s, d = call("POST", f"/api/businesses/{BIZ}/payees/{DUP}/archive", {})
check("payee can be archived", s == 200, f"{s} {d}")
s, d = call("GET", f"/api/businesses/{BIZ}/payees")
check("archived payee hidden by default", len(d) == 2, str(len(d)))
s, d = call("GET", f"/api/businesses/{BIZ}/payees?includeArchived=true")
check("archived payee visible when requested", len(d) == 3, str(len(d)))

s, d = call("GET", f"/api/businesses/{BIZ2}/payees")
check("payees do not leak across businesses", s == 200 and len(d) == 0, f"{s} {d}")

print(); print("=" * 70); print("WRITTEN AMOUNT CORRECTNESS (legal amount line)"); print("=" * 70)

# US check convention: dollars spelled in words, cents as a fraction "NN/100".
cases = [
    ("1.00", "One and 00/100"),
    ("0.01", "Zero and 01/100"),
    ("0.99", "Zero and 99/100"),
    ("1.05", "One and 05/100"),
    ("10.00", "Ten and 00/100"),
    ("21.00", "Twenty-one and 00/100"),
    ("100.00", "One hundred and 00/100"),
    ("101.00", "One hundred one and 00/100"),
    ("1000.00", "One thousand and 00/100"),
    ("1234.56", "One thousand two hundred thirty-four and 56/100"),
    ("1000000.00", "One million and 00/100"),
    ("4827.50", "Four thousand eight hundred twenty-seven and 50/100"),
    ("15.10", "Fifteen and 10/100"),
    ("999999.99", "Nine hundred ninety-nine thousand nine hundred ninety-nine and 99/100"),
]
written = {}
for amt, expected in cases:
    s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
        "bankAccountId": ACCT, "checkDate": "2026-08-22",
        "payeeName": "Apex Materials Co.", "payeeId": PAYEE,
        "amount": amt, "memo": f"written-amount test {amt}"})
    if s != 200:
        check(f"written amount for ${amt}", False, f"HTTP {s} {d}")
        continue
    got = d.get("writtenAmount") or ""
    written[amt] = got
    check(f"${amt:>12} -> {got}", got == expected, f"expected '{expected}'")

s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
    "bankAccountId": ACCT, "checkDate": "2026-08-22",
    "payeeName": "Apex", "amount": "0"})
check("zero amount rejected", s >= 400, f"got {s}")

s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
    "bankAccountId": ACCT, "checkDate": "2026-08-22",
    "payeeName": "Apex", "amount": "-50.00"})
check("negative amount rejected", s >= 400, f"got {s}")

s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
    "bankAccountId": ACCT, "checkDate": "2026-08-22",
    "payeeName": "Apex", "amount": "abc"})
check("non-numeric amount rejected", s >= 400, f"got {s}")

print(); print("=" * 70); print("LINE ITEMS"); print("=" * 70)

s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
    "bankAccountId": ACCT, "checkDate": "2026-08-22",
    "payeeName": "Apex Materials Co.", "payeeId": PAYEE, "amount": "300.00",
    "memo": "line item test",
    "lineItems": [
        {"category": "Lumber", "department": "Ops", "amount": "100.00", "description": "2x4"},
        {"category": "Fixings", "project": "Site A", "amount": "200.00"}]})
check("check with line items created", s == 200, f"{s} {d}")
LICHECK = d.get("id")
if s == 200:
    s2, full = call("GET", f"/api/businesses/{BIZ}/checks/{LICHECK}")
    li = full.get("lineItems", []) if isinstance(full, dict) else []
    check("both line items persisted", len(li) == 2, str(len(li)))
    total = sum(x.get("amountCents", 0) for x in li)
    check("line item total equals check amount (30000c)", total == 30000, f"{total}c vs {full.get('amountCents')}c")

s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
    "bankAccountId": ACCT, "checkDate": "2026-08-22",
    "payeeName": "Apex", "amount": "300.00", "memo": "mismatched line items",
    "lineItems": [{"category": "A", "amount": "100.00"}, {"category": "B", "amount": "50.00"}]})
check("line items that do not sum to the amount are rejected", s >= 400,
      f"got {s} — allowing this lets the register disagree with the check face")

print(); print("=" * 70); print("CHECK NUMBERING"); print("=" * 70)

s, d = call("GET", f"/api/businesses/{BIZ}/checks")
nums = sorted(c["checkNumber"] for c in d) if s == 200 else []
check("numbering started at configured 1001", nums and nums[0] == 1001, str(nums[:3]))
check("numbers are sequential with no gaps",
      nums == list(range(nums[0], nums[0] + len(nums))) if nums else False,
      f"{nums}")
check("no duplicate check numbers issued", len(nums) == len(set(nums)), str(nums))

nxt = max(nums) + 1 if nums else 1001
s, d = call("GET", f"/api/businesses/{BIZ}/check-number-validate/{ACCT}/{nums[0]}")
check("validator reports an already-used number",
      s == 200 and d.get("valid") is False
      and any("already exists" in w for w in d.get("warnings", [])), f"{s} {d}")
s, d = call("GET", f"/api/businesses/{BIZ}/check-number-validate/{ACCT}/{nxt}")
check("validator accepts the next free number",
      s == 200 and d.get("valid") is True and not d.get("warnings"), f"{s} {d}")

s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
    "bankAccountId": ACCT, "checkDate": "2026-08-22", "payeeName": "Apex",
    "amount": "10.00", "checkNumberOverride": nums[0]})
check("duplicate check number override rejected", s >= 400, f"got {s} {d}")

# second bank account must have an independent sequence
s, d = call("POST", f"/api/businesses/{BIZ}/bank-accounts", {
    "bankName": "Valley Credit Union", "nickname": "Payroll",
    "routingNumber": "021000021", "accountNumber": "5551234567",
    "accountType": "checking", "checkStartingNumber": 7001}, token=OWNER)
ACCT2 = d.get("id") if s == 200 else None
check("second bank account created", s == 200 and ACCT2, f"{s} {d}")
s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
    "bankAccountId": ACCT2, "checkDate": "2026-08-22",
    "payeeName": "Sarah Chen", "payeeId": PAYEE2, "amount": "500.00"})
check("second account numbers independently from 7001",
      s == 200 and d.get("checkNumber") == 7001, f"{s} got {d.get('checkNumber')}")

# restricted account must refuse issuance
s, d = call("PATCH", f"/api/businesses/{BIZ}/bank-accounts/{ACCT2}", {"status": "restricted"})
check("account can be set to restricted", s == 200, f"{s} {d}")
s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
    "bankAccountId": ACCT2, "checkDate": "2026-08-22",
    "payeeName": "Sarah Chen", "amount": "100.00"})
check("issuance from restricted account blocked", s >= 400, f"got {s} {d}")
call("PATCH", f"/api/businesses/{BIZ}/bank-accounts/{ACCT2}", {"status": "active"})

# cross-business bank account must be refused
s, d = call("POST", f"/api/businesses/{BIZ2}/checks", {
    "bankAccountId": ACCT, "checkDate": "2026-08-22",
    "payeeName": "X", "amount": "10.00"})
check("cannot draw on another business's bank account", s >= 400, f"got {s} {d}")

S.update({"PAYEE": PAYEE, "PAYEE2": PAYEE2, "ACCT2": ACCT2, "LICHECK": LICHECK,
          "FIRSTNUM": nums[0] if nums else None})
json.dump(S, open("/home/user/workspace/qa-state.json", "w"))

print(); print("=" * 70)
print(f"PART 2: {P} passed, {F} failed")
if NOTES:
    print("\nFailures:")
    for n in NOTES: print("  -", n)
print("=" * 70)

#!/usr/bin/env python3
"""QA part 3: approval workflow, segregation of duties, immutability, void/reissue, print."""
import json, urllib.request, urllib.error

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
            return e.code, json.loads(t)
        except Exception:
            return e.code, t

def check(name, cond, detail=""):
    global P, F
    if cond:
        P += 1; print(f"  PASS  {name}")
    else:
        F += 1; print(f"  FAIL  {name}  {detail}"); NOTES.append(f"{name}: {detail}")

def mk(amount, memo="wf", token=OWNER):
    s, d = call("POST", f"/api/businesses/{BIZ}/checks", {
        "bankAccountId": ACCT, "checkDate": "2026-08-22",
        "payeeName": "Apex Materials Co.", "amount": amount, "memo": memo}, token=token)
    return d.get("id") if s == 200 else None

def status(cid, token=OWNER):
    s, d = call("GET", f"/api/businesses/{BIZ}/checks/{cid}", token=token)
    return d.get("status") if s == 200 else f"HTTP{s}"

print("=" * 70); print("DRAFT EDITING (must be freely editable before issuance)"); print("=" * 70)

c = mk("250.00", "editable draft")
check("new check starts as a draft", status(c) == "draft", status(c))
s, d = call("PATCH", f"/api/businesses/{BIZ}/checks/{c}", {"amount": "275.00", "memo": "edited"})
check("draft amount can be edited", s == 200, f"{s} {d}")
s, d = call("GET", f"/api/businesses/{BIZ}/checks/{c}")
check("edited draft shows new amount", d.get("amountCents") == 27500, f"{d.get('amountCents')}")
check("written amount recalculated on edit",
      d.get("writtenAmount") == "Two hundred seventy-five and 00/100", d.get("writtenAmount"))
s, d = call("PATCH", f"/api/businesses/{BIZ}/checks/{c}", {"payeeName": "New Payee LLC"})
check("draft payee can be edited", s == 200, f"{s}")

print(); print("=" * 70); print("APPROVAL WORKFLOW (owner is a complete approval chain)"); print("=" * 70)

# A sole owner holds every permission, so they must be able to approve their own
# check at ANY amount. Blocking self-approval would leave a one-person business
# unable to issue its own payments.
small = mk("100.00", "standard band")
s, d = call("POST", f"/api/businesses/{BIZ}/checks/{small}/approve", {})
check("owner may self-approve a small check", s == 200, f"{s} {d}")

big = mk("5000.00", "elevated band")
s, d = call("POST", f"/api/businesses/{BIZ}/checks/{big}/approve", {})
check("owner may self-approve a $5,000 check", s == 200, f"{s} {d}")
check("self-approved check reaches approved status", status(big) == "approved", status(big))

huge = mk("25000.00", "high-value band")
s, d = call("POST", f"/api/businesses/{BIZ}/checks/{huge}/approve", {})
check("owner may self-approve a $25,000 check", s == 200, f"{s} {d}")

# Self-approval is allowed, but it must stay fully attributable.
s, d = call("GET", f"/api/businesses/{BIZ}/checks/{huge}")
check("self-approval records the owner as the approver",
      bool(d.get("approverId")) and d.get("approverId") == d.get("preparerId"),
      f"preparer={d.get('preparerId')} approver={d.get('approverId')}")

s, d = call("GET", f"/api/businesses/{BIZ}/audit")
entries = d if isinstance(d, list) else (d.get("entries") or d.get("rows") or [])
def _self_approved(e):
    """newValue is stored as a JSON string, so parse it rather than substring-matching."""
    if e.get("action") != "check.approve":
        return False
    nv = e.get("newValue")
    if isinstance(nv, str):
        try:
            nv = json.loads(nv)
        except ValueError:
            return False
    return bool(isinstance(nv, dict) and nv.get("selfApproved"))

self_marked = [e for e in entries if _self_approved(e)]
check("audit log flags the approval as self-approved", len(self_marked) > 0,
      f"scanned {len(entries)} audit entries, found {len(self_marked)} self-approved markers")

# Delegated approval still works when the owner has added a second user.
delegated = mk("7500.00", "approved by someone else")
s, d = call("POST", f"/api/businesses/{BIZ}/checks/{delegated}/approve", {}, token=APPROVER)
check("a second authorized user can still approve", s == 200, f"{s} {d}")
s, d = call("GET", f"/api/businesses/{BIZ}/checks/{delegated}")
check("delegated approval records approver separately from preparer",
      bool(d.get("approverId")) and d.get("approverId") != d.get("preparerId"),
      f"preparer={d.get('preparerId')} approver={d.get('approverId')}")

print(); print("=" * 70); print("PRINT GATING (must not print an unapproved check)"); print("=" * 70)

unappr = mk("400.00", "never approved")
s, d = call("POST", f"/api/businesses/{BIZ}/checks/{unappr}/print", {})
check("cannot print a check that was never approved or signed",
      s >= 400, f"got {s} status now {status(unappr)} — printing a draft bypasses approval")

s, d = call("POST", f"/api/businesses/{BIZ}/checks/{big}/sign", {})
check("approved check can be signed", s == 200, f"{s} {d}")
check("signing moves it to ready_to_print", status(big) == "ready_to_print", status(big))

print(); print("=" * 70); print("TEST PRINT MUST NOT CONSUME A REAL CHECK"); print("=" * 70)

tp = mk("123.45", "test print target")
call("POST", f"/api/businesses/{BIZ}/checks/{tp}/approve", {}, token=APPROVER)
call("POST", f"/api/businesses/{BIZ}/checks/{tp}/sign", {}, token=APPROVER)
before = status(tp)
s, d = call("POST", f"/api/businesses/{BIZ}/checks/{tp}/print", {"testMode": True})
after = status(tp)
check("a TEST/VOID calibration print does not mark the check as printed",
      after != "printed", f"status went {before} -> {after} on a test print")

print(); print("=" * 70); print("POST-ISSUANCE IMMUTABILITY"); print("=" * 70)

s, d = call("POST", f"/api/businesses/{BIZ}/checks/{big}/print", {})
check("signed check can be printed", s == 200, f"{s} {d}")
check("printed status recorded", status(big) == "printed", status(big))
s, d = call("GET", f"/api/businesses/{BIZ}/checks/{big}")
check("immutable snapshot captured at print time", bool(d.get("issuedSnapshot")), "no snapshot")
snap = json.loads(d.get("issuedSnapshot") or "{}")
check("snapshot records the amount actually printed", snap.get("amountCents") == 500000,
      str(snap.get("amountCents")))

for field, val in [("amount", "9999.00"), ("payeeName", "Fraudulent Payee"),
                   ("memo", "altered"), ("checkDate", "2026-01-01")]:
    s, d = call("PATCH", f"/api/businesses/{BIZ}/checks/{big}", {field: val})
    check(f"printed check cannot be silently edited ({field})", s >= 400, f"got {s}")

s, d = call("GET", f"/api/businesses/{BIZ}/checks/{big}")
check("printed check amount unchanged after edit attempts", d.get("amountCents") == 500000,
      str(d.get("amountCents")))

print(); print("=" * 70); print("VOID / REISSUE / REPRINT — reason and audit required"); print("=" * 70)

s, d = call("POST", f"/api/businesses/{BIZ}/checks/{big}/void", {})
check("void without a reason is rejected", s >= 400, f"got {s} {d}")
s, d = call("POST", f"/api/businesses/{BIZ}/checks/{big}/void", {"reason": "Lost in mail"})
check("void with a reason succeeds", s == 200, f"{s} {d}")
check("voided status recorded", status(big) == "voided", status(big))
s, d = call("PATCH", f"/api/businesses/{BIZ}/checks/{big}", {"amount": "1.00"})
check("voided check cannot be edited", s >= 400, f"got {s}")

rp = mk("777.00", "reprint target")
call("POST", f"/api/businesses/{BIZ}/checks/{rp}/approve", {}, token=APPROVER)
call("POST", f"/api/businesses/{BIZ}/checks/{rp}/sign", {}, token=APPROVER)
call("POST", f"/api/businesses/{BIZ}/checks/{rp}/print", {})
s, d = call("POST", f"/api/businesses/{BIZ}/checks/{rp}/reprint", {})
check("reprint without a reason is rejected", s >= 400, f"got {s}")
s, d = call("POST", f"/api/businesses/{BIZ}/checks/{rp}/reprint", {"reason": "Printer jam"})
check("reprint with a reason succeeds", s == 200, f"{s} {d}")
s, d = call("GET", f"/api/businesses/{BIZ}/checks/{rp}")
check("reprint keeps the same check number", d.get("checkNumber") is not None, "number lost")

s, d = call("POST", f"/api/businesses/{BIZ}/checks/{big}/replace", {"reason": "Reissue after void"})
check("voided check can be replaced by a new check", s == 200, f"{s} {d}")
if s == 200:
    newid = d.get("id") or (d.get("replacement") or {}).get("id")
    check("replacement is a new check with a new number", bool(newid) and newid != big, f"{newid}")

print(); print("=" * 70); print("AUDIT TRAIL"); print("=" * 70)

s, d = call("GET", f"/api/businesses/{BIZ}/audit")
events = d if isinstance(d, list) else d.get("events", [])
acts = [e.get("action") for e in events]
for want in ["check.create", "check.approve", "check.sign", "check.print",
             "check.void", "check.reprint"]:
    check(f"audit records {want}", want in acts, f"missing; saw {sorted(set(acts))[:12]}")
voids = [e for e in events if e.get("action") == "check.void"]
check("void audit entry stores the stated reason",
      any("Lost in mail" in json.dumps(e) for e in voids), "reason not stored")
check("audit entries are attributed to a user",
      all(e.get("userId") for e in events[:20]), "missing userId")

S.update({"BIGCHECK": big, "RPCHECK": rp, "SMALL": small})
json.dump(S, open("/home/user/workspace/qa-state.json", "w"))

print(); print("=" * 70)
print(f"PART 3: {P} passed, {F} failed")
if NOTES:
    print("\nFailures:")
    for n in NOTES: print("  -", n)
print("=" * 70)

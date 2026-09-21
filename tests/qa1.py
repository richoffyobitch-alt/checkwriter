#!/usr/bin/env python3
"""Functional QA part 1: setup, auth, businesses, isolation, bank accounts."""
import json, urllib.request, urllib.error

B = "http://localhost:5050"
P = F = 0
NOTES = []

def call(method, path, body=None, token=None, raw=False):
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
        P += 1
        print(f"  PASS  {name}")
    else:
        F += 1
        print(f"  FAIL  {name}  {detail}")
        NOTES.append(f"{name}: {detail}")

print("=" * 70)
print("SETUP WIZARD & AUTH")
print("=" * 70)

s, d = call("GET", "/api/system/status")
check("empty install reports needsSetup=true", d.get("needsSetup") is True, str(d))

# weak password must be rejected
s, d = call("POST", "/api/setup/first-admin", {
    "email": "owner@richco.test", "name": "Rich Owner", "password": "short",
    "legalName": "RichCo LLC", "addressLine1": "500 Casino Center Blvd",
    "city": "Las Vegas", "state": "NV", "zip": "89101"})
check("setup rejects password under 10 chars", s == 400, f"got {s}")

# missing business fields rejected
s, d = call("POST", "/api/setup/first-admin", {
    "email": "owner@richco.test", "name": "Rich Owner", "password": "strongpass123"})
check("setup rejects missing business fields", s == 400, f"got {s}")

# valid setup
s, d = call("POST", "/api/setup/first-admin", {
    "email": "owner@richco.test", "name": "Rich Owner", "password": "strongpass123",
    "legalName": "RichCo Holdings LLC", "dba": "RichCo",
    "addressLine1": "500 Casino Center Blvd", "city": "Las Vegas",
    "state": "NV", "zip": "89101", "phone": "(702) 555-0100",
    "defaultSigner": "Rich Owner"})
check("setup creates admin + business", s == 200 and d.get("sessionToken"), f"{s} {d}")
OWNER = d.get("sessionToken", "")
BIZ = d.get("businessId")

s, d = call("POST", "/api/setup/first-admin", {
    "email": "attacker@evil.test", "name": "X", "password": "strongpass123",
    "legalName": "Evil", "addressLine1": "1 X", "city": "Y", "state": "NV", "zip": "89101"})
check("second setup attempt blocked (409)", s == 409, f"got {s}")

s, d = call("GET", "/api/system/status")
check("needsSetup flips to false", d.get("needsSetup") is False, str(d))

s, d = call("GET", "/api/auth/me", token=OWNER)
check("owner session works", s == 200 and d.get("email") == "owner@richco.test", f"{s} {d}")

s, d = call("GET", "/api/businesses")
check("unauthenticated request rejected (401)", s == 401, f"got {s}")

s, d = call("POST", "/api/auth/login", {"email": "owner@richco.test", "password": "wrongpass999"})
check("wrong password rejected", s == 401, f"got {s}")

s, d = call("POST", "/api/auth/login", {"email": "owner@richco.test", "password": "strongpass123"})
check("correct password logs in", s == 200 and d.get("sessionToken"), f"got {s}")

# demo seed endpoint must be gone in production mode
s, d = call("POST", "/api/seed", {}, token=OWNER)
check("demo seed endpoint disabled (404)", s == 404, f"got {s} {d}")

# second user for approval testing
s, d = call("POST", "/api/auth/register", {
    "email": "approver@richco.test", "name": "Ann Approver", "password": "approverpass123"})
check("second user can register", s == 200 and d.get("sessionToken"), f"{s} {d}")
APPROVER = d.get("sessionToken", "")

print()
print("=" * 70)
print("BUSINESS ISOLATION (cross-tenant leakage)")
print("=" * 70)

s, d = call("GET", "/api/businesses", token=OWNER)
check("owner sees exactly 1 business", s == 200 and len(d) == 1, f"{s} {d}")

s, d = call("POST", "/api/businesses", {
    "legalName": "Second Venture LLC", "addressLine1": "9 Fremont St",
    "city": "Las Vegas", "state": "NV", "zip": "89101"}, token=OWNER)
check("owner can create a 2nd business", s == 200 and d.get("id"), f"{s} {d}")
BIZ2 = d.get("id")

s, d = call("GET", "/api/businesses", token=OWNER)
check("owner now sees 2 businesses", len(d) == 2, str(len(d)))

s, d = call("GET", "/api/businesses", token=APPROVER)
check("other user sees 0 businesses (no leakage)", s == 200 and len(d) == 0, f"{s} {d}")

s, d = call("GET", f"/api/businesses/{BIZ}", token=APPROVER)
check("other user cannot read business by id", s in (403, 404), f"got {s}")

s, d = call("GET", f"/api/businesses/{BIZ}/checks", token=APPROVER)
check("other user cannot list another's checks", s in (403, 404), f"got {s}")

print()
print("=" * 70)
print("BANK ACCOUNTS: validation, masking, encryption, reveal")
print("=" * 70)

s, d = call("POST", f"/api/businesses/{BIZ}/bank-accounts", {
    "bankName": "First National Bank", "nickname": "Operations Checking",
    "routingNumber": "121000358", "accountNumber": "9876543210",
    "accountType": "checking", "checkStartNumber": 1001}, token=OWNER)
check("create bank account with valid routing", s == 200 and d.get("id"), f"{s} {d}")
ACCT = d.get("id")
check("routing validated as correct checksum", d.get("routingValid") is True, str(d.get("routingValid")))

s, d = call("POST", f"/api/businesses/{BIZ}/bank-accounts", {
    "bankName": "Bad Bank", "nickname": "Bad Routing",
    "routingNumber": "121000359", "accountNumber": "1111222233",
    "accountType": "checking", "checkStartNumber": 1}, token=OWNER)
BADACCT = d.get("id") if s == 200 else None
check("invalid routing checksum flagged", s == 200 and d.get("routingValid") is False,
      f"{s} routingValid={d.get('routingValid')}")

s, d = call("GET", f"/api/businesses/{BIZ}/bank-accounts", token=OWNER)
acct = next((a for a in d if a["id"] == ACCT), {})
check("list never returns full account number",
      "accountNumber" not in acct and "accountEncrypted" not in acct, str(list(acct.keys())))
check("list returns only last 4", acct.get("accountLast4") == "3210", str(acct.get("accountLast4")))
check("list never returns routing number",
      "routingNumber" not in acct and "routingEncrypted" not in acct, str(list(acct.keys())))

s, d = call("GET", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}/reveal", token=OWNER)
check("reveal blocked without step-up (403 REAUTH_REQUIRED)",
      s == 403 and (d.get("code") == "REAUTH_REQUIRED" if isinstance(d, dict) else False),
      f"{s} {d}")

s, d = call("POST", "/api/auth/step-up", {"password": "wrongpass999"}, token=OWNER)
check("step-up rejects wrong password", s == 401, f"got {s}")

s, d = call("POST", "/api/auth/step-up", {"password": "strongpass123"}, token=OWNER)
check("step-up succeeds with correct password", s == 200, f"{s} {d}")

s, d = call("GET", f"/api/businesses/{BIZ}/bank-accounts/{ACCT}/reveal", token=OWNER)
check("reveal returns full numbers after step-up",
      s == 200 and d.get("routingNumber") == "121000358" and d.get("accountNumber") == "9876543210",
      f"{s} {d}")

print()
print("=" * 70)
print("TEAM MEMBERSHIP (needed for segregation of duties)")
print("=" * 70)

# a business with one user cannot issue checks >= $1,000, so a second
# authorized user must be addable.
s, d = call("GET", f"/api/businesses/{BIZ}/members", token=OWNER)
check("member list shows the owner", s == 200 and len(d) == 1 and d[0]["role"] == "owner", f"{s} {d}")

# A brand-new sign-in has no step-up session, so granting check authority must
# be refused until the password is re-confirmed.
s, d = call("POST", "/api/auth/login",
            {"email": "owner@richco.test", "password": "strongpass123"})
FRESH = d.get("sessionToken") if s == 200 else None
check("owner can sign in again for a fresh session", bool(FRESH), f"{s} {d}")
s, d = call("POST", f"/api/businesses/{BIZ}/members",
            {"email": "approver@richco.test", "role": "approver"}, token=FRESH)
check("adding a user requires step-up re-authentication",
      s == 403 and d.get("code") == "REAUTH_REQUIRED", f"got {s} {d}")

s, d = call("POST", "/api/auth/step-up", {"password": "strongpass123"}, token=FRESH)
check("owner can start a step-up session", s == 200, f"{s} {d}")

s, d = call("POST", f"/api/businesses/{BIZ}/members",
            {"email": "approver@richco.test", "role": "approver"}, token=FRESH)
check("existing user can be added as approver", s == 200 and d.get("role") == "approver", f"{s} {d}")

s, d = call("POST", f"/api/businesses/{BIZ}/members",
            {"email": "approver@richco.test", "role": "approver"}, token=OWNER)
check("adding the same user twice is rejected", s == 409, f"got {s} {d}")

s, d = call("POST", f"/api/businesses/{BIZ}/members",
            {"email": "nobody@richco.test", "role": "bookkeeper"}, token=OWNER)
check("a brand new user needs an initial password", s == 400, f"got {s} {d}")

s, d = call("POST", f"/api/businesses/{BIZ}/members",
            {"email": "clerk@richco.test", "name": "Clerk", "role": "bookkeeper",
             "password": "clerkpass123"}, token=OWNER)
check("a brand new user can be created with a password", s == 200, f"{s} {d}")
CLERK = d.get("userId")

s, d = call("POST", f"/api/businesses/{BIZ}/members",
            {"email": "x@richco.test", "role": "wizard", "password": "whatever123"}, token=OWNER)
check("an unknown role is rejected", s == 400, f"got {s} {d}")

s, d = call("GET", f"/api/businesses/{BIZ}/members", token=OWNER)
check("member list now shows three users", s == 200 and len(d) == 3, f"{len(d) if isinstance(d,list) else d}")
check("member list never exposes password hashes",
      "passwordHash" not in json.dumps(d) and "hash" not in json.dumps(d).lower(), "hash leaked")

s, d = call("PATCH", f"/api/businesses/{BIZ}/members/{CLERK}", {"role": "signer"}, token=OWNER)
check("a member's role can be changed", s == 200, f"{s} {d}")

owner_id = [m for m in call("GET", f"/api/businesses/{BIZ}/members", token=OWNER)[1] if m["role"] == "owner"][0]["userId"]
s, d = call("PATCH", f"/api/businesses/{BIZ}/members/{owner_id}", {"role": "viewer"}, token=OWNER)
check("the only owner cannot be demoted", s == 400, f"got {s} {d}")
s, d = call("DELETE", f"/api/businesses/{BIZ}/members/{owner_id}", token=OWNER)
check("the only owner cannot be removed", s == 400, f"got {s} {d}")

s, d = call("DELETE", f"/api/businesses/{BIZ}/members/{CLERK}", token=OWNER)
check("a member can be removed", s == 200, f"{s} {d}")
s, d = call("GET", f"/api/businesses/{BIZ}/members", token=OWNER)
check("removed member no longer has access", len(d) == 2, str(len(d)))

# a non-owner must not be able to grant themselves rights
s, d = call("POST", f"/api/auth/step-up", {"password": "approverpass123"}, token=APPROVER)
s, d = call("POST", f"/api/businesses/{BIZ}/members",
            {"email": "sneaky@richco.test", "role": "owner", "password": "sneaky12345"},
            token=APPROVER)
check("an approver cannot add users or grant owner", s == 403, f"got {s} {d}")

json.dump({"OWNER": OWNER, "APPROVER": APPROVER, "BIZ": BIZ, "BIZ2": BIZ2,
           "ACCT": ACCT, "BADACCT": BADACCT}, open("/home/user/workspace/qa-state.json", "w"))

print()
print("=" * 70)
print(f"PART 1: {P} passed, {F} failed")
if NOTES:
    print("\nFailures:")
    for n in NOTES:
        print("  -", n)
print("=" * 70)

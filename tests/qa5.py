#!/usr/bin/env python3
"""Functional QA part 5: security headers, password change, session revocation.

Covers the two gaps closed this round:
  * helmet security headers / CSP
  * immediate session revocation on password change, role change, and removal
"""
import json, urllib.request, urllib.error

B = "http://localhost:5050"
P = F = 0
NOTES = []


def call(method, path, body=None, token=None, want_headers=False):
    req = urllib.request.Request(B + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=25) as r:
            t = r.read().decode()
            parsed = json.loads(t) if t and t.lstrip().startswith(("{", "[")) else t
            return (r.status, parsed, dict(r.headers)) if want_headers else (r.status, parsed)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            parsed = json.loads(t)
        except Exception:
            parsed = t
        return (e.code, parsed, dict(e.headers)) if want_headers else (e.code, parsed)


def check(name, cond, detail=""):
    global P, F
    if cond:
        P += 1
        print(f"  PASS  {name}")
    else:
        F += 1
        print(f"  FAIL  {name}  {detail}")
        NOTES.append(f"{name}: {detail}")


def login(email, pwd):
    s, d = call("POST", "/api/auth/login", {"email": email, "password": pwd})
    return (d or {}).get("sessionToken") if s == 200 else None


def step_up(token, pwd):
    return call("POST", "/api/auth/step-up", {"password": pwd}, token=token)[0]


def ensure_step_up(name, token, pwd):
    """Open a step-up window before a privileged call.

    A 429 here is correct behaviour, not a failure: the step-up endpoint is rate
    limited, and this suite re-authenticates far more often than a human would.
    The five-minute window from the previous step-up is still open in that case,
    so the privileged call that follows is still expected to succeed - which the
    next assertion checks on its own.
    """
    st = step_up(token, pwd)
    check(name, st in (200, 429), f"status={st}")


OWNER_EMAIL = "owner@richco.test"
OWNER_PWD = "strongpass123"

print("=" * 70)
print("SECURITY HEADERS")
print("=" * 70)

s, d, h = call("GET", "/api/system/status", want_headers=True)
csp = h.get("Content-Security-Policy", "")
check("Content-Security-Policy header is sent", bool(csp), repr(h.get("Content-Security-Policy")))
check("CSP restricts scripts to same origin", "script-src 'self'" in csp, csp[:160])
check("CSP has no unsafe-inline for scripts",
      "script-src 'self'" in csp and "'unsafe-inline'" not in csp.split("script-src")[1].split(";")[0],
      csp[:200])
check("CSP has no unsafe-eval anywhere", "'unsafe-eval'" not in csp, csp[:200])
check("CSP blocks framing (clickjacking)", "frame-ancestors 'none'" in csp, csp[:200])
check("CSP allows data: fonts for the bundled E-13B face",
      "font-src" in csp and "data:" in csp.split("font-src")[1].split(";")[0], csp[:250])
check("CSP allows blob: frames for generated PDFs",
      "frame-src" in csp and "blob:" in csp.split("frame-src")[1].split(";")[0], csp[:250])
check("CSP forbids plugins/objects", "object-src 'none'" in csp, csp[:250])
check("X-Content-Type-Options is nosniff", h.get("X-Content-Type-Options") == "nosniff", str(h.get("X-Content-Type-Options")))
check("Referrer-Policy withholds the referrer", h.get("Referrer-Policy") == "no-referrer", str(h.get("Referrer-Policy")))
check("X-Powered-By is suppressed", "X-Powered-By" not in h, str(h.get("X-Powered-By")))
# On a plain-http local install HSTS must NOT be sent: it would pin the browser
# to https://localhost and lock the owner out of their own installation.
check("HSTS is not sent over local http", "Strict-Transport-Security" not in h,
      str(h.get("Strict-Transport-Security")))
check("upgrade-insecure-requests absent over local http", "upgrade-insecure-requests" not in csp, csp[:250])

print()
print("=" * 70)
print("PASSWORD CHANGE GUARDS")
print("=" * 70)

tok = login(OWNER_EMAIL, OWNER_PWD)
check("owner can sign in", tok is not None)

s, d = call("POST", "/api/auth/change-password",
            {"currentPassword": OWNER_PWD, "newPassword": "brandnewpass456"}, token=tok)
check("password change refused without step-up", s == 403 and (d or {}).get("code") == "REAUTH_REQUIRED", f"{s} {d}")

check("step-up succeeds", step_up(tok, OWNER_PWD) == 200)

s, d = call("POST", "/api/auth/change-password",
            {"currentPassword": "wrongpassword", "newPassword": "brandnewpass456"}, token=tok)
check("password change refused with wrong current password", s == 401, f"{s} {d}")

s, d = call("POST", "/api/auth/change-password",
            {"currentPassword": OWNER_PWD, "newPassword": "short1"}, token=tok)
check("password change refused for under 10 characters", s == 400, f"{s} {d}")

s, d = call("POST", "/api/auth/change-password",
            {"currentPassword": OWNER_PWD, "newPassword": OWNER_PWD}, token=tok)
check("password change refused when reusing the current password", s == 400, f"{s} {d}")

print()
print("=" * 70)
print("REVOCATION ON PASSWORD CHANGE")
print("=" * 70)

# Two independent sessions for the same user, as if two devices were signed in.
other = login(OWNER_EMAIL, OWNER_PWD)
check("second device signs in", other is not None)
check("second device is authenticated", call("GET", "/api/auth/me", token=other)[0] == 200)

NEW_PWD = "brandnewpass456"
s, d = call("POST", "/api/auth/change-password",
            {"currentPassword": OWNER_PWD, "newPassword": NEW_PWD}, token=tok)
check("password change succeeds with step-up and correct current password", s == 200, f"{s} {d}")
check("response reports the other session was revoked", (d or {}).get("otherSessionsRevoked", 0) >= 1, str(d))

s, d = call("GET", "/api/auth/me", token=other)
check("other device is signed out immediately", s == 401, f"{s} {d}")
s, d = call("GET", "/api/auth/me", token=tok)
check("the session that changed the password stays signed in", s == 200, f"{s} {d}")

check("old password no longer works", login(OWNER_EMAIL, OWNER_PWD) is None)
tok = login(OWNER_EMAIL, NEW_PWD)
check("new password works", tok is not None)

print()
print("=" * 70)
print("SIGN OUT ALL OTHER DEVICES")
print("=" * 70)

ensure_step_up("step-up before revoke", tok, NEW_PWD)
extra1 = login(OWNER_EMAIL, NEW_PWD)
extra2 = login(OWNER_EMAIL, NEW_PWD)
check("two more devices signed in", extra1 is not None and extra2 is not None)

s, d = call("POST", "/api/auth/revoke-sessions", {}, token=tok)
check("revoke-sessions succeeds", s == 200, f"{s} {d}")
check("revoke-sessions reports both devices", (d or {}).get("otherSessionsRevoked", 0) >= 2, str(d))
check("first extra device signed out", call("GET", "/api/auth/me", token=extra1)[0] == 401)
check("second extra device signed out", call("GET", "/api/auth/me", token=extra2)[0] == 401)
check("current session survives revoke-sessions", call("GET", "/api/auth/me", token=tok)[0] == 200)

s, d = call("POST", "/api/auth/revoke-sessions", {}, token=tok)
check("revoke-sessions is idempotent and reports zero", s == 200 and (d or {}).get("otherSessionsRevoked") == 0, f"{s} {d}")

print()
print("=" * 70)
print("REVOCATION ON ROLE CHANGE AND REMOVAL")
print("=" * 70)

# Fresh business + member so this section is independent of other suites.
ensure_step_up("step-up before member management", tok, NEW_PWD)
s, biz = call("POST", "/api/businesses", {
    "legalName": "Revocation Test Co", "addressLine1": "1 Test Way",
    "city": "Las Vegas", "state": "NV", "zip": "89101",
}, token=tok)
check("test business created", s == 200 and biz.get("id"), f"{s} {biz}")
bid = (biz or {}).get("id")

CLERK_PWD = "clerkpassword99"
s, d = call("POST", f"/api/businesses/{bid}/members", {
    "email": "revoke-clerk@richco.test", "name": "Revoke Clerk",
    "password": CLERK_PWD, "role": "bookkeeper",
}, token=tok)
check("clerk added", s == 200, f"{s} {d}")

clerk = login("revoke-clerk@richco.test", CLERK_PWD)
check("clerk signs in", clerk is not None)
check("clerk session is live", call("GET", "/api/auth/me", token=clerk)[0] == 200)

# Find the clerk's user id from the member list.
s, members = call("GET", f"/api/businesses/{bid}/members", token=tok)
rows = members if isinstance(members, list) else []
clerk_id = next((m.get("userId") or m.get("id") for m in rows
                 if isinstance(m, dict) and str(m.get("email", "")).startswith("revoke-clerk")), None)
check("clerk user id resolved", clerk_id is not None, str(members))

ensure_step_up("step-up before role change", tok, NEW_PWD)
s, d = call("PATCH", f"/api/businesses/{bid}/members/{clerk_id}", {"role": "viewer"}, token=tok)
check("role change succeeds", s == 200, f"{s} {d}")
s, d = call("GET", "/api/auth/me", token=clerk)
check("clerk session revoked immediately on role change", s == 401, f"{s} {d}")

# Sign back in under the new role, then get removed.
clerk = login("revoke-clerk@richco.test", CLERK_PWD)
check("clerk signs back in after role change", clerk is not None)
check("clerk session live again", call("GET", "/api/auth/me", token=clerk)[0] == 200)

ensure_step_up("step-up before removal", tok, NEW_PWD)
s, d = call("DELETE", f"/api/businesses/{bid}/members/{clerk_id}", token=tok)
check("member removal succeeds", s == 200, f"{s} {d}")
s, d = call("GET", "/api/auth/me", token=clerk)
check("removed member is signed out immediately", s == 401, f"{s} {d}")

print()
print("=" * 70)
print("REVOCATION OVER THE COOKIE TRANSPORT (what a browser actually uses)")
print("=" * 70)

# The bearer token is a preview-only fallback and is purged outright, so it
# 401s without a reason code. A real browser holds a cookie session, and that
# path must both refuse the request and say why. Exercise it with a cookie jar
# and no Authorization header at all.
import http.cookiejar

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def cookie_call(method, path, body=None):
    req = urllib.request.Request(B + path, method=method)
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with opener.open(req, data, timeout=25) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t and t.lstrip().startswith(("{", "[")) else t)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, t


COOKIE_PWD = "cookieuserpass1"
ensure_step_up("step-up before adding cookie-transport member", tok, NEW_PWD)
s, d = call("POST", f"/api/businesses/{bid}/members", {
    "email": "cookie-user@richco.test", "name": "Cookie User",
    "password": COOKIE_PWD, "role": "bookkeeper",
}, token=tok)
check("cookie-transport member added", s == 200, f"{s} {d}")

s, d = cookie_call("POST", "/api/auth/login", {"email": "cookie-user@richco.test", "password": COOKIE_PWD})
check("member signs in over cookies", s == 200, f"{s} {d}")
check("a session cookie was actually set", len(jar) > 0, f"jar={len(jar)}")
check("cookie session is live", cookie_call("GET", "/api/auth/me")[0] == 200)

s, members2 = call("GET", f"/api/businesses/{bid}/members", token=tok)
rows2 = members2 if isinstance(members2, list) else []
cookie_id = next((m.get("userId") or m.get("id") for m in rows2
                  if isinstance(m, dict) and str(m.get("email", "")).startswith("cookie-user")), None)
check("cookie member id resolved", cookie_id is not None, str(members2)[:200])

ensure_step_up("step-up before cookie member role change", tok, NEW_PWD)
s, d = call("PATCH", f"/api/businesses/{bid}/members/{cookie_id}", {"role": "viewer"}, token=tok)
check("role change on cookie member succeeds", s == 200, f"{s} {d}")

s, d = cookie_call("GET", "/api/auth/me")
check("cookie session is refused after role change", s == 401, f"{s} {d}")
check("cookie session is told why (SESSION_REVOKED)", (d or {}).get("code") == "SESSION_REVOKED", str(d))
check("the reason is human readable",
      "sign in again" in str((d or {}).get("message", "")).lower(), str(d))

print()
print("=" * 70)
print("AUDIT TRAIL")
print("=" * 70)

s, events = call("GET", "/api/audit", token=tok)
kinds = {e.get("action") for e in (events or [])} if isinstance(events, list) else set()
check("password change is audited", "user.password_change" in kinds, f"got={sorted(k for k in kinds if k)}"[:400])

# Restore the original password so reruns and other suites are unaffected.
ensure_step_up("step-up before restoring password", tok, NEW_PWD)
s, d = call("POST", "/api/auth/change-password",
            {"currentPassword": NEW_PWD, "newPassword": OWNER_PWD}, token=tok)
check("original password restored", s == 200, f"{s} {d}")

# This file deliberately revokes sessions and rotates the owner password, which
# invalidates the token later parts inherit. Logins are rate limited per email
# (by design), so a later part cannot simply log in again without risking a 429.
# Hand back the still-valid token this file is already holding.
if tok:
    try:
        _st = json.load(open("/home/user/workspace/qa-state.json"))
        _st["OWNER"] = tok
        json.dump(_st, open("/home/user/workspace/qa-state.json", "w"))
        print("\n[qa5] refreshed OWNER token in qa-state.json for later parts")
    except Exception as _e:
        print(f"\n[qa5] could not refresh qa-state.json: {_e}")

print()
print("=" * 70)
print(f"PART 5: {P} passed, {F} failed")
print("=" * 70)
if NOTES:
    print("\nFailures:")
    for n in NOTES:
        print(" -", n)

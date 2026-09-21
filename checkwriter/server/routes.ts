import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import session from "express-session";
import memorystore from "memorystore";
import helmet from "helmet";
import { Storage, migrate, resetAllDataOnce, logAudit, logSecurity, type AuditContext } from "./storage";
import { reconcileColumns } from "./migrate-columns";
import { can } from "@shared/domain";

const MemoryStore = memorystore(session);

declare module "express-session" {
  interface SessionData {
    userId?: number;
    reauthedAt?: number;
    /** Session generation this login was minted under. Compared against the
        user's current epoch on every request; a mismatch means the session was
        revoked (password change, role change, removal, sign-out-everywhere). */
    epoch?: number;
  }
}

const NODE_ENV = process.env.NODE_ENV || "development";

/* A predictable session secret lets anyone forge a signed session cookie, so in
   production it must come from the environment. Development keeps a fixed
   fallback so the demo runs with no setup. */
const DEV_SESSION_SECRET = "checkwriter-dev-secret-change-me";
if (NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET must be set in production. Generate one with: openssl rand -base64 48"
  );
}
const SESSION_SECRET = process.env.SESSION_SECRET || DEV_SESSION_SECRET;

/* The production build bakes NODE_ENV="production" into the bundle, so it cannot
   distinguish a hosted deployment from a local install. Cookie attributes and
   proxy trust depend on the actual transport, not the build mode: a local
   install serves plain http://localhost, where Secure / SameSite=None /
   __Host- are wrong and silently prevent the session cookie from being stored.
   Secret enforcement deliberately stays tied to NODE_ENV so a local install
   still requires real keys. Set LOCAL_HTTP=1 when serving over plain HTTP. */
const BEHIND_HTTPS_PROXY =
  NODE_ENV === "production" && process.env.LOCAL_HTTP !== "1";

/* Fixed-window limiter for credential endpoints. Without this, the login and
   step-up routes accept unlimited password guesses. Kept dependency-free and
   in-memory, which is adequate for a single-instance prototype but would need a
   shared store behind multiple instances.

   Deliberately NOT keyed on client IP alone. Behind the hosting proxy the
   server observes a different internal source address on nearly every request,
   so an IP-keyed window never accumulates and the limiter silently does
   nothing. Keying on the identity being attacked (the submitted email, or the
   session user for step-up) both survives that and targets the realistic
   threat: repeated guesses against one account from many addresses. */
type RateWindow = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateWindow>();

/** Best-effort client address, preferring the originating XFF entry. */
function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  const first = raw?.split(",")[0]?.trim();
  return first || req.ip || "unknown";
}

function rateLimit(opts: {
  max: number;
  windowMs: number;
  tag: string;
  /** Identity to meter. Defaults to the client address. */
  keyFn?: (req: Request) => string;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const identity = (opts.keyFn ? opts.keyFn(req) : clientIp(req)) || "unknown";
    const key = `${opts.tag}:${identity}`;
    const now = Date.now();
    const w = rateBuckets.get(key);
    if (!w || now > w.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    w.count += 1;
    if (w.count > opts.max) {
      const retryAfter = Math.ceil((w.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      logSecurity("auth.rate_limited", "warn", { userId: null, ip: clientIp(req) }, {
        tag: opts.tag,
        retryAfter,
      });
      return res.status(429).json({
        message: `Too many attempts. Try again in ${retryAfter}s.`,
        code: "RATE_LIMITED",
      });
    }
    next();
  };
}
/* Periodically drop expired windows so the map cannot grow without bound. */
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of Array.from(rateBuckets.entries())) {
    if (now > w.resetAt) rateBuckets.delete(k);
  }
}, 60_000).unref?.();

/** Normalized email from the request body, used as the metered identity. */
function emailKey(req: Request): string {
  const raw = (req.body as { email?: unknown } | undefined)?.email;
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : clientIp(req);
}

const loginLimiter = rateLimit({
  max: 10,
  windowMs: 15 * 60_000,
  tag: "login",
  keyFn: emailKey,
});
const registerLimiter = rateLimit({
  max: 5,
  windowMs: 60 * 60_000,
  tag: "register",
  keyFn: clientIp,
});
/* Step-up always happens inside an authenticated session, so the session user
   is the precise thing to meter. */
const stepUpLimiter = rateLimit({
  max: 10,
  windowMs: 15 * 60_000,
  tag: "stepup",
  keyFn: (req) => (req.session?.userId ? `user:${req.session.userId}` : clientIp(req)),
});
const REAUTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

/* Preview-safe opaque bearer sessions.
   The deployed preview proxies API calls through a host that strips the
   httpOnly session cookie, so cookies alone cannot persist auth there.
   As a fallback we also mint an opaque bearer token (returned in the login
   JSON, stored client-side in memory/sessionStorage, sent as
   `Authorization: Bearer`). Only a SHA-256 hash is kept server-side; the raw
   token never leaves the response. This is a prototype fallback — httpOnly
   cookies remain the preferred production auth path. */
interface BearerRecord {
  userId: number;
  expiresAt: number;
  reauthedAt: number | null;
  /** See SessionData.epoch. Bearer tokens are subject to the same check. */
  epoch: number;
}
const bearerSessions = new Map<string, BearerRecord>();
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function mintBearer(userId: number, epoch: number): string {
  const token = randomBytes(32).toString("hex");
  bearerSessions.set(hashToken(token), {
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
    reauthedAt: null,
    epoch,
  });
  return token;
}
function bearerFromReq(req: Request): BearerRecord | null {
  const header = req.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const rec = bearerSessions.get(hashToken(token));
  if (!rec || rec.expiresAt < Date.now()) return null;
  return rec;
}
function revokeBearerFromReq(req: Request): void {
  const h = bearerHashFromReq(req);
  if (h) bearerSessions.delete(h);
}
function bearerHashFromReq(req: Request): string | undefined {
  const header = req.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return undefined;
  const token = header.slice(7).trim();
  return token ? hashToken(token) : undefined;
}
/** Drop every bearer token belonging to a user, optionally sparing one.

    The epoch check already refuses stale tokens, so this is not what enforces
    revocation — it stops revoked tokens sitting in memory until their TTL and
    lets the caller report how many devices were signed out. */
function revokeBearerForUser(userId: number, keepHash?: string): number {
  let removed = 0;
  /* Array.from rather than iterating the Map directly: the build targets a
     pre-ES2015 lib where Map is not iterable, and it also makes deleting
     during the walk unambiguous. */
  for (const [hash, rec] of Array.from(bearerSessions.entries())) {
    if (rec.userId === userId && hash !== keepHash) {
      bearerSessions.delete(hash);
      removed += 1;
    }
  }
  return removed;
}
/** Start an authenticated session, stamping the user's current epoch onto both
    the cookie session and the bearer token so later revocation can strand it. */
function beginSession(req: Request, user: { id: number; sessionEpoch?: number }): string {
  const epoch = user.sessionEpoch ?? 0;
  req.session.userId = user.id;
  req.session.epoch = epoch;
  return mintBearer(user.id, epoch);
}

export async function registerRoutes(_httpServer: Server, app: Express): Promise<Server> {
  migrate();
  /* Bring an already-populated database up to the current schema. Runs after
     table creation and before seeding so every later query sees the full shape. */
  const columnReport = reconcileColumns();
  for (const c of columnReport.applied) {
    console.log(`[schema] added ${c.table}.${c.column}`);
  }
  for (const s of columnReport.skipped) {
    console.warn(`[schema] NOT applied ${s.table}.${s.column} — ${s.reason}`);
  }
  /* One-time destructive reset. Honoured once per token value, so leaving
     RESET_TOKEN set cannot wipe real data on a later restart. */
  const resetToken = process.env.RESET_TOKEN;
  if (resetToken) {
    if (resetAllDataOnce(resetToken)) {
      console.log("[reset] All data cleared — first-run setup wizard is now available.");
    } else {
      console.log("[reset] RESET_TOKEN already consumed — no data was changed.");
    }
  }

  /* Demo data is only seeded when SEED_DEMO=1 is set (development/testing).
     A normal install starts with an empty database and the first-run setup
     wizard creates the initial admin account and business. */
  if (process.env.SEED_DEMO === "1") {
    seedIfEmpty();
  } else {
    const n = Storage.userCount();
    if (n === 0) {
      console.log("[setup] No users found — first-run setup wizard is available.");
    } else {
      console.log(`[setup] ${n} user account(s) found — setup wizard disabled.`);
    }
  }

  /* Only trust X-Forwarded-For when actually behind the hosting proxy. On a
     local install nothing sits in front of us, so trusting the header would let
     any client spoof its own address. */
  if (BEHIND_HTTPS_PROXY) app.set("trust proxy", 1);

  /* Security response headers.

     The CSP is written out rather than taking helmet's defaults so that every
     allowance below is a deliberate, reviewable decision. It applies to the
     app as served by this process (the local install and any self-hosted
     deployment); the hosted preview serves its HTML from a static host, so
     only the API responses here carry it there. */
  const cspDirectives: Record<string, string[]> = {
    defaultSrc: ["'self'"],
    /* Bundled application code only — no inline scripts, no eval, no CDN.
       This is the directive that actually blocks injected-script attacks. */
    scriptSrc: ["'self'"],
    /* 'unsafe-inline' is required for React style attributes, which the check
       designer uses to position elements to the millimetre. Style injection
       cannot execute code, and script-src stays strict. */
    styleSrc: ["'self'", "'unsafe-inline'", "https://api.fontshare.com"],
    /* data: carries the bundled E-13B MICR face, which ships base64 in the
       stylesheet so the app needs no font installed on the machine. */
    fontSrc: ["'self'", "data:", "https://api.fontshare.com", "https://cdn.fontshare.com"],
    /* blob: for generated check PDFs, data: for business logos. */
    imgSrc: ["'self'", "data:", "blob:"],
    connectSrc: ["'self'"],
    /* The print screen opens generated PDFs as blob: documents. */
    frameSrc: ["'self'", "blob:"],
    objectSrc: ["'none'"],
    /* Nothing may frame the app. Check approval and signing are exactly the
       kind of one-click action clickjacking targets. */
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  };
  /* Only meaningful where TLS is actually terminated; on a local http install
     it would force every request to https and break the app. */
  if (BEHIND_HTTPS_PROXY) cspDirectives.upgradeInsecureRequests = [];

  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: cspDirectives },
      /* Same reasoning as upgrade-insecure-requests: sending HSTS from a local
         http install teaches the browser to force https://localhost, which
         locks the user out of their own installation. */
      hsts: BEHIND_HTTPS_PROXY ? { maxAge: 15_552_000, includeSubDomains: true } : false,
      /* The hosted preview serves the UI from a different origin than this
         API, so responses must stay readable cross-origin. */
      crossOriginResourcePolicy: { policy: "cross-origin" },
      /* allow-popups so the print screen can open a PDF in a new tab. */
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      crossOriginEmbedderPolicy: false,
      /* URLs carry check and business ids; do not hand them to third parties. */
      referrerPolicy: { policy: "no-referrer" },
    })
  );

  app.use(
    session({
      store: new MemoryStore({ checkPeriod: 86_400_000 }),
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: BEHIND_HTTPS_PROXY ? "none" : "lax",
        secure: BEHIND_HTTPS_PROXY,
        path: "/",
        maxAge: 1000 * 60 * 60 * 12, // 12h
      },
      /* Hosting proxies for *.pplx.app strip any request cookie whose name is not
         `__Host-`-prefixed, to prevent cross-tenant cookie leakage between sites
         on the shared parent domain. The prefix requires Secure + Path=/ + no
         Domain attribute, which only holds over HTTPS — so keep the plain name
         for local http development. */
      name: BEHIND_HTTPS_PROXY ? "__Host-cw.sid" : "cw.sid",
    })
  );

  /* ------------------------------------------------------- helpers */
  function auditCtx(req: Request): AuditContext {
    /* Business-scoped routes must stamp the business onto the audit event.
       Without it every event was written with businessId=null, which left the
       per-business audit screen empty and put those events into every other
       user's global feed. */
    const rawBusinessId = req.params?.businessId;
    const routeBusinessId = Number.parseInt(typeof rawBusinessId === "string" ? rawBusinessId : "", 10);
    return {
      userId: req.session.userId ?? null,
      businessId: Number.isFinite(routeBusinessId) ? routeBusinessId : null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      correlationId: req.get("x-correlation-id") ?? null,
    };
  }
  function currentUser(req: Request) {
    if (!req.session.userId) return undefined;
    return Storage.getUser(req.session.userId);
  }
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!req.session.userId) {
      // Preview fallback: accept an opaque bearer token when the session
      // cookie was stripped by the proxy.
      const rec = bearerFromReq(req);
      if (rec) {
        req.session.userId = rec.userId;
        req.session.reauthedAt = rec.reauthedAt ?? undefined;
        req.session.epoch = rec.epoch;
      }
    }
    if (!req.session.userId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    /* Revocation check. The session carries the epoch it was minted under; the
       user row carries the current one. A password change, role change,
       removal, or explicit sign-out-everywhere bumps the user's epoch, which
       strands every session issued before it — including one held by someone
       who should no longer have access. Without this a stolen session stayed
       usable for the full 12h TTL no matter what the account owner did. */
    const user = Storage.getUser(req.session.userId);
    const revoked = !user || (req.session.epoch ?? -1) !== (user.sessionEpoch ?? 0);
    if (revoked) {
      revokeBearerFromReq(req);
      const message = user
        ? "Your session ended because your password or access changed. Please sign in again."
        : "Authentication required";
      const code = user ? "SESSION_REVOKED" : "USER_GONE";
      req.session.destroy(() => {
        res.status(401).json({ message, code });
      });
      return;
    }
    next();
  }
  /** First-run setup: only allowed when no users exist yet. Creates the initial
      owner account and first business in one transaction. Idempotent-guarded
      by re-checking userCount inside the transaction so two concurrent
      setup attempts cannot both succeed. */
  function setupAllowed(req: Request, res: Response, next: NextFunction) {
    if (Storage.userCount() > 0) {
      return res
        .status(409)
        .json({ message: "Setup has already been completed. Sign in instead.", code: "SETUP_COMPLETE" });
    }
    next();
  }
  /** require recent re-authentication (step-up) */
  function requireStepUp(req: Request, res: Response, next: NextFunction) {
    const ts = req.session.reauthedAt ?? 0;
    if (Date.now() - ts > REAUTH_WINDOW_MS) {
      return res.status(403).json({ message: "Step-up authentication required", code: "REAUTH_REQUIRED" });
    }
    next();
  }
  function requirePermission(businessId: number, permission: string) {
    return (req: Request, res: Response, next: NextFunction) => {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Authentication required" });
      const membership = Storage.membership(userId, businessId);
      if (!membership) return res.status(403).json({ message: "Not a member of this business" });
      if (!can(membership.role, permission)) {
        return res.status(403).json({ message: `Your role (${membership.role}) lacks permission: ${permission}` });
      }
      next();
    };
  }
  function businessIdFromReq(req: Request): number {
    return parseInt(req.params.businessId, 10);
  }

  /* ------------------------------------------------------- first-run setup */
  app.get("/api/system/status", (req, res) => {
    res.json({ needsSetup: Storage.userCount() === 0 });
  });

  app.post("/api/setup/first-admin", setupAllowed, async (req, res, next) => {
    try {
      const {
        email,
        name,
        password,
        legalName,
        dba,
        addressLine1,
        city,
        state,
        zip,
        phone,
        defaultSigner,
      } = req.body ?? {};
      if (!email || !name || !password) {
        return res.status(400).json({ message: "Email, name, and password are required" });
      }
      if (!legalName || !addressLine1 || !city || !state || !zip) {
        return res.status(400).json({ message: "Business legal name and address are required" });
      }
      if (password.length < 10) {
        return res.status(400).json({ message: "Password must be at least 10 characters" });
      }
      if (Storage.getUserByEmail(email)) {
        return res.status(409).json({ message: "An account with that email already exists" });
      }
      /* Re-check inside the operation: a concurrent setup attempt may have
         created the first user between the setupAllowed gate and here. */
      if (Storage.userCount() > 0) {
        return res.status(409).json({ message: "Setup has already been completed.", code: "SETUP_COMPLETE" });
      }
      const ctx: AuditContext = { userId: null, ip: clientIp(req) };
      const user = Storage.createUser(email, name, password, "owner");
      ctx.userId = user.id;
      const business = Storage.createBusiness(user.id, {
        legalName,
        dba: dba || undefined,
        addressLine1,
        city,
        state,
        zip,
        phone: phone || undefined,
        defaultSigner: defaultSigner || name,
      }, "owner");
      const setupToken = beginSession(req, user);
      logSecurity("system.first_admin_created", "info", ctx, {
        email,
        businessId: business.id,
        businessName: legalName,
      });
      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        mfaEnabled: user.mfaEnabled,
        sessionToken: setupToken,
        businessId: business.id,
      });
    } catch (e) {
      next(e);
    }
  });

  /* ------------------------------------------------------- auth */
  app.post("/api/auth/register", registerLimiter, async (req, res, next) => {
    try {
      const { email, name, password } = req.body ?? {};
      if (!email || !name || !password) return res.status(400).json({ message: "email, name, password required" });
      if (password.length < 10) return res.status(400).json({ message: "Password must be at least 10 characters" });
      if (Storage.getUserByEmail(email)) return res.status(409).json({ message: "Email already registered" });
      const user = Storage.createUser(email, name, password, "owner");
      const registerToken = beginSession(req, user);
      logSecurity("auth.register", "info", auditCtx(req), { email });
      res.json({ id: user.id, email: user.email, name: user.name, mfaEnabled: user.mfaEnabled, sessionToken: registerToken });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/auth/login", loginLimiter, async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      const ip = req.ip ?? "unknown";
      const user = Storage.verifyUserPassword(email ?? "", password ?? "");
      if (!user) {
        logSecurity("auth.login_failed", "warn", auditCtx(req), { email, ip });
        return res.status(401).json({ message: "Invalid email or password" });
      }
      const loginToken = beginSession(req, user);
      logSecurity("auth.login", "info", auditCtx(req), { email: user.email });
      res.json({ id: user.id, email: user.email, name: user.name, mfaEnabled: user.mfaEnabled, sessionToken: loginToken });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/auth/logout", requireAuth, (req, res) => {
    logSecurity("auth.logout", "info", auditCtx(req), {});
    revokeBearerFromReq(req);
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  /* requireAuth first: it resolves the user (including from a bearer token), so
     the limiter downstream can meter the actual account rather than a rotating
     proxy address. */
  app.post("/api/auth/step-up", requireAuth, stepUpLimiter, async (req, res) => {
    const { password } = req.body ?? {};
    const user = Storage.getUser(req.session.userId!);
    if (!user) return res.status(401).json({ message: "User not found" });
    const ok = Storage.verifyUserPassword(user.email, password ?? "");
    if (!ok) {
      logSecurity("auth.step_up_failed", "warn", auditCtx(req), { email: user.email });
      return res.status(401).json({ message: "Incorrect password" });
    }
    const now = Date.now();
    req.session.reauthedAt = now;
    const rec = bearerFromReq(req);
    if (rec) rec.reauthedAt = now;
    logSecurity("auth.step_up", "info", auditCtx(req), { email: user.email });
    res.json({ ok: true, validUntil: now + REAUTH_WINDOW_MS });
  });

  /* Keep the caller's own session alive after a revocation they initiated:
     re-stamp it with the new epoch and drop every other token they hold. */
  function keepThisSessionOnly(req: Request, userId: number, epoch: number): number {
    const keep = bearerHashFromReq(req);
    const revoked = revokeBearerForUser(userId, keep);
    req.session.epoch = epoch;
    const rec = keep ? bearerSessions.get(keep) : undefined;
    if (rec) rec.epoch = epoch;
    return revoked;
  }

  /* Change your own password.

     Step-up proves the session was recently authenticated; the current password
     in the body proves the person at the keyboard knows the secret being
     replaced. Both are required because either alone is weaker than it looks:
     a step-up window can be inherited by a hijacked tab, and a known password
     can be replayed from a captured request. */
  app.post("/api/auth/change-password", requireAuth, requireStepUp, (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body ?? {};
      const userId = req.session.userId!;
      const epoch = Storage.changePassword(userId, currentPassword ?? "", newPassword ?? "", auditCtx(req));
      const revoked = keepThisSessionOnly(req, userId, epoch);
      res.json({ ok: true, otherSessionsRevoked: revoked });
    } catch (e) {
      next(e);
    }
  });

  /* Sign out everywhere. The escape hatch for "I think someone has my session"
     that does not require changing the password first. */
  app.post("/api/auth/revoke-sessions", requireAuth, requireStepUp, (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const epoch = Storage.bumpSessionEpoch(userId, auditCtx(req), "signed out of all other devices");
      const revoked = keepThisSessionOnly(req, userId, epoch);
      res.json({ ok: true, otherSessionsRevoked: revoked });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    const user = Storage.getUser(req.session.userId!);
    if (!user) return res.status(404).json({ message: "User not found" });
    const stepUp = req.session.reauthedAt ?? 0;
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: user.mfaEnabled,
      stepUpActive: Date.now() - stepUp <= REAUTH_WINDOW_MS,
      stepUpExpiresAt: stepUp ? stepUp + REAUTH_WINDOW_MS : null,
      /* Whether field encryption is using a real key from the environment rather
         than the development fallback, so the Settings screen can state this
         accurately instead of hardcoding "dev key". Boolean only — never the key. */
      encryptionKeyManaged: Boolean(process.env.ENCRYPTION_KEY),
    });
  });

  /* ------------------------------------------------------- businesses */
  app.get("/api/businesses", requireAuth, (req, res) => {
    res.json(Storage.listBusinesses(req.session.userId!));
  });
  app.post("/api/businesses", requireAuth, (req, res, next) => {
    try {
      const b = Storage.createBusiness(req.session.userId!, req.body ?? {}, "owner");
      logAudit("business.create", "business", b.id, auditCtx(req), { newValue: b });
      res.json(b);
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/businesses/:businessId", requireAuth, (req, res) => {
    const b = Storage.getBusiness(req.session.userId!, businessIdFromReq(req));
    if (!b) return res.status(404).json({ message: "Business not found" });
    res.json(b);
  });
  app.patch("/api/businesses/:businessId", requireAuth, (req, res, next) => {
    try {
      const id = businessIdFromReq(req);
      if (!Storage.getBusiness(req.session.userId!, id)) return res.status(404).json({ message: "Business not found" });
      const b = Storage.updateBusiness(req.session.userId!, id, req.body ?? {});
      logAudit("business.update", "business", id, auditCtx(req), { newValue: req.body });
      res.json(b);
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/archive", requireAuth, (req, res) => {
    const id = businessIdFromReq(req);
    const b = Storage.archiveBusiness(req.session.userId!, id);
    logAudit("business.archive", "business", id, auditCtx(req), {});
    res.json(b);
  });

  /* ------------------------------------------------------- bank accounts */
  app.get("/api/businesses/:businessId/bank-accounts", requireAuth, (req, res) => {
    const id = businessIdFromReq(req);
    if (!Storage.getBusiness(req.session.userId!, id)) return res.status(404).json({ message: "Business not found" });
    res.json(Storage.listBankAccounts(req.session.userId!, id));
  });
  app.post("/api/businesses/:businessId/bank-accounts", requireAuth, (req, res, next) => {
    try {
      const id = businessIdFromReq(req);
      if (!Storage.getBusiness(req.session.userId!, id)) return res.status(404).json({ message: "Business not found" });
      const acct = Storage.createBankAccount(req.session.userId!, id, req.body ?? {}, auditCtx(req));
      res.json(acct);
    } catch (e) {
      next(e);
    }
  });
  app.patch("/api/businesses/:businessId/bank-accounts/:accountId", requireAuth, requireStepUp, (req, res, next) => {
    // editing bank account details is high-risk → step-up required
    try {
      const acct = Storage.updateBankAccount(
        req.session.userId!,
        parseInt(req.params.accountId, 10),
        req.body ?? {},
        auditCtx(req)
      );
      res.json(acct);
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/bank-accounts/:accountId/reveal", requireAuth, requireStepUp, (req, res) => {
    const revealed = Storage.revealBankAccount(req.session.userId!, parseInt(req.params.accountId, 10), auditCtx(req));
    res.json(revealed);
  });
  app.get("/api/businesses/:businessId/bank-accounts/:accountId/reveal", requireAuth, requireStepUp, (req, res) => {
    const revealed = Storage.revealBankAccount(req.session.userId!, parseInt(req.params.accountId, 10), auditCtx(req));
    /* Full routing/account numbers must never sit in a shared or disk cache. */
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.json(revealed);
  });

  /* ------------------------------------------------------- payees */
  app.get("/api/businesses/:businessId/payees", requireAuth, (req, res) => {
    const id = businessIdFromReq(req);
    if (!Storage.getBusiness(req.session.userId!, id)) return res.status(404).json({ message: "Business not found" });
    const includeArchived = req.query.includeArchived === "true";
    res.json(Storage.listPayees(req.session.userId!, id, includeArchived));
  });
  app.post("/api/businesses/:businessId/payees", requireAuth, (req, res, next) => {
    try {
      const id = businessIdFromReq(req);
      const p = Storage.createPayee(req.session.userId!, id, req.body ?? {}, auditCtx(req));
      res.json(p);
    } catch (e) {
      next(e);
    }
  });
  app.patch("/api/businesses/:businessId/payees/:payeeId", requireAuth, (req, res, next) => {
    try {
      const p = Storage.updatePayee(req.session.userId!, parseInt(req.params.payeeId, 10), req.body ?? {}, auditCtx(req));
      res.json(p);
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/payees/:payeeId/archive", requireAuth, (req, res) => {
    const p = Storage.archivePayee(req.session.userId!, parseInt(req.params.payeeId, 10), auditCtx(req));
    res.json(p);
  });
  app.get("/api/businesses/:businessId/payees/duplicates", requireAuth, (req, res) => {
    const id = businessIdFromReq(req);
    res.json(Storage.findDuplicatePayees(req.session.userId!, id));
  });

  /* ------------------------------------------------------- checks */
  app.get("/api/businesses/:businessId/checks", requireAuth, (req, res) => {
    const id = businessIdFromReq(req);
    if (!Storage.getBusiness(req.session.userId!, id)) return res.status(404).json({ message: "Business not found" });
    const filters: { bankAccountId?: number; status?: string; q?: string } = {};
    if (req.query.bankAccountId) filters.bankAccountId = parseInt(req.query.bankAccountId as string, 10);
    if (req.query.status) filters.status = req.query.status as string;
    if (req.query.q) filters.q = req.query.q as string;
    res.json(Storage.listChecks(req.session.userId!, id, filters));
  });
  app.post("/api/businesses/:businessId/checks", requireAuth, (req, res, next) => {
    try {
      const id = businessIdFromReq(req);
      if (!Storage.getBusiness(req.session.userId!, id)) return res.status(404).json({ message: "Business not found" });
      const c = Storage.createCheck(req.session.userId!, { businessId: id, ...(req.body ?? {}) }, auditCtx(req));
      res.json(c);
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/businesses/:businessId/checks/:checkId", requireAuth, (req, res) => {
    const c = Storage.getCheck(req.session.userId!, parseInt(req.params.checkId, 10));
    if (!c) return res.status(404).json({ message: "Check not found" });
    res.json(c);
  });
  app.patch("/api/businesses/:businessId/checks/:checkId", requireAuth, (req, res, next) => {
    try {
      const c = Storage.updateCheck(req.session.userId!, parseInt(req.params.checkId, 10), req.body ?? {}, auditCtx(req));
      res.json(c);
    } catch (e: any) {
      if (e.message?.includes("Cannot edit")) return res.status(409).json({ message: e.message, code: "IMMUTABLE" });
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/checks/:checkId/approve", requireAuth, (req, res, next) => {
    try {
      const c = Storage.approveCheck(req.session.userId!, parseInt(req.params.checkId, 10), auditCtx(req), req.body?.comment);
      res.json(c);
    } catch (e: any) {
      if (e.message?.includes("Not authorized")) return res.status(403).json({ message: e.message });
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/checks/:checkId/sign", requireAuth, (req, res, next) => {
    try {
      const c = Storage.signCheck(req.session.userId!, parseInt(req.params.checkId, 10), auditCtx(req));
      res.json(c);
    } catch (e: any) {
      if (e.message?.includes("Not authorized")) return res.status(403).json({ message: e.message });
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/checks/:checkId/print", requireAuth, (req, res, next) => {
    try {
      const testMode = req.body?.testMode === true;
      const c = Storage.printCheck(req.session.userId!, parseInt(req.params.checkId, 10), auditCtx(req), testMode);
      res.json(c);
    } catch (e: any) {
      if (e.message?.includes("Not authorized")) return res.status(403).json({ message: e.message });
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/checks/:checkId/reprint", requireAuth, (req, res, next) => {
    try {
      const c = Storage.reprintCheck(req.session.userId!, parseInt(req.params.checkId, 10), req.body?.reason ?? "", auditCtx(req));
      res.json(c);
    } catch (e: any) {
      if (e.message?.includes("Not authorized")) return res.status(403).json({ message: e.message });
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/checks/:checkId/void", requireAuth, (req, res, next) => {
    try {
      const c = Storage.voidCheck(req.session.userId!, parseInt(req.params.checkId, 10), req.body?.reason ?? "", auditCtx(req));
      res.json(c);
    } catch (e: any) {
      if (e.message?.includes("Not authorized")) return res.status(403).json({ message: e.message });
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/checks/:checkId/replace", requireAuth, (req, res, next) => {
    try {
      const result = Storage.replaceCheck(req.session.userId!, parseInt(req.params.checkId, 10), req.body?.reason ?? "", auditCtx(req));
      res.json(result);
    } catch (e: any) {
      if (e.message?.includes("Not authorized")) return res.status(403).json({ message: e.message });
      next(e);
    }
  });
  app.post("/api/businesses/:businessId/checks/:checkId/clear", requireAuth, (req, res, next) => {
    try {
      const c = Storage.markCleared(req.session.userId!, parseInt(req.params.checkId, 10), req.body?.clearedAt ?? Date.now(), auditCtx(req));
      res.json(c);
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/businesses/:businessId/check-number-reconciliation/:accountId", requireAuth, (req, res) => {
    res.json(Storage.checkNumberReconciliation(req.session.userId!, parseInt(req.params.accountId, 10)));
  });
  app.get("/api/businesses/:businessId/check-number-validate/:accountId/:number", requireAuth, (req, res) => {
    res.json(
      Storage.validateCheckNumber(
        req.session.userId!,
        businessIdFromReq(req),
        parseInt(req.params.accountId, 10),
        parseInt(req.params.number, 10)
      )
    );
  });

  /* ------------------------------------------------------- templates */
  app.get("/api/businesses/:businessId/templates", requireAuth, (req, res) => {
    const id = businessIdFromReq(req);
    res.json(Storage.listTemplates(req.session.userId!, id));
  });
  app.post("/api/businesses/:businessId/templates", requireAuth, (req, res, next) => {
    try {
      const t = Storage.createTemplate(req.session.userId!, businessIdFromReq(req), req.body ?? {}, auditCtx(req));
      res.json(t);
    } catch (e) {
      next(e);
    }
  });
  app.patch("/api/businesses/:businessId/templates/:templateId", requireAuth, (req, res, next) => {
    try {
      const t = Storage.updateTemplate(req.session.userId!, parseInt(req.params.templateId, 10), req.body ?? {}, auditCtx(req));
      res.json(t);
    } catch (e) {
      next(e);
    }
  });

  app.delete("/api/businesses/:businessId/templates/:templateId", requireAuth, (req, res, next) => {
    try {
      res.json(
        Storage.deleteTemplate(req.session.userId!, parseInt(String(req.params.templateId), 10), auditCtx(req)),
      );
    } catch (e) {
      next(e);
    }
  });

  /* -------------------------------------------------- template assets */
  /* Logos, signature images, and background artwork. Payloads are base64 in
     the request body, so the cap below is on the decoded byte count rather
     than the JSON length. */
  const MAX_ASSET_BYTES = 2 * 1024 * 1024; // 2 MB
  const ALLOWED_ASSET_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

  app.get("/api/businesses/:businessId/assets", requireAuth, (req, res) => {
    res.json(Storage.listAssets(req.session.userId!, businessIdFromReq(req)));
  });

  /* Serves the bytes for one asset. Kept separate from the list endpoint so
     the designer can lazily fetch only the artwork actually placed. */
  app.get("/api/assets/:assetId", requireAuth, (req, res, next) => {
    try {
      const a = Storage.getAsset(req.session.userId!, parseInt(String(req.params.assetId), 10));
      if (!a) return res.status(404).json({ message: "Asset not found" });
      const buf = Buffer.from(a.data, "base64");
      res.setHeader("Content-Type", a.mimeType);
      res.setHeader("Cache-Control", "private, max-age=300");
      /* Defence in depth: an uploaded file should never be interpreted as a
         document even if the mime type is wrong. */
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/businesses/:businessId/assets", requireAuth, (req, res, next) => {
    try {
      const body = req.body ?? {};
      const mimeType = String(body.mimeType ?? "");
      if (!ALLOWED_ASSET_MIME.has(mimeType)) {
        return res
          .status(400)
          .json({ message: "Only PNG, JPEG, and WebP images can be uploaded." });
      }
      /* Accept either a bare base64 string or a full data: URL. */
      const raw = String(body.data ?? "");
      const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
      if (!base64) return res.status(400).json({ message: "No image data received." });
      if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
        return res.status(400).json({ message: "Image data is not valid base64." });
      }
      const byteSize = Buffer.from(base64, "base64").length;
      if (byteSize === 0) return res.status(400).json({ message: "Image data is empty." });
      if (byteSize > MAX_ASSET_BYTES) {
        return res.status(413).json({
          message: `Image is ${(byteSize / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB — resize it and try again.`,
        });
      }
      const asset = Storage.createAsset(
        req.session.userId!,
        businessIdFromReq(req),
        {
          name: String(body.name ?? "Untitled").slice(0, 120),
          kind: String(body.kind ?? "business_logo"),
          mimeType,
          data: base64.replace(/\s/g, ""),
          byteSize,
          widthPx: body.widthPx ? Number(body.widthPx) : null,
          heightPx: body.heightPx ? Number(body.heightPx) : null,
          rightsAttested: !!body.rightsAttested,
        },
        auditCtx(req),
      );
      res.json(asset);
    } catch (e) {
      next(e);
    }
  });

  app.delete("/api/assets/:assetId", requireAuth, (req, res, next) => {
    try {
      res.json(Storage.deleteAsset(req.session.userId!, parseInt(String(req.params.assetId), 10), auditCtx(req)));
    } catch (e) {
      next(e);
    }
  });

  /* ------------------------------------------------------- printers */
  app.get("/api/businesses/:businessId/printers", requireAuth, (req, res) => {
    res.json(Storage.listPrinters(req.session.userId!, businessIdFromReq(req)));
  });
  app.post("/api/businesses/:businessId/printers", requireAuth, (req, res, next) => {
    try {
      const p = Storage.createPrinter(req.session.userId!, businessIdFromReq(req), req.body ?? {}, auditCtx(req));
      res.json(p);
    } catch (e) {
      next(e);
    }
  });
  app.patch("/api/businesses/:businessId/printers/:printerId", requireAuth, (req, res, next) => {
    try {
      const p = Storage.updatePrinter(req.session.userId!, parseInt(req.params.printerId, 10), req.body ?? {}, auditCtx(req));
      res.json(p);
    } catch (e) {
      next(e);
    }
  });

  /* ------------------------------------------------------- audit + security */
  /* --------------------------------------------------------- team members */
  app.get("/api/businesses/:businessId/members", requireAuth, (req, res) => {
    res.json(Storage.listMembers(req.session.userId!, businessIdFromReq(req)));
  });
  app.post("/api/businesses/:businessId/members", requireAuth, requireStepUp, (req, res, next) => {
    try {
      const b = req.body ?? {};
      res.json(
        Storage.addMember(
          req.session.userId!,
          businessIdFromReq(req),
          { email: b.email, name: b.name, password: b.password, role: b.role },
          auditCtx(req)
        )
      );
    } catch (e) {
      next(e);
    }
  });
  app.patch("/api/businesses/:businessId/members/:targetUserId", requireAuth, requireStepUp, (req, res, next) => {
    try {
      const targetUserId = parseInt(String(req.params.targetUserId), 10);
      const members = Storage.updateMemberRole(
        req.session.userId!,
        businessIdFromReq(req),
        targetUserId,
        (req.body ?? {}).role,
        auditCtx(req)
      );
      /* updateMemberRole bumped the target's epoch, which is what actually
         revokes them; this just clears their tokens out of memory now rather
         than at TTL. */
      revokeBearerForUser(targetUserId);
      res.json(members);
    } catch (e) {
      next(e);
    }
  });
  app.delete("/api/businesses/:businessId/members/:targetUserId", requireAuth, requireStepUp, (req, res, next) => {
    try {
      const targetUserId = parseInt(String(req.params.targetUserId), 10);
      const members = Storage.removeMember(
        req.session.userId!,
        businessIdFromReq(req),
        targetUserId,
        auditCtx(req)
      );
      revokeBearerForUser(targetUserId);
      res.json(members);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/businesses/:businessId/audit", requireAuth, (req, res) => {
    res.json(Storage.listAuditEvents(req.session.userId!, businessIdFromReq(req), 500));
  });
  app.get("/api/audit", requireAuth, (req, res) => {
    res.json(Storage.listAuditEvents(req.session.userId!, undefined, 500));
  });
  app.get("/api/security-events", requireAuth, (req, res) => {
    res.json(Storage.listSecurityEvents(req.session.userId!, 200));
  });

  /* ------------------------------------------------------- positive pay */
  app.get("/api/businesses/:businessId/positive-pay", requireAuth, (req, res) => {
    res.json(Storage.listPositivePayExports(req.session.userId!, businessIdFromReq(req)));
  });
  app.post("/api/businesses/:businessId/positive-pay/:accountId", requireAuth, requireStepUp, (req, res, next) => {
    try {
      const result = Storage.buildPositivePay(req.session.userId!, parseInt(req.params.accountId, 10), auditCtx(req));
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  /* ------------------------------------------------------- reports (CSV exports) */
  app.get("/api/businesses/:businessId/export/checks", requireAuth, (req, res) => {
    const id = businessIdFromReq(req);
    const checks = Storage.listChecks(req.session.userId!, id, {});
    const header = "check_number,check_date,status,payee,amount_cents,amount,memo,bank_account_id,cleared_at,voided_at,void_reason";
    const rows = checks.map((c) =>
      [c.checkNumber, c.checkDate, c.status, escapeCsv(c.payeeName), c.amountCents, (c.amountCents / 100).toFixed(2), escapeCsv(c.memo ?? ""), c.bankAccountId, c.clearedAt ?? "", c.voidedAt ?? "", escapeCsv(c.voidReason ?? "")].join(",")
    );
    sendCsv(res, "check-register.csv", [header, ...rows].join("\n"));
  });
  app.get("/api/businesses/:businessId/export/payees", requireAuth, (req, res) => {
    const payees = Storage.listPayees(req.session.userId!, businessIdFromReq(req), true);
    const header = "name,type,category,city,state,zip,contact_name,contact_email,archived";
    const rows = payees.map((p) =>
      [escapeCsv(p.name), p.type, escapeCsv(p.category ?? ""), p.city ?? "", p.state ?? "", p.zip ?? "", escapeCsv(p.contactName ?? ""), p.contactEmail ?? "", p.archived ? "yes" : "no"].join(",")
    );
    sendCsv(res, "payees.csv", [header, ...rows].join("\n"));
  });
  app.get("/api/businesses/:businessId/export/audit", requireAuth, (req, res) => {
    const events = Storage.listAuditEvents(req.session.userId!, businessIdFromReq(req), 5000);
    const header = "created_at,action,entity_type,entity_id,user_id,reason";
    const rows = events.map((e) =>
      [new Date(e.createdAt).toISOString(), e.action, e.entityType ?? "", e.entityId ?? "", e.userId ?? "", escapeCsv(e.reason ?? "")].join(",")
    );
    sendCsv(res, "audit-log.csv", [header, ...rows].join("\n"));
  });

  /* ------------------------------------------------------- demo seed */
  /* Development-only helper. Without this gate any authenticated user could
     inject sample records into a production install. */
  app.post("/api/seed", requireAuth, async (req, res, next) => {
    if (process.env.SEED_DEMO !== "1") {
      return res.status(404).json({ message: "Not found" });
    }
    try {
      seedForUser(req.session.userId!);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return _httpServer;
}

function escapeCsv(s: string): string {
  const needsQuote = s.indexOf(",") >= 0 || s.indexOf('"') >= 0 || s.indexOf("\n") >= 0;
  if (needsQuote) {
    const escaped = s.replace(/"/g, '""');
    return '"' + escaped + '"';
  }
  return s;
}
function sendCsv(res: Response, filename: string, content: string) {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(content);
}

/* ------------------------------------------------------- seeding */
function seedIfEmpty() {
  const usersCount = Storage.getUserByEmail("demo@checkwriter.app");
  if (usersCount) return;
  const demo = Storage.createUser("demo@checkwriter.app", "Demo Owner", "demo1234!", "owner");
  seedForUser(demo.id);
  logSecurity("system.seed", "info", { userId: demo.id }, { note: "Demo data created (demo@checkwriter.app / demo1234!)" });
}

function seedForUser(userId: number) {
  const ctx: AuditContext = { userId };
  const biz = Storage.createBusiness(userId, {
    legalName: "Summit Ridge Construction LLC",
    dba: "Summit Ridge",
    addressLine1: "742 Evergreen Terrace",
    city: "Las Vegas",
    state: "NV",
    zip: "89101",
    phone: "(702) 555-0148",
    defaultSigner: "Jordan Mitchell",
  }, "owner");
  // a second authorized user so the demo shows delegated approval, which is optional
  let approverId = userId;
  const approver = Storage.getUserByEmail("approver@checkwriter.app");
  if (!approver) {
    const a = Storage.createUser("approver@checkwriter.app", "Casey Approver", "approve1234!", "owner");
    Storage.setMembership(a.id, biz.id, "approver");
    approverId = a.id;
  } else {
    Storage.setMembership(approver.id, biz.id, "approver");
    approverId = approver.id;
  }
  const acct = Storage.createBankAccount(userId, biz.id, {
    bankName: "First National Bank",
    nickname: "Operations Checking",
    routingNumber: "121000358", // valid ABA test
    accountNumber: "9876543210",
    checkStartingNumber: 4201,
    accountType: "checking",
    bankAddress: "First National Bank, Las Vegas, NV",
    positivePayEnabled: true,
  }, ctx);
  const acct2 = Storage.createBankAccount(userId, biz.id, {
    bankName: "First National Bank",
    nickname: "Payroll Account",
    routingNumber: "121000358",
    accountNumber: "9876543211",
    checkStartingNumber: 5001,
    accountType: "checking",
    positivePayEnabled: false,
  }, ctx);
  // a second, restricted account to demonstrate issuance blocking
  const acct3 = Storage.createBankAccount(userId, biz.id, {
    bankName: "Valley Credit Union",
    nickname: "Reserve (restricted)",
    routingNumber: "321172773",
    accountNumber: "1234567890",
    checkStartingNumber: 1001,
    accountType: "savings",
  }, ctx);
  Storage.updateBankAccount(userId, acct3.id, { status: "restricted" }, ctx);

  const payees = [
    { name: "Apex Materials Co.", category: "Materials", city: "Henderson", state: "NV", defaultMemo: "Invoice A-2291" },
    { name: "Red Rock Plumbing", category: "Subcontractor", city: "Las Vegas", state: "NV" },
    { name: "Nevada Power LLC", category: "Utilities", city: "Las Vegas", state: "NV", defaultMemo: "Monthly electric" },
    { name: "Sarah Chen", type: "individual", category: "Consulting", city: "Reno", state: "NV" },
    { name: "Mesa Office Supplies", category: "Office", city: "Las Vegas", state: "NV" },
  ];
  const payeeIds: number[] = [];
  for (const p of payees) {
    const created = Storage.createPayee(userId, biz.id, p as any, ctx);
    payeeIds.push(created.id);
  }
  // a couple of sample checks across statuses
  const c1 = Storage.createCheck(userId, { businessId: biz.id, bankAccountId: acct.id, checkDate: new Date().toISOString().slice(0, 10), payeeName: "Apex Materials Co.", payeeId: payeeIds[0], amount: "4827.50", memo: "Invoice A-2291 - lumber & fasteners", lineItems: [{ category: "Materials", project: "Highland Project", invoiceRef: "A-2291", amount: "4827.50" }] }, ctx);
  Storage.approveCheck(approverId, c1.id, ctx, "Approved per PO");
  Storage.signCheck(userId, c1.id, ctx);
  Storage.printCheck(userId, c1.id, ctx, false);
  Storage.createCheck(userId, { businessId: biz.id, bankAccountId: acct.id, checkDate: new Date().toISOString().slice(0, 10), payeeName: "Red Rock Plumbing", payeeId: payeeIds[1], amount: "1850.00", memo: "Rough-in work - Unit 14" }, ctx);
  Storage.createCheck(userId, { businessId: biz.id, bankAccountId: acct2.id, checkDate: new Date().toISOString().slice(0, 10), payeeName: "Sarah Chen", payeeId: payeeIds[3], amount: "3200.00", memo: "Permit consulting - July" }, ctx);
  // a voided example
  const c4 = Storage.createCheck(userId, { businessId: biz.id, bankAccountId: acct.id, checkDate: new Date().toISOString().slice(0, 10), payeeName: "Nevada Power LLC", payeeId: payeeIds[2], amount: "412.89", memo: "Electric - deposit" }, ctx);
  Storage.voidCheck(userId, c4.id, "Voided - duplicate bill", ctx);
  // default template
  Storage.createTemplate(userId, biz.id, { name: "Business Check - Blank Stock", layoutType: "business", stockType: "blank", isDefault: true }, ctx);
  // printer profile
  Storage.createPrinter(userId, biz.id, { name: "Office HP - Blank Stock", stockType: "blank", offsetX: 0, offsetY: 0, scale: 100, notes: "Default calibration" }, ctx);
}

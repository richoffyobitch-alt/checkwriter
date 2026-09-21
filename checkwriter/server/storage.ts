import { db } from "./storage-db";
import { encrypt, decrypt, last4Of, hashPassword, verifyPassword } from "./crypto";
import {
  businesses,
  bankAccounts,
  payees,
  checks,
  checkLineItems,
  checkTemplates,
  templateAssets,
  printerProfiles,
  auditEvents,
  positivePayExports,
  users,
  businessMemberships,
  securityEvents,
} from "@shared/schema";
import type {
  Business,
  BankAccount,
  Payee,
  Check,
  CheckTemplate,
  PrinterProfile,
  AuditEvent,
  PositivePayExport,
  User,
} from "@shared/schema";
import {
  amountToWords,
  dollarsToCents,
  isValidRoutingNumber,
  maskAccountNumber,
  maskEin,
  can,
  isKnownRole,
  ROLE_PERMISSIONS,
  DEFAULT_TEMPLATE_ELEMENTS,
} from "@shared/domain";
import { fractionFromRouting, defaultDesign } from "@shared/template";
import { eq, sql, and, desc } from "drizzle-orm";
import crypto from "node:crypto";

export { db };

/* ----------------------------------------- self-bootstrapping migration */
/** Error carrying an HTTP status, honoured by the global error handler. */
function httpError(status: number, message: string) {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

export function migrate() {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, password_hash TEXT NOT NULL, mfa_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, legal_name TEXT NOT NULL, dba TEXT,
      ein TEXT, address_line_1 TEXT, address_line_2 TEXT, city TEXT, state TEXT, zip TEXT,
      phone TEXT, logo_data_url TEXT, default_signer TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS business_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      business_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'bookkeeper',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL,
      bank_name TEXT NOT NULL, nickname TEXT NOT NULL,
      routing_encrypted TEXT, account_encrypted TEXT, account_last_4 TEXT,
      check_starting_number INTEGER NOT NULL DEFAULT 1001,
      next_check_number INTEGER NOT NULL DEFAULT 1001,
      account_type TEXT NOT NULL DEFAULT 'checking', bank_address TEXT,
      default_template_id INTEGER, status TEXT NOT NULL DEFAULT 'active',
      bank_validation_status TEXT NOT NULL DEFAULT 'pending',
      bank_validation_date INTEGER, bank_validation_notes TEXT,
      positive_pay_enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS payees (
      id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL,
      name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'business',
      address_line_1 TEXT, address_line_2 TEXT, city TEXT, state TEXT, zip TEXT,
      contact_name TEXT, contact_email TEXT, contact_phone TEXT,
      default_memo TEXT, category TEXT, tags TEXT NOT NULL DEFAULT '[]',
      internal_notes TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL,
      bank_account_id INTEGER NOT NULL, check_number INTEGER NOT NULL,
      check_date TEXT NOT NULL, payee_id INTEGER, payee_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, written_amount TEXT NOT NULL, memo TEXT,
      status TEXT NOT NULL DEFAULT 'draft', preparer_id INTEGER, approver_id INTEGER,
      signer_id INTEGER, printed_at INTEGER, issued_at INTEGER, cleared_at INTEGER,
      voided_at INTEGER, void_reason TEXT, replaced_by_id INTEGER,
      reprint_count INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      issued_snapshot TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(bank_account_id, check_number)
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS check_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, check_id INTEGER NOT NULL,
      category TEXT, department TEXT, project TEXT, class_field TEXT,
      invoice_ref TEXT, description TEXT, amount_cents INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS check_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL,
      bank_account_id INTEGER, name TEXT NOT NULL,
      layout_type TEXT NOT NULL DEFAULT 'business', stock_type TEXT NOT NULL DEFAULT 'blank',
      elements TEXT NOT NULL DEFAULT '[]', is_default INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS template_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'business_logo',
      mime_type TEXT NOT NULL,
      data TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      width_px INTEGER,
      height_px INTEGER,
      rights_attested_at INTEGER,
      uploaded_by INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS printer_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL,
      name TEXT NOT NULL, stock_type TEXT NOT NULL DEFAULT 'blank',
      offset_x INTEGER NOT NULL DEFAULT 0, offset_y INTEGER NOT NULL DEFAULT 0,
      scale INTEGER NOT NULL DEFAULT 100, validated_at INTEGER, notes TEXT, created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, business_id INTEGER,
      action TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
      old_value TEXT, new_value TEXT, reason TEXT, correlation_id TEXT,
      ip TEXT, user_agent TEXT, created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS positive_pay_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL,
      bank_account_id INTEGER NOT NULL, format TEXT NOT NULL DEFAULT 'csv',
      item_count INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
      file_checksum TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
      user_id INTEGER, exported_at INTEGER NOT NULL, check_ids TEXT NOT NULL DEFAULT '[]'
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
      event_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info',
      details TEXT, ip TEXT, created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS system_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
    )
  `);
}

/* ------------------------------------------------------------ system meta */

export function getMeta(key: string): string | null {
  const row = db.get<{ value: string }>(
    sql`SELECT value FROM system_meta WHERE key = ${key}`
  );
  return row?.value ?? null;
}

export function setMeta(key: string, value: string) {
  db.run(sql`
    INSERT INTO system_meta (key, value, updated_at)
    VALUES (${key}, ${value}, ${Date.now()})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
}

/**
 * One-time destructive reset, used to clear evaluation data from an existing
 * deployment before it is handed over for real use.
 *
 * Guarded by a token: the token that performed a reset is recorded in
 * `system_meta`, and a token is honoured only once. Leaving RESET_TOKEN set in
 * the environment therefore cannot wipe real data on a later restart, which is
 * the property that makes this safe to ship.
 *
 * Returns true only when a wipe actually happened.
 */
export function resetAllDataOnce(token: string): boolean {
  if (!token) return false;
  if (getMeta("reset_token_consumed") === token) return false;

  const tables = [
    "check_line_items",
    "checks",
    "positive_pay_exports",
    "printer_profiles",
    "check_templates",
    "payees",
    "bank_accounts",
    "business_memberships",
    "businesses",
    "users",
    "audit_events",
    "security_events",
  ];

  db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    for (const t of tables) db.run(sql.raw(`DELETE FROM ${t}`));
    // Restart id sequences so the fresh install numbers from 1.
    db.run(sql.raw(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map((t) => `'${t}'`).join(",")})`));
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }

  setMeta("reset_token_consumed", token);
  setMeta("reset_performed_at", String(Date.now()));
  return true;
}

/* ------------------------------------------------------- audit + security */
export interface AuditContext {
  userId: number | null;
  businessId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export function logAudit(
  action: string,
  entityType: string | null,
  entityId: string | number | null,
  ctx: AuditContext,
  details?: { oldValue?: unknown; newValue?: unknown; reason?: string }
) {
  return db
    .insert(auditEvents)
    .values({
      userId: ctx.userId ?? null,
      businessId: ctx.businessId ?? null,
      action,
      entityType,
      entityId: entityId == null ? null : String(entityId),
      oldValue: details?.oldValue != null ? JSON.stringify(details.oldValue) : null,
      newValue: details?.newValue != null ? JSON.stringify(details.newValue) : null,
      reason: details?.reason ?? null,
      correlationId: ctx.correlationId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    })
    .returning()
    .get();
}

export function logSecurity(
  eventType: string,
  severity: "info" | "warn" | "critical",
  ctx: AuditContext,
  details?: unknown
) {
  return db
    .insert(securityEvents)
    .values({
      userId: ctx.userId ?? null,
      eventType,
      severity,
      details: details ? JSON.stringify(details) : null,
      ip: ctx.ip ?? null,
    })
    .returning()
    .get();
}

/* ----------------------------------------------------------- serialization */
function serializeBusiness(b: Business) {
  return { ...b, ein: maskEin(b.ein) };
}

/* Keeps a blank prefix as null instead of an empty string, so "not supplied"
   has exactly one representation and fractionFromRouting can short-circuit. */
/* The fraction prefix is the one part of PP-YYYY/XXXX that cannot be derived
   from the routing number, so it is typed by hand. Silently coercing bad input
   is the dangerous option here: truncating "100" to "10" or stripping "-5" to
   "5" would print a plausible-looking but wrong fraction on real check stock,
   and nobody would notice until the bank did. Reject instead, and let an
   explicitly empty value clear the field. */
function normalizeFractionPrefix(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const raw = String(v).trim();
  if (!raw) return null;
  if (!/^[1-9][0-9]?$/.test(raw)) {
    throw httpError(
      400,
      "The fraction prefix is the 1 or 2 digit city/state code from your bank (1-99). Copy it from an existing check.",
    );
  }
  return raw;
}

function serializeBankAccount(a: BankAccount) {
  /* Report the real checksum result rather than a fixed value, so the UI can
     warn on an incomplete or mistyped routing number. Full routing/account
     numbers are still withheld here; they are only available via reveal. */
  const routing = a.routingEncrypted ? decrypt(a.routingEncrypted) : null;
  return {
    ...a,
    routingEncrypted: undefined,
    accountEncrypted: undefined,
    accountLast4: a.accountLast4,
    accountMasked: maskAccountNumber(a.accountLast4),
    routingValid: routing ? isValidRoutingNumber(routing) : false,
    /* The fractional routing number is printed in the clear on the face of
       every check and is derived from the routing number, which the ABA
       publishes. It is not account-identifying, so unlike the account number
       it is returned here rather than gated behind reveal. Null whenever the
       bank-supplied prefix is missing — a partial fraction is worse than none. */
    fractionNumber: routing ? fractionFromRouting(routing, a.fractionPrefix) : null,
  };
}

/* ----------------------------------------------------------- storage API */
export const Storage = {
  /* ----------------------------- auth */
  getUserByEmail(email: string): User | undefined {
    return db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
  },
  getUser(id: number): User | undefined {
    return db.select().from(users).where(eq(users.id, id)).get();
  },
  createUser(email: string, name: string, password: string, role: string = "owner"): User {
    const user = db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        name,
        passwordHash: hashPassword(password),
        mfaEnabled: false,
      })
      .returning()
      .get();
    // if this is the first user, make them owner of nothing yet — memberships created separately
    return user;
  },
  /** Total user accounts. Used to detect a never-initialized install so the
      first-run setup wizard can take over. */
  userCount(): number {
    const row = db.select({ n: sql`count(*)` }).from(users).get() as { n: number } | undefined;
    return row?.n ?? 0;
  },
  verifyUserPassword(email: string, password: string): User | undefined {
    const user = this.getUserByEmail(email);
    if (!user) return undefined;
    if (!verifyPassword(password, user.passwordHash)) return undefined;
    return user;
  },

  /** Invalidate every session currently held by a user.

      Increments the user's session epoch. Sessions carry the epoch they were
      minted under, so every one issued before this call stops authenticating on
      its next request. Returns the new epoch so the caller can re-stamp the
      session it wants to keep alive (the one performing a password change,
      typically — changing your own password should not sign you out of the tab
      you are sitting in).

      This is the revocation primitive: anything that should strand existing
      sessions calls it. */
  bumpSessionEpoch(userId: number, ctx: AuditContext, reason: string): number {
    const user = this.getUser(userId);
    if (!user) throw httpError(404, "User not found");
    const next = (user.sessionEpoch ?? 0) + 1;
    db.update(users).set({ sessionEpoch: next }).where(eq(users.id, userId)).run();
    logSecurity("auth.sessions_revoked", "warn", ctx, { targetUserId: userId, reason, epoch: next });
    return next;
  },

  /** Change a user's own password.

      Requires the current password even though the route already demands
      step-up: step-up proves the session was recently authenticated, this
      proves the person at the keyboard knows the secret being replaced. Every
      other session is revoked, because the usual reason to change a password is
      that the old one may be in someone else's hands. */
  changePassword(userId: number, currentPassword: string, newPassword: string, ctx: AuditContext): number {
    const user = this.getUser(userId);
    if (!user) throw httpError(404, "User not found");
    if (!verifyPassword(currentPassword ?? "", user.passwordHash)) {
      logSecurity("auth.password_change_failed", "warn", ctx, { userId, reason: "current password incorrect" });
      throw httpError(401, "Your current password is incorrect");
    }
    if (typeof newPassword !== "string" || newPassword.length < 10) {
      throw httpError(400, "New password must be at least 10 characters");
    }
    if (verifyPassword(newPassword, user.passwordHash)) {
      throw httpError(400, "New password must be different from the current one");
    }
    db.update(users).set({ passwordHash: hashPassword(newPassword) }).where(eq(users.id, userId)).run();
    logAudit("user.password_change", "user", userId, ctx, { reason: "Password changed by the account holder" });
    return this.bumpSessionEpoch(userId, ctx, "password changed");
  },

  /* ----------------------------- memberships */
  /** Membership alone is not authority. Every mutating or sensitive read path
      must also confirm the member's role carries the specific permission, so an
      approver cannot manage bank accounts, reveal account numbers, or send a
      positive-pay file, and a viewer cannot change anything. */
  requirePerm(userId: number, businessId: number, permission: string) {
    const m = this.membership(userId, businessId);
    if (!m) throw httpError(403, "Not a member of this business");
    if (!can(m.role, permission)) {
      throw httpError(403, `Your role (${m.role}) lacks permission: ${permission}`);
    }
    return m;
  },
  membership(userId: number, businessId: number) {
    return db
      .select()
      .from(businessMemberships)
      .where(
        and(
          eq(businessMemberships.userId, userId),
          eq(businessMemberships.businessId, businessId)
        )
      )
      .get();
  },
  userBusinesses(userId: number) {
    const rows = db
      .select({
        business: businesses,
        membership: businessMemberships,
      })
      .from(businessMemberships)
      .innerJoin(businesses, eq(businessMemberships.businessId, businesses.id))
      .where(eq(businessMemberships.userId, userId))
      .all();
    return rows.map((r) => ({ ...serializeBusiness(r.business), role: r.membership.role }));
  },
  setMembership(userId: number, businessId: number, role: string) {
    const existing = this.membership(userId, businessId);
    if (existing) {
      return db
        .update(businessMemberships)
        .set({ role })
        .where(eq(businessMemberships.id, existing.id))
        .returning()
        .get();
    }
    return db
      .insert(businessMemberships)
      .values({ userId, businessId, role })
      .returning()
      .get();
  },

  /* ----------------------------- businesses */
  listBusinesses(userId: number) {
    return this.userBusinesses(userId);
  },
  getBusiness(userId: number, businessId: number): Business | undefined {
    const m = this.membership(userId, businessId);
    if (!m) return undefined; // tenant isolation: no membership = no access
    const b = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
    return b ? serializeBusiness(b) : undefined;
  },
  createBusiness(userId: number, data: Partial<Business>, role: string = "owner") {
    const b = db
      .insert(businesses)
      .values({
        legalName: data.legalName ?? "Untitled Business",
        dba: data.dba ?? null,
        ein: data.ein ? encrypt(data.ein) : null,
        addressLine1: data.addressLine1 ?? null,
        addressLine2: data.addressLine2 ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        zip: data.zip ?? null,
        phone: data.phone ?? null,
        logoDataUrl: data.logoDataUrl ?? null,
        defaultSigner: data.defaultSigner ?? null,
        status: "active",
      })
      .returning()
      .get();
    db.insert(businessMemberships).values({ userId, businessId: b.id, role }).run();
    /* Give every new business a working standard business-check layout so the
       designer and print preview are usable immediately rather than starting
       empty. The user can reposition or replace it at any time. */
    db.insert(checkTemplates)
      .values({
        businessId: b.id,
        bankAccountId: null,
        name: "Standard business check",
        layoutType: "business",
        stockType: "blank",
        elements: JSON.stringify(DEFAULT_TEMPLATE_ELEMENTS),
        isDefault: true,
        version: 1,
      })
      .run();
    return serializeBusiness(b);
  },
  updateBusiness(userId: number, businessId: number, data: Partial<Business>) {
    const existing = this.getBusiness(userId, businessId);
    if (!existing) throw new Error("Business not found");
    db.update(businesses)
      .set({
        legalName: data.legalName ?? undefined,
        dba: data.dba ?? undefined,
        ein: data.ein !== undefined ? (data.ein ? encrypt(data.ein) : null) : undefined,
        addressLine1: data.addressLine1 ?? undefined,
        addressLine2: data.addressLine2 ?? undefined,
        city: data.city ?? undefined,
        state: data.state ?? undefined,
        zip: data.zip ?? undefined,
        phone: data.phone ?? undefined,
        logoDataUrl: data.logoDataUrl ?? undefined,
        defaultSigner: data.defaultSigner ?? undefined,
      })
      .where(eq(businesses.id, businessId))
      .run();
    return this.getBusiness(userId, businessId);
  },
  archiveBusiness(userId: number, businessId: number) {
    if (!this.getBusiness(userId, businessId)) throw new Error("Business not found");
    db.update(businesses).set({ status: "archived" }).where(eq(businesses.id, businessId)).run();
    return this.getBusiness(userId, businessId);
  },

  /* ----------------------------- bank accounts */
  listBankAccounts(userId: number, businessId: number): (BankAccount & { accountMasked: string })[] {
    if (!this.membership(userId, businessId)) return [];
    const rows = db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.businessId, businessId))
      .all();
    return rows.map((a) => serializeBankAccount(a) as BankAccount & { accountMasked: string });
  },
  getBankAccount(userId: number, bankAccountId: number) {
    const account = db.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).get();
    if (!account) return undefined;
    if (!this.membership(userId, account.businessId)) return undefined;
    return serializeBankAccount(account) as BankAccount & { accountMasked: string };
  },
  createBankAccount(
    userId: number,
    businessId: number,
    data: {
      bankName: string;
      nickname: string;
      routingNumber?: string;
      accountNumber?: string;
      checkStartingNumber?: number;
      accountType?: string;
      bankAddress?: string;
      fractionPrefix?: string;
      defaultTemplateId?: number;
      positivePayEnabled?: boolean;
    },
    ctx: AuditContext
  ) {
    this.requirePerm(userId, businessId, "bank.manage");
    const routing = data.routingNumber?.replace(/\s|-/g, "") || null;
    let routingValid = true;
    if (routing) {
      routingValid = isValidRoutingNumber(routing);
      if (!routingValid) {
        logAudit("bank_account.routing_invalid", "bank_account", null, ctx, {
          newValue: { routingLength: routing.length },
          reason: "Routing number failed ABA checksum validation",
        });
      }
    }
    const start = data.checkStartingNumber ?? 1001;
    const created = db
      .insert(bankAccounts)
      .values({
        businessId,
        bankName: data.bankName,
        nickname: data.nickname,
        routingEncrypted: routing ? encrypt(routing) : null,
        accountEncrypted: data.accountNumber ? encrypt(data.accountNumber) : null,
        accountLast4: last4Of(data.accountNumber),
        checkStartingNumber: start,
        nextCheckNumber: start,
        accountType: data.accountType ?? "checking",
        bankAddress: data.bankAddress ?? null,
        fractionPrefix: normalizeFractionPrefix(data.fractionPrefix),
        defaultTemplateId: data.defaultTemplateId ?? null,
        status: "active",
        bankValidationStatus: routingValid ? "pending" : "requires_attention",
        positivePayEnabled: data.positivePayEnabled ?? false,
      })
      .returning()
      .get();
    /* Log a redacted summary, never the raw row: `created` carries the AES
       ciphertext of the routing and account numbers, and audit records are
       readable by every role with audit.view. */
    logAudit("bank_account.create", "bank_account", created.id, ctx, {
      newValue: {
        bankName: created.bankName,
        nickname: created.nickname,
        accountType: created.accountType,
        accountLast4: created.accountLast4,
        checkStartingNumber: created.checkStartingNumber,
        status: created.status,
        bankValidationStatus: created.bankValidationStatus,
        positivePayEnabled: created.positivePayEnabled,
        routingOnFile: created.routingEncrypted !== null,
        accountOnFile: created.accountEncrypted !== null,
      },
    });
    return serializeBankAccount(created);
  },
  updateBankAccount(
    userId: number,
    bankAccountId: number,
    data: Partial<{
      bankName: string;
      nickname: string;
      routingNumber: string;
      accountNumber: string;
      accountType: string;
      bankAddress: string;
      fractionPrefix: string;
      defaultTemplateId: number;
      status: string;
      positivePayEnabled: boolean;
      bankValidationStatus: string;
      bankValidationNotes: string;
    }>,
    ctx: AuditContext
  ) {
    const account = db.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).get();
    if (!account) throw httpError(404, "Bank account not found");
    this.requirePerm(userId, account.businessId, "bank.manage");
    const patch: Partial<BankAccount> = {};
    if (data.bankName !== undefined) patch.bankName = data.bankName;
    if (data.nickname !== undefined) patch.nickname = data.nickname;
    if (data.accountType !== undefined) patch.accountType = data.accountType;
    if (data.bankAddress !== undefined) patch.bankAddress = data.bankAddress;
    if (data.fractionPrefix !== undefined)
      patch.fractionPrefix = normalizeFractionPrefix(data.fractionPrefix);
    if (data.defaultTemplateId !== undefined) patch.defaultTemplateId = data.defaultTemplateId;
    if (data.status !== undefined) patch.status = data.status;
    if (data.positivePayEnabled !== undefined)
      patch.positivePayEnabled = data.positivePayEnabled;
    if (data.bankValidationStatus !== undefined)
      patch.bankValidationStatus = data.bankValidationStatus;
    if (data.bankValidationNotes !== undefined)
      patch.bankValidationNotes = data.bankValidationNotes;
    if (data.routingNumber !== undefined && data.routingNumber !== "") {
      const r = data.routingNumber.replace(/\s|-/g, "");
      patch.routingEncrypted = encrypt(r);
      if (!isValidRoutingNumber(r)) {
        patch.bankValidationStatus = "requires_attention";
      }
    }
    if (data.accountNumber !== undefined && data.accountNumber !== "") {
      patch.accountEncrypted = encrypt(data.accountNumber);
      patch.accountLast4 = last4Of(data.accountNumber);
    }
    // editing bank account details is a high-risk action
    logAudit("bank_account.update", "bank_account", bankAccountId, ctx, {
      oldValue: { nickname: account.nickname, status: account.status },
      newValue: patch,
      reason: "Bank account details changed (high-risk; requires re-auth)",
    });
    db.update(bankAccounts).set(patch).where(eq(bankAccounts.id, bankAccountId)).run();
    return this.getBankAccount(userId, bankAccountId);
  },
  /** Re-authenticated reveal of full account/routing numbers. */
  revealBankAccount(userId: number, bankAccountId: number, ctx: AuditContext) {
    const account = db.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).get();
    if (!account) throw httpError(404, "Bank account not found");
    /* Either explicit reveal authority, or authority to print — a printed check
       carries the routing and account numbers in its MICR line, so anyone who
       may print must be able to render them. Roles with neither (approver,
       signer, viewer) stay blocked. Every reveal is audited as a warning. */
    const m = this.membership(userId, account.businessId);
    if (!m) throw httpError(403, "Not a member of this business");
    if (!can(m.role, "bank.reveal") && !can(m.role, "check.print")) {
      throw httpError(403, `Your role (${m.role}) lacks permission: bank.reveal`);
    }
    logSecurity("bank_account.reveal", "warn", ctx, { bankAccountId });
    logAudit("bank_account.reveal", "bank_account", bankAccountId, ctx, {
      reason: "Full account/routing number revealed (re-authenticated)",
    });
    return {
      routingNumber: decrypt(account.routingEncrypted) ?? null,
      accountNumber: decrypt(account.accountEncrypted) ?? null,
      accountLast4: account.accountLast4,
    };
  },

  /* ----------------------------- payees */
  listPayees(userId: number, businessId: number, includeArchived = false) {
    if (!this.membership(userId, businessId)) return [];
    /* Both filters must be combined in a single where(). Chaining a second
       .where() replaces the first, which previously dropped the business
       filter and leaked payees from every business the user could reach. */
    const where = includeArchived
      ? eq(payees.businessId, businessId)
      : and(eq(payees.businessId, businessId), eq(payees.archived, false));
    const rows = db.select().from(payees).where(where).all();
    return rows.map((p) => ({ ...p, tags: safeParse(p.tags, []) }));
  },
  getPayee(userId: number, payeeId: number) {
    const p = db.select().from(payees).where(eq(payees.id, payeeId)).get();
    if (!p) return undefined;
    if (!this.membership(userId, p.businessId)) return undefined;
    return { ...p, tags: safeParse(p.tags, []) };
  },
  findDuplicatePayees(userId: number, businessId: number) {
    const all = this.listPayees(userId, businessId, true);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
    const groups: Record<string, number[]> = {};
    for (const p of all) {
      if (p.archived) continue;
      const key = norm(p.name);
      (groups[key] = groups[key] || []).push(p.id);
    }
    return Object.values(groups).filter((ids) => ids.length > 1);
  },
  createPayee(userId: number, businessId: number, data: Partial<Payee>, ctx: AuditContext) {
    this.requirePerm(userId, businessId, "payee.manage");
    const created = db
      .insert(payees)
      .values({
        businessId,
        name: data.name ?? "Unnamed Payee",
        type: data.type ?? "business",
        addressLine1: data.addressLine1 ?? null,
        addressLine2: data.addressLine2 ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        zip: data.zip ?? null,
        contactName: data.contactName ?? null,
        contactEmail: data.contactEmail ?? null,
        contactPhone: data.contactPhone ?? null,
        defaultMemo: data.defaultMemo ?? null,
        category: data.category ?? null,
        tags: JSON.stringify(data.tags ?? []),
        internalNotes: data.internalNotes ?? null,
        archived: false,
      })
      .returning()
      .get();
    logAudit("payee.create", "payee", created.id, ctx, { newValue: created });
    return { ...created, tags: safeParse(created.tags, []) };
  },
  updatePayee(userId: number, payeeId: number, data: Partial<Payee>, ctx: AuditContext) {
    const existing = this.getPayee(userId, payeeId);
    if (!existing) throw httpError(404, "Payee not found");
    this.requirePerm(userId, existing.businessId, "payee.manage");
    db.update(payees)
      .set({
        name: data.name ?? undefined,
        type: data.type ?? undefined,
        addressLine1: data.addressLine1 ?? undefined,
        addressLine2: data.addressLine2 ?? undefined,
        city: data.city ?? undefined,
        state: data.state ?? undefined,
        zip: data.zip ?? undefined,
        contactName: data.contactName ?? undefined,
        contactEmail: data.contactEmail ?? undefined,
        contactPhone: data.contactPhone ?? undefined,
        defaultMemo: data.defaultMemo ?? undefined,
        category: data.category ?? undefined,
        tags: data.tags ? JSON.stringify(data.tags) : undefined,
        internalNotes: data.internalNotes ?? undefined,
        archived: data.archived ?? undefined,
      })
      .where(eq(payees.id, payeeId))
      .run();
    logAudit("payee.update", "payee", payeeId, ctx, { oldValue: existing, reason: "Payee edited" });
    return this.getPayee(userId, payeeId);
  },
  archivePayee(userId: number, payeeId: number, ctx: AuditContext) {
    const existing = this.getPayee(userId, payeeId);
    if (!existing) throw httpError(404, "Payee not found");
    this.requirePerm(userId, existing.businessId, "payee.manage");
    db.update(payees).set({ archived: true }).where(eq(payees.id, payeeId)).run();
    logAudit("payee.archive", "payee", payeeId, ctx, { reason: "Payee archived" });
    return this.getPayee(userId, payeeId);
  },

  /* ----------------------------- check templates */
  listTemplates(userId: number, businessId: number) {
    if (!this.membership(userId, businessId)) return [];
    const rows = db
      .select()
      .from(checkTemplates)
      .where(eq(checkTemplates.businessId, businessId))
      .all();
    return rows.map((t) => ({
      ...t,
      elements: safeParse(t.elements, []),
      background: safeParse(t.background, { mode: "none" }),
    }));
  },
  getTemplate(userId: number, templateId: number) {
    const t = db.select().from(checkTemplates).where(eq(checkTemplates.id, templateId)).get();
    if (!t) return undefined;
    if (!this.membership(userId, t.businessId)) return undefined;
    return {
      ...t,
      elements: safeParse(t.elements, []),
      background: safeParse(t.background, { mode: "none" }),
    };
  },
  createTemplate(
    userId: number,
    businessId: number,
    data: {
      name: string;
      layoutType?: string;
      stockType?: string;
      elements?: unknown[];
      background?: unknown;
      bankAccountId?: number;
      isDefault?: boolean;
    },
    ctx: AuditContext
  ) {
    this.requirePerm(userId, businessId, "template.manage");
    if (data.isDefault) {
      db.update(checkTemplates).set({ isDefault: false }).where(eq(checkTemplates.businessId, businessId)).run();
    }
    const created = db
      .insert(checkTemplates)
      .values({
        businessId,
        bankAccountId: data.bankAccountId ?? null,
        name: data.name,
        layoutType: data.layoutType ?? "business",
        stockType: data.stockType ?? "blank",
        elements: JSON.stringify(data.elements ?? defaultDesign().elements),
        background: JSON.stringify(data.background ?? { mode: "none" }),
        isDefault: data.isDefault ?? false,
        version: 1,
      })
      .returning()
      .get();
    logAudit("template.create", "check_template", created.id, ctx, { newValue: created });
    return {
      ...created,
      elements: safeParse(created.elements, []),
      background: safeParse(created.background, { mode: "none" }),
    };
  },
  updateTemplate(
    userId: number,
    templateId: number,
    data: Partial<{
      name: string;
      elements: unknown[];
      background: unknown;
      isDefault: boolean;
      layoutType: string;
      stockType: string;
    }>,
    ctx: AuditContext
  ) {
    const t = this.getTemplate(userId, templateId);
    if (!t) throw httpError(404, "Template not found");
    this.requirePerm(userId, t.businessId, "template.manage");
    if (data.isDefault) {
      db.update(checkTemplates).set({ isDefault: false }).where(eq(checkTemplates.businessId, t.businessId)).run();
    }
    db.update(checkTemplates)
      .set({
        name: data.name ?? undefined,
        elements: data.elements ? JSON.stringify(data.elements) : undefined,
        background: data.background !== undefined ? JSON.stringify(data.background) : undefined,
        isDefault: data.isDefault ?? undefined,
        layoutType: data.layoutType ?? undefined,
        stockType: data.stockType ?? undefined,
        version: (t.version || 1) + 1,
      })
      .where(eq(checkTemplates.id, templateId))
      .run();
    logAudit("template.update", "check_template", templateId, ctx, { reason: "Template edited/versioned" });
    return this.getTemplate(userId, templateId);
  },

  deleteTemplate(userId: number, templateId: number, ctx: AuditContext) {
    const t = this.getTemplate(userId, templateId);
    if (!t) throw httpError(404, "Template not found");
    this.requirePerm(userId, t.businessId, "template.manage");
    /* Refuse while any bank account still points here: silently orphaning a
       default template would make the next print fall back to a layout the
       user never calibrated. */
    const inUse = db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.defaultTemplateId, templateId))
      .all();
    if (inUse.length > 0) {
      throw httpError(
        409,
        `This template is the default for ${inUse.length} bank account(s). Point them at another template first.`,
      );
    }
    db.delete(checkTemplates).where(eq(checkTemplates.id, templateId)).run();
    logAudit("template.delete", "check_template", templateId, ctx, { oldValue: t });
    return { ok: true };
  },

  /* ----------------------------- template assets */
  listAssets(userId: number, businessId: number) {
    if (!this.membership(userId, businessId)) return [];
    /* Deliberately omits `data`: an index of twenty logos should not ship
       megabytes of base64 into the browser on every designer page load. */
    return db
      .select({
        id: templateAssets.id,
        businessId: templateAssets.businessId,
        name: templateAssets.name,
        kind: templateAssets.kind,
        mimeType: templateAssets.mimeType,
        byteSize: templateAssets.byteSize,
        widthPx: templateAssets.widthPx,
        heightPx: templateAssets.heightPx,
        rightsAttestedAt: templateAssets.rightsAttestedAt,
        createdAt: templateAssets.createdAt,
      })
      .from(templateAssets)
      .where(eq(templateAssets.businessId, businessId))
      .all();
  },
  getAsset(userId: number, assetId: number) {
    const a = db.select().from(templateAssets).where(eq(templateAssets.id, assetId)).get();
    if (!a) return undefined;
    if (!this.membership(userId, a.businessId)) return undefined;
    return a;
  },
  createAsset(
    userId: number,
    businessId: number,
    data: {
      name: string;
      kind: string;
      mimeType: string;
      data: string;
      byteSize: number;
      widthPx?: number | null;
      heightPx?: number | null;
      rightsAttested?: boolean;
    },
    ctx: AuditContext,
  ) {
    this.requirePerm(userId, businessId, "template.manage");
    /* A bank's logo is the bank's mark. Placing it on a check without the
       bank's written authorization is not the customer's call, so record an
       explicit attestation rather than assuming permission. */
    if (data.kind === "bank_logo" && !data.rightsAttested) {
      throw httpError(
        400,
        "A bank logo requires written authorization from the bank. Confirm you hold it before uploading.",
      );
    }
    const created = db
      .insert(templateAssets)
      .values({
        businessId,
        name: data.name,
        kind: data.kind,
        mimeType: data.mimeType,
        data: data.data,
        byteSize: data.byteSize,
        widthPx: data.widthPx ?? null,
        heightPx: data.heightPx ?? null,
        rightsAttestedAt: data.rightsAttested ? Date.now() : null,
        uploadedBy: userId,
      })
      .returning()
      .get();
    /* Log the metadata only — never the payload. */
    logAudit("template_asset.create", "template_asset", created.id, ctx, {
      newValue: {
        name: created.name,
        kind: created.kind,
        mimeType: created.mimeType,
        byteSize: created.byteSize,
        rightsAttested: !!created.rightsAttestedAt,
      },
    });
    const { data: _omit, ...meta } = created;
    return meta;
  },
  deleteAsset(userId: number, assetId: number, ctx: AuditContext) {
    const a = this.getAsset(userId, assetId);
    if (!a) throw httpError(404, "Asset not found");
    this.requirePerm(userId, a.businessId, "template.manage");
    /* Refuse if a template still references it, so a saved template cannot
       quietly lose its logo. */
    const templates = db
      .select()
      .from(checkTemplates)
      .where(eq(checkTemplates.businessId, a.businessId))
      .all();
    const users_ = templates.filter((t) => {
      const els = safeParse<Array<{ assetId?: number | null }>>(t.elements, []);
      const bg = safeParse<{ assetId?: number | null }>(t.background, {});
      return els.some((e) => e.assetId === assetId) || bg.assetId === assetId;
    });
    if (users_.length > 0) {
      throw httpError(
        409,
        `In use by ${users_.length} template(s): ${users_.map((t) => t.name).join(", ")}. Remove it from those templates first.`,
      );
    }
    db.delete(templateAssets).where(eq(templateAssets.id, assetId)).run();
    logAudit("template_asset.delete", "template_asset", assetId, ctx, {
      oldValue: { name: a.name, kind: a.kind },
    });
    return { ok: true };
  },

  /* ----------------------------- printer profiles */
  listPrinters(userId: number, businessId: number) {
    if (!this.membership(userId, businessId)) return [];
    return db.select().from(printerProfiles).where(eq(printerProfiles.businessId, businessId)).all();
  },
  createPrinter(
    userId: number,
    businessId: number,
    data: { name: string; stockType?: string; offsetX?: number; offsetY?: number; scale?: number; notes?: string },
    ctx: AuditContext
  ) {
    this.requirePerm(userId, businessId, "printer.manage");
    const created = db
      .insert(printerProfiles)
      .values({
        businessId,
        name: data.name,
        stockType: data.stockType ?? "blank",
        offsetX: data.offsetX ?? 0,
        offsetY: data.offsetY ?? 0,
        scale: data.scale ?? 100,
        notes: data.notes ?? null,
      })
      .returning()
      .get();
    logAudit("printer.create", "printer_profile", created.id, ctx, { newValue: created });
    return created;
  },
  updatePrinter(
    userId: number,
    printerId: number,
    data: Partial<{ name: string; offsetX: number; offsetY: number; scale: number; notes: string; stockType: string }>,
    ctx: AuditContext
  ) {
    const p = db.select().from(printerProfiles).where(eq(printerProfiles.id, printerId)).get();
    if (!p) throw httpError(404, "Printer profile not found");
    this.requirePerm(userId, p.businessId, "printer.manage");
    db.update(printerProfiles)
      .set({
        name: data.name ?? undefined,
        offsetX: data.offsetX ?? undefined,
        offsetY: data.offsetY ?? undefined,
        scale: data.scale ?? undefined,
        notes: data.notes ?? undefined,
        stockType: data.stockType ?? undefined,
      })
      .where(eq(printerProfiles.id, printerId))
      .run();
    logAudit("printer.calibrate", "printer_profile", printerId, ctx, {
      newValue: data,
      reason: "Printer calibration changed",
    });
    return db.select().from(printerProfiles).where(eq(printerProfiles.id, printerId)).get();
  },

  /* ----------------------------- checks */
  listChecks(userId: number, businessId: number, filters?: { bankAccountId?: number; status?: string; q?: string }) {
    if (!this.membership(userId, businessId)) return [];
    let rows = db
      .select()
      .from(checks)
      .where(eq(checks.businessId, businessId))
      .all();
    if (filters?.bankAccountId) rows = rows.filter((c) => c.bankAccountId === filters.bankAccountId);
    if (filters?.status) rows = rows.filter((c) => c.status === filters.status);
    if (filters?.q) {
      const q = filters.q.toLowerCase();
      rows = rows.filter(
        (c) =>
          c.payeeName.toLowerCase().includes(q) ||
          String(c.checkNumber).includes(q) ||
          (c.memo ?? "").toLowerCase().includes(q)
      );
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
  getCheck(userId: number, checkId: number) {
    const c = db.select().from(checks).where(eq(checks.id, checkId)).get();
    if (!c) return undefined;
    if (!this.membership(userId, c.businessId)) return undefined;
    const lineItems = db
      .select()
      .from(checkLineItems)
      .where(eq(checkLineItems.checkId, checkId))
      .all();
    return { ...c, lineItems };
  },
  /** Validate a check number against a bank account's sequence.
   *  Scoped: the caller must be a member of `businessId`, and the account must
   *  belong to it — otherwise this leaks another tenant's check sequence and
   *  void history via a guessable account id. */
  validateCheckNumber(userId: number, businessId: number, bankAccountId: number, checkNumber: number) {
    this.requirePerm(userId, businessId, "check.prepare");
    const account = db
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.businessId, businessId)))
      .get();
    if (!account) throw httpError(404, "Bank account not found");
    const existing = db
      .select()
      .from(checks)
      .where(and(eq(checks.bankAccountId, bankAccountId), eq(checks.checkNumber, checkNumber)))
      .all();
    const next = account.nextCheckNumber ?? checkNumber;
    const warnings: string[] = [];
    if (existing.length > 0) warnings.push(`Check #${checkNumber} already exists on this account`);
    if (checkNumber < next) warnings.push(`Check #${checkNumber} is below the next expected number (#${next}) — possible gap reuse`);
    if (checkNumber > next) warnings.push(`Check #${checkNumber} skips ${checkNumber - next} number(s) from #${next}`);
    const voided = existing.filter((e) => e.status === "voided");
    if (voided.length > 0) warnings.push(`Check #${checkNumber} was previously voided`);
    return { warnings, valid: warnings.length === 0, expectedNext: next };
  },
  createCheck(
    userId: number,
    input: {
      businessId: number;
      bankAccountId: number;
      checkDate: string;
      payeeId?: number | null;
      payeeName: string;
      amount: number | string;
      memo?: string;
      lineItems?: Array<{ category?: string; department?: string; project?: string; classField?: string; invoiceRef?: string; description?: string; amount: number | string }>;
      checkNumberOverride?: number;
      status?: string;
    },
    ctx: AuditContext
  ) {
    if (!this.membership(userId, input.businessId)) throw new Error("Access denied");
    const account = db.select().from(bankAccounts).where(eq(bankAccounts.id, input.bankAccountId)).get();
    if (!account) throw new Error("Bank account not found");
    if (account.businessId !== input.businessId) throw new Error("Bank account does not belong to this business");
    if (account.status !== "active") {
      throw new Error(`Cannot issue from a ${account.status} bank account`);
    }

    const amountCents = dollarsToCents(input.amount);
    if (amountCents <= 0) throw new Error("Amount must be greater than zero");

    /* Line items are accounting detail for the same payment, so they must
       account for the full face amount. Allowing a mismatch would let the
       register and the printed check disagree. */
    if (input.lineItems && input.lineItems.length) {
      const lineTotal = input.lineItems.reduce((sum, li) => sum + dollarsToCents(li.amount), 0);
      if (lineTotal !== amountCents) {
        throw httpError(
          400,
          `Line items total ${(lineTotal / 100).toFixed(2)} but the check amount is ${(amountCents / 100).toFixed(2)}. They must match.`
        );
      }
    }

    const writtenAmount = amountToWords(amountCents / 100);

    // check-number sequence with a transaction + unique constraint
    return db.transaction((tx) => {
      let checkNumber = input.checkNumberOverride ?? account.nextCheckNumber;
      const accountNow = tx.select().from(bankAccounts).where(eq(bankAccounts.id, input.bankAccountId)).get();
      const nextExpected = accountNow?.nextCheckNumber ?? checkNumber;
      if (!input.checkNumberOverride) {
        checkNumber = nextExpected;
      } else if (input.checkNumberOverride !== nextExpected) {
        // manual override — must be recorded with a reason
        logAudit("check_number.override", "bank_account", input.bankAccountId, ctx, {
          newValue: { requested: input.checkNumberOverride, expected: nextExpected },
          reason: "Manual check-number override",
        });
      }
      // unique constraint (bank_account_id, check_number) prevents duplicates
      let created: Check;
      try {
        created = tx
          .insert(checks)
          .values({
            businessId: input.businessId,
            bankAccountId: input.bankAccountId,
            checkNumber,
            checkDate: input.checkDate,
            payeeId: input.payeeId ?? null,
            payeeName: input.payeeName,
            amountCents,
            writtenAmount,
            memo: input.memo ?? null,
            status: input.status ?? "draft",
            preparerId: userId,
            version: 1,
          })
          .returning()
          .get();
      } catch (e) {
        throw new Error(`Check #${checkNumber} already exists on this account (duplicate)`);
      }
      // advance the sequence only when using the auto-assigned number
      if (!input.checkNumberOverride) {
        tx.update(bankAccounts)
          .set({ nextCheckNumber: checkNumber + 1 })
          .where(eq(bankAccounts.id, input.bankAccountId))
          .run();
      }
      // line items
      if (input.lineItems && input.lineItems.length) {
        for (const li of input.lineItems) {
          tx.insert(checkLineItems)
            .values({
              checkId: created.id,
              category: li.category ?? null,
              department: li.department ?? null,
              project: li.project ?? null,
              classField: li.classField ?? null,
              invoiceRef: li.invoiceRef ?? null,
              description: li.description ?? null,
              amountCents: dollarsToCents(li.amount),
            })
            .run();
        }
      }
      logAudit("check.create", "check", created.id, ctx, { newValue: created });
      return created;
    });
  },
  updateCheck(userId: number, checkId: number, data: Partial<{ checkDate: string; payeeName: string; amount: number | string; memo: string; payeeId: number | null; lineItems: unknown[] }>, ctx: AuditContext) {
    const existing = this.getCheck(userId, checkId);
    if (!existing) throw httpError(404, "Check not found");
    this.requirePerm(userId, existing.businessId, "check.prepare");
    // post-issuance edits forbidden — must use void/reissue
    const immutable = ["printed", "issued", "cleared", "voided", "replaced"];
    if (immutable.includes(existing.status)) {
      throw new Error(`Cannot edit a check in status "${existing.status}". Use void/reissue workflow.`);
    }
    const patch: Partial<Check> = { updatedAt: Date.now() };
    if (data.checkDate) patch.checkDate = data.checkDate;
    if (data.payeeName !== undefined) patch.payeeName = data.payeeName;
    if (data.memo !== undefined) patch.memo = data.memo;
    if (data.payeeId !== undefined) patch.payeeId = data.payeeId;
    if (data.amount !== undefined) {
      const cents = dollarsToCents(data.amount);
      if (cents <= 0) throw new Error("Amount must be greater than zero");
      patch.amountCents = cents;
      patch.writtenAmount = amountToWords(cents / 100);
    }
    db.update(checks).set(patch).where(eq(checks.id, checkId)).run();
    if (data.lineItems) {
      db.delete(checkLineItems).where(eq(checkLineItems.checkId, checkId)).run();
      for (const li of data.lineItems as Array<Record<string, unknown>>) {
        db.insert(checkLineItems)
          .values({
            checkId,
            category: (li.category as string) ?? null,
            department: (li.department as string) ?? null,
            project: (li.project as string) ?? null,
            classField: (li.classField as string) ?? null,
            invoiceRef: (li.invoiceRef as string) ?? null,
            description: (li.description as string) ?? null,
            amountCents: dollarsToCents(li.amount as number | string),
          })
          .run();
      }
    }
    logAudit("check.update", "check", checkId, ctx, { oldValue: { status: existing.status, amountCents: existing.amountCents }, reason: "Draft check edited before issuance" });
    return this.getCheck(userId, checkId);
  },
  setCheckStatus(userId: number, checkId: number, status: string, ctx: AuditContext, reason?: string) {
    const existing = this.getCheck(userId, checkId);
    if (!existing) throw new Error("Check not found");
    if (!can(existing.role, "check.print")) {
      // role is not on check; we check via membership below
    }
    const membership = this.membership(userId, existing.businessId);
    if (!membership) throw new Error("Access denied");
    db.update(checks)
      .set({ status, updatedAt: Date.now(), ...(status === "printed" ? { printedAt: Date.now() } : {}), ...(status === "issued" ? { issuedAt: Date.now() } : {}) })
      .where(eq(checks.id, checkId))
      .run();
    logAudit(`check.${status}`, "check", checkId, ctx, { oldValue: { status: existing.status }, reason: reason ?? `Status changed to ${status}` });
    return this.getCheck(userId, checkId);
  },
  approveCheck(userId: number, checkId: number, ctx: AuditContext, comment?: string) {
    const existing = this.getCheck(userId, checkId);
    if (!existing) throw new Error("Check not found");
    const membership = this.membership(userId, existing.businessId);
    if (!membership || !can(membership.role, "check.approve")) throw new Error("Not authorized to approve checks");

    /* Whoever holds check.approve may approve any check at any amount,
       including one they prepared themselves. A single-operator business is its
       own approval chain, so a self-approval block would leave the owner unable
       to issue their own payments. Approval remains attributable rather than
       restricted: preparerId and approverId are both stored, and the audit entry
       records that the approver was also the preparer. */
    const selfApproved = existing.preparerId === userId;
    db.update(checks).set({ status: "approved", approverId: userId, updatedAt: Date.now() }).where(eq(checks.id, checkId)).run();
    logAudit("check.approve", "check", checkId, ctx, {
      reason: comment ?? (selfApproved ? "Check approved by its preparer" : "Check approved"),
      newValue: { selfApproved, amountCents: existing.amountCents },
    });
    return this.getCheck(userId, checkId);
  },
  signCheck(userId: number, checkId: number, ctx: AuditContext) {
    const existing = this.getCheck(userId, checkId);
    if (!existing) throw new Error("Check not found");
    const membership = this.membership(userId, existing.businessId);
    if (!membership || !can(membership.role, "check.sign")) throw new Error("Not authorized to sign checks");
    /* Signing attests to an approved payment, so it cannot skip approval. */
    if (existing.status !== "approved") {
      throw httpError(400, `Only an approved check can be signed (this one is "${existing.status}").`);
    }
    db.update(checks).set({ status: "ready_to_print", signerId: userId, updatedAt: Date.now() }).where(eq(checks.id, checkId)).run();
    logAudit("check.sign", "check", checkId, ctx, { reason: "Check signed / marked ready to print" });
    return this.getCheck(userId, checkId);
  },
  printCheck(userId: number, checkId: number, ctx: AuditContext, testMode = false) {
    const existing = this.getCheck(userId, checkId);
    if (!existing) throw new Error("Check not found");
    const membership = this.membership(userId, existing.businessId);
    if (!membership || !can(membership.role, "check.print")) throw new Error("Not authorized to print checks");

    /* A test print is a printer-calibration aid marked VOID/TEST ONLY. It must
       never consume the check: no status change, no printedAt, no issued
       snapshot. It is still recorded in the audit trail. */
    if (testMode) {
      logAudit("check.print", "check", checkId, ctx, {
        reason: "TEST/VOID calibration print — check not issued",
        newValue: { testMode: true, statusUnchanged: existing.status },
      });
      return this.getCheck(userId, checkId);
    }

    /* A real print is issuance, so it must have cleared approval and signing.
       Re-printing an already-printed check must go through the reprint
       workflow, which requires a stated reason. */
    const printable = ["approved", "ready_to_print", "reprinted"];
    if (!printable.includes(existing.status)) {
      const hint =
        existing.status === "printed"
          ? "Use the reprint workflow, which records a reason."
          : "It must be approved and signed first.";
      throw httpError(400, `Cannot print a check in status "${existing.status}". ${hint}`);
    }

    // capture immutable snapshot at print time
    const snapshot = JSON.stringify({
      checkNumber: existing.checkNumber,
      payeeName: existing.payeeName,
      amountCents: existing.amountCents,
      writtenAmount: existing.writtenAmount,
      checkDate: existing.checkDate,
      memo: existing.memo,
      bankAccountId: existing.bankAccountId,
      testMode,
      capturedAt: Date.now(),
    });
    const newStatus = existing.status === "reprinted" ? "reprinted" : "printed";
    db.update(checks)
      .set({ status: newStatus, printedAt: Date.now(), issuedSnapshot: snapshot, reprintCount: existing.reprintCount + (newStatus === "reprinted" ? 1 : 0) })
      .where(eq(checks.id, checkId))
      .run();
    logAudit("check.print", "check", checkId, ctx, { reason: testMode ? "TEST/VOID print" : "Check printed", newValue: { testMode } });
    return this.getCheck(userId, checkId);
  },
  reprintCheck(userId: number, checkId: number, reason: string, ctx: AuditContext) {
    if (!reason) throw new Error("A reason is required for reprints");
    const existing = this.getCheck(userId, checkId);
    if (!existing) throw new Error("Check not found");
    const membership = this.membership(userId, existing.businessId);
    if (!membership || !can(membership.role, "check.reprint")) throw new Error("Not authorized to reprint");
    db.update(checks).set({ status: "reprinted", reprintCount: existing.reprintCount + 1, updatedAt: Date.now() }).where(eq(checks.id, checkId)).run();
    logAudit("check.reprint", "check", checkId, ctx, { reason, newValue: { reprintCount: existing.reprintCount + 1 } });
    return this.getCheck(userId, checkId);
  },
  voidCheck(userId: number, checkId: number, reason: string, ctx: AuditContext) {
    if (!reason) throw new Error("A reason is required to void a check");
    const existing = this.getCheck(userId, checkId);
    if (!existing) throw new Error("Check not found");
    const membership = this.membership(userId, existing.businessId);
    if (!membership || !can(membership.role, "check.void")) throw new Error("Not authorized to void checks");
    db.update(checks).set({ status: "voided", voidedAt: Date.now(), voidReason: reason, updatedAt: Date.now() }).where(eq(checks.id, checkId)).run();
    logAudit("check.void", "check", checkId, ctx, { reason });
    return this.getCheck(userId, checkId);
  },
  replaceCheck(userId: number, checkId: number, reason: string, ctx: AuditContext) {
    // void the old, create a replacement referencing it
    const existing = this.getCheck(userId, checkId);
    if (!existing) throw new Error("Check not found");
    const membership = this.membership(userId, existing.businessId);
    if (!membership || !can(membership.role, "check.replace")) throw new Error("Not authorized to replace checks");
    db.update(checks).set({ status: "replaced", voidedAt: Date.now(), voidReason: reason, updatedAt: Date.now() }).where(eq(checks.id, checkId)).run();
    // replacement gets the next sequential number
    const replacement = this.createCheck(userId, {
      businessId: existing.businessId,
      bankAccountId: existing.bankAccountId,
      checkDate: existing.checkDate,
      payeeName: existing.payeeName,
      payeeId: existing.payeeId,
      amount: existing.amountCents / 100,
      memo: existing.memo ?? undefined,
    }, ctx);
    db.update(checks).set({ replacedById: replacement.id }).where(eq(checks.id, checkId)).run();
    logAudit("check.replace", "check", checkId, ctx, { reason, newValue: { replacementId: replacement.id } });
    return { original: this.getCheck(userId, checkId), replacement };
  },
  markCleared(userId: number, checkId: number, clearedDate: number, ctx: AuditContext) {
    const existing = this.getCheck(userId, checkId);
    if (!existing) throw new Error("Check not found");
    const membership = this.membership(userId, existing.businessId);
    if (!membership || !can(membership.role, "check.clear"))
      throw httpError(403, "Not authorized to clear checks");
    db.update(checks).set({ status: "cleared", clearedAt: clearedDate, updatedAt: Date.now() }).where(eq(checks.id, checkId)).run();
    logAudit("check.clear", "check", checkId, ctx, { newValue: { clearedDate } });
    return this.getCheck(userId, checkId);
  },

  /* ----------------------------- team membership

     Extra users are optional. A sole owner can prepare, approve, sign and print
     on their own; adding members is for delegating that work, not for unlocking
     it. */
  listMembers(userId: number, businessId: number) {
    if (!this.membership(userId, businessId)) return [];
    return db
      .select({ membership: businessMemberships, user: users })
      .from(businessMemberships)
      .innerJoin(users, eq(businessMemberships.userId, users.id))
      .where(eq(businessMemberships.businessId, businessId))
      .all()
      .map((r) => ({
        userId: r.user.id,
        email: r.user.email,
        name: r.user.name,
        role: r.membership.role,
        membershipId: r.membership.id,
        createdAt: r.membership.createdAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },
  addMember(
    actorId: number,
    businessId: number,
    input: { email: string; name?: string; password?: string; role: string },
    ctx: AuditContext
  ) {
    const actor = this.membership(actorId, businessId);
    if (!actor || !can(actor.role, "business.manage")) {
      throw httpError(403, "Not authorized to manage users for this business");
    }
    const role = (input.role || "").trim();
    if (!isKnownRole(role)) {
      throw httpError(400, `Unknown role "${input.role}". Valid roles: ${Object.keys(ROLE_PERMISSIONS).join(", ")}`);
    }
    /* Only an owner may create another owner, so an admin cannot escalate. */
    if (role === "owner" && actor.role !== "owner") {
      throw httpError(403, "Only an owner can grant the owner role");
    }
    const email = (input.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) throw httpError(400, "A valid email address is required");

    let user = this.getUserByEmail(email);
    if (!user) {
      /* New person: an initial password is required so they can sign in. */
      if (!input.password || input.password.length < 10) {
        throw httpError(400, "New users need an initial password of at least 10 characters");
      }
      user = this.createUser(email, (input.name || email.split("@")[0]).trim(), input.password);
    }
    if (this.membership(user.id, businessId)) {
      throw httpError(409, "That user is already a member of this business");
    }
    const created = db
      .insert(businessMemberships)
      .values({ userId: user.id, businessId, role, createdAt: Date.now() })
      .returning()
      .get();
    logAudit("member.add", "user", user.id, ctx, {
      reason: `Added ${email} as ${role}`,
      newValue: { email, role },
    });
    return { userId: user.id, email: user.email, name: user.name, role, membershipId: created.id, createdAt: created.createdAt };
  },
  updateMemberRole(actorId: number, businessId: number, targetUserId: number, role: string, ctx: AuditContext) {
    const actor = this.membership(actorId, businessId);
    if (!actor || !can(actor.role, "business.manage")) {
      throw httpError(403, "Not authorized to manage users for this business");
    }
    if (!isKnownRole(role)) throw httpError(400, `Unknown role "${role}"`);
    if (role === "owner" && actor.role !== "owner") throw httpError(403, "Only an owner can grant the owner role");
    const target = this.membership(targetUserId, businessId);
    if (!target) throw httpError(404, "That user is not a member of this business");
    /* Never let the last owner be demoted — the business would become
       unmanageable and no one could approve or configure anything. */
    if (target.role === "owner" && role !== "owner" && this.ownerCount(businessId) <= 1) {
      throw httpError(400, "This is the only owner. Promote another owner before changing this role.");
    }
    db.update(businessMemberships)
      .set({ role })
      .where(and(eq(businessMemberships.userId, targetUserId), eq(businessMemberships.businessId, businessId)))
      .run();
    logAudit("member.role_change", "user", targetUserId, ctx, {
      reason: `Role changed from ${target.role} to ${role}`,
      oldValue: { role: target.role },
      newValue: { role },
    });
    /* Force the target to sign in again under the new role. Permission checks
       already read the role from the database per request, so this is not what
       stops a demoted user from acting — it clears any step-up window they had
       banked under the old role, which otherwise survives the demotion. */
    this.bumpSessionEpoch(targetUserId, ctx, `role changed to ${role}`);
    return this.listMembers(actorId, businessId);
  },
  removeMember(actorId: number, businessId: number, targetUserId: number, ctx: AuditContext) {
    const actor = this.membership(actorId, businessId);
    if (!actor || !can(actor.role, "business.manage")) {
      throw httpError(403, "Not authorized to manage users for this business");
    }
    const target = this.membership(targetUserId, businessId);
    if (!target) throw httpError(404, "That user is not a member of this business");
    if (target.role === "owner" && this.ownerCount(businessId) <= 1) {
      throw httpError(400, "This is the only owner and cannot be removed.");
    }
    db.delete(businessMemberships)
      .where(and(eq(businessMemberships.userId, targetUserId), eq(businessMemberships.businessId, businessId)))
      .run();
    /* The person's prepared/approved checks and audit history are deliberately
       retained — removing access must not erase the trail. */
    logAudit("member.remove", "user", targetUserId, ctx, { reason: `Removed from business (was ${target.role})` });
    /* Cut off live sessions immediately. Without this a just-removed bookkeeper
       keeps a working session against any other business they belong to, and
       retains their step-up window, until the 12h TTL expires. */
    this.bumpSessionEpoch(targetUserId, ctx, "removed from a business");
    return this.listMembers(actorId, businessId);
  },
  ownerCount(businessId: number) {
    return db
      .select()
      .from(businessMemberships)
      .where(and(eq(businessMemberships.businessId, businessId), eq(businessMemberships.role, "owner")))
      .all().length;
  },

  /* ----------------------------- audit + exports */
  listAuditEvents(userId: number, businessId?: number, limit = 200) {
    // audit visible only to members of the business (or all businesses the user is in)
    const userBusinessIds = this.userBusinesses(userId).map((b) => b.id);
    let rows = db.select().from(auditEvents).all();
    if (businessId) {
      if (!this.membership(userId, businessId)) return [];
      rows = rows.filter((e) => e.businessId === businessId);
    } else {
      /* Events with no business (sign-in, registration, account-level actions)
         are only ever the caller's own — otherwise every user would read every
         other user's activity out of the global feed. */
      rows = rows.filter((e) =>
        e.businessId == null ? e.userId === userId : userBusinessIds.includes(e.businessId)
      );
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },
  listSecurityEvents(userId: number, limit = 100) {
    /* Security events are per-user and carry no businessId, and their `details`
       can contain other people's email addresses (e.g. failed logins) — so a
       caller only ever sees their own events, never the global feed. */
    return db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.userId, userId))
      .all()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },
  listPositivePayExports(userId: number, businessId: number) {
    if (!this.membership(userId, businessId)) return [];
    return db.select().from(positivePayExports).where(eq(positivePayExports.businessId, businessId)).all().sort((a, b) => b.exportedAt - a.exportedAt);
  },
  /** Build a positive-pay export for issued/printed (not voided) checks on an account. */
  buildPositivePay(userId: number, bankAccountId: number, ctx: AuditContext) {
    const account = db.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).get();
    if (!account) throw httpError(404, "Bank account not found");
    this.requirePerm(userId, account.businessId, "positivepay.export");
    const allChecks = db.select().from(checks).where(eq(checks.bankAccountId, bankAccountId)).all();
    /* A positive-pay file must carry VOID records, not just issues. A check that
       was printed and later voided is already in the bank's issue file, so
       omitting it would leave the bank matching and paying an item the business
       has cancelled. Checks that were never printed are not reported at all. */
    const issuedStatuses = ["printed", "issued", "cleared", "reprinted"];
    /* A check that was printed and then cancelled is already in the bank's issue
       file. "replaced" means it was voided and superseded by a new check, so it
       must be reported as a VOID exactly like a plain void — otherwise the bank
       keeps matching and paying the cancelled item. */
    const cancelledStatuses = ["voided", "replaced", "stopped"];
    const included = allChecks.filter(
      (c) => issuedStatuses.includes(c.status) || (cancelledStatuses.includes(c.status) && c.printedAt != null)
    );
    /* The control total covers payable items only; voids carry no value. */
    const totalCents = included
      .filter((c) => !cancelledStatuses.includes(c.status))
      .reduce((s, c) => s + c.amountCents, 0);
    const lines = included.map((c) => {
      const payee = c.payeeName.replace(/,/g, " ");
      const isVoid = cancelledStatuses.includes(c.status);
      const issueType = isVoid ? "VOID" : "ISSUE";
      const voidFlag = isVoid ? "V" : "N";
      // CSV format: account last4, issue date, check number, amount, payee, void, type
      return [
        account.accountLast4 ?? "••••",
        c.checkDate,
        c.checkNumber,
        (c.amountCents / 100).toFixed(2),
        `"${payee}"`,
        voidFlag,
        issueType,
      ].join(",");
    });
    const header = "account_last4,issue_date,check_number,amount,payee_name,void_flag,issue_type";
    const csv = [header, ...lines].join("\n");
    const checksum = crypto.createHash("sha256").update(csv).digest("hex");
    const exportRecord = db
      .insert(positivePayExports)
      .values({
        businessId: account.businessId,
        bankAccountId,
        format: "csv",
        itemCount: included.length,
        totalCents,
        fileChecksum: checksum,
        status: "created",
        userId,
        checkIds: JSON.stringify(included.map((c) => c.id)),
      })
      .returning()
      .get();
    logAudit("positive_pay.export", "positive_pay_export", exportRecord.id, ctx, {
      newValue: { itemCount: included.length, totalCents, checksum },
      reason: "Positive Pay file generated",
    });
    return { export: exportRecord, csv, checksum, itemCount: included.length, totalCents };
  },

  /* ----------------------------- check-number reconciliation */
  checkNumberReconciliation(userId: number, bankAccountId: number) {
    const account = db.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).get();
    if (!account) throw httpError(404, "Bank account not found");
    this.requirePerm(userId, account.businessId, "report.view");
    const issued = db
      .select()
      .from(checks)
      .where(eq(checks.bankAccountId, bankAccountId))
      .all()
      .sort((a, b) => a.checkNumber - b.checkNumber);
    const numbers = issued.map((c) => c.checkNumber);
    const gaps: string[] = [];
    if (numbers.length > 0) {
      for (let n = numbers[0]; n < numbers[numbers.length - 1]; n++) {
        if (!numbers.includes(n)) gaps.push(`#${n}`);
      }
    }
    return {
      startNumber: account.checkStartingNumber,
      nextNumber: account.nextCheckNumber,
      issuedCount: numbers.length,
      gaps,
      /* A number is out of circulation whether it was voided outright or voided
         and superseded by a replacement, so both count here. Reporting only
         "voided" understates how many numbers were cancelled. */
      voided: issued
        .filter((c) => ["voided", "replaced", "stopped"].includes(c.status))
        .map((c) => `#${c.checkNumber}`),
      sequence: issued.map((c) => ({ number: c.checkNumber, status: c.status, payee: c.payeeName, amountCents: c.amountCents })),
    };
  },
};

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}


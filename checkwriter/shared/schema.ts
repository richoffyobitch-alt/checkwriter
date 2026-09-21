import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";

/**
 * CheckWriter data model.
 *
 * Money is stored as integer cents (amountCents) to avoid floating-point drift.
 * Bank routing/account numbers are stored encrypted at rest (AES-256-GCM) and
 * only ever returned masked (last 4) through the API. Full reveal requires a
 * dedicated, re-authenticated endpoint.
 *
 * Audit events are append-only (no UPDATE/DELETE on this table anywhere).
 */

/* ---------------------------------------------------------------- users */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  // scrypt hash, never the plaintext password
  passwordHash: text("password_hash").notNull(),
  // demo MFA flag (real TOTP wiring is a backend integration point)
  mfaEnabled: integer("mfa_enabled", { mode: "boolean" }).notNull().default(false),
  /* Session generation counter. Every issued session records the epoch it was
     minted under; a request whose epoch no longer matches this value is
     rejected and destroyed. Bumping it therefore revokes every outstanding
     session for the user at once — on password change, role change, removal
     from a business, or an explicit "sign out everywhere".

     Kept on the user row rather than in the session store on purpose: it works
     the same whether sessions live in memory, Redis, or Postgres, and it does
     not require enumerating the store to find a user's sessions. */
  sessionEpoch: integer("session_epoch").notNull().default(0),
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  name: true,
  passwordHash: true,
  mfaEnabled: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

/* ----------------------------------------------------------- businesses */
export const businesses = sqliteTable("businesses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  legalName: text("legal_name").notNull(),
  dba: text("dba"),
  // EIN stored encrypted; masked in responses
  ein: text("ein"),
  addressLine1: text("address_line_1"),
  addressLine2: text("address_line_2"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  phone: text("phone"),
  logoDataUrl: text("logo_data_url"),
  defaultSigner: text("default_signer"),
  status: text("status").notNull().default("active"), // active | archived
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export const insertBusinessSchema = createInsertSchema(businesses).omit({
  id: true,
  createdAt: true,
});
export type InsertBusiness = z.infer<typeof insertBusinessSchema>;
export type Business = typeof businesses.$inferSelect;

/* ------------------------------------------------- business memberships */
export const businessMemberships = sqliteTable("business_memberships", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  businessId: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  // owner | admin | bookkeeper | approver | signer | viewer
  role: text("role").notNull().default("bookkeeper"),
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export const insertMembershipSchema = createInsertSchema(businessMemberships).omit({
  id: true,
  createdAt: true,
});
export type InsertMembership = z.infer<typeof insertMembershipSchema>;
export type Membership = typeof businessMemberships.$inferSelect;

export const ROLES = [
  "owner",
  "admin",
  "bookkeeper",
  "approver",
  "signer",
  "viewer",
] as const;
export type Role = (typeof ROLES)[number];

/* --------------------------------------------------------- bank accounts */
export const bankAccounts = sqliteTable("bank_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  bankName: text("bank_name").notNull(),
  nickname: text("nickname").notNull(),
  // encrypted ciphertext (iv:tag:data) — masked in all normal responses
  routingEncrypted: text("routing_encrypted"),
  accountEncrypted: text("account_encrypted"),
  accountLast4: text("account_last_4"),
  checkStartingNumber: integer("check_starting_number").notNull().default(1001),
  nextCheckNumber: integer("next_check_number").notNull().default(1001),
  accountType: text("account_type").notNull().default("checking"), // checking | savings
  bankAddress: text("bank_address"),
  /* The 1-2 digit ABA city/state prefix used in the fractional routing number
     (PP-YYYY/XXXX). It is a geographic code assigned by the ABA and is not
     encoded in the 9-digit routing number, so it cannot be derived and has to
     come from the bank. Not secret, so not encrypted. */
  fractionPrefix: text("fraction_prefix"),
  defaultTemplateId: integer("default_template_id"),
  // active | inactive | archived | restricted
  status: text("status").notNull().default("active"),
  // pending | validated | requires_attention
  bankValidationStatus: text("bank_validation_status").notNull().default("pending"),
  bankValidationDate: integer("bank_validation_date"),
  bankValidationNotes: text("bank_validation_notes"),
  positivePayEnabled: integer("positive_pay_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export const insertBankAccountSchema = createInsertSchema(bankAccounts).omit({
  id: true,
  createdAt: true,
  accountLast4: true,
  nextCheckNumber: true,
  bankValidationStatus: true,
});
export type InsertBankAccount = z.infer<typeof insertBankAccountSchema>;
export type BankAccount = typeof bankAccounts.$inferSelect;

/* --------------------------------------------------------------- payees */
export const payees = sqliteTable("payees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  name: text("name").notNull(),
  type: text("type").notNull().default("business"), // individual | business
  addressLine1: text("address_line_1"),
  addressLine2: text("address_line_2"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  defaultMemo: text("default_memo"),
  category: text("category"),
  tags: text("tags").notNull().default("[]"), // JSON array
  internalNotes: text("internal_notes"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export const insertPayeeSchema = createInsertSchema(payees).omit({
  id: true,
  createdAt: true,
  archived: true,
  tags: true,
});
export type InsertPayee = z.infer<typeof insertPayeeSchema>;
export type Payee = typeof payees.$inferSelect;

/* ---------------------------------------------------------------- checks */
export const CHECK_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "ready_to_print",
  "printed",
  "issued",
  "cleared",
  "voided",
  "reprinted",
  "replaced",
  "stale",
] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const checks = sqliteTable("checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  bankAccountId: integer("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  checkNumber: integer("check_number").notNull(),
  checkDate: text("check_date").notNull(), // ISO yyyy-mm-dd
  payeeId: integer("payee_id").references(() => payees.id),
  payeeName: text("payee_name").notNull(),
  // integer cents
  amountCents: integer("amount_cents").notNull(),
  writtenAmount: text("written_amount").notNull(),
  memo: text("memo"),
  status: text("status").notNull().default("draft"),
  preparerId: integer("preparer_id").references(() => users.id),
  approverId: integer("approver_id").references(() => users.id),
  signerId: integer("signer_id").references(() => users.id),
  printedAt: integer("printed_at"),
  issuedAt: integer("issued_at"),
  clearedAt: integer("cleared_at"),
  voidedAt: integer("voided_at"),
  voidReason: text("void_reason"),
  replacedById: integer("replaced_by_id"),
  reprintCount: integer("reprint_count").notNull().default(0),
  version: integer("version").notNull().default(1),
  // immutable snapshot of the issued/printed version
  issuedSnapshot: text("issued_snapshot"),
  createdAt: integer("created_at").notNull().default(Date.now()),
  updatedAt: integer("updated_at").notNull().default(Date.now()),
});

export const insertCheckSchema = createInsertSchema(checks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  printedAt: true,
  issuedAt: true,
  clearedAt: true,
  voidedAt: true,
  voidReason: true,
  replacedById: true,
  reprintCount: true,
  version: true,
  issuedSnapshot: true,
  approverId: true,
  signerId: true,
});
export type InsertCheck = z.infer<typeof insertCheckSchema>;
export type Check = typeof checks.$inferSelect;

/* ----------------------------------------------------- check line items */
export const checkLineItems = sqliteTable("check_line_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  checkId: integer("check_id")
    .notNull()
    .references(() => checks.id),
  category: text("category"),
  department: text("department"),
  project: text("project"),
  classField: text("class_field"),
  invoiceRef: text("invoice_ref"),
  description: text("description"),
  amountCents: integer("amount_cents").notNull().default(0),
});

export const insertLineItemSchema = createInsertSchema(checkLineItems).omit({ id: true });
export type InsertLineItem = z.infer<typeof insertLineItemSchema>;
export type LineItem = typeof checkLineItems.$inferSelect;

/* ----------------------------------------------------- check templates */
export const checkTemplates = sqliteTable("check_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  bankAccountId: integer("bank_account_id").references(() => bankAccounts.id),
  name: text("name").notNull(),
  // voucher | wallet | business
  layoutType: text("layout_type").notNull().default("business"),
  // blank | preprinted
  stockType: text("stock_type").notNull().default("blank"),
  /* JSON: TemplateElement[] from shared/template.ts, geometry in mm. */
  elements: text("elements").notNull().default("[]"),
  /* JSON: TemplateBackground from shared/template.ts. */
  background: text("background").notNull().default('{"mode":"none"}'),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export const insertTemplateSchema = createInsertSchema(checkTemplates).omit({
  id: true,
  createdAt: true,
  version: true,
});
export type InsertTemplate = z.infer<typeof insertTemplateSchema>;
export type CheckTemplate = typeof checkTemplates.$inferSelect;

/* ------------------------------------------------------ template assets */
/* Raster artwork referenced by a template: business logo, bank logo, signature
   image, or a background picture. Stored as base64 in the same local database
   as everything else so a template travels with its artwork and there is no
   second filesystem to back up or leak. Size is capped at the route. */
export const templateAssets = sqliteTable("template_assets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  name: text("name").notNull(),
  // business_logo | bank_logo | signature | background
  kind: text("kind").notNull().default("business_logo"),
  mimeType: text("mime_type").notNull(),
  /* base64 payload, no data: prefix */
  data: text("data").notNull(),
  byteSize: integer("byte_size").notNull().default(0),
  widthPx: integer("width_px"),
  heightPx: integer("height_px"),
  /* Set when the user attests they hold rights to use this artwork — required
     for a bank logo, which is the bank's mark and not the customer's to place
     without written authorization. */
  rightsAttestedAt: integer("rights_attested_at"),
  uploadedBy: integer("uploaded_by").references(() => users.id),
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export type TemplateAsset = typeof templateAssets.$inferSelect;

/* ---------------------------------------------------- printer profiles */
export const printerProfiles = sqliteTable("printer_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  name: text("name").notNull(),
  stockType: text("stock_type").notNull().default("blank"),
  // calibration offsets in mm
  offsetX: integer("offset_x").notNull().default(0),
  offsetY: integer("offset_y").notNull().default(0),
  scale: integer("scale").notNull().default(100),
  validatedAt: integer("validated_at"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export const insertPrinterSchema = createInsertSchema(printerProfiles).omit({
  id: true,
  createdAt: true,
  validatedAt: true,
});
export type InsertPrinter = z.infer<typeof insertPrinterSchema>;
export type PrinterProfile = typeof printerProfiles.$inferSelect;

/* --------------------------------------------------------- audit events */
export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id"),
  businessId: integer("business_id"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  reason: text("reason"),
  correlationId: text("correlation_id"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export type AuditEvent = typeof auditEvents.$inferSelect;

/* ------------------------------------------------ positive pay exports */
export const positivePayExports = sqliteTable("positive_pay_exports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  bankAccountId: integer("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  format: text("format").notNull().default("csv"), // csv | fixed
  itemCount: integer("item_count").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
  fileChecksum: text("file_checksum").notNull(),
  status: text("status").notNull().default("created"),
  userId: integer("user_id").references(() => users.id),
  exportedAt: integer("exported_at").notNull().default(Date.now()),
  checkIds: text("check_ids").notNull().default("[]"), // JSON
});

export type PositivePayExport = typeof positivePayExports.$inferSelect;

/* --------------------------------------------------- security events */
export const securityEvents = sqliteTable("security_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id"),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull().default("info"),
  details: text("details"),
  ip: text("ip"),
  createdAt: integer("created_at").notNull().default(Date.now()),
});

export type SecurityEvent = typeof securityEvents.$inferSelect;

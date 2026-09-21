/**
 * Turns a check record into the strings a template's data-bound fields print.
 *
 * Shared by the PDF renderer and the on-screen preview so the two cannot drift:
 * before this existed each had its own formatting, and a change to one silently
 * left the other behind.
 */

import type { FieldKey, TemplateElement, FontFamily } from "./template";
import { DEFAULT_CAPTIONS, FIELD_LABELS } from "./template";

export interface RenderCheck {
  checkNumber: number | string;
  checkDate: string;
  payeeName: string;
  amountCents: number;
  writtenAmount: string;
  memo?: string | null;
}

export interface RenderBusiness {
  legalName: string;
  dba?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  defaultSigner?: string | null;
}

export interface RenderBank {
  bankName: string;
  bankAddress?: string | null;
  nickname?: string | null;
  accountMasked?: string | null;
  /** Already formatted, e.g. "11-72/1224". Null when the prefix is unknown. */
  fractionNumber?: string | null;
}

export interface RenderContext {
  check: RenderCheck;
  business: RenderBusiness;
  bank: RenderBank;
  /** Days after the check date before it is stale-dated, if the user set one. */
  voidAfterDays?: number | null;
}

/** Formats cents as a US dollar figure with the symbol, e.g. "$1,234.56". */
export function formatAmount(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function addressLines(b: RenderBusiness): string[] {
  const cityLine = b.city ? `${b.city}, ${b.state ?? ""} ${b.zip ?? ""}`.trim() : "";
  return [b.addressLine1 ?? "", cityLine, b.phone ?? ""].filter(Boolean) as string[];
}

/**
 * The printable value for a bound field.
 *
 * Returns an array because some fields are genuinely multi-line (the issuer
 * address). Returns an empty array when there is nothing to print, so callers
 * draw nothing rather than an empty box or a literal "null".
 */
export function resolveField(key: FieldKey, ctx: RenderContext): string[] {
  const { check, business, bank } = ctx;
  switch (key) {
    case "businessName":
      return business.legalName ? [business.legalName] : [];
    case "businessDba":
      return business.dba ? [`dba ${business.dba}`] : [];
    case "businessAddress":
      return addressLines(business);
    case "businessPhone":
      return business.phone ? [business.phone] : [];
    case "checkNumber":
      return [String(check.checkNumber)];
    case "checkDate":
      return check.checkDate ? [check.checkDate] : [];
    case "payee":
      return check.payeeName ? [check.payeeName] : [];
    case "numericAmount":
      return [formatAmount(check.amountCents)];
    case "writtenAmount":
      return check.writtenAmount ? [check.writtenAmount] : [];
    case "memo":
      return check.memo ? [check.memo] : [];
    case "signature":
      /* The signature element prints only its rule and caption; the name goes
         in the caption. Nothing is auto-drawn on the line itself — a machine
         reproducing a signature is exactly what should not happen by default. */
      return [];
    case "bankName":
      return bank.bankName ? [bank.bankName] : [];
    case "bankAddress":
      return bank.bankAddress ? [bank.bankAddress] : [];
    case "fractionNumber":
      return bank.fractionNumber ? [bank.fractionNumber] : [];
    case "accountLabel":
      return bank.nickname ? [`${bank.nickname}${bank.accountMasked ? ` · ${bank.accountMasked}` : ""}`] : [];
    case "voidAfter":
      return ctx.voidAfterDays ? [`VOID AFTER ${ctx.voidAfterDays} DAYS`] : [];
    case "micrLine":
      /* Drawn by the dedicated MICR routine, which places each character at an
         absolute 1/8in position. Never rendered as ordinary text. */
      return [];
    default:
      return [];
  }
}

/** The caption to draw above an element, or null when it has none. */
export function resolveCaption(el: TemplateElement, ctx: RenderContext): string | null {
  if (!el.showCaption) return null;
  if (el.caption) return el.caption;
  if (el.fieldKey === "signature") {
    return ctx.business.defaultSigner
      ? `Authorized signature \u00b7 ${ctx.business.defaultSigner}`
      : "Authorized signature";
  }
  if (el.fieldKey) return DEFAULT_CAPTIONS[el.fieldKey] ?? FIELD_LABELS[el.fieldKey];
  return null;
}

/** The literal lines an element prints, whatever its type. */
export function elementLines(el: TemplateElement, ctx: RenderContext): string[] {
  if (el.type === "field" && el.fieldKey) {
    const lines = resolveField(el.fieldKey, ctx);
    return el.uppercase ? lines.map((l) => l.toUpperCase()) : lines;
  }
  if (el.type === "text" || el.type === "microprint") {
    const raw = el.text ?? "";
    return raw ? (el.uppercase ? [raw.toUpperCase()] : [raw]) : [];
  }
  return [];
}

/** CSS font stacks for each family, so the preview and designer agree. */
export const FONT_STACKS: Record<FontFamily, string> = {
  sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  serif: "'Times New Roman', Times, Georgia, serif",
  mono: "'Courier New', Courier, monospace",
};

/* Kept short so they fit the inspector's narrow select without truncating.
   The face each one actually prints as is shown as a hint beneath the control,
   which is where that detail matters. */
export const FONT_LABELS: Record<FontFamily, string> = {
  sans: "Sans",
  serif: "Serif",
  mono: "Mono",
};

/** The standard PDF face each family resolves to when printed. */
export const FONT_PRINT_FACE: Record<FontFamily, string> = {
  sans: "Helvetica",
  serif: "Times",
  mono: "Courier",
};

/**
 * SVG-ready geometry for a named background pattern.
 *
 * These are ordinary decorative rules, dots, and hatching. They are not
 * reproductions of any bank's security background and carry no anti-copy
 * claim — the microprint element is the only genuine copy-resistant feature
 * here, and it works because it is real small type, not artwork.
 */
export function patternPath(pattern: string, scaleMm: number): { d: string; tile: number } {
  const t = Math.max(1, scaleMm);
  switch (pattern) {
    case "grid":
      return { d: `M0 0 H${t} M0 0 V${t}`, tile: t };
    case "diagonal":
      return { d: `M0 ${t} L${t} 0`, tile: t };
    case "dots":
      return { d: `M${t / 2} ${t / 2} m-0.35 0 a0.35 0.35 0 1 0 0.7 0 a0.35 0.35 0 1 0 -0.7 0`, tile: t };
    case "lines":
    default:
      return { d: `M0 ${t} H${t}`, tile: t };
  }
}

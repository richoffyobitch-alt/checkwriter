/**
 * The check template model.
 *
 * This is the single contract shared by the designer, the on-screen print
 * preview, and the PDF renderer. All three read the same element list, so what
 * is dragged in the designer is what prints. Before this existed the PDF
 * renderer carried its own hardcoded layout and silently ignored templates,
 * which meant the designer was decorative.
 *
 * Units: every geometric value is millimetres on the CANVAS_W_MM x CANVAS_H_MM
 * check face, measured from the top-left. Font sizes are points, because that
 * is what both CSS and PDF user space ultimately want.
 */

import {
  CANVAS_W_MM,
  CANVAS_H_MM,
  MICR_BAND_TOP_MM,
  MICR_BAND_HEIGHT_MM,
  MICR_CLEAR_BAND_MM,
} from "./domain";

/* ------------------------------------------------------------------ types */

export type ElementType =
  /** Bound to live check data — the value comes from the check record. */
  | "field"
  /** Free literal text the user types. */
  | "text"
  /** A ruled line, e.g. a signature or amount line. */
  | "line"
  /** A rectangle, filled and/or stroked. */
  | "rect"
  /** A raster image: business logo, bank logo, or signature graphic. */
  | "image"
  /**
   * Repeated tiny text along a path. A genuine, generic anti-photocopy
   * measure: microprint survives printing but degrades when copied. The text
   * is the user's own, so this reproduces nothing belonging to anyone else.
   */
  | "microprint";

/** Data-bound field keys. These map to real values on the check record. */
export const FIELD_KEYS = [
  "businessName",
  "businessDba",
  "businessAddress",
  "businessPhone",
  "checkNumber",
  "checkDate",
  "payee",
  "numericAmount",
  "writtenAmount",
  "memo",
  "signature",
  "bankName",
  "bankAddress",
  /**
   * The fractional routing number, e.g. "11-72/1224". Historically printed
   * near the check number as a human-readable backup to the MICR line.
   */
  "fractionNumber",
  "accountLabel",
  "voidAfter",
  "micrLine",
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

export const FIELD_LABELS: Record<FieldKey, string> = {
  businessName: "Business name",
  businessDba: "Business DBA",
  businessAddress: "Business address",
  businessPhone: "Business phone",
  checkNumber: "Check number",
  checkDate: "Check date",
  payee: "Payee",
  numericAmount: "Numeric amount",
  writtenAmount: "Written amount",
  memo: "Memo",
  signature: "Signature line",
  bankName: "Bank name",
  bankAddress: "Bank address",
  fractionNumber: "Fraction number",
  accountLabel: "Account label",
  voidAfter: "Void-after notice",
  micrLine: "MICR line",
};

/** Fields a check cannot be issued without. These may be hidden but not deleted. */
export const REQUIRED_FIELD_KEYS: FieldKey[] = [
  "checkNumber",
  "checkDate",
  "payee",
  "numericAmount",
  "writtenAmount",
];

export type FontFamily = "sans" | "serif" | "mono";
export type TextAlign = "left" | "center" | "right";

/** Named patterns for a template background. */
export type BackgroundPattern = "lines" | "grid" | "diagonal" | "dots";

export interface TemplateElement {
  /** Stable id. Survives reordering, unlike an array index. */
  id: string;
  type: ElementType;
  /** For type "field", which value to bind. Ignored otherwise. */
  fieldKey?: FieldKey;
  /** Display name in the layer list. Defaults to the field label. */
  name?: string;

  /* geometry, mm from top-left */
  x: number;
  y: number;
  w: number;
  h: number;

  /** Higher draws on top. */
  z: number;
  locked: boolean;
  hidden: boolean;

  /* ---- text styling, used by field / text / microprint */
  /** Literal content for "text" and "microprint". */
  text?: string;
  fontSize?: number;
  fontFamily?: FontFamily;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: TextAlign;
  color?: string;
  letterSpacing?: number;
  uppercase?: boolean;
  /** Draw the small uppercase caption, e.g. "PAY TO THE ORDER OF". */
  showCaption?: boolean;
  /** Custom caption text. Falls back to a sensible default per field. */
  caption?: string;
  /** Draw a ruled line along the bottom of the box. */
  showRule?: boolean;

  /* ---- line / rect */
  strokeWidth?: number;
  strokeColor?: string;
  /** null or omitted means no fill. */
  fillColor?: string | null;
  dashed?: boolean;
  /** Corner radius in mm, rect only. */
  radius?: number;

  /* ---- image */
  assetId?: number | null;
  opacity?: number;
  fit?: "contain" | "stretch";
}

export interface TemplateBackground {
  mode: "none" | "color" | "pattern" | "image";
  color?: string;
  pattern?: BackgroundPattern;
  patternColor?: string;
  /** 0..1 */
  patternOpacity?: number;
  /** Pattern repeat size in mm. */
  patternScale?: number;
  assetId?: number | null;
  /** 0..1. Low values keep printed data legible over the image. */
  imageOpacity?: number;
}

export interface TemplateDesign {
  elements: TemplateElement[];
  background: TemplateBackground;
}

/* ------------------------------------------------- fraction number helper */

export interface FractionParts {
  /** 1-2 digit geographic prefix. Not derivable from the routing number. */
  prefix: string;
  /** ABA institution identifier — routing digits 5-8. */
  institution: string;
  /** Federal Reserve routing symbol — routing digits 1-4. */
  routingSymbol: string;
}

/**
 * Derives the parts of the fractional routing number that a 9-digit routing
 * number actually determines.
 *
 * A routing number is XXXXYYYYC: XXXX is the Federal Reserve routing symbol,
 * YYYY the ABA institution identifier, C the check digit. The fraction is
 * printed as PP-YYYY/XXXX, with leading zeros conventionally stripped from
 * both YYYY and XXXX (Wikipedia, "Routing transit number").
 *
 * The PP prefix is a geographic city/state code assigned by the ABA and is
 * NOT encoded anywhere in the routing number, so it cannot be computed — it
 * has to come from the bank. Returning null for it rather than guessing keeps
 * a wrong fraction off a printed check.
 */
export function deriveFractionParts(routing: string): Omit<FractionParts, "prefix"> | null {
  const digits = (routing ?? "").replace(/\D/g, "");
  if (digits.length !== 9) return null;
  const routingSymbol = digits.slice(0, 4).replace(/^0+/, "") || "0";
  const institution = digits.slice(4, 8).replace(/^0+/, "") || "0";
  return { routingSymbol, institution };
}

/** Formats the fraction for printing, e.g. "11-72/1224". */
export function formatFraction(parts: FractionParts): string {
  return `${parts.prefix}-${parts.institution}/${parts.routingSymbol}`;
}

/**
 * Builds the printable fraction from a routing number plus the bank-supplied
 * prefix. Returns null when either input is missing, so callers render nothing
 * rather than a half-formed fraction.
 */
export function fractionFromRouting(routing: string, prefix?: string | null): string | null {
  const derived = deriveFractionParts(routing);
  if (!derived || !prefix) return null;
  const p = String(prefix).replace(/\D/g, "");
  if (!p) return null;
  return formatFraction({ prefix: p, ...derived });
}

/** True when the prefix is a plausible ABA city/state code (1-99). */
export function isValidFractionPrefix(prefix: string): boolean {
  const p = (prefix ?? "").replace(/\D/g, "");
  if (p.length < 1 || p.length > 2) return false;
  const n = Number(p);
  return n >= 1 && n <= 99;
}

/* ------------------------------------------------------------- defaults */

const el = (e: Partial<TemplateElement> & { id: string; type: ElementType }): TemplateElement => ({
  x: 0,
  y: 0,
  w: 40,
  h: 6,
  z: 0,
  locked: false,
  hidden: false,
  fontFamily: "sans",
  fontSize: 9,
  align: "left",
  color: "#101418",
  ...e,
});

/**
 * The stock business layout, matching the geometry the PDF renderer used when
 * it was hardcoded — so upgrading an existing install does not move anything
 * on already-calibrated printers.
 */
export function defaultDesign(): TemplateDesign {
  const M = 8.9; // 0.35in left margin
  return {
    background: { mode: "none" },
    elements: [
      el({ id: "businessName", type: "field", fieldKey: "businessName", x: M, y: 5.6, w: 107, h: 5, fontSize: 9.5, bold: true, z: 10 }),
      el({ id: "businessDba", type: "field", fieldKey: "businessDba", x: M, y: 10.7, w: 107, h: 4, fontSize: 6.5, color: "#5b6773", z: 11 }),
      el({ id: "businessAddress", type: "field", fieldKey: "businessAddress", x: M, y: 14.7, w: 107, h: 11, fontSize: 6.5, color: "#5b6773", z: 12 }),
      el({ id: "checkNumber", type: "field", fieldKey: "checkNumber", x: 188, y: 5.6, w: 19, h: 5, fontSize: 11, bold: true, align: "right", z: 13 }),
      el({ id: "fractionNumber", type: "field", fieldKey: "fractionNumber", x: 176, y: 11.4, w: 31, h: 4, fontSize: 6.5, align: "right", color: "#5b6773", z: 14 }),
      el({ id: "checkDate", type: "field", fieldKey: "checkDate", x: 151.1, y: 18.8, w: 55.9, h: 5, fontSize: 8.5, showCaption: true, showRule: true, z: 15 }),
      el({ id: "payee", type: "field", fieldKey: "payee", x: M, y: 30.5, w: 142.2, h: 5, fontSize: 10, bold: true, showCaption: true, showRule: true, z: 16 }),
      el({ id: "numericAmount", type: "field", fieldKey: "numericAmount", x: 156.2, y: 30.2, w: 50.8, h: 5.3, fontSize: 10, bold: true, align: "right", showCaption: true, z: 17,
           strokeWidth: 0.75, strokeColor: "#101418" }),
      el({ id: "writtenAmount", type: "field", fieldKey: "writtenAmount", x: M, y: 41.1, w: 198.1, h: 5, fontSize: 8.5, showRule: true, z: 18 }),
      el({ id: "memo", type: "field", fieldKey: "memo", x: M, y: 53.8, w: 86.4, h: 5, fontSize: 7.5, color: "#5b6773", showCaption: true, showRule: true, z: 19 }),
      el({ id: "signature", type: "field", fieldKey: "signature", x: 124.5, y: 53.8, w: 82.6, h: 6, fontSize: 5.5, showCaption: true, showRule: true, z: 20 }),
      el({ id: "bankName", type: "field", fieldKey: "bankName", x: M, y: 65.5, w: 90, h: 4, fontSize: 6, color: "#8b97a3", z: 21 }),
      // Locked: ANSI X9.13 fixes the MICR line at 65 positions of 1/8in with a
      // 3/16in baseline, so its geometry is not the user's to move.
      el({ id: "micrLine", type: "field", fieldKey: "micrLine", x: 1.6, y: MICR_BAND_TOP_MM, w: 206.4, h: MICR_BAND_HEIGHT_MM, fontSize: 12, fontFamily: "mono", locked: true, z: 100 }),
    ],
  };
}

/**
 * Presentation defaults for a known field, taken from the stock layout.
 *
 * Only the *styling* is read here (rules, amount box, captions) — never the
 * geometry, because an existing template's positions may already be calibrated
 * against a specific printer and moving them would silently misalign live stock.
 */
const DEFAULT_FIELD_STYLE: Partial<Record<FieldKey, Partial<TemplateElement>>> = (() => {
  const out: Partial<Record<FieldKey, Partial<TemplateElement>>> = {};
  for (const d of defaultDesign().elements) {
    if (d.type !== "field" || !d.fieldKey) continue;
    out[d.fieldKey] = {
      showRule: d.showRule,
      showCaption: d.showCaption,
      strokeWidth: d.strokeWidth,
      strokeColor: d.strokeColor,
      bold: d.bold,
      align: d.align,
      color: d.color,
      fontFamily: d.fontFamily,
    };
  }
  return out;
})();

/**
 * True when a stored element uses the pre-layer shape: `{ key, x, y, w, h,
 * fontSize, locked }` with no `type`, `z`, or `fieldKey`.
 *
 * The distinction matters. A legacy element never had the fields that draw a
 * signature rule or the amount box, so leaving them unset produces a check with
 * no signature line — not a design choice, just missing data. A *modern*
 * element that omits `showRule` means the user deliberately switched that rule
 * off, and re-adding it would overwrite their intent. So the backfill below is
 * applied only to the legacy shape.
 */
export function isLegacyElement(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return r.type === undefined && r.z === undefined && r.fieldKey === undefined && typeof r.key === "string";
}

/**
 * Bring any stored element — legacy or current — up to the layered model.
 *
 * Shared deliberately: the designer, the on-screen canvas, and the PDF renderer
 * must all read a template the same way, or what you arrange on screen is not
 * what comes out of the printer.
 */
export function normalizeElement(raw: unknown, i = 0): TemplateElement {
  const r = (raw ?? {}) as Record<string, any>;
  const key: string | undefined = r.fieldKey ?? r.key;
  const fieldKey =
    key && (FIELD_KEYS as readonly string[]).includes(key) ? (key as FieldKey) : undefined;

  // Legacy rows predate the styling fields, so recover them from the stock layout.
  const base: Partial<TemplateElement> =
    isLegacyElement(r) && fieldKey ? (DEFAULT_FIELD_STYLE[fieldKey] ?? {}) : {};

  const pick = <K extends keyof TemplateElement>(k: K, fallback?: TemplateElement[K]) =>
    (r[k] !== undefined ? r[k] : base[k] !== undefined ? base[k] : fallback) as TemplateElement[K];

  return {
    id: r.id ?? key ?? newElementId(),
    type: (r.type as ElementType) ?? "field",
    fieldKey,
    name: r.name,
    x: r.x ?? 0,
    y: r.y ?? 0,
    w: r.w ?? 40,
    h: r.h ?? 6,
    z: r.z ?? i,
    locked: !!r.locked,
    hidden: !!r.hidden,
    text: r.text,
    fontSize: r.fontSize ?? 9,
    fontFamily: pick("fontFamily", "sans"),
    bold: pick("bold"),
    italic: r.italic,
    underline: r.underline,
    align: pick("align", "left"),
    color: pick("color", "#101418"),
    letterSpacing: r.letterSpacing,
    uppercase: r.uppercase,
    showCaption: pick("showCaption"),
    caption: r.caption,
    showRule: pick("showRule"),
    strokeWidth: pick("strokeWidth"),
    strokeColor: pick("strokeColor"),
    fillColor: r.fillColor,
    dashed: r.dashed,
    radius: r.radius,
    assetId: r.assetId ?? null,
    opacity: r.opacity,
    fit: r.fit,
  };
}

/** Normalize a whole stored design, falling back to the stock layout if empty. */
export function normalizeDesign(
  elements: unknown[] | null | undefined,
  background?: TemplateBackground | null,
): TemplateDesign {
  const els = (elements ?? []).map((e, i) => normalizeElement(e, i));
  return {
    elements: els.length ? els : defaultDesign().elements,
    background: background ?? { mode: "none" },
  };
}

/** Default caption text for fields that conventionally carry one. */
export const DEFAULT_CAPTIONS: Partial<Record<FieldKey, string>> = {
  checkDate: "Date",
  payee: "Pay to the order of",
  numericAmount: "Amount",
  memo: "Memo",
  signature: "Authorized signature",
};

/* ------------------------------------------------------------ validation */

export interface DesignIssue {
  level: "error" | "warning";
  elementId?: string;
  message: string;
}

/**
 * Checks a design for problems that would produce a bad printed check.
 *
 * Errors are things that make the output unusable or unbankable. Warnings are
 * things a reasonable user might still want. This never silently repairs a
 * design — the designer surfaces the list so the user decides.
 */
export function validateDesign(design: TemplateDesign): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const clearBandTop = CANVAS_H_MM - MICR_CLEAR_BAND_MM;

  for (const e of design.elements) {
    const label = e.name ?? (e.fieldKey ? FIELD_LABELS[e.fieldKey] : e.type);

    if (e.x < 0 || e.y < 0 || e.x + e.w > CANVAS_W_MM + 0.01 || e.y + e.h > CANVAS_H_MM + 0.01) {
      issues.push({ level: "error", elementId: e.id, message: `${label} extends past the edge of the check and would be clipped.` });
    }

    // Everything except the MICR line itself must stay clear of the bottom
    // 5/8in band, or the bank's reader may fail the item.
    if (e.fieldKey !== "micrLine" && !e.hidden && e.y + e.h > clearBandTop + 0.01) {
      issues.push({ level: "error", elementId: e.id, message: `${label} intrudes into the MICR clear band. Banks can reject checks with content there.` });
    }

    if (e.type === "text" && !(e.text ?? "").trim()) {
      issues.push({ level: "warning", elementId: e.id, message: `${label} is an empty text box and will not print.` });
    }
    if (e.type === "image" && !e.assetId) {
      issues.push({ level: "warning", elementId: e.id, message: `${label} has no image selected.` });
    }
    if (e.type === "microprint" && !(e.text ?? "").trim()) {
      issues.push({ level: "warning", elementId: e.id, message: `${label} has no microprint text.` });
    }
    if ((e.fontSize ?? 9) < 5 && (e.type === "field" || e.type === "text")) {
      issues.push({ level: "warning", elementId: e.id, message: `${label} is under 5pt and may not print legibly.` });
    }
  }

  for (const key of REQUIRED_FIELD_KEYS) {
    const found = design.elements.find((e) => e.fieldKey === key);
    if (!found) {
      issues.push({ level: "error", message: `${FIELD_LABELS[key]} is missing. A check cannot be issued without it.` });
    } else if (found.hidden) {
      issues.push({ level: "error", message: `${FIELD_LABELS[key]} is hidden. A check cannot be issued without it.` });
    }
  }

  const micr = design.elements.find((e) => e.fieldKey === "micrLine");
  if (micr && micr.hidden) {
    issues.push({ level: "warning", message: "The MICR line is hidden. That is only correct on pre-printed stock that already carries it." });
  }

  if (design.background.mode === "image" && (design.background.imageOpacity ?? 1) > 0.35) {
    issues.push({ level: "warning", message: "A background image above 35% opacity can make the payee and amount hard to read, and harder for the bank to image." });
  }

  return issues;
}

/** Clamp an element to the printable area, keeping it out of the clear band. */
export function clampElement(e: TemplateElement): TemplateElement {
  const isMicr = e.fieldKey === "micrLine";
  const maxY = isMicr ? CANVAS_H_MM - e.h : CANVAS_H_MM - MICR_CLEAR_BAND_MM - e.h;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    ...e,
    x: round(Math.min(Math.max(0, CANVAS_W_MM - e.w), Math.max(0, e.x))),
    y: round(Math.min(Math.max(0, maxY), Math.max(0, e.y))),
  };
}

export function nextZ(elements: TemplateElement[]): number {
  return elements.reduce((m, e) => Math.max(m, e.z), 0) + 1;
}

/** Short random id. Only needs to be unique within one template. */
export function newElementId(prefix = "el"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export { CANVAS_W_MM, CANVAS_H_MM, MICR_CLEAR_BAND_MM, MICR_BAND_TOP_MM, MICR_BAND_HEIGHT_MM };

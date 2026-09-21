/**
 * Pure domain helpers shared by client and server. No DB, no I/O.
 */

/* ----------------------------------------------------------- money utils */
export function dollarsToCents(dollars: number | string): number {
  const n = typeof dollars === "string" ? parseFloat(dollars) : dollars;
  if (!isFinite(n) || isNaN(n)) throw new Error("Invalid amount");
  if (n < 0) throw new Error("Amount cannot be negative");
  if (n > 99_999_999.99) throw new Error("Amount exceeds maximum ($99,999,999.99)");
  // round to nearest cent to absorb float error
  return Math.round(n * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function formatCentsPlain(cents: number): string {
  return (cents / 100).toFixed(2);
}

/* ------------------------------------------------ amount-to-words (check) */
const ONES = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const SCALES = ["", "thousand", "million"];

function threeDigitToWords(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
  if (rest > 0) {
    if (rest < 20) {
      parts.push(ONES[rest]);
    } else {
      const t = Math.floor(rest / 10);
      const o = rest % 10;
      parts.push(o === 0 ? TENS[t] : `${TENS[t]}-${ONES[o]}`);
    }
  }
  return parts.join(" ");
}

/**
 * Convert a dollar amount to the legal written form used on checks.
 * e.g. 1234.56 -> "One thousand two hundred thirty-four and 56/100"
 * Handles zero-dollar and cent rounding rules.
 */
export function amountToWords(dollars: number | string): string {
  const cents = dollarsToCents(dollars);
  const wholeDollars = Math.floor(cents / 100);
  const centsPart = cents % 100;

  if (wholeDollars === 0) {
    return `Zero and ${centsPart.toString().padStart(2, "0")}/100`;
  }

  const chunks: string[] = [];
  let working = wholeDollars;
  let scaleIndex = 0;
  while (working > 0) {
    const chunk = working % 1000;
    if (chunk > 0) {
      const words = threeDigitToWords(chunk);
      const scale = SCALES[scaleIndex];
      chunks.push(scale ? `${words} ${scale}` : words);
    }
    working = Math.floor(working / 1000);
    scaleIndex++;
    if (scaleIndex >= SCALES.length && working > 0) {
      throw new Error("Amount too large to express in words");
    }
  }

  const dollarsWords = chunks.reverse().join(" ");
  // capitalize first letter
  const dollarsText = dollarsWords.charAt(0).toUpperCase() + dollarsWords.slice(1);
  return `${dollarsText} and ${centsPart.toString().padStart(2, "0")}/100`;
}

/* ------------------------------------------------- routing number check */
/** Validate ABA routing number via the 3-1-3-7 checksum. */
export function isValidRoutingNumber(routing: string): boolean {
  const r = routing.replace(/\s|-/g, "");
  if (!/^\d{9}$/.test(r)) return false;
  /* ABA/NACHA check digit: weights repeat 3,7,1 across the nine digits.
     Sum of digit*weight must be a multiple of 10. */
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(r[i], 10) * weights[i];
  }
  return sum % 10 === 0;
}

export function maskAccountNumber(last4: string | null | undefined): string {
  if (!last4) return "••••";
  return `••••${last4}`;
}

export function maskEin(ein: string | null | undefined): string {
  if (!ein) return "";
  const digits = ein.replace(/\D/g, "");
  if (digits.length < 4) return "••-••";
  return `••-•${digits.slice(-2)}`;
}

/* --------------------------------------------------------- date helpers */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/* ----------------------------------------------- role / permission model */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: [
    "business.manage",
    "bank.manage",
    "bank.reveal",
    "payee.manage",
    "check.prepare",
    "check.approve",
    "check.sign",
    "check.print",
    "check.void",
    "check.reprint",
    "check.replace",
    "check.clear",
    "template.manage",
    "printer.manage",
    "positivepay.export",
    "report.view",
    "audit.view",
    "settings.manage",
  ],
  admin: [
    "business.manage",
    "bank.manage",
    "bank.reveal",
    "payee.manage",
    "check.prepare",
    "check.approve",
    "check.sign",
    "check.print",
    "check.void",
    "check.reprint",
    "check.replace",
    "check.clear",
    "template.manage",
    "printer.manage",
    "positivepay.export",
    "report.view",
    "audit.view",
    "settings.manage",
  ],
  bookkeeper: [
    "payee.manage",
    "check.prepare",
    "check.print",
    "check.reprint",
    "check.clear",
    "report.view",
    "audit.view",
  ],
  approver: ["check.approve", "report.view", "audit.view"],
  signer: ["check.sign", "report.view"],
  viewer: ["report.view", "audit.view"],
};

export function isKnownRole(role: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}

export function can(role: string, permission: string): boolean {
  if (!isKnownRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Amount thresholds used to flag larger payments for attention (cents).
 *
 * These are advisory only. They label a check so a reviewer can see at a glance
 * that it is a big one; they do NOT gate approval. Any user holding the
 * check.approve permission may approve any check, including one they prepared
 * themselves, at any amount. An owner running a one-person business is the
 * whole approval chain, and blocking them from approving their own payment just
 * makes the product unusable for them.
 *
 * Self-approval is still fully attributable: preparerId and approverId are both
 * recorded on the check, and the audit entry marks the approval as self-approved
 * when they are the same person.
 */
export const AMOUNT_FLAGS = {
  elevated: 1000_00, // >= $1,000
  high: 10000_00, // >= $10,000
};

export type AmountFlag = "standard" | "elevated" | "high";

/** Advisory size band for a check amount. Never used to block an action. */
export function amountFlagFor(cents: number): AmountFlag {
  if (cents >= AMOUNT_FLAGS.high) return "high";
  if (cents >= AMOUNT_FLAGS.elevated) return "elevated";
  return "standard";
}

/* Canvas for a US standard business check: 8.5 x 3.5 in, expressed in mm.
   8.5in is the narrowest stock that fits all 65 MICR positions, because MICR
   position 65 begins 8 7/16in in from the trailing (right) edge. */
export const CANVAS_W_MM = 215.9; // 8.5in
export const CANVAS_H_MM = 88.9; // 3.5in

/* The MICR clear band occupies the bottom 5/8in (15.875mm). Only the E-13B
   line may be printed there, so no draggable element may enter it. */
export const MICR_CLEAR_BAND_MM = 15.875;
export const MICR_BAND_TOP_MM = CANVAS_H_MM - 11.1125; // 7/16in above the edge
export const MICR_BAND_HEIGHT_MM = 6.35; // 1/4in

/* Default check layout elements, positions in mm on the canvas above.
   All non-MICR elements stay above CANVAS_H_MM - MICR_CLEAR_BAND_MM (73.025mm). */
export const DEFAULT_TEMPLATE_ELEMENTS = [
  { key: "businessName", x: 8.9, y: 5.6, w: 90, h: 5, fontSize: 9, locked: false },
  { key: "businessAddress", x: 8.9, y: 10.7, w: 90, h: 11, fontSize: 7, locked: false },
  { key: "checkNumber", x: 188, y: 5.6, w: 19, h: 5, fontSize: 11, locked: false },
  { key: "checkDate", x: 151.1, y: 15.7, w: 55.9, h: 6, fontSize: 9, locked: false },
  { key: "payee", x: 8.9, y: 27.4, w: 142.2, h: 6, fontSize: 10, locked: false },
  { key: "numericAmount", x: 156.2, y: 27.4, w: 50.8, h: 6, fontSize: 10, locked: false },
  { key: "writtenAmount", x: 8.9, y: 41.1, w: 198.1, h: 6, fontSize: 9, locked: false },
  { key: "memo", x: 8.9, y: 53.8, w: 86.4, h: 6, fontSize: 8, locked: false },
  { key: "signature", x: 124.5, y: 53.8, w: 82.6, h: 8, fontSize: 8, locked: false },
  // Locked: fixed by ANSI X9.13 at 1/8in pitch, 65 positions, baseline 3/16in.
  { key: "micrLine", x: 1.6, y: MICR_BAND_TOP_MM, w: 206.4, h: MICR_BAND_HEIGHT_MM, fontSize: 12, locked: true },
];

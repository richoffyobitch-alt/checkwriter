/**
 * ANSI X9.13 MICR clear-band geometry and E-13B field layout.
 *
 * All measurements are in INCHES. Horizontal distances are measured from the
 * check's *leading edge* (the RIGHT edge) and vertical distances from the
 * *aligning edge* (the BOTTOM edge), exactly as the standard specifies.
 *
 *  - Clear band: the bottom 5/8" of the document, which must be free of
 *    magnetic ink other than the E-13B characters themselves.
 *  - MICR print band: 1/4" tall, running from 3/16" to 7/16" above the
 *    aligning edge. The character BASELINE sits at 3/16" — the bottom of the
 *    print band.
 *  - Horizontally the band begins 5/16" from the leading edge and extends to a
 *    maximum of 8 7/16". At the fixed 1/8" character pitch that is exactly 65
 *    positions, numbered 1..65 with position 1 RIGHTMOST.
 *  - Horizontal lengths carry a 1/16" cutting tolerance, so the start of the
 *    band may fall anywhere between 1/4" and 7/16" from the leading edge.
 *
 * Reference: ANSI X9.13. Bank-specific specifications still govern live use.
 */

export const MICR_GEOM = {
  /** Fixed character pitch: 1/8". */
  pitch: 0.125,
  /** Total addressable positions in the band. */
  positions: 65,
  /** Right edge of position 1, from the leading (right) edge: 5/16". */
  bandRightInset: 0.3125,
  /** Character baseline above the aligning (bottom) edge: 3/16". */
  baselineFromBottom: 0.1875,
  /** Top of the print band above the aligning edge: 7/16". */
  bandTopFromBottom: 0.4375,
  /** Print band height: 1/4". */
  bandHeight: 0.25,
  /** Clear band height above the aligning edge: 5/8". */
  clearBandHeight: 0.625,
  /** Permitted cutting tolerance on horizontal lengths: 1/16". */
  cutTolerance: 0.0625,
  /**
   * Font size giving an exact 1/8" pitch. The bundled MICR E13B face has a
   * uniform glyph advance of 0.75em (1536/2048), so 0.125 / 0.75 = 1/6" = 12pt,
   * the standard E-13B size.
   */
  fontSizeIn: 0.125 / 0.75,
} as const;

/** Minimum document width needed to address all 65 positions: 8 7/16". */
export const MICR_MIN_FULL_WIDTH_IN =
  MICR_GEOM.bandRightInset + MICR_GEOM.positions * MICR_GEOM.pitch; // 8.4375

/** Documents wider than 6" carry the Auxiliary On-Us field. */
export const MICR_AUX_MIN_WIDTH_IN = 6;

/**
 * Canvas size for a US standard business check. 8.5in is the narrowest stock
 * that can hold all 65 MICR positions, because position 65 begins 8 7/16in in
 * from the trailing (right) edge.
 */
export const CHECK_W_IN = 8.5;
export const CHECK_H_IN = 3.5;

/**
 * The bundled MICR E13B font maps the four E-13B control symbols onto ASCII
 * A-D — the conventional mapping, and the one the standard's own field
 * descriptions refer to ("separated with special MICR symbols (A, B, C and D)").
 * Verified against this font's cmap and rendered glyph outlines: the font has
 * no glyphs in the Unicode OCR block (U+2440..U+244A), so those codepoints
 * would silently fall back to a non-MICR face.
 */
export const E13B = {
  /** Transit / branch-bank identification — brackets the 9-digit routing number. */
  transit: "A",
  /** Amount — brackets the bank-printed amount field. */
  amount: "B",
  /** On-Us / customer account number. */
  onUs: "C",
  /** Dash — interchangeable with a space inside the On-Us field. */
  dash: "D",
} as const;

export type MicrFieldName = "amount" | "onUs" | "routing" | "epc" | "auxOnUs";

export interface MicrFieldSpec {
  from: number;
  to: number;
  label: string;
  /** True when the bank prints this field and the issuer must leave it blank. */
  bankPrinted: boolean;
  note: string;
}

/** Position ranges (inclusive), counted from the right edge. */
export const MICR_FIELDS: Record<MicrFieldName, MicrFieldSpec> = {
  amount: {
    from: 1,
    to: 12,
    label: "Amount",
    bankPrinted: true,
    note: "Printed by the bank. Leave blank when designing checks.",
  },
  onUs: {
    from: 13,
    to: 32,
    label: "On-Us",
    bankPrinted: false,
    note: "Account number followed by the On-Us symbol. Positions 13 and 32 stay blank.",
  },
  routing: {
    from: 33,
    to: 43,
    label: "Routing / transit",
    bankPrinted: false,
    note: "Transit symbol, 9-digit routing number, transit symbol. Fixed width.",
  },
  epc: {
    from: 44,
    to: 44,
    label: "EPC",
    bankPrinted: true,
    note: "Reserved for bank special processing. Leave blank.",
  },
  auxOnUs: {
    from: 45,
    to: 65,
    label: "Auxiliary On-Us",
    bankPrinted: false,
    note: 'Serial (check) number bracketed by On-Us symbols. Only on documents wider than 6".',
  },
};

export interface MicrCell {
  char: string;
  /** ANSI position; 1 = rightmost. */
  position: number;
  /** Distance from the document's LEFT edge to this cell's left edge, in inches. */
  leftIn: number;
  field: MicrFieldName;
}

/** Left edge of `position`, measured from the document's LEFT edge. */
export function positionLeftIn(position: number, checkWidthIn: number): number {
  return checkWidthIn - MICR_GEOM.bandRightInset - position * MICR_GEOM.pitch;
}

/** Validates a routing number against the ABA 3-7-1 checksum. */
export function isValidAbaRouting(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = routing.split("").reduce((s, d, i) => s + Number(d) * weights[i], 0);
  return sum % 10 === 0;
}

const digitsOnly = (s: string) => s.replace(/[^0-9]/g, "");

/**
 * Lays a field out left-aligned from `leftmostPosition`. Position numbers count
 * from the right, but characters inside a field read left-to-right, so the
 * first character takes the highest position number.
 */
function place(
  text: string,
  leftmostPosition: number,
  field: MicrFieldName,
  checkWidthIn: number,
): MicrCell[] {
  return text.split("").map((char, i) => {
    const position = leftmostPosition - i;
    return { char, position, leftIn: positionLeftIn(position, checkWidthIn), field };
  });
}

export interface MicrInput {
  routing: string;
  account: string;
  checkNumber: number | string;
  checkWidthIn: number;
  /** Include the Auxiliary On-Us serial field. Ignored on documents <= 6". */
  includeAuxOnUs?: boolean;
}

export interface MicrLayout {
  cells: MicrCell[];
  warnings: string[];
  /** Baseline distance from the TOP of the document, for positioning. */
  baselineFromTopIn: number;
  /** Top of the clear band, from the TOP of the document. */
  clearBandTopFromTopIn: number;
}

/** Usable On-Us digit capacity: positions 14..31, less one for the On-Us symbol. */
const ON_US_LEFTMOST = 31;
const ON_US_RIGHTMOST = 14;
export const ON_US_MAX_DIGITS = ON_US_LEFTMOST - ON_US_RIGHTMOST; // 17

/**
 * Builds the exact character placement for a MICR line.
 *
 * Positions 1-12 (Amount) and 44 (EPC) are deliberately never populated —
 * those are bank-printed.
 */
export function buildMicrLayout(input: MicrInput, checkHeightIn: number): MicrLayout {
  const { routing, account, checkNumber, checkWidthIn } = input;
  const warnings: string[] = [];
  const cells: MicrCell[] = [];

  const auxAllowed = checkWidthIn > MICR_AUX_MIN_WIDTH_IN;
  const includeAux = (input.includeAuxOnUs ?? true) && auxAllowed;

  if (checkWidthIn + 1e-9 < MICR_MIN_FULL_WIDTH_IN) {
    warnings.push(
      `Document is ${checkWidthIn}" wide; ${MICR_MIN_FULL_WIDTH_IN}" is required to address all ${MICR_GEOM.positions} positions.`,
    );
  }

  /* Routing — positions 33..43: transit + 9 digits + transit, fixed width. */
  const r = digitsOnly(routing);
  if (r.length === 0) {
    warnings.push("No routing number available; the transit field cannot be encoded.");
  } else if (r.length !== 9) {
    warnings.push(
      `Routing number must be exactly 9 digits (got ${r.length}). Positions 34-42 are fixed width.`,
    );
  } else if (!isValidAbaRouting(r)) {
    warnings.push("Routing number fails the ABA 3-7-1 checksum. Confirm it with the bank before live printing.");
  }
  if (r.length) {
    const routingText = `${E13B.transit}${r.slice(0, 9).padStart(9, "0")}${E13B.transit}`;
    cells.push(...place(routingText, MICR_FIELDS.routing.to, "routing", checkWidthIn));
  }

  /* On-Us — positions 13..32, left-aligned from 31 so 32 stays blank. */
  const a = digitsOnly(account);
  if (a.length === 0) {
    warnings.push("No account number available; the On-Us field cannot be encoded.");
  } else if (a.length > ON_US_MAX_DIGITS) {
    warnings.push(
      `Account number is ${a.length} digits; the On-Us field holds ${ON_US_MAX_DIGITS} plus the On-Us symbol.`,
    );
  }
  if (a.length) {
    const onUsText = `${a.slice(0, ON_US_MAX_DIGITS)}${E13B.onUs}`;
    cells.push(...place(onUsText, ON_US_LEFTMOST, "onUs", checkWidthIn));
  }

  /* Auxiliary On-Us — serial number, starting at position 45 and running left. */
  if (includeAux) {
    const serial = digitsOnly(String(checkNumber));
    if (serial.length) {
      const auxText = `${E13B.onUs}${serial}${E13B.onUs}`;
      const leftmost = MICR_FIELDS.auxOnUs.from + auxText.length - 1;
      if (leftmost > MICR_FIELDS.auxOnUs.to) {
        warnings.push(
          `Serial number needs position ${leftmost}, beyond the Auxiliary On-Us limit of ${MICR_FIELDS.auxOnUs.to}.`,
        );
      }
      cells.push(...place(auxText, leftmost, "auxOnUs", checkWidthIn));
    }
  } else if (!auxAllowed) {
    warnings.push(
      'Auxiliary On-Us appears only on documents wider than 6"; the serial number is omitted from the MICR line.',
    );
  }

  const past = cells.filter((c) => c.leftIn < -1e-9);
  if (past.length) {
    warnings.push(`${past.length} MICR character(s) fall past the left edge of the document.`);
  }

  return {
    cells,
    warnings,
    baselineFromTopIn: checkHeightIn - MICR_GEOM.baselineFromBottom,
    clearBandTopFromTopIn: checkHeightIn - MICR_GEOM.clearBandHeight,
  };
}

/** Human-readable field summary for the diagnostics panel. */
export function summarizeMicr(layout: MicrLayout) {
  const byField = new Map<MicrFieldName, MicrCell[]>();
  for (const c of layout.cells) {
    const list = byField.get(c.field) ?? [];
    list.push(c);
    byField.set(c.field, list);
  }
  return (Object.keys(MICR_FIELDS) as MicrFieldName[]).map((name) => {
    const spec = MICR_FIELDS[name];
    const cells = (byField.get(name) ?? []).slice().sort((x, y) => y.position - x.position);
    return {
      name,
      spec,
      text: cells.map((c) => c.char).join(""),
      occupied: cells.length
        ? `${Math.min(...cells.map((c) => c.position))}-${Math.max(...cells.map((c) => c.position))}`
        : "—",
    };
  });
}

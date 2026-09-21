import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { buildMicrLayout, MICR_GEOM } from "@/lib/micr";
import { e13bFontBytes } from "@/lib/e13b-font";
import type { TemplateDesign, TemplateElement } from "@shared/template";
import { elementLines, resolveCaption, type RenderContext } from "@shared/render";

/**
 * Builds a print-ready PDF of a single check.
 *
 * Why this exists instead of just calling window.print(): the app is often
 * viewed inside an embedded frame, where the browser's print dialog is a
 * blocked modal, so window.print() silently does nothing. Generating the PDF
 * ourselves works everywhere and, as a bonus, is deterministic — the geometry
 * comes from these coordinates rather than from whatever margins the user's
 * browser and print driver negotiate.
 *
 * Coordinates below are literal inches taken from the on-screen renderer in
 * pages/print.tsx, so the PDF and the preview stay in agreement. PDF user space
 * is 72 units to the inch with the origin at the BOTTOM-left, hence the
 * `yFromTop` conversion.
 */

const PT = 72;

const INK = rgb(0x10 / 255, 0x14 / 255, 0x18 / 255);
const SUBTLE = rgb(0x5b / 255, 0x67 / 255, 0x73 / 255);
const FAINT = rgb(0x8b / 255, 0x97 / 255, 0xa3 / 255);
const BORDER = rgb(0xd4 / 255, 0xda / 255, 0xe0 / 255);
const VOID_RED = rgb(220 / 255, 38 / 255, 38 / 255);

const LEFT_MARGIN_IN = 0.35;

export interface CheckPdfInput {
  check: {
    checkNumber: number;
    checkDate: string;
    payeeName: string;
    amountCents: number;
    writtenAmount: string;
    memo?: string | null;
  };
  business: {
    legalName: string;
    dba?: string | null;
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    phone?: string | null;
    defaultSigner?: string | null;
  };
  bankName: string;
  /** Full routing number. Empty string renders no MICR routing field. */
  routing: string;
  /** Full account number. */
  account: string;
  checkWidthIn: number;
  checkHeightIn: number;
  /** Stamps VOID / TEST ONLY across the face. */
  testMode: boolean;
  /**
   * Pre-printed stock already carries the bank's MICR line, so drawing our own
   * would double it up. Blank stock needs us to lay it down.
   */
  includeMicr: boolean;
  /**
   * The saved template. When present the face is drawn from it, so what the
   * user arranged in the designer is what prints. When absent the built-in
   * layout is used, which keeps older callers and existing installs working.
   */
  design?: TemplateDesign | null;
  /**
   * Extra values only a template can reference — fraction number, bank
   * address, account label. Optional so callers that only need the built-in
   * layout do not have to assemble it.
   */
  extras?: {
    fractionNumber?: string | null;
    bankAddress?: string | null;
    accountNickname?: string | null;
    accountMasked?: string | null;
    voidAfterDays?: number | null;
  };
  /** Decoded artwork for image elements, keyed by asset id. */
  assets?: Record<number, { bytes: Uint8Array; mimeType: string }>;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  serif: PDFFont;
  serifBold: PDFFont;
  mono: PDFFont;
  /**
   * The E-13B face. Null only if embedding failed, in which case the MICR
   * line falls back to Courier and the caller is told the line is not
   * machine-readable rather than being left to assume it is.
   */
  micr: PDFFont | null;
}

/**
 * Embeds the MICR E-13B face so the PDF carries real E-13B glyph outlines
 * rather than a monospace stand-in.
 *
 * pdf-lib can only embed non-standard fonts through fontkit, which has to be
 * registered on the document first. The font is subset on embed, so only the
 * glyphs actually used ride along in the file.
 *
 * Returns null rather than throwing if the face cannot be embedded: a check
 * whose MICR line is visually wrong is still worth producing for layout and
 * calibration work, and drawMicr surfaces the substitution on the face itself
 * instead of letting it pass as a real MICR line.
 */
async function embedE13b(doc: PDFDocument): Promise<PDFFont | null> {
  try {
    doc.registerFontkit(fontkit);
    return await doc.embedFont(e13bFontBytes(), { subset: true });
  } catch (err) {
    console.error("MICR E-13B font could not be embedded into the PDF", err);
    return null;
  }
}

export async function buildCheckPdf(input: CheckPdfInput): Promise<Uint8Array> {
  const { checkWidthIn: W, checkHeightIn: H } = input;

  const doc = await PDFDocument.create();
  doc.setTitle(`Check ${input.check.checkNumber} — ${input.business.legalName}`);
  doc.setProducer("CheckWriter");
  doc.setCreator("CheckWriter");

  const page = doc.addPage([W * PT, H * PT]);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    micr: await embedE13b(doc),
  };

  if (input.design && input.design.elements.length > 0) {
    await drawTemplateFace(doc, page, fonts, input, input.design);
  } else {
    drawFace(page, fonts, input);
  }
  if (input.includeMicr) drawMicr(page, fonts, input);
  if (input.testMode) drawVoidStamp(page, fonts, input);

  return doc.save();
}

/** Convert an inches-from-top value to PDF's bottom-up y axis. */
function yFromTop(topIn: number, heightIn: number): number {
  return (heightIn - topIn) * PT;
}

/**
 * Places text whose visual top edge sits at `topIn`, matching how CSS positions
 * a block. Helvetica's cap height is roughly 0.72em and its ascent 0.75em, so
 * shifting the baseline down by 0.8em lands close enough that the PDF and the
 * HTML preview line up.
 */
function text(
  page: PDFPage,
  font: PDFFont,
  value: string,
  opts: {
    leftIn: number;
    topIn: number;
    sizePt: number;
    heightIn: number;
    color?: ReturnType<typeof rgb>;
    /** Right-align within [leftIn, leftIn + widthIn]. */
    widthIn?: number;
    align?: "left" | "right";
    /** Truncate with an ellipsis rather than overrunning this width. */
    maxWidthIn?: number;
  }
) {
  const { leftIn, topIn, sizePt, heightIn } = opts;
  let str = value ?? "";
  if (opts.maxWidthIn !== undefined) str = truncate(str, font, sizePt, opts.maxWidthIn * PT);

  let x = leftIn * PT;
  if (opts.align === "right" && opts.widthIn !== undefined) {
    const w = font.widthOfTextAtSize(str, sizePt);
    x = (leftIn + opts.widthIn) * PT - w;
  }

  page.drawText(str, {
    x,
    y: yFromTop(topIn, heightIn) - sizePt * 0.8,
    size: sizePt,
    font,
    color: opts.color ?? INK,
  });
}

function truncate(str: string, font: PDFFont, sizePt: number, maxPt: number): string {
  if (font.widthOfTextAtSize(str, sizePt) <= maxPt) return str;
  let out = str;
  while (out.length > 1 && font.widthOfTextAtSize(out + "…", sizePt) > maxPt) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

/** A ruled line, as produced by a CSS border-bottom. */
function rule(
  page: PDFPage,
  opts: { leftIn: number; topIn: number; widthIn: number; heightIn: number; color?: ReturnType<typeof rgb>; thicknessPt?: number }
) {
  const y = yFromTop(opts.topIn, opts.heightIn);
  page.drawLine({
    start: { x: opts.leftIn * PT, y },
    end: { x: (opts.leftIn + opts.widthIn) * PT, y },
    thickness: opts.thicknessPt ?? 0.75,
    color: opts.color ?? INK,
  });
}

/** Small uppercase field caption, e.g. "PAY TO THE ORDER OF". */
function caption(page: PDFPage, fonts: Fonts, value: string, leftIn: number, topIn: number, heightIn: number) {
  text(page, fonts.regular, value.toUpperCase(), {
    leftIn,
    topIn,
    sizePt: 5.5,
    heightIn,
    color: FAINT,
  });
}

/* ------------------------------------------------- template-driven face */

const MM_PER_IN = 25.4;
const mmToIn = (mm: number) => mm / MM_PER_IN;

/** Parses "#rrggbb" into pdf-lib's rgb. Falls back to ink on anything odd. */
function parseColor(hex: string | undefined | null): ReturnType<typeof rgb> {
  if (!hex) return INK;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return INK;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function fontFor(fonts: Fonts, el: TemplateElement): PDFFont {
  /* pdf-lib's standard 14 give us Helvetica, Times, and Courier in regular
     and bold. Italic is not carried here: faking it by skewing would misreport
     the metrics used for truncation and right-alignment, so the designer marks
     italic as preview-only rather than printing something the widths do not
     match. */
  if (el.fontFamily === "mono") return fonts.mono;
  if (el.fontFamily === "serif") return el.bold ? fonts.serifBold : fonts.serif;
  return el.bold ? fonts.bold : fonts.regular;
}

function buildRenderContext(input: CheckPdfInput): RenderContext {
  return {
    check: {
      checkNumber: input.check.checkNumber,
      checkDate: input.check.checkDate,
      payeeName: input.check.payeeName,
      amountCents: input.check.amountCents,
      writtenAmount: input.check.writtenAmount,
      memo: input.check.memo,
    },
    business: input.business,
    bank: {
      bankName: input.bankName,
      bankAddress: input.extras?.bankAddress ?? null,
      nickname: input.extras?.accountNickname ?? null,
      accountMasked: input.extras?.accountMasked ?? null,
      fractionNumber: input.extras?.fractionNumber ?? null,
    },
    voidAfterDays: input.extras?.voidAfterDays ?? null,
  };
}

/**
 * Draws the check face from a saved template.
 *
 * Elements are drawn in ascending z so the layer order the user set in the
 * designer is the order that reaches paper. Every coordinate on a template is
 * millimetres from the top-left; this converts to inches once, at the edge,
 * and then reuses the same inch-based helpers as the built-in layout.
 */
async function drawTemplateFace(
  doc: PDFDocument,
  page: PDFPage,
  fonts: Fonts,
  input: CheckPdfInput,
  design: TemplateDesign,
) {
  const H = input.checkHeightIn;
  const W = input.checkWidthIn;
  const ctx = buildRenderContext(input);

  await drawBackground(doc, page, input, design);

  // Outer trim border, as in the built-in layout.
  page.drawRectangle({ x: 0, y: 0, width: W * PT, height: H * PT, borderColor: BORDER, borderWidth: 0.75 });

  const ordered = [...design.elements].sort((a, b) => a.z - b.z);

  for (const el of ordered) {
    if (el.hidden) continue;
    // The MICR line has its own routine; drawing it as text here would place
    // the glyphs on a pitch the bank's reader does not expect.
    if (el.fieldKey === "micrLine") continue;

    const leftIn = mmToIn(el.x);
    const topIn = mmToIn(el.y);
    const widthIn = mmToIn(el.w);
    const heightBoxIn = mmToIn(el.h);

    switch (el.type) {
      case "line":
        rule(page, {
          leftIn,
          topIn: topIn + heightBoxIn,
          widthIn,
          heightIn: H,
          color: parseColor(el.strokeColor),
          thicknessPt: el.strokeWidth ?? 0.75,
        });
        break;

      case "rect":
        page.drawRectangle({
          x: leftIn * PT,
          y: yFromTop(topIn + heightBoxIn, H),
          width: widthIn * PT,
          height: heightBoxIn * PT,
          color: el.fillColor ? parseColor(el.fillColor) : undefined,
          borderColor: el.strokeWidth ? parseColor(el.strokeColor) : undefined,
          borderWidth: el.strokeWidth ?? 0,
          opacity: el.opacity ?? 1,
        });
        break;

      case "image":
        await drawImageElement(doc, page, input, el, leftIn, topIn, widthIn, heightBoxIn, H);
        break;

      case "microprint":
        drawMicroprint(page, fonts, el, leftIn, topIn, widthIn, heightBoxIn, H, ctx);
        break;

      case "field":
      case "text":
      default:
        drawTextElement(page, fonts, el, leftIn, topIn, widthIn, heightBoxIn, H, ctx);
        break;
    }
  }
}

function drawTextElement(
  page: PDFPage,
  fonts: Fonts,
  el: TemplateElement,
  leftIn: number,
  topIn: number,
  widthIn: number,
  heightBoxIn: number,
  H: number,
  ctx: RenderContext,
) {
  const font = fontFor(fonts, el);
  const sizePt = el.fontSize ?? 9;
  const color = parseColor(el.color);

  // Optional box outline — how the amount field gets its border.
  if (el.strokeWidth && el.strokeWidth > 0) {
    page.drawRectangle({
      x: leftIn * PT,
      y: yFromTop(topIn + heightBoxIn, H),
      width: widthIn * PT,
      height: heightBoxIn * PT,
      borderColor: parseColor(el.strokeColor),
      borderWidth: el.strokeWidth,
    });
  }

  let cursorTop = topIn;

  const cap = resolveCaption(el, ctx);
  if (cap) {
    /* Captions normally sit above the box, matching the on-screen preview where
       the label is rendered before the value. The signature line is the one
       exception: on a real check "AUTHORIZED SIGNATURE" is printed beneath the
       rule, because the space above it is where the signature goes. */
    const below = el.fieldKey === "signature" && el.showRule;
    caption(page, fonts, cap, leftIn, below ? topIn + heightBoxIn + 0.03 : Math.max(0, topIn - 0.11), H);
  }

  const lines = elementLines(el, ctx);
  const lineStepIn = (sizePt * 1.35) / PT;
  const pad = el.strokeWidth ? 0.04 : 0;

  for (const line of lines) {
    text(page, font, line, {
      leftIn: leftIn + pad,
      topIn: cursorTop + pad,
      sizePt,
      heightIn: H,
      color,
      widthIn: widthIn - pad * 2,
      align: el.align === "right" ? "right" : "left",
      maxWidthIn: widthIn - pad * 2,
    });
    cursorTop += lineStepIn;
  }

  if (el.showRule) {
    rule(page, {
      leftIn,
      topIn: topIn + heightBoxIn,
      widthIn,
      heightIn: H,
      color: el.fieldKey === "memo" ? FAINT : INK,
      thicknessPt: 0.75,
    });
  }
}

/**
 * Repeats the element's text at very small size across its box.
 *
 * This is a genuine anti-copy measure and not decoration: real type at 1pt
 * survives an original print run but breaks up on a photocopier or scanner, so
 * a copied check shows a broken line where the original shows readable words.
 * It works precisely because it is the user's own text set small — nothing
 * here reproduces any bank's artwork or security design.
 */
function drawMicroprint(
  page: PDFPage,
  fonts: Fonts,
  el: TemplateElement,
  leftIn: number,
  topIn: number,
  widthIn: number,
  heightBoxIn: number,
  H: number,
  ctx: RenderContext,
) {
  const lines = elementLines(el, ctx);
  const phrase = lines[0];
  if (!phrase) return;

  const sizePt = Math.min(el.fontSize ?? 1.2, 2);
  const font = fonts.regular;
  const unit = `${phrase} `;
  const unitW = font.widthOfTextAtSize(unit, sizePt);
  if (unitW <= 0) return;

  const reps = Math.max(1, Math.ceil((widthIn * PT) / unitW));
  const row = unit.repeat(reps);
  const rowStepIn = (sizePt * 1.6) / PT;
  const rows = Math.max(1, Math.floor(heightBoxIn / rowStepIn));

  for (let i = 0; i < rows; i++) {
    text(page, font, row, {
      leftIn,
      topIn: topIn + i * rowStepIn,
      sizePt,
      heightIn: H,
      color: parseColor(el.color),
      maxWidthIn: widthIn,
    });
  }
}

/** Embeds and places one image element. */
async function drawImageElement(
  doc: PDFDocument,
  page: PDFPage,
  input: CheckPdfInput,
  el: TemplateElement,
  leftIn: number,
  topIn: number,
  widthIn: number,
  heightBoxIn: number,
  H: number,
) {
  if (!el.assetId) return;
  const asset = input.assets?.[el.assetId];
  if (!asset) return;
  const img = await embedImage(doc, asset);
  if (!img) return;

  let w = widthIn * PT;
  let h = heightBoxIn * PT;
  let x = leftIn * PT;
  let y = yFromTop(topIn + heightBoxIn, H);

  if ((el.fit ?? "contain") === "contain") {
    /* Fit inside the box without distorting the artwork — a stretched logo
       looks wrong on a printed check and is usually a trademark problem too. */
    const scale = Math.min(w / img.width, h / img.height);
    const fw = img.width * scale;
    const fh = img.height * scale;
    x += (w - fw) / 2;
    y += (h - fh) / 2;
    w = fw;
    h = fh;
  }

  page.drawImage(img, { x, y, width: w, height: h, opacity: el.opacity ?? 1 });
}

async function embedImage(doc: PDFDocument, asset: { bytes: Uint8Array; mimeType: string }) {
  try {
    /* pdf-lib embeds PNG and JPEG natively. WebP is accepted on upload for the
       on-screen designer but cannot be embedded here, so it is reported rather
       than silently dropped from the printed check. */
    if (asset.mimeType === "image/png") return await doc.embedPng(asset.bytes);
    if (asset.mimeType === "image/jpeg") return await doc.embedJpg(asset.bytes);
    console.warn(`Image type ${asset.mimeType} cannot be embedded in a PDF; use PNG or JPEG.`);
    return null;
  } catch (err) {
    console.error("Image could not be embedded into the check PDF", err);
    return null;
  }
}

/** Fills the face with the template's background before anything else is drawn. */
async function drawBackground(
  doc: PDFDocument,
  page: PDFPage,
  input: CheckPdfInput,
  design: TemplateDesign,
) {
  const bg = design.background ?? { mode: "none" };
  const W = input.checkWidthIn * PT;
  const H = input.checkHeightIn * PT;

  if (bg.mode === "color" && bg.color) {
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: parseColor(bg.color) });
    return;
  }

  if (bg.mode === "image" && bg.assetId) {
    const asset = input.assets?.[bg.assetId];
    if (!asset) return;
    const img = await embedImage(doc, asset);
    if (!img) return;
    /* Cover the face, cropping overflow, so there is never an unprinted strip
       down one edge. */
    const scale = Math.max(W / img.width, H / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: (W - w) / 2,
      y: (H - h) / 2,
      width: w,
      height: h,
      opacity: bg.imageOpacity ?? 0.15,
    });
    return;
  }

  if (bg.mode === "pattern") {
    drawPattern(page, input, bg.pattern ?? "lines", bg.patternColor ?? "#d4dae0", bg.patternOpacity ?? 0.35, bg.patternScale ?? 4);
  }
}

/**
 * Draws a repeating decorative pattern as plain vector strokes.
 *
 * Deliberately simple geometry. This is background styling, not a security
 * background: it makes no anti-copy claim and imitates no bank's stock.
 */
function drawPattern(
  page: PDFPage,
  input: CheckPdfInput,
  pattern: string,
  color: string,
  opacity: number,
  scaleMm: number,
) {
  const W = input.checkWidthIn * PT;
  const H = input.checkHeightIn * PT;
  const step = Math.max(1, mmToIn(scaleMm)) * PT;
  const c = parseColor(color);
  const common = { thickness: 0.3, color: c, opacity };

  if (pattern === "dots") {
    const r = Math.min(0.6, step * 0.06);
    for (let x = step / 2; x < W; x += step) {
      for (let y = step / 2; y < H; y += step) {
        page.drawCircle({ x, y, size: r, color: c, opacity });
      }
    }
    return;
  }

  if (pattern === "diagonal") {
    for (let o = -H; o < W + H; o += step) {
      page.drawLine({ start: { x: o, y: 0 }, end: { x: o + H, y: H }, ...common });
    }
    return;
  }

  // "lines" and the horizontal half of "grid"
  for (let y = 0; y < H; y += step) {
    page.drawLine({ start: { x: 0, y }, end: { x: W, y }, ...common });
  }
  if (pattern === "grid") {
    for (let x = 0; x < W; x += step) {
      page.drawLine({ start: { x, y: 0 }, end: { x, y: H }, ...common });
    }
  }
}

function drawFace(page: PDFPage, fonts: Fonts, input: CheckPdfInput) {
  const { checkWidthIn: W, checkHeightIn: H, check, business } = input;
  const M = LEFT_MARGIN_IN;

  // Outer trim border.
  page.drawRectangle({
    x: 0,
    y: 0,
    width: W * PT,
    height: H * PT,
    borderColor: BORDER,
    borderWidth: 0.75,
  });

  // ---- issuer block
  text(page, fonts.bold, business.legalName, { leftIn: M, topIn: 0.22, sizePt: 9.5, heightIn: H, maxWidthIn: 4.2 });
  if (business.dba) {
    text(page, fonts.regular, `dba ${business.dba}`, { leftIn: M, topIn: 0.42, sizePt: 6.5, heightIn: H, color: SUBTLE, maxWidthIn: 4.2 });
  }
  let addrTop = business.dba ? 0.58 : 0.42;
  const addrLines = [
    business.addressLine1 ?? "",
    business.city ? `${business.city}, ${business.state ?? ""} ${business.zip ?? ""}`.trim() : "",
    business.phone ?? "",
  ].filter(Boolean);
  for (const line of addrLines) {
    text(page, fonts.regular, line, { leftIn: M, topIn: addrTop, sizePt: 6.5, heightIn: H, color: SUBTLE, maxWidthIn: 4.2 });
    addrTop += 6.5 * 1.35 / PT; // line-height 1.35, expressed in inches
  }

  // ---- check number, top right
  text(page, fonts.bold, String(check.checkNumber), {
    leftIn: W - 1.1,
    topIn: 0.22,
    sizePt: 11,
    heightIn: H,
    widthIn: 0.75,
    align: "right",
  });

  // ---- date
  caption(page, fonts, "Date", W - 2.55, 0.62, H);
  text(page, fonts.regular, check.checkDate, { leftIn: W - 2.55, topIn: 0.74, sizePt: 8.5, heightIn: H });
  rule(page, { leftIn: W - 2.55, topIn: 0.895, widthIn: 2.2, heightIn: H });

  // ---- payee
  caption(page, fonts, "Pay to the order of", M, 1.08, H);
  text(page, fonts.bold, check.payeeName, { leftIn: M, topIn: 1.2, sizePt: 10, heightIn: H, maxWidthIn: 5.5 });
  rule(page, { leftIn: M, topIn: 1.38, widthIn: 5.6, heightIn: H });

  // ---- numeric amount, boxed
  caption(page, fonts, "Amount", 6.15, 1.08, H);
  const amount = (check.amountCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const boxTop = 1.19;
  const boxH = 0.21;
  page.drawRectangle({
    x: 6.15 * PT,
    y: yFromTop(boxTop + boxH, H),
    width: 2 * PT,
    height: boxH * PT,
    borderColor: INK,
    borderWidth: 0.75,
  });
  text(page, fonts.bold, `$${amount}`, {
    leftIn: 6.15,
    topIn: boxTop + 0.045,
    sizePt: 10,
    heightIn: H,
    widthIn: 2 - 0.08,
    align: "right",
  });

  // ---- written amount, with the DOLLARS caption pinned right
  const writtenWidth = W - M * 2;
  const dollarsW = fonts.regular.widthOfTextAtSize("DOLLARS", 5.5) / PT;
  text(page, fonts.regular, check.writtenAmount, {
    leftIn: M,
    topIn: 1.62,
    sizePt: 8.5,
    heightIn: H,
    maxWidthIn: writtenWidth - dollarsW - 0.1,
  });
  text(page, fonts.regular, "DOLLARS", {
    leftIn: M,
    topIn: 1.635,
    sizePt: 5.5,
    heightIn: H,
    widthIn: writtenWidth,
    align: "right",
    color: FAINT,
  });
  rule(page, { leftIn: M, topIn: 1.78, widthIn: writtenWidth, heightIn: H });

  // ---- memo
  caption(page, fonts, "Memo", M, 2.12, H);
  if (check.memo) {
    text(page, fonts.regular, check.memo, { leftIn: M, topIn: 2.24, sizePt: 7.5, heightIn: H, color: SUBTLE, maxWidthIn: 3.35 });
  }
  rule(page, { leftIn: M, topIn: 2.42, widthIn: 3.4, heightIn: H, color: FAINT });

  // ---- signature
  rule(page, { leftIn: 4.9, topIn: 2.42, widthIn: 3.25, heightIn: H });
  caption(
    page,
    fonts,
    business.defaultSigner ? `Authorized signature \u00b7 ${business.defaultSigner}` : "Authorized signature",
    4.9,
    2.45,
    H
  );

  // ---- bank name
  text(page, fonts.regular, input.bankName, { leftIn: M, topIn: 2.66, sizePt: 6, heightIn: H, color: FAINT });
}

/**
 * Lays the MICR characters at their exact ANSI X9.13 positions, in the embedded
 * E-13B face.
 *
 * Geometry comes from buildMicrLayout, so every character is placed at an
 * absolute 1/8in position rather than being emitted as one run of text — an
 * unexpected glyph advance therefore cannot shift the rest of the line.
 *
 * Two independent requirements make a MICR line readable, and this function can
 * only satisfy the first:
 *   1. Correct glyph shapes at correct positions — done here.
 *   2. Magnetic ink. That is a property of the toner and the printer, not of
 *      the PDF, so the PDF alone is never sufficient for live issuance.
 *
 * If the face failed to embed we fall back to Courier and stamp a visible
 * warning under the line, so a proof can never be mistaken for the real thing.
 */
function drawMicr(page: PDFPage, fonts: Fonts, input: CheckPdfInput) {
  const layout = buildMicrLayout(
    {
      routing: input.routing,
      account: input.account,
      checkNumber: input.check.checkNumber,
      checkWidthIn: input.checkWidthIn,
    },
    input.checkHeightIn
  );

  const authentic = fonts.micr !== null;
  const face = fonts.micr ?? fonts.mono;
  const sizePt = MICR_GEOM.fontSizeIn * PT;
  for (const cell of layout.cells) {
    page.drawText(cell.char, {
      x: cell.leftIn * PT,
      // buildMicrLayout gives a true baseline, so no ascent fudge here.
      y: yFromTop(layout.baselineFromTopIn, input.checkHeightIn),
      size: sizePt,
      font: face,
      color: rgb(0, 0, 0),
    });
  }

  if (!authentic) {
    // Sits above the 5/8in clear band so the warning itself never intrudes on
    // the band it is warning about.
    page.drawText("NOT MACHINE READABLE - E-13B font unavailable, glyphs substituted", {
      x: LEFT_MARGIN_IN * PT,
      y: yFromTop(input.checkHeightIn - 0.7, input.checkHeightIn),
      size: 6,
      font: fonts.bold,
      color: VOID_RED,
    });
  }
}

function drawVoidStamp(page: PDFPage, fonts: Fonts, input: CheckPdfInput) {
  const label = "VOID \u00b7 TEST ONLY";
  const sizePt = 40;
  const angleDeg = -11;
  const rad = (Math.abs(angleDeg) * Math.PI) / 180;
  const w = fonts.bold.widthOfTextAtSize(label, sizePt);
  // pdf-lib rotates about the text origin rather than its centre, so a plain
  // centred origin would let the baseline drift down and to the right. Nudge
  // the origin up by half the vertical run and left by half the horizontal
  // shrink so the finished stamp sits centred on the face.
  const rotatedW = w * Math.cos(rad);
  const verticalRun = w * Math.sin(rad);
  page.drawText(label, {
    x: (input.checkWidthIn * PT - rotatedW) / 2,
    y: (input.checkHeightIn * PT) / 2 - sizePt * 0.35 + verticalRun / 2,
    size: sizePt,
    font: fonts.bold,
    color: VOID_RED,
    opacity: 0.16,
    rotate: degrees(angleDeg),
  });
}

/** Triggers a browser download of the given PDF bytes. */
export function downloadPdf(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the navigation has already been kicked off.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Opens the PDF in a new tab. Used as the "preview" action, because an embedded
 * frame cannot show the browser's own print preview.
 */
export function openPdfInNewTab(bytes: Uint8Array): boolean {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (!win) {
    URL.revokeObjectURL(url);
    return false;
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

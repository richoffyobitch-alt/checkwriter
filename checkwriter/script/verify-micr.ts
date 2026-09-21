import {
  buildMicrLayout,
  positionLeftIn,
  MICR_GEOM,
  MICR_FIELDS,
  MICR_MIN_FULL_WIDTH_IN,
  isValidAbaRouting,
  summarizeMicr,
} from "../client/src/lib/micr";
import { E13B_FONT_BASE64, e13bFontBytes } from "../client/src/lib/e13b-font";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const W = 8.5;
const H = 3.5;
const routing = "121000358";
const account = "9876543210";
const checkNumber = 4201;

console.log("=== geometry invariants ===");
const checks: [string, number, number][] = [
  ["min full width (8 7/16)", MICR_MIN_FULL_WIDTH_IN, 8.4375],
  ["pos 1 left edge from left", positionLeftIn(1, W), 8.0625],
  ["pos 1 right edge from RIGHT", W - (positionLeftIn(1, W) + 0.125), 0.3125],
  ["pos 65 left edge from left", positionLeftIn(65, W), 0.0625],
  ["pos 65 left edge from RIGHT", W - positionLeftIn(65, W), 8.4375],
  ["baseline from top (3.5in check)", H - MICR_GEOM.baselineFromBottom, 3.3125],
  ["print band top from top", H - MICR_GEOM.bandTopFromBottom, 3.0625],
  ["clear band top from top", H - MICR_GEOM.clearBandHeight, 2.875],
  ["font size (in) for 1/8 pitch", MICR_GEOM.fontSizeIn, 1 / 6],
];
let pass = true;
for (const [label, got, want] of checks) {
  const ok = Math.abs(got - want) < 1e-9;
  if (!ok) pass = false;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} got=${got.toFixed(6)} want=${want.toFixed(6)}`);
}

console.log("\n=== ABA checksum ===");
console.log("121000358 valid:", isValidAbaRouting("121000358"), "(expect true)");
console.log("121000359 valid:", isValidAbaRouting("121000359"), "(expect false)");

const layout = buildMicrLayout({ routing, account, checkNumber, checkWidthIn: W }, H);
console.log("\n=== field summary ===");
for (const f of summarizeMicr(layout)) {
  console.log(
    `${f.spec.label.padEnd(18)} spec=${String(f.spec.from).padStart(2)}-${String(f.spec.to).padStart(2)}` +
      `  used=${f.occupied.padEnd(7)} ${f.spec.bankPrinted ? "[BANK-PRINTED]" : ""} "${f.text}"`,
  );
}

console.log("\n=== warnings ===");
console.log(layout.warnings.length ? layout.warnings.join("\n") : "(none)");

// Verify every cell sits on an exact 1/8" multiple and inside the band.
console.log("\n=== per-cell placement integrity ===");
let cellsOk = true;
for (const c of layout.cells) {
  const expected = W - MICR_GEOM.bandRightInset - c.position * MICR_GEOM.pitch;
  if (Math.abs(c.leftIn - expected) > 1e-9) { cellsOk = false; console.log("BAD offset", c); }
  if (c.position < 1 || c.position > 65) { cellsOk = false; console.log("BAD position", c); }
  if (c.leftIn < 0) { cellsOk = false; console.log("OFF-EDGE", c); }
}
const positions = layout.cells.map((c) => c.position);
const dupes = positions.filter((p, i) => positions.indexOf(p) !== i);
if (dupes.length) { cellsOk = false; console.log("COLLISION at positions:", dupes); }
// Bank-printed fields must be untouched.
for (const c of layout.cells) {
  if (c.position <= 12 || c.position === 44) { cellsOk = false; console.log("INTRUDES into bank field:", c); }
}
console.log(cellsOk ? "PASS  all cells exact, unique, in-band, bank fields clear" : "FAIL");

// Render the 65-position band map, position 65 (left) .. 1 (right).
console.log("\n=== band map (left edge -> right edge) ===");
const row: string[] = [];
for (let p = 65; p >= 1; p--) {
  const cell = layout.cells.find((c) => c.position === p);
  row.push(cell ? cell.char : ".");
}
console.log("pos65" + " ".repeat(56) + "pos1");
console.log(row.join(""));
const ruler = [];
for (let p = 65; p >= 1; p--) ruler.push(p % 10 === 0 ? "|" : " ");
console.log(ruler.join(""));
console.log("\nlegend: A=transit B=amount C=on-us D=dash  '.'=blank");
/* ---------------------------------------------------------------- E-13B face
   The glyph shapes matter as much as the geometry: a correctly positioned line
   set in the wrong face is not machine-readable. Two copies of the font exist
   by necessity — index.css needs a CSS @font-face for the DOM preview, and
   lib/e13b-font.ts needs the raw bytes for pdf-lib to embed into the PDF. If
   they ever drift, the preview and the PDF would disagree about what a check
   looks like, so assert they are byte-identical here. */
console.log("\n=== E-13B face ===");
let fontOk = true;

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(here, "..", "client", "src", "index.css");
const css = fs.readFileSync(cssPath, "utf8");
const cssMatch = css.match(
  /font-family:\s*"MICR E13B";\s*src:\s*url\("data:font\/ttf;base64,([A-Za-z0-9+/=]+)"\)/,
);
if (!cssMatch) {
  fontOk = false;
  console.log("FAIL  no MICR E13B @font-face data URI found in index.css");
} else {
  const same = cssMatch[1] === E13B_FONT_BASE64;
  if (!same) fontOk = false;
  console.log(
    `${same ? "PASS" : "FAIL"}  index.css and lib/e13b-font.ts carry the same face ` +
      `(css=${cssMatch[1].length}B b64, ts=${E13B_FONT_BASE64.length}B b64)`,
  );
}

const bytes = e13bFontBytes();
const magicOk = bytes.length > 1024 && bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00;
if (!magicOk) fontOk = false;
console.log(`${magicOk ? "PASS" : "FAIL"}  decodes to a TrueType program (${bytes.length} bytes)`);

/* Every glyph this app can emit must exist in the face. A missing glyph would
   silently render as blank or fall back, which on a MICR line is a defect that
   only a bank's reader would catch. */
const required = "0123456789ABCD";
const cmapCoverage = (() => {
  /* Minimal cmap format-4 walk: enough to prove the codepoints are mapped,
     without pulling a font-parsing dependency into the build. */
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(4);
  let cmapOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
    if (tag === "cmap") cmapOff = dv.getUint32(rec + 8);
  }
  if (cmapOff < 0) return null;
  const nSub = dv.getUint16(cmapOff + 2);
  let best = -1;
  for (let i = 0; i < nSub; i++) {
    const rec = cmapOff + 4 + i * 8;
    if (dv.getUint16(rec + 2) <= 1 || dv.getUint16(rec) === 3) best = cmapOff + dv.getUint32(rec + 4);
  }
  if (best < 0 || dv.getUint16(best) !== 4) return null;
  const segX2 = dv.getUint16(best + 6);
  const seg = segX2 / 2;
  const endO = best + 14;
  const startO = endO + segX2 + 2;
  const deltaO = startO + segX2;
  const rangeO = deltaO + segX2;
  const lookup = (cp: number) => {
    for (let i = 0; i < seg; i++) {
      const end = dv.getUint16(endO + i * 2);
      if (cp > end) continue;
      const start = dv.getUint16(startO + i * 2);
      if (cp < start) return 0;
      const ro = dv.getUint16(rangeO + i * 2);
      if (ro === 0) return (cp + dv.getInt16(deltaO + i * 2)) & 0xffff;
      const gi = dv.getUint16(rangeO + i * 2 + ro + (cp - start) * 2);
      return gi === 0 ? 0 : (gi + dv.getInt16(deltaO + i * 2)) & 0xffff;
    }
    return 0;
  };
  return Array.from(required).map((ch) => [ch, lookup(ch.charCodeAt(0))] as const);
})();

if (!cmapCoverage) {
  fontOk = false;
  console.log("FAIL  could not read a format-4 cmap from the face");
} else {
  const missing = cmapCoverage.filter(([, gid]) => gid === 0).map(([ch]) => ch);
  if (missing.length) fontOk = false;
  console.log(
    `${missing.length ? "FAIL" : "PASS"}  all ${required.length} required glyphs mapped` +
      (missing.length ? ` (missing: ${missing.join(", ")})` : " (0-9 plus A/B/C/D control symbols)"),
  );
}

/* The 1/8in pitch in MICR_GEOM.fontSizeIn is derived from a uniform 0.75em
   advance. If the face were ever swapped for one with proportional advances,
   the whole line would creep out of position, so pin the assumption down. */
const advanceOk = (() => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(4);
  const tables: Record<string, number> = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
    tables[tag] = dv.getUint32(rec + 8);
  }
  if (!tables.head || !tables.hhea || !tables.hmtx) return null;
  const upm = dv.getUint16(tables.head + 18);
  const numH = dv.getUint16(tables.hhea + 34);
  /* Only the glyphs this app actually emits are in scope. .notdef and any
     unmapped glyph legitimately carry a zero advance, and including them would
     fail the check for a font that is perfectly correct in practice. */
  const gids = (cmapCoverage ?? []).map(([, gid]) => gid).filter((g) => g > 0);
  if (!gids.length) return null;
  const advances = new Set<number>();
  for (const gid of gids) {
    const i = Math.min(gid, numH - 1);
    advances.add(dv.getUint16(tables.hmtx + i * 4));
  }
  return { upm, advances: [...advances] };
})();

if (!advanceOk) {
  fontOk = false;
  console.log("FAIL  could not read horizontal metrics");
} else {
  const ems = advanceOk.advances.map((a) => a / advanceOk.upm);
  const uniform = ems.every((e) => Math.abs(e - 0.75) < 1e-6);
  if (!uniform) fontOk = false;
  console.log(
    `${uniform ? "PASS" : "FAIL"}  uniform 0.75em advance across the 14 emitted glyphs (upm=${advanceOk.upm}, ` +
      `distinct advances: ${ems.map((e) => e.toFixed(4)).join(", ")})`,
  );
  const derived = MICR_GEOM.pitch / 0.75;
  const pitchOk = Math.abs(MICR_GEOM.fontSizeIn - derived) < 1e-12;
  if (!pitchOk) fontOk = false;
  console.log(
    `${pitchOk ? "PASS" : "FAIL"}  fontSizeIn yields exact 1/8in pitch ` +
      `(${MICR_GEOM.fontSizeIn.toFixed(6)}in = ${(MICR_GEOM.fontSizeIn * 72).toFixed(2)}pt)`,
  );
}

console.log("\n" + (pass && cellsOk && fontOk ? "ALL GEOMETRY AND FONT CHECKS PASSED" : "SOME CHECKS FAILED"));

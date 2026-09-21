/**
 * Regression checks for template normalisation.
 *
 * The bug this guards against: a template saved before the layered designer
 * stores elements as `{ key, x, y, w, h, fontSize, locked }` with no styling
 * fields at all. Read literally, that produces a check with no signature line,
 * no ruled lines, and no box around the amount — which is not a printable
 * business check. Equally important in the other direction: a *modern* template
 * where the user deliberately switched a rule off must keep it off, so the
 * backfill must not fire for those.
 *
 * Run with: npm run verify:template
 */
import {
  DEFAULT_TEMPLATE_ELEMENTS,
} from "../shared/domain";
import {
  defaultDesign,
  isLegacyElement,
  normalizeDesign,
  normalizeElement,
  validateDesign,
  validatePrintColour,
  type FieldKey,
  type TemplateElement,
} from "../shared/template";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n=== template normalisation ===\n");

/* ---------------------------------------------- legacy shape detection */

check(
  "the seeded pre-layer elements are recognised as legacy",
  DEFAULT_TEMPLATE_ELEMENTS.every((e) => isLegacyElement(e)),
);

check(
  "a current layered element is not treated as legacy",
  defaultDesign().elements.every((e) => !isLegacyElement(e)),
);

check("a null element is not legacy", !isLegacyElement(null));
check("an element with an explicit type is not legacy", !isLegacyElement({ key: "payee", type: "field" }));
check("an element with a z index is not legacy", !isLegacyElement({ key: "payee", z: 4 }));

/* ---------------------------------------------- the actual bug */

const legacy = normalizeDesign(DEFAULT_TEMPLATE_ELEMENTS as unknown[], null);
const byKey = new Map<string, TemplateElement>();
for (const e of legacy.elements) if (e.fieldKey) byKey.set(e.fieldKey, e);

check(
  "a legacy signature field recovers its ruled line",
  byKey.get("signature")?.showRule === true,
  `showRule=${byKey.get("signature")?.showRule}`,
);
check(
  "a legacy numeric amount recovers its box outline",
  (byKey.get("numericAmount")?.strokeWidth ?? 0) > 0,
  `strokeWidth=${byKey.get("numericAmount")?.strokeWidth}`,
);
check(
  "a legacy payee recovers its ruled line and caption",
  byKey.get("payee")?.showRule === true && byKey.get("payee")?.showCaption === true,
);
check(
  "a legacy written amount recovers its ruled line",
  byKey.get("writtenAmount")?.showRule === true,
);
check("a legacy memo recovers its ruled line", byKey.get("memo")?.showRule === true);
check("a legacy check date recovers its ruled line", byKey.get("checkDate")?.showRule === true);

const ruled: FieldKey[] = ["checkDate", "payee", "writtenAmount", "memo", "signature"];
check(
  "every conventionally ruled field is ruled after normalisation",
  ruled.every((k) => byKey.get(k)?.showRule === true),
  ruled.filter((k) => byKey.get(k)?.showRule !== true).join(", ") || "none missing",
);

/* -------------------------------- geometry must survive untouched */

for (const raw of DEFAULT_TEMPLATE_ELEMENTS) {
  const got = byKey.get(raw.key);
  if (!got) continue;
  check(
    `${raw.key} keeps its calibrated position and size`,
    got.x === raw.x && got.y === raw.y && got.w === raw.w && got.h === raw.h,
    `got ${got.x},${got.y} ${got.w}x${got.h} want ${raw.x},${raw.y} ${raw.w}x${raw.h}`,
  );
}

check(
  "the locked MICR element stays locked through normalisation",
  byKey.get("micrLine")?.locked === true,
);

/* -------------------------------- deliberate user choices are respected */

const userTurnedRuleOff = normalizeElement({
  id: "signature",
  type: "field",
  fieldKey: "signature",
  x: 124.5, y: 53.8, w: 82.6, h: 6, z: 20,
  showRule: false,
});
check(
  "a rule the user switched off is not silently restored",
  userTurnedRuleOff.showRule === false,
  `showRule=${userTurnedRuleOff.showRule}`,
);

const modernWithoutRule = normalizeElement({
  id: "memo", type: "field", fieldKey: "memo",
  x: 8.9, y: 53.8, w: 86.4, h: 5, z: 19,
});
check(
  "a modern element with no rule set stays unruled",
  modernWithoutRule.showRule === undefined,
  `showRule=${modernWithoutRule.showRule}`,
);

const noBox = normalizeElement({
  id: "numericAmount", type: "field", fieldKey: "numericAmount",
  x: 156.2, y: 30.2, w: 50.8, h: 5.3, z: 17, strokeWidth: 0,
});
check("an amount box the user removed stays removed", noBox.strokeWidth === 0);

/* -------------------------------- general robustness */

const empty = normalizeDesign([], null);
check("an empty element list falls back to the stock layout", empty.elements.length > 0);
check("a missing element list falls back to the stock layout", normalizeDesign(null, null).elements.length > 0);
check("a null background normalises to none", empty.background.mode === "none");

const junk = normalizeElement({ key: "not-a-real-field", x: 1, y: 2 });
check("an unknown field key is dropped rather than guessed", junk.fieldKey === undefined);
check("an unknown field key keeps its position", junk.x === 1 && junk.y === 2);

const custom = normalizeElement({ id: "t1", type: "text", text: "Hello", x: 5, y: 5, w: 30, h: 5, z: 1 });
check("a custom text element survives normalisation", custom.type === "text" && custom.text === "Hello");
check("a custom text element gets no field backfill", custom.showRule === undefined);

check(
  "normalisation is idempotent",
  JSON.stringify(legacy.elements.map((e) => normalizeElement(e))) === JSON.stringify(legacy.elements),
);

/* ------------------------------------------------ print colour warnings */

/* These guard a specific promise to the user: the app flags backgrounds and
   ink that a bank is likely to reject, but never stops them designing the
   check they asked for. Every finding must be a warning, never an error. */

function designWithBackground(bg: Record<string, unknown>) {
  const d = defaultDesign();
  return { ...d, background: { ...d.background, ...bg } as typeof d.background };
}

const white = validatePrintColour(designWithBackground({ mode: "none" }));
check("a plain white background raises nothing", white.length === 0);

const pastel = validatePrintColour(designWithBackground({ mode: "color", color: "#eaf4ff" }));
check("a pastel background raises nothing", pastel.length === 0);

const red = validatePrintColour(designWithBackground({ mode: "color", color: "#eb1414" }));
check("a red background is flagged", red.some((i) => i.message.includes("red")));

const black = validatePrintColour(designWithBackground({ mode: "color", color: "#000000" }));
check("a black background is flagged", black.some((i) => i.message.includes("black")));

const navy = validatePrintColour(designWithBackground({ mode: "color", color: "#12306b" }));
check("a dark blue background is flagged", navy.some((i) => i.message.includes("dark blue")));

const forest = validatePrintColour(designWithBackground({ mode: "color", color: "#125c2a" }));
check("a dark green background is flagged", forest.some((i) => i.message.includes("dark green")));

const midGrey = validatePrintColour(designWithBackground({ mode: "color", color: "#9a9a9a" }));
check(
  "a mid grey background is flagged on reflectance, not colour family",
  midGrey.length > 0 && midGrey.every((i) => !i.message.includes("prohibit")),
);

const faintGrey = validatePrintColour(designWithBackground({ mode: "color", color: "#f2f2f2" }));
check("a very light grey background raises nothing", faintGrey.length === 0);

check(
  "every colour finding is a warning, so the design still saves",
  [...red, ...black, ...navy, ...forest, ...midGrey].every((i) => i.level === "warning"),
);

const darkDesign = designWithBackground({ mode: "color", color: "#000000" });
check(
  "a prohibited background produces no blocking error",
  validateDesign(darkDesign).filter((i) => i.level === "error").length === 0,
);

const patterned = validatePrintColour(
  designWithBackground({ mode: "pattern", patternColor: "#cccccc", patternOpacity: 0.2 }),
);
check(
  "a visible pattern warns about the fields that must stay on plain paper",
  patterned.some((i) => i.message.includes("plain paper")),
);

const patternOff = validatePrintColour(
  designWithBackground({ mode: "pattern", patternColor: "#cccccc", patternOpacity: 0 }),
);
check("a pattern at zero opacity raises nothing", patternOff.length === 0);

const imaged = validatePrintColour(
  designWithBackground({ mode: "image", assetId: 1, imageOpacity: 0.2 }),
);
check(
  "an image background is called out even though its colour is unknowable",
  imaged.some((i) => i.message.includes("plain paper")),
);

const paleInk = (() => {
  const d = defaultDesign();
  const els = d.elements.map((e) =>
    e.fieldKey === "payee" ? { ...e, color: "#f0f0f0" } : e,
  );
  return validatePrintColour({ ...d, elements: els });
})();
check(
  "pale ink on white paper is flagged for contrast",
  paleInk.some((i) => i.message.includes("little contrast")),
);

const normalInk = validatePrintColour(defaultDesign());
check("default black ink on white paper raises no contrast finding", normalInk.length === 0);

console.log(`\n${"=".repeat(70)}`);
console.log(`TEMPLATE: ${passed} passed, ${failures.length} failed`);
console.log("=".repeat(70));
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

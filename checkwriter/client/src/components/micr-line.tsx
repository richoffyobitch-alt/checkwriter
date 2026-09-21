import {
  buildMicrLayout,
  MICR_GEOM,
  MICR_FIELDS,
  positionLeftIn,
  type MicrFieldName,
  type MicrInput,
} from "@/lib/micr";

/**
 * Renders the MICR line as SVG. SVG places text by its BASELINE, so the
 * 3/16" baseline requirement lands exactly without depending on font ascent
 * metrics. The viewBox uses 1 user unit = 1 inch, so every coordinate below is
 * a literal inch measurement taken straight from ANSI X9.13.
 */

const FIELD_TINT: Record<MicrFieldName, string> = {
  amount: "#ef4444",
  onUs: "#22c55e",
  routing: "#3b82f6",
  epc: "#ef4444",
  auxOnUs: "#a855f7",
};

export interface MicrLineProps extends MicrInput {
  checkHeightIn: number;
  /** Draw the clear band, print band, position ruler and field tints. */
  showDiagnostics?: boolean;
  ink?: string;
}

export function MicrLine({
  checkHeightIn,
  showDiagnostics = false,
  ink = "#000",
  ...input
}: MicrLineProps) {
  const { checkWidthIn } = input;
  const layout = buildMicrLayout(input, checkHeightIn);
  const baseline = layout.baselineFromTopIn;
  const bandTop = checkHeightIn - MICR_GEOM.bandTopFromBottom;
  const clearTop = layout.clearBandTopFromTopIn;

  return (
    <svg
      width={`${checkWidthIn}in`}
      height={`${checkHeightIn}in`}
      viewBox={`0 0 ${checkWidthIn} ${checkHeightIn}`}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}
      aria-label="MICR line"
    >
      {showDiagnostics && (
        <g className="micr-diagnostics">
          {/* Clear band: bottom 5/8" must stay free of other magnetic ink. */}
          <rect
            x={0}
            y={clearTop}
            width={checkWidthIn}
            height={MICR_GEOM.clearBandHeight}
            fill="#f59e0b"
            fillOpacity={0.07}
          />
          <line
            x1={0}
            y1={clearTop}
            x2={checkWidthIn}
            y2={clearTop}
            stroke="#f59e0b"
            strokeWidth={0.006}
            strokeDasharray="0.05 0.03"
          />
          {/* MICR print band: 3/16" to 7/16" above the aligning edge. */}
          <rect
            x={positionLeftIn(MICR_GEOM.positions, checkWidthIn)}
            y={bandTop}
            width={MICR_GEOM.positions * MICR_GEOM.pitch}
            height={MICR_GEOM.bandHeight}
            fill="#3b82f6"
            fillOpacity={0.07}
            stroke="#3b82f6"
            strokeWidth={0.005}
          />
          {/* Field tints across their full position ranges. */}
          {(Object.keys(MICR_FIELDS) as MicrFieldName[]).map((name) => {
            const spec = MICR_FIELDS[name];
            return (
              <rect
                key={name}
                x={positionLeftIn(spec.to, checkWidthIn)}
                y={bandTop}
                width={(spec.to - spec.from + 1) * MICR_GEOM.pitch}
                height={MICR_GEOM.bandHeight}
                fill={FIELD_TINT[name]}
                fillOpacity={spec.bankPrinted ? 0.14 : 0.09}
              />
            );
          })}
          {/* Baseline. */}
          <line
            x1={positionLeftIn(MICR_GEOM.positions, checkWidthIn)}
            y1={baseline}
            x2={positionLeftIn(0, checkWidthIn)}
            y2={baseline}
            stroke="#3b82f6"
            strokeWidth={0.004}
          />
          {/* Position ruler every 5th position. */}
          {Array.from({ length: MICR_GEOM.positions }, (_, i) => i + 1)
            .filter((p) => p % 5 === 0 || p === 1)
            .map((p) => (
              <g key={p}>
                <line
                  x1={positionLeftIn(p, checkWidthIn)}
                  y1={bandTop - 0.03}
                  x2={positionLeftIn(p, checkWidthIn)}
                  y2={bandTop}
                  stroke="#64748b"
                  strokeWidth={0.004}
                />
                <text
                  x={positionLeftIn(p, checkWidthIn) + MICR_GEOM.pitch / 2}
                  y={bandTop - 0.045}
                  fontSize={0.055}
                  fill="#64748b"
                  textAnchor="middle"
                  fontFamily="ui-monospace, monospace"
                >
                  {p}
                </text>
              </g>
            ))}
        </g>
      )}

      {/* The MICR characters themselves, one per 1/8" position. */}
      {layout.cells.map((c) => (
        <text
          key={`${c.field}-${c.position}`}
          x={c.leftIn}
          y={baseline}
          fontFamily='"MICR E13B", monospace'
          fontSize={MICR_GEOM.fontSizeIn}
          fill={ink}
          textAnchor="start"
        >
          {c.char}
        </text>
      ))}
    </svg>
  );
}

/** Warnings produced by the layout, for callers that want to surface them. */
export function useMicrWarnings(input: MicrInput, checkHeightIn: number): string[] {
  return buildMicrLayout(input, checkHeightIn).warnings;
}

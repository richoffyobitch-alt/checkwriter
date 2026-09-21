/**
 * Renders a check face from a template design.
 *
 * This is the single on-screen renderer, used by both the designer and the
 * print preview. Sharing it is the point: the designer previously had its own
 * crude box view and the preview had a hardcoded layout, so what a user
 * arranged was not what they saw and neither was what printed. The geometry
 * here mirrors client/src/lib/check-pdf.ts element for element.
 *
 * Coordinates on a template are millimetres from the top-left of the face.
 * They are converted to inches once, here, because CSS `in` units and the
 * PDF's 72-unit inch line up exactly at 100% zoom.
 */
import type { CSSProperties, ReactNode } from "react";
import type { TemplateDesign, TemplateElement } from "@shared/template";
import { CANVAS_W_MM, CANVAS_H_MM, MICR_CLEAR_BAND_MM } from "@shared/template";
import {
  elementLines,
  resolveCaption,
  FONT_STACKS,
  patternPath,
  type RenderContext,
} from "@shared/render";

const MM_PER_IN = 25.4;
const mmToIn = (mm: number) => mm / MM_PER_IN;

export const CHECK_W_IN = mmToIn(CANVAS_W_MM);
export const CHECK_H_IN = mmToIn(CANVAS_H_MM);

const INK = "#101418";
const FAINT = "#8b97a3";

export interface CheckCanvasProps {
  design: TemplateDesign;
  ctx: RenderContext;
  /** Drawn into the MICR band. The band is reserved even when this is absent. */
  micr?: ReactNode;
  /** Stamps the VOID / TEST ONLY watermark. */
  testMode?: boolean;
  /** Designer chrome: grid, clear-band shading, safe margins. */
  showGuides?: boolean;
  /** Element id to outline as selected. Designer only. */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onElementPointerDown?: (id: string, e: React.PointerEvent) => void;
  /** Resolves an asset id to a URL the browser can load. */
  assetUrl?: (assetId: number) => string;
  className?: string;
}

export function CheckCanvas({
  design,
  ctx,
  micr,
  testMode = false,
  showGuides = false,
  selectedId = null,
  onSelect,
  onElementPointerDown,
  assetUrl = (id) => `/api/assets/${id}`,
  className,
}: CheckCanvasProps) {
  const ordered = [...design.elements].sort((a, b) => a.z - b.z);
  const clearBandTopIn = CHECK_H_IN - mmToIn(MICR_CLEAR_BAND_MM);

  return (
    <div
      className={className ? `relative ${className}` : "relative"}
      style={{
        width: `${CHECK_W_IN}in`,
        height: `${CHECK_H_IN}in`,
        background: "#fff",
        color: INK,
        overflow: "hidden",
      }}
      data-testid="check-canvas-inner"
    >
      <Background design={design} assetUrl={assetUrl} />

      <div style={{ position: "absolute", inset: 0, border: "1px solid #d4dae0", pointerEvents: "none" }} />

      {showGuides && (
        <>
          {/* The bottom 5/8in is the MICR clear band. Nothing else may print
              there, so the designer shades it rather than silently clipping. */}
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: `${clearBandTopIn}in`,
              bottom: 0,
              background: "repeating-linear-gradient(45deg,rgba(220,38,38,.05) 0 6px,transparent 6px 12px)",
              borderTop: "1px dashed rgba(220,38,38,.45)",
              pointerEvents: "none",
            }}
            data-testid="guide-clear-band"
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage:
                "linear-gradient(to right,rgba(16,20,24,.07) 1px,transparent 1px),linear-gradient(to bottom,rgba(16,20,24,.07) 1px,transparent 1px)",
              backgroundSize: `${mmToIn(5)}in ${mmToIn(5)}in`,
              pointerEvents: "none",
            }}
          />
        </>
      )}

      {ordered.map((el) => (
        <ElementView
          key={el.id}
          el={el}
          ctx={ctx}
          selected={selectedId === el.id}
          interactive={!!onSelect}
          onSelect={onSelect}
          onPointerDown={onElementPointerDown}
          assetUrl={assetUrl}
          micr={micr}
        />
      ))}

      {testMode && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              fontSize: "40pt",
              fontWeight: 700,
              color: "rgba(220,38,38,.16)",
              transform: "rotate(-11deg)",
              whiteSpace: "nowrap",
            }}
          >
            VOID · TEST ONLY
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ background */

function Background({
  design,
  assetUrl,
}: {
  design: TemplateDesign;
  assetUrl: (id: number) => string;
}) {
  const bg = design.background ?? { mode: "none" };

  if (bg.mode === "color" && bg.color) {
    return <div style={{ position: "absolute", inset: 0, background: bg.color }} />;
  }

  if (bg.mode === "image" && bg.assetId) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `url(${assetUrl(bg.assetId)})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          opacity: bg.imageOpacity ?? 0.15,
        }}
      />
    );
  }

  if (bg.mode === "pattern") {
    const scale = bg.patternScale ?? 4;
    const { d, tile } = patternPath(bg.pattern ?? "lines", scale);
    const id = `pat-${bg.pattern ?? "lines"}-${scale}`;
    const stroke = bg.patternColor ?? "#d4dae0";
    return (
      <svg
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: bg.patternOpacity ?? 0.35 }}
        aria-hidden="true"
      >
        <defs>
          <pattern id={id} width={`${mmToIn(tile)}in`} height={`${mmToIn(tile)}in`} patternUnits="userSpaceOnUse">
            <path
              d={d}
              stroke={stroke}
              strokeWidth="0.4"
              fill={bg.pattern === "dots" ? stroke : "none"}
              transform={`scale(${(mmToIn(1) * 96) / 1})`}
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id})`} />
      </svg>
    );
  }

  return null;
}

/* --------------------------------------------------------------- element */

function ElementView({
  el,
  ctx,
  selected,
  interactive,
  onSelect,
  onPointerDown,
  assetUrl,
  micr,
}: {
  el: TemplateElement;
  ctx: RenderContext;
  selected: boolean;
  interactive: boolean;
  onSelect?: (id: string) => void;
  onPointerDown?: (id: string, e: React.PointerEvent) => void;
  assetUrl: (id: number) => string;
  micr?: ReactNode;
}) {
  if (el.hidden && !interactive) return null;

  const box: CSSProperties = {
    position: "absolute",
    left: `${mmToIn(el.x)}in`,
    top: `${mmToIn(el.y)}in`,
    width: `${mmToIn(el.w)}in`,
    height: `${mmToIn(el.h)}in`,
    opacity: el.hidden ? 0.25 : 1,
    cursor: interactive ? (el.locked ? "not-allowed" : "move") : "default",
    outline: selected ? "1.5px solid #2563eb" : undefined,
    outlineOffset: "1px",
    boxSizing: "border-box",
  };

  const handlers = interactive
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          onSelect?.(el.id);
          if (!el.locked) onPointerDown?.(el.id, e);
        },
        "data-testid": `el-${el.id}`,
      }
    : {};

  /* The MICR line is placed by its own component at exact 1/8in positions;
     this element only reserves the space. */
  if (el.fieldKey === "micrLine") {
    return (
      <div style={{ ...box, pointerEvents: interactive ? "auto" : "none" }} {...handlers}>
        {micr}
      </div>
    );
  }

  if (el.type === "line") {
    return (
      <div style={box} {...handlers}>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            borderBottom: `${el.strokeWidth ?? 0.75}px ${el.dashed ? "dashed" : "solid"} ${el.strokeColor ?? INK}`,
          }}
        />
      </div>
    );
  }

  if (el.type === "rect") {
    return (
      <div
        style={{
          ...box,
          background: el.fillColor ?? "transparent",
          border: el.strokeWidth ? `${el.strokeWidth}px ${el.dashed ? "dashed" : "solid"} ${el.strokeColor ?? INK}` : undefined,
          borderRadius: el.radius ? `${mmToIn(el.radius)}in` : undefined,
          opacity: (el.opacity ?? 1) * (el.hidden ? 0.25 : 1),
        }}
        {...handlers}
      />
    );
  }

  if (el.type === "image") {
    return (
      <div style={box} {...handlers}>
        {el.assetId ? (
          <img
            src={assetUrl(el.assetId)}
            alt={el.name ?? "Template image"}
            style={{
              width: "100%",
              height: "100%",
              objectFit: (el.fit ?? "contain") === "stretch" ? "fill" : "contain",
              opacity: el.opacity ?? 1,
            }}
          />
        ) : interactive ? (
          <div
            style={{
              width: "100%",
              height: "100%",
              border: "1px dashed #b6c0cb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "6pt",
              color: FAINT,
            }}
          >
            No image
          </div>
        ) : null}
      </div>
    );
  }

  if (el.type === "microprint") {
    const phrase = (el.text ?? "").trim();
    if (!phrase) return interactive ? <div style={box} {...handlers} /> : null;
    return (
      <div
        style={{
          ...box,
          fontSize: `${Math.min(el.fontSize ?? 1.2, 2)}pt`,
          lineHeight: 1.6,
          color: el.color ?? INK,
          overflow: "hidden",
          wordBreak: "break-all",
          fontFamily: FONT_STACKS[el.fontFamily ?? "sans"],
        }}
        {...handlers}
      >
        {`${phrase} `.repeat(600)}
      </div>
    );
  }

  // field + text
  const lines = elementLines(el, ctx);
  const cap = resolveCaption(el, ctx);
  const sizePt = el.fontSize ?? 9;
  const pad = el.strokeWidth ? 1 : 0;
  /* Mirrors the PDF: the signature caption prints under its rule, because the
     space above the rule is where the signature itself goes. */
  const capBelow = el.fieldKey === "signature" && !!el.showRule;

  return (
    <div style={box} {...handlers}>
      {cap && (
        <div
          style={{
            position: "absolute",
            left: 0,
            ...(capBelow
              ? { top: "100%", marginTop: "0.03in" }
              : { bottom: "100%", marginBottom: "0.01in" }),
            fontSize: "5.5pt",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: FAINT,
            whiteSpace: "nowrap",
          }}
        >
          {cap}
        </div>
      )}
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: pad ? `${pad}px 2px` : undefined,
          border: el.strokeWidth ? `${el.strokeWidth}px solid ${el.strokeColor ?? INK}` : undefined,
          boxSizing: "border-box",
          fontFamily: FONT_STACKS[el.fontFamily ?? "sans"],
          fontSize: `${sizePt}pt`,
          fontWeight: el.bold ? 700 : 400,
          fontStyle: el.italic ? "italic" : "normal",
          textDecoration: el.underline ? "underline" : "none",
          textAlign: el.align ?? "left",
          color: el.color ?? INK,
          letterSpacing: el.letterSpacing ? `${el.letterSpacing}em` : undefined,
          lineHeight: 1.35,
          overflow: "hidden",
          whiteSpace: lines.length > 1 ? "pre-line" : "nowrap",
        }}
      >
        {lines.join("\n")}
      </div>
      {el.showRule && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            borderBottom: `0.75px solid ${el.fieldKey === "memo" ? FAINT : INK}`,
          }}
        />
      )}
    </div>
  );
}

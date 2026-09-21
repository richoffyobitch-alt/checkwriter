import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "wouter";
import { useApp } from "@/context/app-context";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Printer, ArrowLeft, ShieldAlert, AlertTriangle, FileDown, Ruler, Eye, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { MicrLine } from "@/components/micr-line";
import { buildMicrLayout, summarizeMicr, MICR_GEOM, CHECK_W_IN, CHECK_H_IN } from "@/lib/micr";
import { buildCheckPdf, downloadPdf, openPdfInNewTab } from "@/lib/check-pdf";
import { normalizeDesign } from "@shared/template";
import type { TemplateElement, TemplateBackground, TemplateDesign } from "@shared/template";

interface CheckData {
  id: number; checkNumber: number; checkDate: string; payeeName: string;
  amountCents: number; writtenAmount: string; memo: string | null; status: string; bankAccountId: number;
}
interface Business { legalName: string; dba: string | null; addressLine1: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null; defaultSigner: string | null; }
interface Account {
  id: number;
  bankName: string;
  nickname: string;
  accountMasked: string;
  bankValidationStatus: string;
  bankAddress: string | null;
  fractionNumber: string | null;
  defaultTemplateId: number | null;
}
interface TemplateRow {
  id: number;
  name: string;
  bankAccountId: number | null;
  isDefault: boolean;
  elements: TemplateElement[];
  background: TemplateBackground;
}
interface Reveal { routingNumber: string; accountNumber: string; accountLast4: string; }

/**
 * Fetches the bytes for every image a design references.
 *
 * Assets live behind an authenticated endpoint and are not bundled with the
 * template, so they have to be pulled at render time. Failures are skipped
 * rather than thrown: a missing logo should still produce a printable check
 * with a warning in the console, not block the payment.
 */
async function loadAssets(
  design: TemplateDesign | null,
): Promise<Record<number, { bytes: Uint8Array; mimeType: string }>> {
  if (!design) return {};
  const ids: number[] = [];
  for (const el of design.elements) {
    if (el.type === "image" && el.assetId && !ids.includes(el.assetId)) ids.push(el.assetId);
  }
  if (design.background.mode === "image" && design.background.assetId) {
    if (!ids.includes(design.background.assetId)) ids.push(design.background.assetId);
  }
  const out: Record<number, { bytes: Uint8Array; mimeType: string }> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await apiRequest("GET", `/api/assets/${id}`);
        const buf = await res.arrayBuffer();
        out[id] = {
          bytes: new Uint8Array(buf),
          mimeType: res.headers.get("content-type") ?? "image/png",
        };
      } catch (err) {
        console.error(`Template image ${id} could not be loaded for printing`, err);
      }
    }),
  );
  return out;
}

export default function PrintView() {
  const { checkId } = useParams<{ checkId: string }>();
  const { activeBusiness, stepUp, user } = useApp();
  const { toast } = useToast();
  const [pwd, setPwd] = useState("");
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [scale, setScale] = useState(100);
  const [testMode, setTestMode] = useState(false);
  const [showGuides, setShowGuides] = useState(false);
  const [pdfBusy, setPdfBusy] = useState<"preview" | "save" | null>(null);

  const checkQ = useQuery<CheckData>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/checks/${checkId}`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/checks/${checkId}`);
      return (await res.json()) as CheckData;
    },
    enabled: !!activeBusiness && !!checkId,
  });
  const accountQ = useQuery<Account[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/bank-accounts`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/bank-accounts`);
      return (await res.json()) as Account[];
    },
    enabled: !!activeBusiness,
  });

  /* The saved templates for this business. The check is printed from the one
     the bank account points at, falling back to the business default, so a
     layout arranged in the designer is what actually reaches paper. */
  const templatesQ = useQuery<TemplateRow[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/templates`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/templates`);
      return (await res.json()) as TemplateRow[];
    },
    enabled: !!activeBusiness,
  });

  const bankAccount = accountQ.data?.find((a) => a.id === checkQ.data?.bankAccountId) ?? accountQ.data?.[0];

  const activeTemplate = (() => {
    const rows = templatesQ.data ?? [];
    if (rows.length === 0) return null;
    if (bankAccount?.defaultTemplateId) {
      const pinned = rows.find((t) => t.id === bankAccount.defaultTemplateId);
      if (pinned) return pinned;
    }
    const forAccount = rows.find((t) => t.bankAccountId === bankAccount?.id);
    if (forAccount) return forAccount;
    return rows.find((t) => t.isDefault) ?? null;
  })();

  /* Shared with the designer so a template that predates the layered model
     prints with the same rules and amount box it shows on screen. */
  const design: TemplateDesign | null = activeTemplate
    ? normalizeDesign(activeTemplate.elements, activeTemplate.background)
    : null;

  const revealQ = useQuery<Reveal>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/checks/${checkId}/reveal`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/bank-accounts/${checkQ.data!.bankAccountId}/reveal`);
      return (await res.json()) as Reveal;
    },
    enabled: !!checkQ.data && !!user?.stepUpActive,
    retry: false,
  });

  const stepUpMut = async () => {
    try {
      await stepUp(pwd);
      setPwd("");
    } catch (e: any) {
      toast({ title: "Authentication failed", description: e.message, variant: "destructive" });
    }
  };

  const markPrinted = async (test: boolean) => {
    try {
      await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/checks/${checkId}/print`, { testMode: test });
      toast({ title: test ? "Test print recorded" : "Check marked printed" });
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    }
  };

  /**
   * Builds the PDF for the check currently on screen.
   *
   * The PDF is generated in-browser from explicit inch coordinates rather than
   * by asking the browser to print the DOM, because window.print() is a modal
   * and is blocked outright when the app runs inside an embedded frame — it
   * fails silently, with no dialog and no error. Generating the bytes ourselves
   * works in every context and pins the geometry down instead of leaving it to
   * the print driver's margins.
   */
  const makePdf = async () => {
    const c = checkQ.data!;
    return buildCheckPdf({
      check: {
        checkNumber: c.checkNumber,
        checkDate: c.checkDate,
        payeeName: c.payeeName,
        amountCents: c.amountCents,
        writtenAmount: c.writtenAmount,
        memo: c.memo,
      },
      business: activeBusiness as unknown as Business,
      bankName: bankAccount?.bankName ?? "",
      routing: revealQ.data?.routingNumber ?? "",
      account: revealQ.data?.accountNumber ?? "",
      checkWidthIn: CHECK_W_IN,
      checkHeightIn: CHECK_H_IN,
      testMode,
      includeMicr: true,
      design,
      extras: {
        fractionNumber: bankAccount?.fractionNumber ?? null,
        bankAddress: bankAccount?.bankAddress ?? null,
        accountNickname: bankAccount?.nickname ?? null,
        accountMasked: bankAccount?.accountMasked ?? null,
      },
      assets: await loadAssets(design),
    });
  };

  const pdfFilename = () => {
    const c = checkQ.data!;
    const payee = c.payeeName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40);
    return `Check-${c.checkNumber}-${payee || "payee"}.pdf`;
  };

  const previewPdf = async () => {
    setPdfBusy("preview");
    try {
      const bytes = await makePdf();
      // A new tab escapes the embedded frame, so the browser's own PDF viewer
      // (and its print button) becomes reachable. If the popup is blocked we
      // fall back to a download rather than appearing to do nothing.
      if (!openPdfInNewTab(bytes)) {
        downloadPdf(bytes, pdfFilename());
        toast({
          title: "Downloaded instead of opening",
          description: "Your browser blocked the new tab, so the PDF was saved to your downloads.",
        });
      }
    } catch (e: any) {
      toast({ title: "Could not build the PDF", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setPdfBusy(null);
    }
  };

  const savePdf = async () => {
    setPdfBusy("save");
    try {
      downloadPdf(await makePdf(), pdfFilename());
      toast({ title: "PDF saved", description: pdfFilename() });
    } catch (e: any) {
      toast({ title: "Could not build the PDF", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setPdfBusy(null);
    }
  };

  /**
   * Hands the check to the browser's print dialog, for driving a printer
   * directly rather than producing a file. The MICR line uses the bundled E-13B
   * face either way, so this path is no longer required for correct glyphs — it
   * is simply the shortest route to paper. It only works when the app is open in
   * its own tab or window, so we detect the blocked-modal case and say so.
   */
  const printDirect = () => {
    try {
      const before = Date.now();
      window.print();
      // A real dialog blocks this thread for as long as it is open. Returning
      // instantly means the browser refused to show one.
      if (Date.now() - before < 60) {
        toast({
          title: "Your browser blocked the print dialog",
          description: "This happens when the app is embedded in another page. Use \u201cPrint preview\u201d to open the PDF in its own tab, then print from there.",
        });
      }
    } catch (e: any) {
      toast({
        title: "Your browser blocked the print dialog",
        description: "Use \u201cPrint preview\u201d to open the PDF in its own tab, then print from there.",
      });
    }
  };

  const requireStepUp = () => {
    toast({ title: "Re-enter your password first", description: "Printing reveals full account and routing numbers." });
    document.getElementById("ppwd")?.focus();
  };

  if (!checkQ.data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const check = checkQ.data;
  const business = activeBusiness as unknown as Business;
  const stepUpNeeded = !user?.stepUpActive;
  const routing = revealQ.data?.routingNumber ?? "";
  const account = revealQ.data?.accountNumber ?? "";
  const accountRow = accountQ.data?.find((a) => (a as any).id === check.bankAccountId) ?? accountQ.data?.[0];

  const checkEl = (
    <CheckRender
      check={check}
      business={business}
      bankName={accountRow?.bankName ?? ""}
      routing={routing}
      account={account}
      testMode={testMode}
      offsetX={offsetX}
      offsetY={offsetY}
      scale={scale}
      showGuides={showGuides}
    />
  );

  const micrLayout = buildMicrLayout(
    { routing, account, checkNumber: check.checkNumber, checkWidthIn: CHECK_W_IN },
    CHECK_H_IN,
  );

  return (
    <div>
      <div className="no-print mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Print Check #{check.checkNumber}</h1>
          <p className="text-sm text-muted-foreground">{check.payeeName}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="ghost" size="sm"><Link href={`/checks/${checkId}`}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link></Button>
          <Button
            variant="outline"
            onClick={stepUpNeeded ? requireStepUp : previewPdf}
            disabled={pdfBusy !== null}
            data-testid="button-print-preview"
          >
            {pdfBusy === "preview" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Eye className="h-4 w-4 mr-1.5" />}
            Print preview
          </Button>
          <Button
            onClick={stepUpNeeded ? requireStepUp : savePdf}
            disabled={pdfBusy !== null}
            data-testid="button-print"
          >
            {pdfBusy === "save" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <FileDown className="h-4 w-4 mr-1.5" />}
            Save as PDF
          </Button>
        </div>
      </div>

      {/* Step-up gate */}
      {stepUpNeeded ? (
        <Card className="no-print max-w-md">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-amber-500" /> Re-authenticate to print</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Printing exposes full account and routing numbers on the MICR line. Re-enter your password to continue.</p>
            <div className="space-y-1.5">
              <Label htmlFor="ppwd">Password</Label>
              <Input id="ppwd" type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
            </div>
            <Button onClick={stepUpMut} disabled={!pwd}>Authenticate</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="no-print grid gap-4 lg:grid-cols-4 mb-4">
          <Card className="lg:col-span-1">
            <CardHeader><CardTitle className="text-sm">Calibration</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div><Label>Offset X (mm)</Label><Input type="number" value={offsetX} onChange={(e) => setOffsetX(parseInt(e.target.value) || 0)} /></div>
              <div><Label>Offset Y (mm)</Label><Input type="number" value={offsetY} onChange={(e) => setOffsetY(parseInt(e.target.value) || 0)} /></div>
              <div><Label>Scale (%)</Label><Input type="number" value={scale} onChange={(e) => setScale(parseInt(e.target.value) || 100)} /></div>
              <label className="flex items-center gap-2 pt-1"><input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} /> VOID / TEST ONLY</label>
              <label className="flex items-center gap-2" data-testid="toggle-micr-guides"><input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} /> Show MICR guides</label>
              <div className="flex flex-col gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={savePdf} disabled={pdfBusy !== null} data-testid="button-save-pdf">
                  <FileDown className="h-3.5 w-3.5 mr-1" /> Save as PDF
                </Button>
                <Button size="sm" variant="outline" onClick={printDirect} data-testid="button-print-direct">
                  <Printer className="h-3.5 w-3.5 mr-1" /> Print directly
                </Button>
                <Button size="sm" variant="outline" onClick={() => markPrinted(true)}>Save test print</Button>
                <Button size="sm" onClick={() => markPrinted(false)}>Mark printed</Button>
              </div>
            </CardContent>
          </Card>
          <Card className="lg:col-span-3">
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Ruler className="h-3.5 w-3.5 text-primary" /> MICR line geometry <span className="text-[10px] font-normal text-muted-foreground">ANSI X9.13 · 65 positions @ 1/8in · baseline 3/16in</span></CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                {summarizeMicr(micrLayout).map((f) => (
                  <div key={f.name} className="flex items-baseline justify-between gap-2 tnum">
                    <span className="text-muted-foreground">
                      {f.spec.label}
                      <span className="ml-1 text-[10px] opacity-60">pos {f.spec.from}–{f.spec.to}</span>
                    </span>
                    <span className={f.spec.bankPrinted ? "text-muted-foreground italic" : "font-medium text-foreground"}>
                      {f.spec.bankPrinted ? "blank · bank-printed" : `${f.occupied} · ${f.text.length} char`}
                    </span>
                  </div>
                ))}
              </div>
              {micrLayout.warnings.length > 0 && (
                <ul className="space-y-0.5 border-t border-border/60 pt-2 text-[11px] text-amber-400">
                  {micrLayout.warnings.map((w) => (
                    <li key={w} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /><span>{w}</span></li>
                  ))}
                </ul>
              )}
              <p className="border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
                Positions are numbered right-to-left from the trailing edge. Bottom {MICR_GEOM.clearBandHeight}in is the clear band and is kept free of other content. Confirm magnetic MICR toner, correct check stock, and printer calibration, and pass your bank's test deck before issuing live checks.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* On-screen preview */}
      {!stepUpNeeded && (
        <div className="no-print mb-2 space-y-1 text-xs text-muted-foreground">
          <p>Preview (actual size). {"\u201c"}Print preview{"\u201d"} opens the same check as a PDF in a new tab; {"\u201c"}Save as PDF{"\u201d"} downloads it.</p>
          <p>
            The MICR line carries genuine E-13B characters at their exact ANSI X9.13 positions in both the preview and the
            generated PDF. Magnetic readability additionally requires MICR toner and a calibrated printer, so load the correct
            stock, run a test print, and pass your bank{"\u2019"}s test deck before issuing live checks.
          </p>
        </div>
      )}
      <div className={stepUpNeeded ? "hidden" : "no-print flex justify-center bg-muted/30 p-4 rounded-lg overflow-auto"}>
        <div className="check-canvas relative bg-white shadow-lg">{checkEl}</div>
      </div>

      {/* Hidden print portal: only this renders when printing */}
      {typeof document !== "undefined" && !stepUpNeeded &&
        createPortal(
          <div className="print-portal">
            <div className="check-canvas" style={{ transform: `translate(${offsetX}mm, ${offsetY}mm) scale(${scale / 100})`, transformOrigin: "top left" }}>
              {checkEl}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

/**
 * The printed check. This is physical output, so it is deliberately laid out in
 * absolute inches on a paper-white surface and does NOT follow the app's dark
 * theme. Every coordinate is an inch measurement on an 8.5in x 3.5in canvas.
 *
 * The bottom 5/8in is the MICR clear band: nothing but the E-13B line is
 * allowed there, so all content above stops at 2.875in from the top.
 */
function CheckRender({ check, business, bankName, routing, account, testMode, showGuides = false }: {
  check: CheckData; business: Business; bankName: string; routing: string; account: string; testMode: boolean; offsetX?: number; offsetY?: number; scale?: number; showGuides?: boolean;
}) {
  const INK = "#101418";
  const SUBTLE = "#5b6773";
  const FAINT = "#8b97a3";
  const M = 0.35; // left margin, inches
  const amount = (check.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const label: CSSProperties = {
    fontSize: "5.5pt",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: FAINT,
  };
  const at = (leftIn: number, topIn: number): CSSProperties => ({
    position: "absolute",
    left: `${leftIn}in`,
    top: `${topIn}in`,
  });

  return (
    <div
      className="relative"
      style={{ width: `${CHECK_W_IN}in`, height: `${CHECK_H_IN}in`, background: "#fff", color: INK, fontFamily: "var(--font-sans)" }}
      data-testid="check-canvas-inner"
    >
      <div style={{ position: "absolute", inset: 0, border: "1px solid #d4dae0" }} />

      {/* ---- issuer block */}
      <div style={{ ...at(M, 0.22), fontSize: "9.5pt", fontWeight: 700, letterSpacing: "-0.01em" }}>{business.legalName}</div>
      {business.dba && <div style={{ ...at(M, 0.42), fontSize: "6.5pt", color: SUBTLE }}>dba {business.dba}</div>}
      <div style={{ ...at(M, business.dba ? 0.58 : 0.42), fontSize: "6.5pt", color: SUBTLE, lineHeight: 1.35 }}>
        {business.addressLine1}
        {business.city ? <><br />{business.city}, {business.state ?? ""} {business.zip ?? ""}</> : null}
        {business.phone ? <><br />{business.phone}</> : null}
      </div>

      {/* ---- check number + date, right side */}
      <div style={{ ...at(CHECK_W_IN - 1.1, 0.22), width: "0.75in", textAlign: "right", fontSize: "11pt", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
        {check.checkNumber}
      </div>
      <div style={{ ...at(CHECK_W_IN - 2.55, 0.62), width: "2.2in" }}>
        <div style={label}>Date</div>
        <div style={{ borderBottom: `1px solid ${INK}`, paddingBottom: "1px", fontSize: "8.5pt", fontVariantNumeric: "tabular-nums" }}>{check.checkDate}</div>
      </div>

      {/* ---- payee + numeric amount */}
      <div style={{ ...at(M, 1.08), width: "5.6in" }}>
        <div style={label}>Pay to the order of</div>
        <div style={{ borderBottom: `1px solid ${INK}`, paddingBottom: "2px", fontSize: "10pt", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {check.payeeName}
        </div>
      </div>
      <div style={{ ...at(6.15, 1.08), width: "2in" }}>
        <div style={label}>Amount</div>
        <div style={{ border: `1px solid ${INK}`, padding: "2px 6px", textAlign: "right", fontSize: "10pt", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          ${amount}
        </div>
      </div>

      {/* ---- written amount */}
      <div style={{ ...at(M, 1.62), width: `${CHECK_W_IN - M * 2}in` }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: "0.06in", borderBottom: `1px solid ${INK}`, paddingBottom: "2px" }}>
          <span style={{ fontSize: "8.5pt", flex: "1 1 auto", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{check.writtenAmount}</span>
          <span style={{ ...label, flex: "0 0 auto", paddingBottom: "0.5pt" }}>Dollars</span>
        </div>
      </div>

      {/* ---- memo + signature, both clear of the 5/8in band */}
      <div style={{ ...at(M, 2.12), width: "3.4in" }}>
        <div style={label}>Memo</div>
        <div style={{ borderBottom: `1px solid ${FAINT}`, minHeight: "0.16in", fontSize: "7.5pt", color: SUBTLE }}>{check.memo ?? ""}</div>
      </div>
      <div style={{ ...at(4.9, 2.12), width: "3.25in" }}>
        <div style={{ borderBottom: `1px solid ${INK}`, minHeight: "0.3in" }}>&nbsp;</div>
        <div style={{ ...label, marginTop: "2px" }}>{business.defaultSigner ? `Authorized signature \u00b7 ${business.defaultSigner}` : "Authorized signature"}</div>
      </div>
      <div style={{ ...at(M, 2.66), fontSize: "6pt", color: FAINT }}>{bankName}</div>

      {/* ---- MICR line: absolutely positioned SVG, exact per ANSI X9.13 */}
      <div style={{ position: "absolute", inset: 0 }}>
        <MicrLine
          routing={routing}
          account={account}
          checkNumber={check.checkNumber}
          checkWidthIn={CHECK_W_IN}
          checkHeightIn={CHECK_H_IN}
          showDiagnostics={showGuides}
          ink="#000"
        />
      </div>

      {testMode && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" style={{ transform: "rotate(-11deg)" }}>
          <span style={{ fontSize: "40pt", fontWeight: 900, color: "rgba(220,38,38,0.16)", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{"VOID \u00b7 TEST ONLY"}</span>
        </div>
      )}
    </div>
  );
}

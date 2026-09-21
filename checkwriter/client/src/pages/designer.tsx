/**
 * The check designer.
 *
 * A layered, WYSIWYG editor over the template model in shared/template.ts. The
 * canvas here is the same component the print preview uses, so what is
 * arranged is genuinely what prints — the designer and the PDF renderer read
 * one element list rather than each carrying its own layout.
 *
 * Two constraints are enforced rather than suggested, because getting them
 * wrong produces a check the bank can reject:
 *   - Nothing but the MICR line may enter the bottom 5/8in clear band.
 *   - The MICR line's own geometry is fixed by ANSI X9.13 and is not draggable.
 */
import { useState, useRef, useMemo, useEffect, type PointerEvent, type ChangeEvent } from "react";
import { useApp } from "@/context/app-context";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PageHeader, EmptyState } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  PenLine, Plus, Save, Lock, Unlock, Grid3x3, Type, Minus, Square, Image as ImageIcon,
  Eye, EyeOff, Trash2, ChevronUp, ChevronDown, Bold, Italic, Underline,
  AlignLeft, AlignCenter, AlignRight, ShieldCheck, Copy, AlertTriangle, Upload,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { CheckCanvas, CHECK_W_IN, CHECK_H_IN } from "@/components/check-canvas";
import { MicrLine } from "@/components/micr-line";
import {
  type TemplateElement, type TemplateDesign, type TemplateBackground, type FieldKey,
  type FontFamily, type ElementType,
  FIELD_LABELS, FIELD_KEYS, REQUIRED_FIELD_KEYS, defaultDesign, normalizeDesign, validateDesign,
  clampElement, nextZ, newElementId, isValidFractionPrefix,
  CANVAS_W_MM, CANVAS_H_MM, MICR_CLEAR_BAND_MM,
} from "@shared/template";
import { FONT_LABELS, FONT_PRINT_FACE, FONT_STACKS, elementLines, type RenderContext } from "@shared/render";

interface TemplateRow {
  id: number;
  name: string;
  layoutType: string;
  stockType: string;
  bankAccountId: number | null;
  elements: TemplateElement[];
  background: TemplateBackground;
  version: number;
  isDefault: boolean;
}

interface AssetRow {
  id: number;
  name: string;
  kind: string;
  mimeType: string;
  byteSize: number;
  rightsAttestedAt: number | null;
}

interface AccountRow {
  id: number;
  bankName: string;
  nickname: string;
  accountMasked: string;
  bankAddress: string | null;
  fractionNumber: string | null;
  fractionPrefix: string | null;
  routingValid: boolean;
}

const MM_PER_IN = 25.4;

/**
 * Placeholder values so the canvas shows a realistic check while designing.
 * Deliberately obvious stand-ins rather than a plausible payee and amount — a
 * layout proof should never be mistakable for a real payment instruction.
 */
function previewContext(account: AccountRow | undefined, businessName: string): RenderContext {
  return {
    check: {
      checkNumber: 1001,
      checkDate: new Date().toLocaleDateString("en-US"),
      payeeName: "Payee name appears here",
      amountCents: 123456,
      writtenAmount: "One thousand two hundred thirty-four and 56/100",
      memo: "Memo line",
    },
    business: {
      legalName: businessName || "Business legal name",
      dba: null,
      addressLine1: "Street address",
      city: "City",
      state: "ST",
      zip: "00000",
      phone: null,
      defaultSigner: null,
    },
    bank: {
      bankName: account?.bankName ?? "Bank name",
      bankAddress: account?.bankAddress ?? null,
      nickname: account?.nickname ?? null,
      accountMasked: account?.accountMasked ?? null,
      fractionNumber: account?.fractionNumber ?? null,
    },
  };
}

export default function Designer() {
  const { activeBusiness } = useApp();
  const { toast } = useToast();

  const [templateId, setTemplateId] = useState<number | null>(null);
  const [name, setName] = useState("Business check");
  const [layout, setLayout] = useState("business");
  const [stock, setStock] = useState("blank");
  const [accountId, setAccountId] = useState<string>("none");
  const [design, setDesign] = useState<TemplateDesign>(() => defaultDesign());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  /* A business check is 8.5in wide — about 816 CSS pixels — which is wider than
     the canvas column on most laptops. Defaulting to 100% silently clipped the
     right-hand third of the check (amount box, date, and the MICR band) with no
     scrollbar in view, so the layout looked wrong when it was merely cropped.
     Default to fitting the column and let the user opt into a fixed zoom. */
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  const [fitScale, setFitScale] = useState(1);
  const zoom = zoomMode === "fit" ? fitScale : zoomMode;
  /* A callback ref rather than useRef: the canvas mounts after the template
     query resolves, so a mount-time effect would measure a node that does not
     exist yet and silently leave the scale at 1. */
  const [canvasWrap, setCanvasWrap] = useState<HTMLDivElement | null>(null);
  const [dirty, setDirty] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingUpload = useRef<{ kind: string; target: "element" | "background" } | null>(null);

  const bid = activeBusiness?.id;

  const templatesQ = useQuery<TemplateRow[]>({
    queryKey: [`/api/businesses/${bid}/templates`],
    queryFn: async () => (await (await apiRequest("GET", `/api/businesses/${bid}/templates`)).json()) as TemplateRow[],
    enabled: !!bid,
  });
  const assetsQ = useQuery<AssetRow[]>({
    queryKey: [`/api/businesses/${bid}/assets`],
    queryFn: async () => (await (await apiRequest("GET", `/api/businesses/${bid}/assets`)).json()) as AssetRow[],
    enabled: !!bid,
  });
  const accountsQ = useQuery<AccountRow[]>({
    queryKey: [`/api/businesses/${bid}/bank-accounts`],
    queryFn: async () => (await (await apiRequest("GET", `/api/businesses/${bid}/bank-accounts`)).json()) as AccountRow[],
    enabled: !!bid,
  });

  const account = accountsQ.data?.find((a) => String(a.id) === accountId) ?? accountsQ.data?.[0];
  const ctx = useMemo(
    () => previewContext(account, (activeBusiness as any)?.legalName ?? ""),
    [account, activeBusiness],
  );

  const selected = design.elements.find((e) => e.id === selectedId) ?? null;
  const issues = useMemo(() => validateDesign(design), [design]);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  /* Load the first saved template once, so the designer opens on real work
     rather than a blank default the user then has to reconcile. */
  /* Measure the canvas column so "Fit width" tracks window and sidebar changes
     instead of being computed once at mount. */
  useEffect(() => {
    const el = canvasWrap;
    if (!el) return;
    const measure = () => {
      const usable = el.clientWidth;
      const natural = CHECK_W_IN * 96;
      if (usable > 0) setFitScale(Math.min(1.5, Math.max(0.35, usable / natural)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasWrap]);

  useEffect(() => {
    if (templateId !== null || !templatesQ.data || templatesQ.data.length === 0) return;
    const t = templatesQ.data.find((x) => x.isDefault) ?? templatesQ.data[0];
    loadTemplate(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templatesQ.data]);

  function loadTemplate(t: TemplateRow) {
    setTemplateId(t.id);
    setName(t.name);
    setLayout(t.layoutType);
    setStock(t.stockType);
    setAccountId(t.bankAccountId ? String(t.bankAccountId) : "none");
    /* A template saved before the layered model has plain elements with no id
       or z. Normalising here means an old template opens and edits cleanly
       instead of failing on a missing field. */
    setDesign(normalizeDesign(t.elements, t.background));
    setSelectedId(null);
    setDirty(false);
  }

  /* ------------------------------------------------------------ mutation */

  const saveMut = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        layoutType: layout,
        stockType: stock,
        bankAccountId: accountId === "none" ? null : Number(accountId),
        elements: design.elements,
        background: design.background,
        isDefault: true,
      };
      const res = templateId
        ? await apiRequest("PATCH", `/api/businesses/${bid}/templates/${templateId}`, body)
        : await apiRequest("POST", `/api/businesses/${bid}/templates`, body);
      return (await res.json()) as TemplateRow;
    },
    onSuccess: (t) => {
      setTemplateId(t.id);
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: [`/api/businesses/${bid}/templates`] });
      toast({ title: "Template saved", description: `Version ${t.version}. Checks printed from this account now use this layout.` });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const uploadMut = useMutation({
    mutationFn: async (payload: { name: string; kind: string; mimeType: string; data: string; rightsAttested: boolean }) => {
      const res = await apiRequest("POST", `/api/businesses/${bid}/assets`, payload);
      return (await res.json()) as AssetRow;
    },
    onSuccess: (a) => {
      queryClient.invalidateQueries({ queryKey: [`/api/businesses/${bid}/assets`] });
      const target = pendingUpload.current?.target;
      pendingUpload.current = null;
      if (target === "background") {
        patchBackground({ mode: "image", assetId: a.id, imageOpacity: 0.15 });
      } else if (selectedId) {
        patchSelected({ assetId: a.id });
      } else {
        addElement("image", { assetId: a.id, name: a.name });
      }
      toast({ title: "Image uploaded", description: a.name });
    },
    onError: (e: any) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  /* -------------------------------------------------------- element edits */

  function mutate(fn: (els: TemplateElement[]) => TemplateElement[]) {
    setDesign((d) => ({ ...d, elements: fn(d.elements) }));
    setDirty(true);
  }

  function patchSelected(patch: Partial<TemplateElement>) {
    if (!selectedId) return;
    mutate((els) => els.map((e) => (e.id === selectedId ? clampElement({ ...e, ...patch }) : e)));
  }

  function patchBackground(patch: Partial<TemplateBackground>) {
    setDesign((d) => ({ ...d, background: { ...d.background, ...patch } }));
    setDirty(true);
  }

  function addElement(type: ElementType, extra: Partial<TemplateElement> = {}) {
    const base: TemplateElement = {
      id: newElementId(type),
      type,
      x: 20,
      y: 20,
      w: type === "line" ? 50 : type === "rect" ? 40 : type === "image" ? 30 : 45,
      h: type === "line" ? 0.5 : type === "rect" ? 15 : type === "image" ? 15 : 6,
      z: nextZ(design.elements),
      locked: false,
      hidden: false,
      fontFamily: "sans",
      fontSize: type === "microprint" ? 1.2 : 9,
      align: "left",
      color: "#101418",
      strokeWidth: type === "line" || type === "rect" ? 0.75 : undefined,
      strokeColor: type === "line" || type === "rect" ? "#101418" : undefined,
      fillColor: type === "rect" ? null : undefined,
      text: type === "text" ? "New text" : type === "microprint" ? "AUTHORIZED SIGNATURE" : undefined,
      opacity: type === "image" ? 1 : undefined,
      fit: type === "image" ? "contain" : undefined,
      ...extra,
    };
    const el = clampElement(base);
    mutate((els) => [...els, el]);
    setSelectedId(el.id);
  }

  function addField(key: FieldKey) {
    if (design.elements.some((e) => e.fieldKey === key)) {
      toast({ title: "Already on the check", description: `${FIELD_LABELS[key]} is already placed.` });
      return;
    }
    addElement("field", { fieldKey: key, id: newElementId(key), name: FIELD_LABELS[key] });
  }

  function removeSelected() {
    if (!selected) return;
    /* A check cannot be issued without these, so removing one would produce a
       template that always fails validation. Hiding is offered instead. */
    if (selected.fieldKey && REQUIRED_FIELD_KEYS.includes(selected.fieldKey)) {
      toast({
        title: "Required field",
        description: `${FIELD_LABELS[selected.fieldKey]} is required on every check and cannot be deleted.`,
        variant: "destructive",
      });
      return;
    }
    if (selected.fieldKey === "micrLine") {
      toast({ title: "MICR line is fixed", description: "Hide it for pre-printed stock instead of deleting it.", variant: "destructive" });
      return;
    }
    mutate((els) => els.filter((e) => e.id !== selected.id));
    setSelectedId(null);
  }

  function duplicateSelected() {
    if (!selected) return;
    const copy = clampElement({
      ...selected,
      id: newElementId(selected.type),
      /* A duplicated data-bound field would print the same value twice, which
         is never what is wanted, so the copy becomes free text. */
      type: selected.type === "field" ? "text" : selected.type,
      fieldKey: undefined,
      text: selected.type === "field" ? (selected.name ?? "Copy") : selected.text,
      name: `${selected.name ?? selected.type} copy`,
      x: selected.x + 4,
      y: selected.y + 4,
      z: nextZ(design.elements),
    });
    mutate((els) => [...els, copy]);
    setSelectedId(copy.id);
  }

  function reorder(dir: -1 | 1) {
    if (!selected) return;
    const sorted = [...design.elements].sort((a, b) => a.z - b.z);
    const i = sorted.findIndex((e) => e.id === selected.id);
    const j = i + dir;
    if (j < 0 || j >= sorted.length) return;
    const a = sorted[i], b = sorted[j];
    mutate((els) => els.map((e) => (e.id === a.id ? { ...e, z: b.z } : e.id === b.id ? { ...e, z: a.z } : e)));
  }

  /* -------------------------------------------------------------- dragging */

  function onPointerDown(id: string, e: PointerEvent) {
    const el = design.elements.find((x) => x.id === id);
    if (!el || el.locked) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pxPerMm = rect.width / CANVAS_W_MM;
    dragRef.current = {
      id,
      dx: (e.clientX - rect.left) / pxPerMm - el.x,
      dy: (e.clientY - rect.top) / pxPerMm - el.y,
    };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pxPerMm = rect.width / CANVAS_W_MM;
    const x = (e.clientX - rect.left) / pxPerMm - drag.dx;
    const y = (e.clientY - rect.top) / pxPerMm - drag.dy;
    mutate((els) => els.map((el) => (el.id === drag.id ? clampElement({ ...el, x, y }) : el)));
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  /* ---------------------------------------------------------- file upload */

  function pickFile(kind: string, target: "element" | "background") {
    pendingUpload.current = { kind, target };
    fileRef.current?.click();
  }

  async function onFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const kind = pendingUpload.current?.kind ?? "business_logo";

    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast({ title: "Unsupported image", description: "Use a PNG, JPEG, or WebP file.", variant: "destructive" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Image too large", description: `${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB.`, variant: "destructive" });
      return;
    }
    /* A bank's logo is the bank's trademark. Placing it on a check is only
       lawful with the bank's written authorization, so this is an explicit
       confirmation rather than a silent upload. */
    let rightsAttested = false;
    if (kind === "bank_logo") {
      rightsAttested = window.confirm(
        "A bank logo is the bank's trademark.\n\nConfirm you have written authorization from the bank to place its logo on your checks. This confirmation is recorded in the audit log.",
      );
      if (!rightsAttested) return;
    }

    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Could not read the file"));
      r.readAsDataURL(file);
    });

    uploadMut.mutate({ name: file.name.slice(0, 120), kind, mimeType: file.type, data, rightsAttested });
  }

  /* ------------------------------------------------------------- rendering */

  if (!activeBusiness) {
    return <EmptyState icon={PenLine} title="No business selected" description="Choose a business to design its check templates." />;
  }

  const unplaced = FIELD_KEYS.filter((k) => !design.elements.some((e) => e.fieldKey === k));
  const imageAssets = assetsQ.data ?? [];

  return (
    <div onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onFileChosen} data-testid="input-asset-file" />

      <PageHeader
        title="Check designer"
        description="Arrange the check face. This layout is what prints."
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowGrid((v) => !v)} data-testid="button-toggle-grid">
              <Grid3x3 className="mr-1.5 h-4 w-4" />
              {showGrid ? "Hide guides" : "Show guides"}
            </Button>
            <Button
              size="sm"
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending || errors.length > 0}
              data-testid="button-save-template"
            >
              <Save className="mr-1.5 h-4 w-4" />
              {saveMut.isPending ? "Saving…" : templateId ? "Save version" : "Save template"}
            </Button>
          </div>
        }
      />

      {errors.length > 0 && (
        <Card className="mb-4 border-destructive/50" data-testid="card-design-errors">
          <CardContent className="flex gap-3 pt-4 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">This layout cannot be saved yet</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                {errors.map((i, n) => <li key={n}>{i.message}</li>)}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      {warnings.length > 0 && (
        <Card className="mb-4 border-amber-500/40" data-testid="card-design-warnings">
          <CardContent className="flex gap-3 pt-4 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <p className="font-medium text-amber-600 dark:text-amber-400">
                This may not pass your bank's validation
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                You can save and print this design anyway. These are things banks
                commonly object to — only your bank, looking at a printed sample,
                can say for certain.
              </p>
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-muted-foreground">
                {warnings.map((i, n) => <li key={n}>{i.message}</li>)}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
        {/* -------------------------------------------------- left: layers */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Add to check</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" onClick={() => addElement("text")} data-testid="button-add-text">
                  <Type className="mr-1.5 h-3.5 w-3.5" />Text
                </Button>
                <Button variant="outline" size="sm" onClick={() => addElement("line")} data-testid="button-add-line">
                  <Minus className="mr-1.5 h-3.5 w-3.5" />Line
                </Button>
                <Button variant="outline" size="sm" onClick={() => addElement("rect")} data-testid="button-add-rect">
                  <Square className="mr-1.5 h-3.5 w-3.5" />Box
                </Button>
                <Button variant="outline" size="sm" onClick={() => addElement("image")} data-testid="button-add-image">
                  <ImageIcon className="mr-1.5 h-3.5 w-3.5" />Image
                </Button>
              </div>
              <Button variant="outline" size="sm" className="w-full" onClick={() => addElement("microprint")} data-testid="button-add-microprint">
                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />Microprint line
              </Button>

              {unplaced.length > 0 && (
                <div className="pt-1">
                  <Label className="text-xs text-muted-foreground">Add a data field</Label>
                  <Select value="" onValueChange={(v) => addField(v as FieldKey)}>
                    <SelectTrigger className="mt-1 h-8" data-testid="select-add-field">
                      <SelectValue placeholder="Choose a field…" />
                    </SelectTrigger>
                    <SelectContent>
                      {unplaced.map((k) => <SelectItem key={k} value={k}>{FIELD_LABELS[k]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Layers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 p-2">
              {[...design.elements].sort((a, b) => b.z - a.z).map((el) => (
                <button
                  key={el.id}
                  onClick={() => setSelectedId(el.id)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover-elevate ${
                    selectedId === el.id ? "bg-accent" : ""
                  }`}
                  data-testid={`layer-${el.id}`}
                >
                  <LayerIcon type={el.type} />
                  <span className={`flex-1 truncate ${el.hidden ? "text-muted-foreground line-through" : ""}`}>
                    {el.name ?? (el.fieldKey ? FIELD_LABELS[el.fieldKey] : el.text || el.type)}
                  </span>
                  {el.locked && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={el.hidden ? "Show layer" : "Hide layer"}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      mutate((els) => els.map((x) => (x.id === el.id ? { ...x, hidden: !x.hidden } : x)));
                    }}
                    onKeyDown={(ev) => { if (ev.key === "Enter") ev.currentTarget.click(); }}
                    data-testid={`layer-visibility-${el.id}`}
                  >
                    {el.hidden ? <EyeOff className="h-3 w-3 text-muted-foreground" /> : <Eye className="h-3 w-3 text-muted-foreground" />}
                  </span>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* --------------------------------------------------- middle: canvas */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div ref={setCanvasWrap} className="overflow-auto">
              <div
                ref={canvasRef}
                style={{
                  width: `${CHECK_W_IN * zoom}in`,
                  height: `${CHECK_H_IN * zoom}in`,
                  position: "relative",
                }}
                onPointerDown={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}
                data-testid="designer-canvas"
              >
                <div style={{ transform: `scale(${zoom})`, transformOrigin: "top left", position: "absolute", inset: 0 }}>
                  <CheckCanvas
                    design={design}
                    ctx={ctx}
                    showGuides={showGrid}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onElementPointerDown={onPointerDown}
                    micr={<MicrLineProof />}
                  />
                </div>
              </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Template</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Name</Label>
                <Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} className="mt-1 h-8" data-testid="input-template-name" />
              </div>
              <div>
                <Label className="text-xs">Zoom</Label>
                <Select
                  value={zoomMode === "fit" ? "fit" : String(zoomMode)}
                  onValueChange={(v) => setZoomMode(v === "fit" ? "fit" : Number(v))}
                >
                  <SelectTrigger className="mt-1 h-8" data-testid="select-zoom"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fit">Fit width ({Math.round(fitScale * 100)}%)</SelectItem>
                    {[0.75, 1, 1.25, 1.5, 2].map((z) => <SelectItem key={z} value={String(z)}>{Math.round(z * 100)}%</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Layout</Label>
                <Select value={layout} onValueChange={(v) => { setLayout(v); setDirty(true); }}>
                  <SelectTrigger className="mt-1 h-8" data-testid="select-layout"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="business">Business</SelectItem>
                    <SelectItem value="voucher">Voucher</SelectItem>
                    <SelectItem value="wallet">Wallet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Stock</Label>
                <Select value={stock} onValueChange={(v) => { setStock(v); setDirty(true); }}>
                  <SelectTrigger className="mt-1 h-8" data-testid="select-stock"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="blank">Blank stock</SelectItem>
                    <SelectItem value="preprinted">Pre-printed stock</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs">Bank account this template prints for</Label>
                <Select value={accountId} onValueChange={(v) => { setAccountId(v); setDirty(true); }}>
                  <SelectTrigger className="mt-1 h-8" data-testid="select-template-account"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Any account</SelectItem>
                    {(accountsQ.data ?? []).map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>{a.nickname} · {a.bankName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {account && !account.fractionNumber && (
                  <p className="mt-1.5 text-xs text-muted-foreground" data-testid="text-fraction-missing">
                    No fraction number yet for {account.nickname}. The routing number gives two of its three parts; the
                    city/state prefix is assigned by the ABA and has to come from your bank. Add it under Bank accounts.
                  </p>
                )}
                {account?.fractionNumber && (
                  <p className="mt-1.5 text-xs text-muted-foreground" data-testid="text-fraction-value">
                    Fraction number: <span className="font-mono">{account.fractionNumber}</span>
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ------------------------------------------------ right: inspector */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{selected ? "Selected element" : "Nothing selected"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!selected && <p className="text-xs text-muted-foreground">Click an element on the check, or a layer on the left, to edit it.</p>}
              {selected && (
                <Inspector
                  el={selected}
                  assets={imageAssets}
                  ctx={ctx}
                  onPatch={patchSelected}
                  onDelete={removeSelected}
                  onDuplicate={duplicateSelected}
                  onReorder={reorder}
                  onUpload={(kind) => pickFile(kind, "element")}
                />
              )}
            </CardContent>
          </Card>

          <BackgroundPanel
            bg={design.background}
            assets={imageAssets}
            onPatch={patchBackground}
            onUpload={() => pickFile("background", "background")}
          />
        </div>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Backgrounds and patterns here are ordinary styling. They are not reproductions of any bank's security stock and
        carry no anti-copy claim — microprint is the only genuine copy-resistant feature offered, and it works because it
        is real small type. Do not use this tool to imitate a bank's official forms or place a bank's logo without its
        written authorization. Confirm any layout with your bank before ordering stock or issuing checks.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- inspector */

/* Both the on-screen canvas and the PDF clip text to its box, so an element
   that is too narrow loses characters at print time with nothing on screen to
   say so. Measure the same string the renderer will draw and warn, because a
   quietly truncated payee name on issued stock is a reprint. */
function measureTextMm(line: string, el: TemplateElement): number {
  if (typeof document === "undefined") return 0;
  const c = (measureTextMm as { _c?: HTMLCanvasElement })._c ??
    ((measureTextMm as { _c?: HTMLCanvasElement })._c = document.createElement("canvas"));
  const g = c.getContext("2d");
  if (!g) return 0;
  const sizePt = el.fontSize ?? 9;
  const weight = el.bold ? "700" : "400";
  g.font = `${weight} ${sizePt}pt ${FONT_STACKS[el.fontFamily ?? "sans"]}`;
  // 1pt = 1/72in, and 1in = 25.4mm.
  return (g.measureText(line).width / 96) * 25.4;
}

function Inspector({
  el, assets, ctx, onPatch, onDelete, onDuplicate, onReorder, onUpload,
}: {
  el: TemplateElement;
  assets: AssetRow[];
  ctx: RenderContext;
  onPatch: (p: Partial<TemplateElement>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onReorder: (d: -1 | 1) => void;
  onUpload: (kind: string) => void;
}) {
  const isText = el.type === "text" || el.type === "field" || el.type === "microprint";
  const isShape = el.type === "line" || el.type === "rect";
  const micrLocked = el.fieldKey === "micrLine";

  /* Widest line this element will actually draw, using the preview values for
     data fields — those are representative, not the final check, so the warning
     is phrased as "may clip" rather than a certainty. */
  const overflow = useMemo(() => {
    if (!isText || el.type === "microprint" || micrLocked) return null;
    const lines = elementLines(el, ctx);
    if (!lines.length) return null;
    const widest = Math.max(...lines.map((l) => measureTextMm(l, el)));
    const pad = el.strokeWidth ? 2 : 0;
    const usable = el.w - pad;
    return widest > usable ? { widest, usable } : null;
  }, [el, ctx, isText, micrLocked]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => onReorder(1)} title="Bring forward" data-testid="button-layer-up">
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => onReorder(-1)} title="Send backward" data-testid="button-layer-down">
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => onPatch({ locked: !el.locked })} title={el.locked ? "Unlock" : "Lock"} data-testid="button-toggle-lock">
          {el.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-2" onClick={onDuplicate} title="Duplicate" data-testid="button-duplicate-element">
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="sm" className="ml-auto h-7 px-2 text-destructive" onClick={onDelete} title="Delete" data-testid="button-delete-element">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {micrLocked && (
        <p className="rounded bg-muted p-2 text-xs text-muted-foreground">
          The MICR line's position is fixed by ANSI X9.13 — 65 positions at 1/8in pitch on a 3/16in baseline. Moving it
          would make the check unreadable to the bank, so only its visibility can be changed here.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <NumField label="X (mm)" value={el.x} onChange={(v) => onPatch({ x: v })} disabled={el.locked} testId="input-el-x" />
        <NumField label="Y (mm)" value={el.y} onChange={(v) => onPatch({ y: v })} disabled={el.locked} testId="input-el-y" />
        <NumField label="Width (mm)" value={el.w} onChange={(v) => onPatch({ w: v })} disabled={el.locked} testId="input-el-w" />
        <NumField label="Height (mm)" value={el.h} onChange={(v) => onPatch({ h: v })} disabled={el.locked} testId="input-el-h" />
      </div>

      {(el.type === "text" || el.type === "microprint") && (
        <div>
          <Label className="text-xs">Text</Label>
          <Textarea
            value={el.text ?? ""}
            onChange={(e) => onPatch({ text: e.target.value })}
            rows={2}
            className="mt-1 text-xs"
            data-testid="input-el-text"
          />
        </div>
      )}

      {el.type === "field" && (
        <div>
          <Label className="text-xs">Field</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {el.fieldKey ? FIELD_LABELS[el.fieldKey] : "Unbound"} — the value comes from the check record, so it cannot be typed here.
          </p>
        </div>
      )}

      {isText && !micrLocked && (
        <>
          <Separator />
          <div className="grid grid-cols-[minmax(0,1fr)_84px] gap-2">
            <div className="min-w-0">
              <Label className="text-xs">Font</Label>
              <Select value={el.fontFamily ?? "sans"} onValueChange={(v) => onPatch({ fontFamily: v as FontFamily })}>
                <SelectTrigger className="mt-1 h-8" data-testid="select-el-font"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(FONT_LABELS) as FontFamily[]).map((f) => (
                    <SelectItem key={f} value={f}>{FONT_LABELS[f]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Prints as {FONT_PRINT_FACE[el.fontFamily ?? "sans"]}
              </p>
            </div>
            <NumField label="Size (pt)" value={el.fontSize ?? 9} step={0.5} onChange={(v) => onPatch({ fontSize: v })} testId="input-el-size" />
          </div>

          {overflow && (
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400"
              data-testid="warn-el-overflow"
            >
              <p>
                This text needs about {overflow.widest.toFixed(0)} mm but the box is {overflow.usable.toFixed(0)} mm.
                It will be cut off when printed.
              </p>
              <button
                type="button"
                className="mt-1.5 rounded border border-amber-500/50 px-2 py-0.5 font-medium hover:bg-amber-500/15"
                onClick={() => onPatch({ w: Math.min(CANVAS_W_MM - el.x, Math.ceil(overflow.widest) + (el.strokeWidth ? 3 : 1)) })}
                data-testid="button-el-fit-width"
              >
                Widen the box to fit
              </button>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <ToggleBtn active={!!el.bold} onClick={() => onPatch({ bold: !el.bold })} label="Bold" testId="button-el-bold"><Bold className="h-3.5 w-3.5" /></ToggleBtn>
            <ToggleBtn active={!!el.italic} onClick={() => onPatch({ italic: !el.italic })} label="Italic" testId="button-el-italic"><Italic className="h-3.5 w-3.5" /></ToggleBtn>
            <ToggleBtn active={!!el.underline} onClick={() => onPatch({ underline: !el.underline })} label="Underline" testId="button-el-underline"><Underline className="h-3.5 w-3.5" /></ToggleBtn>
            <span className="mx-1 h-5 w-px bg-border" />
            <ToggleBtn active={el.align === "left"} onClick={() => onPatch({ align: "left" })} label="Align left" testId="button-el-align-left"><AlignLeft className="h-3.5 w-3.5" /></ToggleBtn>
            <ToggleBtn active={el.align === "center"} onClick={() => onPatch({ align: "center" })} label="Align centre" testId="button-el-align-center"><AlignCenter className="h-3.5 w-3.5" /></ToggleBtn>
            <ToggleBtn active={el.align === "right"} onClick={() => onPatch({ align: "right" })} label="Align right" testId="button-el-align-right"><AlignRight className="h-3.5 w-3.5" /></ToggleBtn>
          </div>

          {el.italic && (
            <p className="text-xs text-muted-foreground">
              Italic shows on screen but prints upright: the PDF uses the standard Helvetica, Times, and Courier faces,
              and faking a slant would break the width measurements used for alignment and truncation.
            </p>
          )}

          <ColorField label="Colour" value={el.color ?? "#101418"} onChange={(v) => onPatch({ color: v })} testId="input-el-color" />
          <div className="flex items-center">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={!!el.uppercase} onCheckedChange={(v) => onPatch({ uppercase: v })} data-testid="switch-el-uppercase" />
              Uppercase
            </label>
          </div>

          {el.type !== "microprint" && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={!!el.showCaption} onCheckedChange={(v) => onPatch({ showCaption: v })} data-testid="switch-el-caption" />
                Show caption above
              </label>
              {el.showCaption && (
                <Input
                  value={el.caption ?? ""}
                  placeholder="Default caption"
                  onChange={(e) => onPatch({ caption: e.target.value })}
                  className="h-8 text-xs"
                  data-testid="input-el-caption"
                />
              )}
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={!!el.showRule} onCheckedChange={(v) => onPatch({ showRule: v })} data-testid="switch-el-rule" />
                Ruled line underneath
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={!!el.strokeWidth}
                  onCheckedChange={(v) => onPatch({ strokeWidth: v ? 0.75 : undefined, strokeColor: v ? "#101418" : undefined })}
                  data-testid="switch-el-box"
                />
                Box outline
              </label>
            </div>
          )}

          {el.type === "microprint" && (
            <p className="rounded bg-muted p-2 text-xs text-muted-foreground">
              Microprint repeats this text at roughly 1pt. It survives an original print run but breaks up when
              photocopied or scanned, so a duplicate shows a broken line. Print a test page and inspect it under
              magnification before relying on it, and confirm with your bank that it does not interfere with imaging.
            </p>
          )}
        </>
      )}

      {isShape && (
        <>
          <Separator />
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Stroke (pt)" value={el.strokeWidth ?? 0.75} step={0.25} onChange={(v) => onPatch({ strokeWidth: v })} testId="input-el-stroke" />
            <ColorField label="Stroke colour" value={el.strokeColor ?? "#101418"} onChange={(v) => onPatch({ strokeColor: v })} testId="input-el-stroke-color" />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={!!el.dashed} onCheckedChange={(v) => onPatch({ dashed: v })} data-testid="switch-el-dashed" />
            Dashed
          </label>
          {el.type === "rect" && (
            <>
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={!!el.fillColor}
                  onCheckedChange={(v) => onPatch({ fillColor: v ? "#eef2f6" : null })}
                  data-testid="switch-el-fill"
                />
                Filled
              </label>
              {el.fillColor && (
                <ColorField label="Fill colour" value={el.fillColor} onChange={(v) => onPatch({ fillColor: v })} testId="input-el-fill-color" />
              )}
              <NumField label="Corner radius (mm)" value={el.radius ?? 0} step={0.5} onChange={(v) => onPatch({ radius: v })} testId="input-el-radius" />
            </>
          )}
        </>
      )}

      {el.type === "image" && (
        <>
          <Separator />
          <div>
            <Label className="text-xs">Image</Label>
            <Select value={el.assetId ? String(el.assetId) : "none"} onValueChange={(v) => onPatch({ assetId: v === "none" ? null : Number(v) })}>
              <SelectTrigger className="mt-1 h-8" data-testid="select-el-asset"><SelectValue placeholder="Choose…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {assets.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onUpload("business_logo")} data-testid="button-upload-business-logo">
              <Upload className="mr-1.5 h-3.5 w-3.5" />Business logo
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onUpload("bank_logo")} data-testid="button-upload-bank-logo">
              <Upload className="mr-1.5 h-3.5 w-3.5" />Bank logo
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            A bank logo needs written authorization from that bank. You will be asked to confirm you hold it, and the
            confirmation is written to the audit log.
          </p>
          <NumField label="Opacity" value={el.opacity ?? 1} step={0.05} min={0} max={1} onChange={(v) => onPatch({ opacity: v })} testId="input-el-opacity" />
          <div>
            <Label className="text-xs">Fit</Label>
            <Select value={el.fit ?? "contain"} onValueChange={(v) => onPatch({ fit: v as "contain" | "stretch" })}>
              <SelectTrigger className="mt-1 h-8" data-testid="select-el-fit"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="contain">Fit inside (keeps proportions)</SelectItem>
                <SelectItem value="stretch">Stretch to box</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ background */

function BackgroundPanel({
  bg, assets, onPatch, onUpload,
}: {
  bg: TemplateBackground;
  assets: AssetRow[];
  onPatch: (p: Partial<TemplateBackground>) => void;
  onUpload: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-sm">Background</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <Select value={bg.mode} onValueChange={(v) => onPatch({ mode: v as TemplateBackground["mode"] })}>
          <SelectTrigger className="h-8" data-testid="select-bg-mode"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None (white)</SelectItem>
            <SelectItem value="color">Solid colour</SelectItem>
            <SelectItem value="pattern">Pattern</SelectItem>
            <SelectItem value="image">Image</SelectItem>
          </SelectContent>
        </Select>

        {bg.mode === "color" && (
          <ColorField label="Colour" value={bg.color ?? "#f5f7fa"} onChange={(v) => onPatch({ color: v })} testId="input-bg-color" />
        )}

        {bg.mode === "pattern" && (
          <>
            <div>
              <Label className="text-xs">Pattern</Label>
              <Select value={bg.pattern ?? "lines"} onValueChange={(v) => onPatch({ pattern: v as any })}>
                <SelectTrigger className="mt-1 h-8" data-testid="select-bg-pattern"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lines">Horizontal lines</SelectItem>
                  <SelectItem value="grid">Grid</SelectItem>
                  <SelectItem value="diagonal">Diagonal</SelectItem>
                  <SelectItem value="dots">Dots</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ColorField label="Pattern colour" value={bg.patternColor ?? "#d4dae0"} onChange={(v) => onPatch({ patternColor: v })} testId="input-bg-pattern-color" />
            <NumField label="Opacity" value={bg.patternOpacity ?? 0.35} step={0.05} min={0} max={1} onChange={(v) => onPatch({ patternOpacity: v })} testId="input-bg-pattern-opacity" />
            <NumField label="Spacing (mm)" value={bg.patternScale ?? 4} step={0.5} min={1} onChange={(v) => onPatch({ patternScale: v })} testId="input-bg-pattern-scale" />
          </>
        )}

        {bg.mode === "image" && (
          <>
            <Select value={bg.assetId ? String(bg.assetId) : "none"} onValueChange={(v) => onPatch({ assetId: v === "none" ? null : Number(v) })}>
              <SelectTrigger className="h-8" data-testid="select-bg-asset"><SelectValue placeholder="Choose…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {assets.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-8 w-full text-xs" onClick={onUpload} data-testid="button-upload-background">
              <Upload className="mr-1.5 h-3.5 w-3.5" />Upload background image
            </Button>
            <NumField
              label="Visibility"
              value={bg.imageOpacity ?? 0.15}
              step={0.05}
              min={0}
              max={1}
              onChange={(v) => onPatch({ imageOpacity: v })}
              testId="input-bg-image-opacity"
            />
            {(bg.imageOpacity ?? 0.15) > 0.35 && (
              <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="text-bg-opacity-warning">
                Above about 35% the payee and amount get hard to read, and the bank's imaging can struggle with the
                check. Keep a background picture faint.
              </p>
            )}
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Decorative only. These are not security backgrounds and make no anti-copy claim.
        </p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------- small bits */

function LayerIcon({ type }: { type: ElementType }) {
  const cls = "h-3 w-3 shrink-0 text-muted-foreground";
  if (type === "line") return <Minus className={cls} />;
  if (type === "rect") return <Square className={cls} />;
  if (type === "image") return <ImageIcon className={cls} />;
  if (type === "microprint") return <ShieldCheck className={cls} />;
  if (type === "text") return <Type className={cls} />;
  return <PenLine className={cls} />;
}

function NumField({
  label, value, onChange, step = 0.5, min, max, disabled, testId,
}: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number; disabled?: boolean; testId?: string;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="mt-1 h-8 text-xs"
        data-testid={testId}
      />
    </div>
  );
}

function ColorField({
  label, value, onChange, testId,
}: { label: string; value: string; onChange: (v: string) => void; testId?: string }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-9 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          data-testid={testId}
          aria-label={label}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 min-w-[7.5ch] flex-1 font-mono text-xs"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function ToggleBtn({
  active, onClick, label, testId, children,
}: { active: boolean; onClick: () => void; label: string; testId?: string; children: React.ReactNode }) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="sm"
      className="h-7 w-7 p-0"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
    >
      {children}
    </Button>
  );
}

/**
 * A representative MICR line for the designer canvas.
 *
 * Deliberately not a real account's MICR data: the designer is a layout tool,
 * and rendering live routing and account digits into a screen that is often
 * shared or screenshotted would leak them for no design benefit.
 */
function MicrLineProof() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'MICR E13B', monospace",
        fontSize: "12pt",
        color: "#101418",
        letterSpacing: "0.02em",
        pointerEvents: "none",
      }}
      data-testid="micr-proof"
    >
      MICR line — placed automatically at print time
    </div>
  );
}

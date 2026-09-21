import { useState, useEffect, useMemo } from "react";
import { Link } from "wouter";
import { useApp } from "@/context/app-context";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, Field } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Plus, Trash2, Save, ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { prettyStatus } from "@/lib/utils";
import { amountToWords, todayISO, dollarsToCents } from "@shared/domain";

interface Account { id: number; nickname: string; bankName: string; status: string; nextCheckNumber: number; accountMasked: string; bankValidationStatus: string; }
interface Payee { id: number; name: string; defaultMemo: string | null; category: string | null; }

interface LineItem { category?: string; project?: string; invoiceRef?: string; description?: string; amount: string }

export default function CheckCreate() {
  const { activeBusiness } = useApp();
  const { toast } = useToast();

  const accountsQ = useQuery<Account[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/bank-accounts`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/bank-accounts`);
      return (await res.json()) as Account[];
    },
    enabled: !!activeBusiness,
  });
  const payeesQ = useQuery<Payee[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/payees`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/payees`);
      return (await res.json()) as Payee[];
    },
    enabled: !!activeBusiness,
  });

  const accounts = accountsQ.data ?? [];
  const payableAccounts = accounts.filter((a) => a.status === "active");
  const payees = payeesQ.data ?? [];

  const [bankAccountId, setBankAccountId] = useState<string>("");
  const [payeeId, setPayeeId] = useState<string>("");
  const [payeeName, setPayeeName] = useState("");
  const [checkDate, setCheckDate] = useState(todayISO());
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  useEffect(() => {
    if (!bankAccountId && payableAccounts.length) setBankAccountId(String(payableAccounts[0].id));
  }, [payableAccounts, bankAccountId]);

  const selectedAccount = accounts.find((a) => String(a.id) === bankAccountId);

  // check-number validation (live)
  const checkNumber = selectedAccount?.nextCheckNumber ?? 0;
  const validateQ = useQuery<{ warnings: string[]; valid: boolean }>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/check-number-validate/${bankAccountId}/${checkNumber}`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/check-number-validate/${bankAccountId}/${checkNumber}`);
      return (await res.json()) as any;
    },
    enabled: !!activeBusiness && !!bankAccountId && checkNumber > 0,
  });

  const writtenAmount = useMemo(() => {
    if (!amount) return "";
    try {
      const cents = dollarsToCents(amount);
      return amountToWords(cents / 100);
    } catch {
      return "Invalid amount";
    }
  }, [amount]);

  const onSelectPayee = (id: string) => {
    setPayeeId(id);
    const p = payees.find((x) => String(x.id) === id);
    if (p) {
      setPayeeName(p.name);
      if (p.defaultMemo && !memo) setMemo(p.defaultMemo);
    }
  };

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/checks`, {
        bankAccountId: parseInt(bankAccountId),
        checkDate,
        payeeId: payeeId ? parseInt(payeeId) : null,
        payeeName,
        amount,
        memo: memo || null,
        lineItems: lineItems.filter((l) => l.amount || l.description),
        status: "draft",
      });
      return (await res.json()) as { id: number };
    },
    onSuccess: (check) => {
      toast({ title: "Draft check saved", description: `Check #${check.id} created` });
      window.location.hash = `#/checks/${check.id}`;
    },
    onError: (e: Error) => toast({ title: "Could not create check", description: e.message, variant: "destructive" }),
  });

  const lineTotal = lineItems.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);

  return (
    <div>
      <PageHeader
        title="Create Check"
        description="Draft checks are fully editable until issued or printed."
        action={<Button asChild variant="ghost" size="sm"><Link href="/checks"><ArrowLeft className="h-4 w-4 mr-1" /> Register</Link></Button>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Check details</CardTitle></CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Bank account">
                  <Select value={bankAccountId} onValueChange={setBankAccountId}>
                    <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                    <SelectContent>
                      {payableAccounts.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>{a.nickname} · {a.accountMasked}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Check number" hint={selectedAccount ? `Next in sequence for this account` : undefined}>
                  <Input value={checkNumber || ""} readOnly className="font-mono bg-muted/40" />
                </Field>
              </div>
              {selectedAccount?.bankValidationStatus !== "validated" && selectedAccount && (
                <div className="flex items-center gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Bank validation: <strong className="font-semibold">{prettyStatus(selectedAccount.bankValidationStatus)}</strong>. Run test prints and confirm with your bank before live issuance.
                  </span>
                </div>
              )}
              {validateQ.data && validateQ.data.warnings.length > 0 && (
                <div className="flex items-center gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" /> {validateQ.data.warnings.join(" · ")}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Payee">
                  <Select value={payeeId} onValueChange={onSelectPayee}>
                    <SelectTrigger><SelectValue placeholder="Select payee" /></SelectTrigger>
                    <SelectContent>
                      {payees.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Check date"><Input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} /></Field>
              </div>
              {payeeId && (
                <Field label="Payee name (printed)"><Input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} /></Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Amount" hint={writtenAmount ? null : "e.g. 1234.56"}>
                  <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" data-testid="input-amount" />
                </Field>
                <Field label="Memo"><Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" /></Field>
              </div>
              {writtenAmount && (
                <div className="rounded-md bg-muted/50 p-2.5 text-sm">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Written amount</div>
                  <div className="font-medium">{writtenAmount}</div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Line items (optional)</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setLineItems([...lineItems, { amount: "" }])}><Plus className="h-3.5 w-3.5 mr-1" /> Add line</Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {lineItems.length === 0 && <p className="text-xs text-muted-foreground">No line items. Add detail for accounting categories, projects, or invoices.</p>}
              {lineItems.map((li, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-3"><Label className="text-[10px]">Category</Label><Input value={li.category ?? ""} onChange={(e) => updateLine(i, { category: e.target.value })} className="text-xs h-8" /></div>
                  <div className="col-span-3"><Label className="text-[10px]">Project</Label><Input value={li.project ?? ""} onChange={(e) => updateLine(i, { project: e.target.value })} className="text-xs h-8" /></div>
                  <div className="col-span-3"><Label className="text-[10px]">Invoice #</Label><Input value={li.invoiceRef ?? ""} onChange={(e) => updateLine(i, { invoiceRef: e.target.value })} className="text-xs h-8" /></div>
                  <div className="col-span-2"><Label className="text-[10px]">Amount</Label><Input value={li.amount} onChange={(e) => updateLine(i, { amount: e.target.value })} inputMode="decimal" className="text-xs h-8" /></div>
                  <div className="col-span-1"><Button size="sm" variant="ghost" onClick={() => setLineItems(lineItems.filter((_, idx) => idx !== i))}><Trash2 className="h-3.5 w-3.5" /></Button></div>
                </div>
              ))}
              {lineItems.length > 0 && (
                <div className="flex justify-between text-xs pt-1 border-t border-border">
                  <span className="text-muted-foreground">Line total</span>
                  <span className="font-medium tabular-nums">${lineTotal.toFixed(2)}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Summary / actions */}
        <div>
          <Card className="sticky top-4">
            <CardHeader><CardTitle className="text-base">Summary</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Business</span><span className="font-medium text-right truncate ml-2">{activeBusiness?.legalName}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Account</span><span className="font-medium">{selectedAccount?.nickname ?? "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Check #</span><span className="font-mono font-medium">#{checkNumber}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold tabular-nums text-base">{amount ? `$${parseFloat(amount).toFixed(2)}` : "$0.00"}</span></div>
              <Button className="w-full" size="lg" onClick={() => createMut.mutate()} disabled={!bankAccountId || !payeeName || !amount || createMut.isPending} data-testid="button-save-draft">
                <Save className="h-4 w-4 mr-1.5" /> Save draft
              </Button>
              <p className="text-[11px] text-muted-foreground text-center">Saved as draft — edit freely until printed or issued.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );

  function updateLine(i: number, patch: Partial<LineItem>) {
    setLineItems(lineItems.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
}

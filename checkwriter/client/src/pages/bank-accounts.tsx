import { useState } from "react";
import { useApp } from "@/context/app-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, Field, EmptyState } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Banknote, Plus, Eye, ShieldAlert, AlertTriangle, CheckCircle2, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { isValidRoutingNumber } from "@shared/domain";
import { deriveFractionParts, isValidFractionPrefix, fractionFromRouting } from "@shared/template";

interface Account {
  id: number;
  bankName: string;
  nickname: string;
  accountLast4: string | null;
  accountMasked: string;
  checkStartingNumber: number;
  nextCheckNumber: number;
  accountType: string;
  bankAddress: string | null;
  fractionPrefix: string | null;
  fractionNumber: string | null;
  status: string;
  bankValidationStatus: string;
  positivePayEnabled: boolean;
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  inactive: "bg-muted text-muted-foreground",
  archived: "bg-slate-500/15 text-slate-500",
  restricted: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

export default function BankAccounts() {
  const { activeBusiness, stepUp, user } = useApp();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [revealFor, setRevealFor] = useState<number | null>(null);
  const [stepUpPwd, setStepUpPwd] = useState("");
  const [form, setForm] = useState<Partial<Account> & { routingNumber?: string; accountNumber?: string }>({});

  const query = useQuery<Account[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/bank-accounts`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/bank-accounts`);
      return (await res.json()) as Account[];
    },
    enabled: !!activeBusiness,
  });

  const createMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/bank-accounts`, data);
      return (await res.json()) as Account;
    },
    onSuccess: () => {
      toast({ title: "Bank account added" });
      setOpen(false);
      setForm({});
      query.refetch();
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const revealMut = useMutation({
    mutationFn: async ({ id, pwd }: { id: number; pwd: string }) => {
      await stepUp(pwd);
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/bank-accounts/${id}/reveal`);
      return (await res.json()) as { routingNumber: string; accountNumber: string; accountLast4: string };
    },
    onSuccess: (data) => {
      toast({
        title: "Account details revealed",
        description: `Routing: ${data.routingNumber} · Account: ${data.accountNumber}`,
      });
      setRevealFor(null);
      setStepUpPwd("");
    },
    onError: (e: Error) => toast({ title: "Reveal failed", description: e.message, variant: "destructive" }),
  });

  const accounts = query.data ?? [];
  const routingOk = form.routingNumber ? isValidRoutingNumber(form.routingNumber) : true;
  const derivedFraction = form.routingNumber ? deriveFractionParts(form.routingNumber) : null;
  const fractionPreview =
    form.routingNumber && form.fractionPrefix && isValidFractionPrefix(form.fractionPrefix)
      ? fractionFromRouting(form.routingNumber, form.fractionPrefix)
      : null;

  return (
    <div>
      <PageHeader
        title="Bank Accounts"
        description="Account and routing numbers are encrypted at rest and masked in all views."
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button data-testid="button-add-account"><Plus className="h-4 w-4 mr-1.5" /> Add account</Button></DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>Add bank account</DialogTitle></DialogHeader>
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Bank name"><Input value={form.bankName ?? ""} onChange={(e) => setForm({ ...form, bankName: e.target.value })} placeholder="First National Bank" /></Field>
                  <Field label="Nickname"><Input value={form.nickname ?? ""} onChange={(e) => setForm({ ...form, nickname: e.target.value })} placeholder="Operations Checking" /></Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Routing number" hint={form.routingNumber && !routingOk ? "Failed ABA checksum" : undefined}>
                    <Input value={form.routingNumber ?? ""} onChange={(e) => setForm({ ...form, routingNumber: e.target.value })} placeholder="9 digits" inputMode="numeric" />
                  </Field>
                  <Field label="Account number">
                    <Input value={form.accountNumber ?? ""} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} placeholder="Encrypted at rest" />
                  </Field>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Start check #"><Input type="number" value={form.checkStartingNumber ?? 1001} onChange={(e) => setForm({ ...form, checkStartingNumber: parseInt(e.target.value) })} /></Field>
                  <Field label="Account type">
                    <Select value={form.accountType ?? "checking"} onValueChange={(v) => setForm({ ...form, accountType: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="checking">Checking</SelectItem><SelectItem value="savings">Savings</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <Field label="Positive Pay">
                    <Select value={form.positivePayEnabled ? "on" : "off"} onValueChange={(v) => setForm({ ...form, positivePayEnabled: v === "on" })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="off">Off</SelectItem><SelectItem value="on">On</SelectItem></SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="Fraction prefix"
                    hint={
                      form.fractionPrefix && !isValidFractionPrefix(form.fractionPrefix)
                        ? "Must be 1-99"
                        : "City/state code from your bank"
                    }
                  >
                    <Input
                      value={form.fractionPrefix ?? ""}
                      onChange={(e) => setForm({ ...form, fractionPrefix: e.target.value })}
                      placeholder="e.g. 11"
                      inputMode="numeric"
                      maxLength={2}
                      data-testid="input-fraction-prefix"
                    />
                  </Field>
                  <Field label="Fraction number">
                    <div className="flex h-10 items-center rounded-md border border-input bg-muted/40 px-3 font-mono text-sm" data-testid="text-fraction-preview">
                      {fractionPreview ?? <span className="font-sans text-xs text-muted-foreground">Needs routing number + prefix</span>}
                    </div>
                  </Field>
                </div>
                {/* The fraction is PP-YYYY/XXXX. YYYY and XXXX come straight out of
                    the routing number, but PP is a geographic code the ABA assigns
                    and is not encoded in the routing number at all — so it is asked
                    for rather than guessed. A wrong fraction on printed stock is a
                    reprint. */}
                {derivedFraction && (
                  <p className="text-xs text-muted-foreground" data-testid="text-fraction-derived">
                    From this routing number: institution <span className="font-mono">{derivedFraction.institution}</span>,
                    routing symbol <span className="font-mono">{derivedFraction.routingSymbol}</span>. The prefix is assigned
                    by the ABA and must come from your bank or an existing check.
                  </p>
                )}
                {form.routingNumber && !routingOk && (
                  <div className="flex items-center gap-2 rounded-md bg-rose-500/10 p-2 text-xs text-rose-600 dark:text-rose-400">
                    <AlertTriangle className="h-3.5 w-3.5" /> Routing number failed the ABA checksum. It will be saved but flagged for review.
                  </div>
                )}
              </div>
              <DialogFooter>
                <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                <Button onClick={() => createMut.mutate(form)} disabled={!form.bankName || !form.nickname || createMut.isPending}>Add account</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      {accounts.length === 0 ? (
        <EmptyState icon={Banknote} title="No bank accounts" description="Add a bank account to start writing checks." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {accounts.map((a) => (
            <Card key={a.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      {a.nickname}
                      {a.status === "restricted" && <Lock className="h-3.5 w-3.5 text-rose-500" />}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">{a.bankName} · {a.accountType}</p>
                  </div>
                  <Badge className={STATUS_TONE[a.status] ?? ""}>{a.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="text-sm space-y-3">
                <div className="grid grid-cols-2 gap-y-2 gap-x-3 text-xs">
                  <div>
                    <div className="text-muted-foreground">Account</div>
                    <div className="font-mono font-medium">{a.accountMasked}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Next check #</div>
                    <div className="font-mono font-medium">{a.nextCheckNumber}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Positive Pay</div>
                    <div>{a.positivePayEnabled ? "Enabled" : "Off"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Validation</div>
                    <div className="flex items-center gap-1">
                      {a.bankValidationStatus === "validated" ? (
                        <><CheckCircle2 className="h-3 w-3 text-emerald-500" /> Validated</>
                      ) : (
                        <><AlertTriangle className="h-3 w-3 text-amber-500" /> {a.bankValidationStatus.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => setRevealFor(a.id)} data-testid={`button-reveal-${a.id}`}>
                    <Eye className="h-3.5 w-3.5 mr-1" /> Reveal
                  </Button>
                  {a.status !== "active" && (
                    <span className="text-xs text-rose-500 flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5" /> Issuance blocked ({a.status})</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Reveal (step-up) dialog */}
      <Dialog open={revealFor != null} onOpenChange={(o) => !o && setRevealFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-amber-500" /> Reveal account details</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Revealing full account and routing numbers is a high-risk action. Re-enter your password to continue. The action is recorded in the security log.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="pwd">Password</Label>
              <Input id="pwd" type="password" value={stepUpPwd} onChange={(e) => setStepUpPwd(e.target.value)} data-testid="input-reveal-pwd" />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button onClick={() => revealFor && revealMut.mutate({ id: revealFor, pwd: stepUpPwd })} disabled={!stepUpPwd || revealMut.isPending} data-testid="button-confirm-reveal">
              {revealMut.isPending ? "Verifying…" : "Reveal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

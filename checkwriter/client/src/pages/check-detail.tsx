import { useState } from "react";
import { Link, useParams } from "wouter";
import { useApp } from "@/context/app-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, StatusBadge, Money, Time, Field } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Printer, CheckCircle2, PenLine, Copy, Ban, RefreshCw, Repeat, BookCheck, Edit, History } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, amountFlagFor } from "@shared/domain";

interface CheckDetail {
  id: number;
  checkNumber: number;
  checkDate: string;
  payeeName: string;
  payeeId: number | null;
  amountCents: number;
  writtenAmount: string;
  memo: string | null;
  status: string;
  preparerId: number | null;
  approverId: number | null;
  signerId: number | null;
  printedAt: number | null;
  issuedAt: number | null;
  clearedAt: number | null;
  voidedAt: number | null;
  voidReason: string | null;
  reprintCount: number;
  issuedSnapshot: string | null;
  createdAt: number;
  lineItems: Array<{ id: number; category: string | null; project: string | null; invoiceRef: string | null; description: string | null; amountCents: number }>;
  bankAccountId: number;
}

export default function CheckDetail() {
  const { id } = useParams<{ id: string }>();
  const { activeBusiness, user } = useApp();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reasonOpen, setReasonOpen] = useState<null | "void" | "reprint" | "replace">(null);
  const [reason, setReason] = useState("");

  const query = useQuery<CheckDetail>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/checks/${id}`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/checks/${id}`);
      return (await res.json()) as CheckDetail;
    },
    enabled: !!activeBusiness && !!id,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: [`/api/businesses/${activeBusiness?.id}/checks/${id}`] });

  const action = useMutation({
    mutationFn: async (path: string, body?: any) => {
      const res = await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/checks/${id}/${path}`, body);
      return (await res.json()) as CheckDetail;
    },
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: [`/api/businesses/${activeBusiness?.id}/checks`] });
      toast({ title: "Done" });
    },
    onError: (e: Error) => toast({ title: "Action failed", description: e.message, variant: "destructive" }),
  });

  const reasonAction = useMutation({
    mutationFn: async ({ path }: { path: "void" | "reprint" | "replace" }) => {
      const res = await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/checks/${id}/${path}`, { reason });
      return (await res.json()) as any;
    },
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: [`/api/businesses/${activeBusiness?.id}/checks`] });
      setReasonOpen(null);
      setReason("");
      toast({ title: "Action completed" });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  if (!query.data) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const c = query.data;
  const role = activeBusiness?.role ?? "viewer";
  const amountFlag = amountFlagFor(c.amountCents);
  const snapshot = c.issuedSnapshot ? JSON.parse(c.issuedSnapshot) : null;

  const canApprove = ["admin", "owner", "approver"].includes(role);
  const canSign = ["admin", "owner", "signer"].includes(role);
  const canPrint = ["admin", "owner", "bookkeeper"].includes(role);

  return (
    <div>
      <PageHeader
        title={`Check #${c.checkNumber}`}
        description={`${c.payeeName} · ${c.checkDate}`}
        action={<Button asChild variant="ghost" size="sm"><Link href="/checks"><ArrowLeft className="h-4 w-4 mr-1" /> Register</Link></Button>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Check</CardTitle>
              <StatusBadge status={c.status} />
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
                <Detail label="Payee" value={c.payeeName} />
                <Detail label="Check number" value={`#${c.checkNumber}`} mono />
                <Detail label="Check date" value={c.checkDate} />
                <Detail label="Amount" value={formatCurrency(c.amountCents)} bold />
                <Detail label="Memo" value={c.memo ?? "—"} />
                <Detail label="Reprints" value={String(c.reprintCount)} />
              </div>
              <div className="rounded-md bg-muted/40 p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Written amount</div>
                <div className="text-sm font-medium">{c.writtenAmount}</div>
              </div>
              {c.voidReason && (
                <div className="rounded-md bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-400">
                  <span className="font-medium">Voided:</span> {c.voidReason} <span className="text-xs">· <Time ts={c.voidedAt} /></span>
                </div>
              )}
            </CardContent>
          </Card>

          {c.lineItems.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Line items</CardTitle></CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground border-b border-border"><th className="px-4 py-2 font-medium">Category</th><th className="px-4 py-2 font-medium">Project</th><th className="px-4 py-2 font-medium">Invoice</th><th className="px-4 py-2 font-medium text-right">Amount</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {c.lineItems.map((li) => (
                      <tr key={li.id}><td className="px-4 py-2">{li.category ?? "—"}</td><td className="px-4 py-2">{li.project ?? "—"}</td><td className="px-4 py-2">{li.invoiceRef ?? "—"}</td><td className="px-4 py-2 text-right tabular-nums">{formatCurrency(li.amountCents)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Lifecycle actions */}
          <Card>
            <CardHeader><CardTitle className="text-base">Lifecycle actions</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm"><Link href={`/print/${c.id}`}><Printer className="h-4 w-4 mr-1.5" /> Print / preview</Link></Button>
                {c.status === "draft" && canApprove && <Button variant="outline" size="sm" onClick={() => action.mutate("approve")}><CheckCircle2 className="h-4 w-4 mr-1.5" /> Approve</Button>}
                {c.status === "approved" && canSign && <Button variant="outline" size="sm" onClick={() => action.mutate("sign")}><PenLine className="h-4 w-4 mr-1.5" /> Sign / ready</Button>}
                {(c.status === "ready_to_print" || c.status === "approved") && canPrint && <Button variant="outline" size="sm" onClick={() => action.mutate("print")}><Printer className="h-4 w-4 mr-1.5" /> Mark printed</Button>}
                {canPrint && <Button variant="outline" size="sm" onClick={() => setReasonOpen("reprint")}><RefreshCw className="h-4 w-4 mr-1.5" /> Reprint</Button>}
                <Button variant="outline" size="sm" onClick={() => setReasonOpen("replace")}><Repeat className="h-4 w-4 mr-1.5" /> Replace</Button>
                {c.status !== "voided" && c.status !== "replaced" && <Button variant="outline" size="sm" className="text-rose-400" onClick={() => setReasonOpen("void")}><Ban className="h-4 w-4 mr-1.5" /> Void</Button>}
                {c.status !== "cleared" && c.status !== "voided" && <Button variant="outline" size="sm" onClick={() => action.mutate("clear")}><BookCheck className="h-4 w-4 mr-1.5" /> Mark cleared</Button>}
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="capitalize">{role}</Badge>
                {/* Advisory size band only — it does not gate approval. */}
                {amountFlag === "high" ? (
                  <Badge className="bg-rose-500/15 text-rose-400" title="Advisory flag for a large payment. It does not require an extra approver.">High value (&ge;$10k)</Badge>
                ) : amountFlag === "elevated" ? (
                  <Badge className="bg-amber-500/15 text-amber-400" title="Advisory flag. It does not require an extra approver.">Elevated (&ge;$1k)</Badge>
                ) : (
                  <Badge className="bg-emerald-500/15 text-emerald-400">Standard (&lt;$1k)</Badge>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Timeline + snapshot */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4" /> Lifecycle</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-2">
              <Timeline label="Created" ts={c.createdAt} done />
              {c.approverId && <Timeline label="Approved" done />}
              {c.signerId && <Timeline label="Signed" done />}
              {c.printedAt && <Timeline label="Printed" ts={c.printedAt} done />}
              {c.issuedAt && <Timeline label="Issued" ts={c.issuedAt} done />}
              {c.clearedAt && <Timeline label="Cleared" ts={c.clearedAt} done />}
              {c.voidedAt && <Timeline label="Voided" ts={c.voidedAt} done />}
            </CardContent>
          </Card>

          {snapshot && (
            <Card>
              <CardHeader><CardTitle className="text-base">Issued snapshot</CardTitle></CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1">
                <p>Immutable record captured at print time.</p>
                <div className="rounded bg-muted/40 p-2 font-mono break-all">{JSON.stringify(snapshot)}</div>
                {snapshot.testMode && <Badge className="mt-1 bg-rose-500/15 text-rose-400">VOID / TEST</Badge>}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Reason dialog */}
      <Dialog open={reasonOpen != null} onOpenChange={(o) => !o && setReasonOpen(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="capitalize">{reasonOpen} check</DialogTitle></DialogHeader>
          <Field label={`Reason for ${reasonOpen}`} hint="Recorded in the audit log.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Misprint, wrong payee, damaged stock" rows={3} />
          </Field>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button onClick={() => reasonOpen && reasonAction.mutate({ path: reasonOpen })} disabled={!reason.trim() || reasonAction.isPending} className={reasonOpen === "void" ? "bg-rose-600 text-white hover:bg-rose-700" : ""}>Confirm {reasonOpen}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Detail({ label, value, mono, bold }: { label: string; value: string; mono?: boolean; bold?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`${mono ? "font-mono" : ""} ${bold ? "font-bold" : "font-medium"}`}>{value}</div>
    </div>
  );
}

function Timeline({ label, ts, done }: { label: string; ts?: number | null; done?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`h-2 w-2 rounded-full ${done ? "bg-primary" : "bg-muted-foreground/30"}`} />
      <span className={done ? "font-medium" : "text-muted-foreground"}>{label}</span>
      {ts && <span className="text-xs text-muted-foreground ml-auto"><Time ts={ts} /></span>}
    </div>
  );
}

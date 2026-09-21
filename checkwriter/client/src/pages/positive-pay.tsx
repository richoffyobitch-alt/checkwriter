import { useState } from "react";
import { useApp } from "@/context/app-context";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, Field, EmptyState, Money, Time } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShieldCheck, Download, ShieldAlert, FileText } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@shared/domain";

interface Account { id: number; nickname: string; accountMasked: string; positivePayEnabled: boolean; }
interface Export { id: number; format: string; itemCount: number; totalCents: number; fileChecksum: string; exportedAt: number; }

export default function PositivePay() {
  const { activeBusiness, stepUp, user } = useApp();
  const { toast } = useToast();
  const [accountId, setAccountId] = useState("");
  const [pwd, setPwd] = useState("");
  const [csv, setCsv] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ itemCount: number; totalCents: number; checksum: string } | null>(null);

  const accountsQ = useQuery<Account[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/bank-accounts`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/bank-accounts`);
      return (await res.json()) as Account[];
    },
    enabled: !!activeBusiness,
  });
  const exportsQ = useQuery<Export[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/positive-pay`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/positive-pay`);
      return (await res.json()) as Export[];
    },
    enabled: !!activeBusiness,
  });

  const generateMut = useMutation({
    mutationFn: async () => {
      if (!user?.stepUpActive) await stepUp(pwd);
      const res = await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/positive-pay/${accountId}`);
      return (await res.json()) as { csv: string; itemCount: number; totalCents: number; checksum: string };
    },
    onSuccess: (data) => {
      setCsv(data.csv);
      setMeta({ itemCount: data.itemCount, totalCents: data.totalCents, checksum: data.checksum });
      setPwd("");
      exportsQ.refetch();
      toast({ title: "Positive Pay file generated" });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const downloadCsv = () => {
    if (!csv) return;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `positive-pay-${accountId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const accounts = accountsQ.data ?? [];

  return (
    <div>
      <PageHeader title="Positive Pay" description="Generate bank-positive-pay files for issued checks. Requires step-up authentication." />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Generate file</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Bank account">
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.nickname} · {a.accountMasked}{a.positivePayEnabled ? "" : " (PP off)"}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            {!user?.stepUpActive && (
              <div className="rounded-md bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5" /> Re-enter your password to authorize the export.
              </div>
            )}
            {!user?.stepUpActive && (
              <div className="space-y-1.5">
                <Label htmlFor="pppwd">Password</Label>
                <Input id="pppwd" type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
              </div>
            )}
            <Button onClick={() => generateMut.mutate()} disabled={!accountId || generateMut.isPending || (!user?.stepUpActive && !pwd)} data-testid="button-generate-pp">
              <Download className="h-4 w-4 mr-1.5" /> Generate & preview
            </Button>
            {csv && (
              <div className="space-y-2 mt-2">
                <div className="rounded-md bg-muted/40 p-2.5 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">Items</span><span className="font-medium">{meta?.itemCount}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Total</span><span className="font-medium">{formatCurrency(meta?.totalCents ?? 0)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Checksum</span><span className="font-mono text-[10px]">{meta?.checksum.slice(0, 16)}…</span></div>
                </div>
                <pre className="max-h-48 overflow-auto rounded-md border border-border bg-background p-2 text-[10px] font-mono whitespace-pre">{csv}</pre>
                <Button onClick={downloadCsv} size="sm" variant="outline"><FileText className="h-3.5 w-3.5 mr-1" /> Download CSV</Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Files are not sent directly to any bank. Configure an approved secure integration separately.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Export history</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-2">
            {(exportsQ.data ?? []).length === 0 && <p className="text-xs text-muted-foreground">No exports yet.</p>}
            {(exportsQ.data ?? []).map((e) => (
              <div key={e.id} className="rounded-md border border-border p-2 text-xs">
                <div className="flex justify-between font-medium"><span>{e.format.toUpperCase()}</span><Money cents={e.totalCents} /></div>
                <div className="text-muted-foreground">{e.itemCount} checks · <Time ts={e.exportedAt} /></div>
                <div className="font-mono text-[9px] text-muted-foreground truncate">{e.fileChecksum.slice(0, 20)}…</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

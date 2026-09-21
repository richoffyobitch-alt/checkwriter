import { useState } from "react";
import { useApp } from "@/context/app-context";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, StatusBadge, Money, EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ListChecks, AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";

interface Account { id: number; nickname: string; bankName: string; accountMasked: string; }
interface Recon {
  startNumber: number; nextNumber: number; issuedCount: number;
  gaps: string[]; voided: string[];
  sequence: { number: number; status: string; payee: string; amountCents: number }[];
}

export default function Reconciliation() {
  const { activeBusiness } = useApp();
  const [accountId, setAccountId] = useState<number | null>(null);

  const accountsQ = useQuery<Account[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/bank-accounts`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/bank-accounts`);
      return (await res.json()) as Account[];
    },
    enabled: !!activeBusiness,
  });

  const selectedId = accountId ?? accountsQ.data?.[0]?.id ?? null;

  const reconQ = useQuery<Recon>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/check-number-reconciliation`, selectedId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/check-number-reconciliation/${selectedId}`);
      return (await res.json()) as Recon;
    },
    enabled: !!activeBusiness && selectedId != null,
  });

  if (!activeBusiness) return null;
  const recon = reconQ.data;
  const clean = recon && recon.gaps.length === 0;

  return (
    <div>
      <PageHeader title="Check Number Reconciliation" description="Verify sequence integrity, detect gaps and voids per bank account." />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={String(selectedId)} onValueChange={(v) => setAccountId(Number(v))}>
          <SelectTrigger className="w-72"><SelectValue placeholder="Select account" /></SelectTrigger>
          <SelectContent>
            {(accountsQ.data ?? []).map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>{a.nickname} · {a.accountMasked}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="text-xs text-muted-foreground">Starting #{recon?.startNumber ?? "—"} · Next #{recon?.nextNumber ?? "—"}</div>
      </div>

      {!recon ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Issued checks" value={String(recon.issuedCount)} icon={ListChecks} />
            <Stat label="Gaps in sequence" value={String(recon.gaps.length)} icon={MinusCircle} tone={recon.gaps.length ? "warn" : "ok"} />
            <Stat label="Voided numbers" value={String(recon.voided.length)} icon={AlertTriangle} tone={recon.voided.length ? "warn" : "ok"} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                {clean ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
                Sequence integrity
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              {recon.gaps.length === 0 ? (
                <p className="text-muted-foreground">No gaps detected — the check-number sequence is continuous.</p>
              ) : (
                <p className="text-amber-400">Gaps detected (skipped or missing numbers): <span className="font-medium">{recon.gaps.join(", ")}</span></p>
              )}
              {recon.voided.length > 0 && (
                <p className="text-muted-foreground">Voided check numbers (retired, not reusable): <span className="font-medium">{recon.voided.join(", ")}</span></p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Sequence detail</CardTitle></CardHeader>
            <CardContent>
              {recon.sequence.length === 0 ? (
                <EmptyState title="No checks issued" description="Checks issued from this account will appear here." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b">
                        <th className="py-2 pr-4 font-medium">Check #</th>
                        <th className="py-2 pr-4 font-medium">Payee</th>
                        <th className="py-2 pr-4 font-medium">Amount</th>
                        <th className="py-2 pr-4 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recon.sequence.map((s) => (
                        <tr key={s.number} className="border-b last:border-0">
                          <td className="py-2 pr-4 font-mono">#{s.number}</td>
                          <td className="py-2 pr-4">{s.payee}</td>
                          <td className="py-2 pr-4"><Money cents={s.amountCents} /></td>
                          <td className="py-2 pr-4"><StatusBadge status={s.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, icon: Icon, tone }: { label: string; value: string; icon: any; tone?: "warn" | "ok" }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <div className={`flex h-9 w-9 items-center justify-center rounded-md ${tone === "warn" ? "bg-amber-500/10 text-amber-400" : tone === "ok" ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <div className="text-xl font-bold tracking-tight">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

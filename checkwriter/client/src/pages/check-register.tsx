import { useState, useMemo } from "react";
import { Link, useSearch } from "wouter";
import { useApp } from "@/context/app-context";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, StatusBadge, Money, EmptyState, CHECK_STATUS_LIST } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Plus, Search } from "lucide-react";
import { formatCurrency } from "@shared/domain";

interface CheckRow {
  id: number;
  checkNumber: number;
  payeeName: string;
  amountCents: number;
  status: string;
  checkDate: string;
  memo: string | null;
}

export default function CheckRegister() {
  const { activeBusiness } = useApp();
  const search = useSearch();
  const initialStatus = useMemo(() => {
    const p = new URLSearchParams(search);
    return p.get("status") ?? "all";
  }, [search]);

  const [q, setQ] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [account, setAccount] = useState("all");

  const accountsQ = useQuery({
    queryKey: [`/api/businesses/${activeBusiness?.id}/bank-accounts`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/bank-accounts`);
      return (await res.json()) as any[];
    },
    enabled: !!activeBusiness,
  });

  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (account !== "all") params.set("bankAccountId", account);
  if (q) params.set("q", q);

  const query = useQuery<CheckRow[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/checks`, params.toString()],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/checks?${params.toString()}`);
      return (await res.json()) as CheckRow[];
    },
    enabled: !!activeBusiness,
  });

  const checks = query.data ?? [];
  const totalCents = checks.filter((c) => c.status !== "voided").reduce((s, c) => s + c.amountCents, 0);

  return (
    <div>
      <PageHeader
        title="Check Register"
        description="Searchable across all accounts within this business."
        action={<Button asChild><Link href="/checks/new"><Plus className="h-4 w-4 mr-1.5" /> New check</Link></Button>}
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search payee, #, or memo…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {CHECK_STATUS_LIST.map((s) => <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, " ")}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={account} onValueChange={setAccount}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {(accountsQ.data ?? []).map((a: any) => <SelectItem key={a.id} value={String(a.id)}>{a.nickname}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {checks.length === 0 ? (
        <EmptyState icon={FileText} title="No checks found" description="Adjust filters or create a new check." action={<Button asChild><Link href="/checks/new"><Plus className="h-4 w-4 mr-1.5" /> New check</Link></Button>} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="font-medium px-4 py-2.5">Check #</th>
                    <th className="font-medium px-4 py-2.5">Date</th>
                    <th className="font-medium px-4 py-2.5">Payee</th>
                    <th className="font-medium px-4 py-2.5">Memo</th>
                    <th className="font-medium px-4 py-2.5 text-right">Amount</th>
                    <th className="font-medium px-4 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {checks.map((c) => (
                    <tr key={c.id} className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => (window.location.hash = `#/checks/${c.id}`)}>
                      <td className="px-4 py-2.5 font-mono">#{c.checkNumber}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{c.checkDate}</td>
                      <td className="px-4 py-2.5 font-medium truncate max-w-[200px]">{c.payeeName}</td>
                      <td className="px-4 py-2.5 text-muted-foreground truncate max-w-[180px]">{c.memo ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums"><Money cents={c.amountCents} /></td>
                      <td className="px-4 py-2.5"><StatusBadge status={c.status} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border text-xs">
                    <td colSpan={4} className="px-4 py-2.5 text-muted-foreground">{checks.length} check(s) · {checks.filter((c) => c.status !== "voided").length} non-void</td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums">{formatCurrency(totalCents)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

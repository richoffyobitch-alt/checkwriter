import { Link } from "wouter";
import { useApp } from "@/context/app-context";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, StatusBadge, Money, EmptyState } from "@/components/common";
import { formatCurrency } from "@shared/domain";
import { prettyStatus } from "@/lib/utils";
import { Plus, FileText, Clock, XCircle, DollarSign, AlertTriangle, ShieldCheck, Banknote } from "lucide-react";

interface CheckRow {
  id: number;
  checkNumber: number;
  payeeName: string;
  amountCents: number;
  status: string;
  checkDate: string;
}
interface BankRow {
  id: number;
  bankName: string;
  nickname: string;
  status: string;
  bankValidationStatus: string;
  accountMasked: string;
}

export default function Dashboard() {
  const { activeBusiness } = useApp();

  const checksQ = useQuery<CheckRow[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/checks`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/checks`);
      return (await res.json()) as CheckRow[];
    },
    enabled: !!activeBusiness,
  });
  const banksQ = useQuery<BankRow[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/bank-accounts`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/bank-accounts`);
      return (await res.json()) as BankRow[];
    },
    enabled: !!activeBusiness,
  });

  if (!activeBusiness) {
    return (
      <EmptyState
        icon={Banknote}
        title="No business selected"
        description="Create your first business to start writing checks."
        action={<Button asChild><Link href="/businesses">Create business</Link></Button>}
      />
    );
  }

  const checks = checksQ.data ?? [];
  const banks = banksQ.data ?? [];

  const outstanding = checks.filter((c) => ["printed", "issued", "ready_to_print", "approved"].includes(c.status));
  const voided = checks.filter((c) => c.status === "voided");
  const needsApproval = checks.filter((c) => c.status === "pending_approval");
  const totalCents = checks.filter((c) => c.status !== "voided").reduce((s, c) => s + c.amountCents, 0);
  const outstandingCents = outstanding.reduce((s, c) => s + c.amountCents, 0);
  const unvalidated = banks.filter((b) => b.bankValidationStatus !== "validated");

  const stats = [
    { label: "Total checks", value: String(checks.length), icon: FileText },
    { label: "Outstanding", value: String(outstanding.length), icon: Clock, sub: formatCurrency(outstandingCents) },
    { label: "Voided", value: String(voided.length), icon: XCircle },
    { label: "Total written", value: formatCurrency(totalCents), icon: DollarSign },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={`${activeBusiness.legalName}${activeBusiness.dba ? " · " + activeBusiness.dba : ""}`}
        action={
          <Button asChild data-testid="button-create-check">
            <Link href="/checks/new"><Plus className="h-4 w-4 mr-1.5" /> New check</Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label}>
              <CardContent className="pt-5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">{s.label}</p>
                  <Icon className="h-4 w-4 text-muted-foreground/60" />
                </div>
                <p className="text-2xl font-bold tracking-tight mt-2 tabular-nums">{s.value}</p>
                {s.sub && <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">{s.sub}</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Recent checks</CardTitle>
            <Button asChild variant="ghost" size="sm"><Link href="/checks">View all</Link></Button>
          </CardHeader>
          <CardContent>
            {checks.length === 0 ? (
              <EmptyState icon={FileText} title="No checks yet" description="Create your first check in under 60 seconds." />
            ) : (
              <div className="divide-y divide-border">
                {checks.slice(0, 6).map((c) => (
                  <Link key={c.id} href={`/checks/${c.id}`} className="flex items-center justify-between py-2.5 hover:bg-muted/30 -mx-2 px-2 rounded transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-xs text-muted-foreground">#{c.checkNumber}</span>
                      <span className="text-sm font-medium truncate">{c.payeeName}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <StatusBadge status={c.status} />
                      <Money cents={c.amountCents} className="text-sm font-semibold" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {needsApproval.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> Approvals needed</CardTitle></CardHeader>
              <CardContent>
                <p className="text-sm">{needsApproval.length} check(s) awaiting approval.</p>
                <Button asChild variant="outline" size="sm" className="mt-3"><Link href="/checks?status=pending_approval">Review</Link></Button>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Bank validation</CardTitle></CardHeader>
            <CardContent>
              {banks.length === 0 ? (
                /* Saying "all validated" when there are no accounts at all reads
                   as reassurance the user has not earned yet. */
                <p className="text-sm text-muted-foreground">
                  No bank accounts yet. Add one to start writing checks.
                </p>
              ) : unvalidated.length === 0 ? (
                <p className="text-sm text-muted-foreground">All accounts validated.</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {unvalidated.map((b) => (
                    <li key={b.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{b.nickname}</span>
                      <span className="text-xs rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 px-2 py-0.5">{prettyStatus(b.bankValidationStatus)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Button asChild variant="ghost" size="sm" className="mt-3"><Link href="/bank-accounts">Manage accounts</Link></Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

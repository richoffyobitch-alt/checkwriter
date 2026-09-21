import { useApp } from "@/context/app-context";
import { PageHeader } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, FileText, Users, ScrollText, FileSpreadsheet, BookOpen } from "lucide-react";

const REPORTS = [
  { key: "checks", label: "Check register", desc: "All checks with status, amount, payee.", icon: FileText },
  { key: "payees", label: "Payee list", desc: "All payees with contact and category.", icon: Users },
  { key: "audit", label: "Audit log", desc: "Append-only audit events.", icon: ScrollText },
];

export default function Reports() {
  const { activeBusiness } = useApp();
  const baseUrl = `/api/businesses/${activeBusiness?.id}/export`;

  return (
    <div>
      <PageHeader title="Reports & Exports" description="Export CSV files of your check register, payees, and audit trail." />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => {
          const Icon = r.icon;
          return (
            <Card key={r.key}>
              <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><Icon className="h-4 w-4" /> {r.label}</CardTitle></CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">{r.desc}</p>
                <Button asChild size="sm" variant="outline">
                  <a href={`${baseUrl}/${r.key}`} download><Download className="h-3.5 w-3.5 mr-1" /> Download CSV</a>
                </Button>
              </CardContent>
            </Card>
          );
        })}

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><BookOpen className="h-4 w-4" /> Reconciliation</CardTitle></CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">Check-number gaps, voided, and sequence per account.</p>
            <Button asChild size="sm" variant="outline"><a href="/#/bank-accounts">View accounts</a></Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" /> Accounting mapping</CardTitle></CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">Line-item categories, projects, and classes map to GL accounts for later integration. No entries are posted automatically.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

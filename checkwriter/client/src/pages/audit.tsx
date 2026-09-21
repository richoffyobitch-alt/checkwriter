import { useApp } from "@/context/app-context";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, Time } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollText, ShieldAlert } from "lucide-react";
import { formatCurrency } from "@shared/domain";

interface AuditEvent { id: number; action: string; entityType: string | null; entityId: string | null; reason: string | null; createdAt: number; userId: number | null; }

export default function Audit() {
  const { activeBusiness } = useApp();

  const query = useQuery<AuditEvent[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/audit`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/audit`);
      return (await res.json()) as AuditEvent[];
    },
    enabled: !!activeBusiness,
  });

  const events = query.data ?? [];
  const isSensitive = (a: string) => /reveal|void|reprint|replace|positive_pay|bank_account\.(update|create)|template\.update|printer\.calibrate|step_up|login_failed/.test(a);

  return (
    <div>
      <PageHeader title="Audit Log" description="Append-only, tamper-evident record of sensitive actions." />

      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border max-h-[70vh] overflow-y-auto">
            {events.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No audit events yet.</div>}
            {events.map((e) => (
              <div key={e.id} className="flex items-start gap-3 px-4 py-2.5">
                <div className="mt-0.5">
                  {isSensitive(e.action) ? <ShieldAlert className="h-3.5 w-3.5 text-amber-500" /> : <ScrollText className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium font-mono">{e.action}</span>
                    {e.entityType && <Badge variant="outline" className="text-[10px]">{e.entityType}{e.entityId ? `#${e.entityId}` : ""}</Badge>}
                  </div>
                  {e.reason && <div className="text-xs text-muted-foreground mt-0.5">{e.reason}</div>}
                </div>
                <div className="text-xs text-muted-foreground shrink-0"><Time ts={e.createdAt} /></div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

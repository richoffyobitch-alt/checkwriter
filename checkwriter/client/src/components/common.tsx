import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatTimestamp } from "@shared/domain";
import type { CheckStatus } from "@shared/schema";

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-tight" data-testid="page-title">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  pending_approval: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  approved: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  ready_to_print: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  printed: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  issued: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  cleared: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-300",
  voided: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  reprinted: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  replaced: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
  stale: "bg-amber-600/15 text-amber-700 dark:text-amber-300",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  ready_to_print: "Ready to print",
  printed: "Printed",
  issued: "Issued",
  cleared: "Cleared",
  voided: "Voided",
  reprinted: "Reprinted",
  replaced: "Replaced",
  stale: "Stale",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-muted text-muted-foreground";
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", style)} data-testid={`status-${status}`}>
      {label}
    </span>
  );
}

export function Money({ cents, className }: { cents: number; className?: string }) {
  return <span className={cn("tabular-nums", className)}>{formatCurrency(cents)}</span>;
}

export function Time({ ts, className }: { ts: number | null | undefined; className?: string }) {
  return <span className={cn("text-muted-foreground", className)}>{formatTimestamp(ts)}</span>;
}

export function EmptyState({ title, description, action, icon: Icon }: { title: string; description?: string; action?: ReactNode; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16 px-6 text-center">
      {Icon && <Icon className="h-10 w-10 text-muted-foreground/50 mb-3" />}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-xs text-muted-foreground mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function RiskBadge({ level }: { level: "low" | "medium" | "high" }) {
  const map = {
    low: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    high: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  };
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", map[level])}>{level}</span>;
}

export const CHECK_STATUS_LIST: CheckStatus[] = [
  "draft", "pending_approval", "approved", "ready_to_print", "printed", "issued", "cleared", "voided", "reprinted", "replaced", "stale",
];

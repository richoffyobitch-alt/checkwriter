import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useApp } from "@/context/app-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Plus, ShieldCheck, ShieldAlert, Building2, LayoutDashboard, Banknote, Users, FileText, PenLine, Printer, ShieldCheck as ShieldIcon, Download, ScrollText, Settings, LogOut, CheckCircle2, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Resolves the single active nav path for a location. A plain `startsWith`
 * test lights up both "Check Register" (/checks) and "Create Check"
 * (/checks/new) on the create screen, so match on full segments and keep only
 * the most specific hit.
 */
function resolveActivePath(location: string, paths: string[]): string | null {
  const matches = paths.filter((p) =>
    p === "/" ? location === "/" : location === p || location.startsWith(p + "/"),
  );
  if (!matches.length) return null;
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

const NAV = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/checks", label: "Check Register", icon: FileText },
  { path: "/checks/new", label: "Create Check", icon: Plus, primary: true },
  { path: "/checks/reconciliation", label: "Reconciliation", icon: ListChecks },
  { path: "/businesses", label: "Businesses", icon: Building2 },
  { path: "/bank-accounts", label: "Bank Accounts", icon: Banknote },
  { path: "/payees", label: "Payees", icon: Users },
  { path: "/designer", label: "Check Designer", icon: PenLine },
  { path: "/printers", label: "Printers & Calibration", icon: Printer },
  { path: "/positive-pay", label: "Positive Pay", icon: ShieldCheck },
  { path: "/reports", label: "Reports & Exports", icon: Download },
  { path: "/audit", label: "Audit Log", icon: ScrollText },
  { path: "/settings", label: "Settings", icon: Settings },
];

const NAV_PATHS = NAV.map((n) => n.path);

/**
 * Mark: the E-13B bar rhythm of a MICR line, set in a red tile. Varying bar
 * weights read as magnetic-ink characters at large sizes and as a confident
 * abstract glyph at 24px.
 */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="7.5" className="fill-primary" />
      <g fill="white">
        <rect x="7" y="9" width="3.5" height="14" rx="0.6" />
        <rect x="12" y="9" width="1.75" height="14" rx="0.6" />
        <rect x="15.25" y="14" width="3.5" height="9" rx="0.6" />
        <rect x="20.25" y="9" width="1.75" height="14" rx="0.6" />
        <rect x="23.5" y="9" width="1.75" height="9" rx="0.6" />
      </g>
    </svg>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, activeBusiness, businesses, setActiveBusinessId, logout } = useApp();
  const [location] = useLocation();
  const activePath = resolveActivePath(location, NAV_PATHS);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-sidebar-border">
          <Logo />
          <span className="font-bold text-[15px] tracking-tight">CheckWriter</span>
        </div>
        <nav className="flex-1 overflow-y-auto py-2 px-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = activePath === item.path;
            if (item.primary) {
              return (
                <Link
                  key={item.path}
                  href={item.path}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors mb-1",
                    active ? "bg-primary text-primary-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            }
            return (
              <Link
                key={item.path}
                href={item.path}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                  active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border p-2">
          <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
            <ShieldIcon className="h-3.5 w-3.5" />
            <span>Encrypted local storage</span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <header className="flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
          {/* Business switcher */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 max-w-[260px]" data-testid="business-switcher">
                <Building2 className="h-4 w-4 shrink-0" />
                <span className="truncate">{activeBusiness?.legalName ?? "No business"}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>Switch business</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {businesses.map((b) => (
                <DropdownMenuItem
                  key={b.id}
                  onClick={() => setActiveBusinessId(b.id)}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate">{b.legalName}</span>
                  {b.id === activeBusiness?.id && <CheckCircle2 className="h-4 w-4 text-primary" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/businesses" className="flex items-center gap-2 cursor-pointer">
                  <Plus className="h-4 w-4" /> Manage businesses
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground">
            {activeBusiness?.role ? (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium capitalize">{activeBusiness.role}</span>
            ) : null}
          </div>

          <div className="flex-1" />

          {/* Step-up indicator */}
          {user?.stepUpActive ? (
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" /> Elevated
            </span>
          ) : (
            /* Not being elevated is the normal resting state, so it is styled
               neutrally — an amber warning here looked like a fault or a plan tier. */
            <span
              title="Standard session. High-risk actions will ask for your password."
              className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
            >
              <ShieldAlert className="h-3.5 w-3.5" /> Standard session
            </span>
          )}

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                  {(user?.name || "U").slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden sm:inline text-sm font-medium">{user?.name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild><Link href="/settings" className="cursor-pointer">Settings</Link></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => logout()} className="text-destructive focus:text-destructive cursor-pointer">
                <LogOut className="h-4 w-4 mr-2" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Mobile nav */}
        <MobileNav />

        <main className="grid-surface flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}

function MobileNav() {
  const [location] = useLocation();
  const activePath = resolveActivePath(location, NAV_PATHS);
  return (
    <div className="md:hidden border-b border-border bg-background overflow-x-auto">
      <div className="flex gap-1 px-2 py-1.5 min-w-max">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = activePath === item.path;
          return (
            <Link
              key={item.path}
              href={item.path}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap",
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

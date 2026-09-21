import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppProvider, useApp } from "@/context/app-context";
import { AppLayout } from "@/components/layout";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import SetupWizard from "@/pages/setup-wizard";

import Dashboard from "@/pages/dashboard";
import Businesses from "@/pages/businesses";
import BankAccounts from "@/pages/bank-accounts";
import Payees from "@/pages/payees";
import CheckCreate from "@/pages/check-create";
import CheckRegister from "@/pages/check-register";
import CheckDetail from "@/pages/check-detail";
import Designer from "@/pages/designer";
import Printers from "@/pages/printers";
import PositivePay from "@/pages/positive-pay";
import Reports from "@/pages/reports";
import Audit from "@/pages/audit";
import Settings from "@/pages/settings";
import PrintView from "@/pages/print";
import Reconciliation from "@/pages/reconciliation";

function Shell({ children }: { children: React.ReactNode }) {
  return <AppLayout>{children}</AppLayout>;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/checks" component={CheckRegister} />
      <Route path="/checks/reconciliation" component={Reconciliation} />
      <Route path="/checks/new" component={CheckCreate} />
      <Route path="/checks/:id" component={CheckDetail} />
      <Route path="/businesses" component={Businesses} />
      <Route path="/bank-accounts" component={BankAccounts} />
      <Route path="/payees" component={Payees} />
      <Route path="/designer" component={Designer} />
      <Route path="/printers" component={Printers} />
      <Route path="/positive-pay" component={PositivePay} />
      <Route path="/reports" component={Reports} />
      <Route path="/audit" component={Audit} />
      <Route path="/settings" component={Settings} />
      <Route path="/print/:checkId" component={PrintView} />
      <Route component={NotFound} />
    </Switch>
  );
}

function Gate() {
  const { user, isLoadingUser, needsSetup, isLoadingSetupStatus } = useApp();
  if (isLoadingUser || isLoadingSetupStatus) {
    return (
      <div className="flex h-screen w-screen items-center justify-center">
        <div className="animate-pulse text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (needsSetup && !user) return <SetupWizard />;
  if (!user) return <LoginPage />;
  return (
    <Shell>
      <AppRouter />
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppProvider>
          <Router hook={useHashLocation}>
            <Gate />
          </Router>
        </AppProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

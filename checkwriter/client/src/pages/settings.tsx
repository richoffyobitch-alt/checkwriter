import { useState } from "react";
import { useApp } from "@/context/app-context";
import { PageHeader, Time } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { TeamPanel } from "@/components/team-panel";
import { ShieldCheck, ShieldAlert, Database, KeyRound, LogOut } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { ROLE_PERMISSIONS, can } from "@shared/domain";

/* Derived from the same ROLE_PERMISSIONS the server enforces, so this matrix
   cannot drift from actual authorization. It previously duplicated the list
   locally and silently under-reported new permissions. */
const ROLES = Object.keys(ROLE_PERMISSIONS);
const PERMISSIONS = Array.from(new Set(Object.values(ROLE_PERMISSIONS).flat())).sort();

export default function Settings() {
  const { user, activeBusiness, logout, stepUp } = useApp();
  const { toast } = useToast();
  const [reauthOpen, setReauthOpen] = useState(false);
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [curPwd, setCurPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [pwdBusy, setPwdBusy] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const stepUpActive = !!user?.stepUpActive;
  /* Mirrors the server rule so the user is told before the round trip rather
     than after it. The server still enforces both independently. */
  const newPwdTooShort = newPwd.length > 0 && newPwd.length < 10;
  const pwdMismatch = confirmPwd.length > 0 && newPwd !== confirmPwd;
  const canSubmitPwd =
    stepUpActive && !pwdBusy && curPwd.length > 0 && newPwd.length >= 10 && newPwd === confirmPwd;

  async function changePassword() {
    setPwdBusy(true);
    try {
      const res = await apiRequest("POST", "/api/auth/change-password", {
        currentPassword: curPwd,
        newPassword: newPwd,
      });
      const body = await res.json();
      const n = body?.otherSessionsRevoked ?? 0;
      toast({
        title: "Password changed",
        description:
          n > 0
            ? `Signed out of ${n} other ${n === 1 ? "session" : "sessions"}. This one stays active.`
            : "No other sessions were signed in.",
      });
      setCurPwd("");
      setNewPwd("");
      setConfirmPwd("");
    } catch (e) {
      toast({
        title: "Could not change password",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPwdBusy(false);
    }
  }

  async function revokeOtherSessions() {
    setRevokeBusy(true);
    try {
      const res = await apiRequest("POST", "/api/auth/revoke-sessions", {});
      const body = await res.json();
      const n = body?.otherSessionsRevoked ?? 0;
      toast({
        title: n > 0 ? "Other sessions signed out" : "Nothing to sign out",
        description:
          n > 0
            ? `${n} other ${n === 1 ? "session was" : "sessions were"} ended. This one stays active.`
            : "You are not signed in anywhere else.",
      });
    } catch (e) {
      toast({
        title: "Could not sign out other sessions",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setRevokeBusy(false);
    }
  }

  /* Start a step-up session here rather than telling the user to go and trigger
     one somewhere else. */
  async function confirmReauth() {
    setBusy(true);
    try {
      await stepUp(pwd);
      toast({ title: "Re-authenticated", description: "High-risk actions are unlocked for this session." });
      setReauthOpen(false);
      setPwd("");
    } catch (e) {
      toast({
        title: "Could not verify password",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Settings" description="Security, roles, and environment information." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Account</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-2">
            <Row label="Name" value={user?.name ?? "—"} />
            <Row label="Email" value={user?.email ?? "—"} />
            <Row label="MFA" value={user?.mfaEnabled ? "Enabled" : "Not enabled"} />
            <div className="flex items-center justify-between pt-1">
              <span className="text-muted-foreground">Step-up session</span>
              {user?.stepUpActive ? <Badge className="bg-emerald-500/15 text-emerald-400"><ShieldCheck className="h-3 w-3 mr-1" /> Active</Badge> : <Badge className="bg-amber-500/15 text-amber-400"><ShieldAlert className="h-3 w-3 mr-1" /> Standard</Badge>}
            </div>
            {!user?.stepUpActive && <Button size="sm" variant="outline" onClick={() => setReauthOpen(true)} data-testid="button-reauth">Re-authenticate</Button>}
            <div className="pt-2"><Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300 hover:bg-red-500/10" onClick={() => logout()}>Sign out</Button></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4" /> Password and sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-4">
            {!stepUpActive && (
              <p className="text-amber-400 text-xs leading-relaxed" data-testid="text-pwd-stepup-hint">
                Re-authenticate above before changing your password or ending other sessions.
              </p>
            )}
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="cur-pwd">Current password</Label>
                <Input
                  id="cur-pwd"
                  type="password"
                  autoComplete="current-password"
                  value={curPwd}
                  disabled={!stepUpActive}
                  onChange={(e) => setCurPwd(e.target.value)}
                  data-testid="input-current-password"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-pwd">New password</Label>
                <Input
                  id="new-pwd"
                  type="password"
                  autoComplete="new-password"
                  value={newPwd}
                  disabled={!stepUpActive}
                  onChange={(e) => setNewPwd(e.target.value)}
                  aria-describedby="new-pwd-help"
                  data-testid="input-new-password"
                />
                <p
                  id="new-pwd-help"
                  className={`text-xs ${newPwdTooShort ? "text-red-400" : "text-muted-foreground"}`}
                >
                  At least 10 characters.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="confirm-pwd">Confirm new password</Label>
                <Input
                  id="confirm-pwd"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPwd}
                  disabled={!stepUpActive}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  data-testid="input-confirm-password"
                />
                {pwdMismatch && (
                  <p className="text-xs text-red-400" data-testid="text-pwd-mismatch">
                    Passwords do not match.
                  </p>
                )}
              </div>
              <Button
                size="sm"
                onClick={changePassword}
                disabled={!canSubmitPwd}
                data-testid="button-change-password"
              >
                {pwdBusy ? "Changing…" : "Change password"}
              </Button>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Changing your password signs out every other device immediately. This one stays
                signed in.
              </p>
            </div>

            <div className="border-t border-border pt-3 space-y-2">
              <Button
                size="sm"
                variant="outline"
                onClick={revokeOtherSessions}
                disabled={!stepUpActive || revokeBusy}
                data-testid="button-revoke-sessions"
              >
                <LogOut className="h-3.5 w-3.5 mr-1.5" />
                {revokeBusy ? "Signing out…" : "Sign out all other devices"}
              </Button>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Ends every other session without changing your password.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Database className="h-4 w-4" /> Environment</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-2">
            <Row label="Active business" value={activeBusiness?.legalName ?? "—"} />
            <Row label="Your role" value={activeBusiness?.role ?? "—"} />
            <Row label="Storage" value="Local SQLite database" />
            <Row
              label="Encryption"
              value={
                user?.encryptionKeyManaged
                  ? "AES-256-GCM (key from environment)"
                  : "AES-256-GCM (development fallback key)"
              }
            />
            <div className="mt-2 rounded-md bg-muted p-2 text-xs text-muted-foreground">
              <Database className="h-3.5 w-3.5 inline mr-1" /> Records are stored in a local encrypted database on this computer.
            </div>
          </CardContent>
        </Card>

        <TeamPanel />

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Role permission matrix</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="font-medium py-2 pr-3">Permission</th>
                  {ROLES.map((r) => <th key={r} className="font-medium px-1.5 py-2 capitalize text-center">{r}</th>)}
                </tr>
              </thead>
              <tbody>
                {PERMISSIONS.map((p) => (
                  <tr key={p} className="border-t border-border">
                    <td className="py-1.5 pr-3 font-mono">{p}</td>
                    {ROLES.map((r) => (
                      <td key={r} className="text-center py-1.5">
                        {hasPerm(r, p) ? (
                          <span className="text-emerald-400" title="Granted" aria-label="Granted">✓</span>
                        ) : (
                          <span className="text-muted-foreground" title="Not granted" aria-label="Not granted">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground mt-4 leading-relaxed">
              Roles that can print (<code>check.print</code>) can also read the routing and
              account numbers needed to render a MICR line, because those numbers appear on
              the printed check itself. Every such read is recorded in the audit log. Roles
              without <code>check.print</code> or <code>bank.reveal</code> — approver, signer
              and viewer — cannot see them at all.
            </p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={reauthOpen} onOpenChange={(o) => { if (!o) { setReauthOpen(false); setPwd(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" /> Re-authenticate
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Confirm your password to unlock high-risk actions such as revealing bank details,
              editing a bank account, adding users, and exporting positive pay files.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="reauth-pwd">Password</Label>
              <Input
                id="reauth-pwd" type="password" autoComplete="current-password" value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && pwd && !busy) confirmReauth(); }}
                data-testid="input-reauth-pwd"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button onClick={confirmReauth} disabled={!pwd || busy} data-testid="button-confirm-reauth">
              {busy ? "Verifying…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function hasPerm(role: string, perm: string): boolean {
  return can(role, perm);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}

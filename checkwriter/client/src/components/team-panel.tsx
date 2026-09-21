import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/context/app-context";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ROLE_PERMISSIONS, can } from "@shared/domain";
import { UserPlus, ShieldAlert, Trash2, Users } from "lucide-react";

interface Member {
  userId: number;
  email: string;
  name: string;
  role: string;
  membershipId: number;
  createdAt: number;
}

const ROLES = Object.keys(ROLE_PERMISSIONS);

/* Additional users are optional. A sole owner holds every permission and can
   prepare, approve, sign and print without anyone else, so this panel is about
   delegating work rather than unlocking it. */
export function TeamPanel() {
  const { activeBusiness, user, stepUp } = useApp();
  const { toast } = useToast();
  const qc = useQueryClient();
  const bizId = activeBusiness?.id;
  const mayManage = can(activeBusiness?.role ?? "", "business.manage");

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "approver" });
  const [pwd, setPwd] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<Member | null>(null);

  const membersQ = useQuery<Member[]>({
    queryKey: ["members", bizId],
    enabled: !!bizId,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${bizId}/members`);
      return (await res.json()) as Member[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["members", bizId] });

  const addMut = useMutation({
    mutationFn: async () => {
      await stepUp(pwd);
      const res = await apiRequest("POST", `/api/businesses/${bizId}/members`, {
        email: form.email.trim(),
        name: form.name.trim() || undefined,
        password: form.password || undefined,
        role: form.role,
      });
      return await res.json();
    },
    onSuccess: () => {
      toast({ title: "User added", description: `${form.email} can now sign in as ${form.role}.` });
      setAddOpen(false);
      setForm({ email: "", name: "", password: "", role: "approver" });
      setPwd("");
      invalidate();
    },
    onError: (e: Error) => toast({ title: "Could not add user", description: e.message, variant: "destructive" }),
  });

  const roleMut = useMutation({
    mutationFn: async ({ userId, role }: { userId: number; role: string }) => {
      const res = await apiRequest("PATCH", `/api/businesses/${bizId}/members/${userId}`, { role });
      return await res.json();
    },
    onSuccess: () => { toast({ title: "Role updated" }); invalidate(); },
    onError: (e: Error) => toast({ title: "Could not change role", description: e.message, variant: "destructive" }),
  });

  const removeMut = useMutation({
    mutationFn: async (userId: number) => {
      const res = await apiRequest("DELETE", `/api/businesses/${bizId}/members/${userId}`);
      return await res.json();
    },
    onSuccess: () => {
      toast({ title: "Access removed", description: "Their past checks and audit history are retained." });
      setConfirmRemove(null);
      invalidate();
    },
    onError: (e: Error) => toast({ title: "Could not remove user", description: e.message, variant: "destructive" }),
  });

  const members = membersQ.data ?? [];

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="h-4 w-4" /> Authorized users
        </CardTitle>
        {mayManage && (
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)} data-testid="button-add-member">
            <UserPlus className="h-4 w-4 mr-1.5" /> Add user
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-3">
          Optional. As the owner you can prepare, approve, sign and print checks on your own at any
          amount. Add users here when you want to delegate — a bookkeeper who writes checks without
          approving them, or an approver who signs off without access to bank numbers.
        </p>

        {membersQ.isLoading ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1].map((i) => <div key={i} className="h-11 rounded-md bg-muted animate-pulse" />)}
          </div>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No users found for this business.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="font-medium py-2 pr-3">Name</th>
                  <th className="font-medium py-2 pr-3">Email</th>
                  <th className="font-medium py-2 pr-3">Role</th>
                  <th className="font-medium py-2 pr-3 sr-only">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const isSelf = m.userId === user?.id;
                  return (
                    <tr key={m.userId} className="border-t border-border" data-testid={`row-member-${m.userId}`}>
                      <td className="py-2 pr-3 font-medium">
                        {m.name} {isSelf && <Badge variant="secondary" className="ml-1.5">You</Badge>}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground break-all">{m.email}</td>
                      <td className="py-2 pr-3">
                        {mayManage && !isSelf ? (
                          <Select value={m.role} onValueChange={(role) => roleMut.mutate({ userId: m.userId, role })}>
                            <SelectTrigger className="h-8 w-[140px]" aria-label={`Role for ${m.name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLES.map((r) => (
                                <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="capitalize">{m.role}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {mayManage && !isSelf && (
                          <Button
                            size="sm" variant="ghost"
                            className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                            onClick={() => setConfirmRemove(m)}
                            aria-label={`Remove ${m.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      {/* Add user — granting check authority is high-risk, so it needs step-up */}
      <Dialog open={addOpen} onOpenChange={(o) => { if (!o) { setAddOpen(false); setPwd(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" /> Add an authorized user
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This grants access to this business's checks and bank accounts. Confirm your own
              password to continue; the change is recorded in the audit trail.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="m-email">Their email</Label>
              <Input id="m-email" type="email" autoComplete="off" value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="input-member-email" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-name">Their name</Label>
              <Input id="m-name" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="input-member-name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-role">Role</Label>
              <Select value={form.role} onValueChange={(role) => setForm({ ...form, role })}>
                <SelectTrigger id="m-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-pass">Their initial password</Label>
              <Input id="m-pass" type="password" autoComplete="new-password" value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} data-testid="input-member-password" />
              <p className="text-xs text-muted-foreground">
                At least 10 characters. Leave blank only if this person already has an account here.
              </p>
            </div>
            <div className="space-y-1.5 border-t border-border pt-3">
              <Label htmlFor="m-own">Your password</Label>
              <Input id="m-own" type="password" autoComplete="current-password" value={pwd}
                onChange={(e) => setPwd(e.target.value)} data-testid="input-member-stepup" />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button
              onClick={() => addMut.mutate()}
              disabled={!form.email.trim() || !pwd || addMut.isPending}
              data-testid="button-confirm-add-member"
            >
              {addMut.isPending ? "Adding…" : "Add user"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <Dialog open={confirmRemove != null} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Remove access</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmRemove?.name} will lose access to {activeBusiness?.legalName}. Checks they
            prepared, approved, or signed and their audit history are kept.
          </p>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button
              className="bg-rose-600 text-white hover:bg-rose-700"
              onClick={() => confirmRemove && removeMut.mutate(confirmRemove.userId)}
              disabled={removeMut.isPending}
            >
              {removeMut.isPending ? "Removing…" : "Remove access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

import { useState } from "react";
import { useApp } from "@/context/app-context";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, EmptyState, Field } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Building2, Plus, MapPin, Phone, Archive } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Biz {
  id: number;
  legalName: string;
  dba: string | null;
  ein: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  defaultSigner: string | null;
  status: string;
  role: string;
}

export default function Businesses() {
  const { activeBusiness, setActiveBusinessId, user } = useApp();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Biz>>({});

  const query = useQuery<Biz[]>({
    queryKey: ["/api/businesses"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/businesses");
      return (await res.json()) as Biz[];
    },
  });

  const createMut = useMutation({
    mutationFn: async (data: Partial<Biz>) => {
      const res = await apiRequest("POST", "/api/businesses", data);
      return (await res.json()) as Biz;
    },
    onSuccess: (biz) => {
      toast({ title: "Business created", description: biz.legalName });
      setActiveBusinessId(biz.id);
      setOpen(false);
      setForm({});
      query.refetch();
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const archiveMut = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/businesses/${id}/archive`);
    },
    onSuccess: () => {
      toast({ title: "Business archived" });
      query.refetch();
    },
  });

  const businesses = query.data ?? [];

  return (
    <div>
      <PageHeader
        title="Businesses"
        description="Manage multiple companies, each with its own bank accounts and users."
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-new-business"><Plus className="h-4 w-4 mr-1.5" /> New business</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>New business</DialogTitle></DialogHeader>
              <div className="grid gap-3">
                <Field label="Legal business name">
                  <Input value={form.legalName ?? ""} onChange={(e) => setForm({ ...form, legalName: e.target.value })} placeholder="Summit Ridge Construction LLC" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="DBA (optional)"><Input value={form.dba ?? ""} onChange={(e) => setForm({ ...form, dba: e.target.value })} /></Field>
                  <Field label="EIN (masked at rest)"><Input value={form.ein ?? ""} onChange={(e) => setForm({ ...form, ein: e.target.value })} placeholder="12-3456789" /></Field>
                </div>
                <Field label="Address line 1"><Input value={form.addressLine1 ?? ""} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} /></Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="City"><Input value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
                  <Field label="State"><Input value={form.state ?? ""} onChange={(e) => setForm({ ...form, state: e.target.value })} /></Field>
                  <Field label="ZIP"><Input value={form.zip ?? ""} onChange={(e) => setForm({ ...form, zip: e.target.value })} /></Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Phone"><Input value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
                  <Field label="Default signer"><Input value={form.defaultSigner ?? ""} onChange={(e) => setForm({ ...form, defaultSigner: e.target.value })} /></Field>
                </div>
              </div>
              <DialogFooter>
                <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                <Button onClick={() => createMut.mutate(form)} disabled={!form.legalName || createMut.isPending}>Create business</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      {businesses.length === 0 ? (
        <EmptyState icon={Building2} title="No businesses yet" description="Add your first business to get started." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {businesses.map((b) => (
            <Card key={b.id} className={b.id === activeBusiness?.id ? "border-primary" : ""}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base leading-tight">{b.legalName}</CardTitle>
                  <span className="text-xs rounded-full bg-muted px-2 py-0.5 capitalize shrink-0">{b.role}</span>
                </div>
                {b.dba && <p className="text-xs text-muted-foreground">DBA: {b.dba}</p>}
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1.5">
                {b.addressLine1 && (
                  <div className="flex items-center gap-1.5"><MapPin className="h-3 w-3" /> {b.addressLine1}{b.city ? `, ${b.city}` : ""}{b.state ? `, ${b.state}` : ""}</div>
                )}
                {b.phone && <div className="flex items-center gap-1.5"><Phone className="h-3 w-3" /> {b.phone}</div>}
                {b.defaultSigner && <div className="flex items-center gap-1.5">Signer: {b.defaultSigner}</div>}
                <div className="flex items-center justify-between pt-2">
                  <span className={b.status === "archived" ? "text-rose-500" : ""}>{b.status}</span>
                  <div className="flex gap-1">
                    {b.id !== activeBusiness?.id && b.status === "active" && (
                      <Button size="sm" variant="outline" onClick={() => setActiveBusinessId(b.id)}>Switch to</Button>
                    )}
                    {b.status === "active" && (
                      <Button size="sm" variant="ghost" onClick={() => archiveMut.mutate(b.id)}><Archive className="h-3.5 w-3.5" /></Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

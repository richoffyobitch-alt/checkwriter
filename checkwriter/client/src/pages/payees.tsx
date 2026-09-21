import { useState, useMemo } from "react";
import { useApp } from "@/context/app-context";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, Field, EmptyState } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, Plus, Search, Archive, Tag, Copy, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Payee {
  id: number;
  name: string;
  type: string;
  category: string | null;
  city: string | null;
  state: string | null;
  contactName: string | null;
  contactEmail: string | null;
  defaultMemo: string | null;
  tags: string[];
  archived: boolean;
}

export default function Payees() {
  const { activeBusiness } = useApp();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [form, setForm] = useState<Partial<Payee> & { tagInput?: string }>({});

  const query = useQuery<Payee[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/payees`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/payees?includeArchived=true`);
      return (await res.json()) as Payee[];
    },
    enabled: !!activeBusiness,
  });

  const dupQ = useQuery<number[][]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/payees/duplicates`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/payees/duplicates`);
      return (await res.json()) as number[][];
    },
    enabled: !!activeBusiness,
  });

  const createMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/payees`, data);
      return (await res.json()) as Payee;
    },
    onSuccess: () => {
      toast({ title: "Payee added" });
      setOpen(false);
      setForm({});
      query.refetch();
      dupQ.refetch();
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const archiveMut = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/payees/${id}/archive`);
    },
    onSuccess: () => {
      toast({ title: "Payee archived" });
      query.refetch();
    },
  });

  const importMut = useMutation({
    mutationFn: async (rows: any[]) => {
      let count = 0;
      for (const r of rows) {
        await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/payees`, r);
        count++;
      }
      return count;
    },
    onSuccess: (n) => {
      toast({ title: "Import complete", description: `${n} payee(s) imported` });
      setImportOpen(false);
      setCsv("");
      query.refetch();
      dupQ.refetch();
    },
    onError: (e: Error) => toast({ title: "Import failed", description: e.message, variant: "destructive" }),
  });

  const payees = query.data ?? [];
  const filtered = useMemo(() => {
    let list = payees;
    if (q.trim()) {
      const term = q.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(term) || (p.category ?? "").toLowerCase().includes(term) || p.tags.some((t) => t.toLowerCase().includes(term)));
    }
    return list.sort((a, b) => Number(a.archived) - Number(b.archived));
  }, [payees, q]);

  const parseCsv = (text: string) => {
    const lines = text.trim().split(/\r?\n/);
    const rows = lines.slice(1).filter(Boolean).map((line) => {
      const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      const [name, type, category, city, state, contactEmail] = cells;
      return { name, type: type || "business", category: category || null, city: city || null, state: state || null, contactEmail: contactEmail || null };
    }).filter((r) => r.name);
    return rows;
  };

  const dupGroups = dupQ.data ?? [];
  const dupNameMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const group of dupGroups) for (const id of group) m.set(id, "duplicate");
    return m;
  }, [dupGroups]);

  return (
    <div>
      <PageHeader
        title="Payees"
        description="Internal notes are never printed unless explicitly selected."
        action={
          <div className="flex gap-2">
            <Dialog open={importOpen} onOpenChange={setImportOpen}>
              <DialogTrigger asChild><Button variant="outline" size="sm"><Upload className="h-4 w-4 mr-1.5" /> Import CSV</Button></DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader><DialogTitle>Import payees (CSV)</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">Header row: <code className="font-mono">name,type,category,city,state,contact_email</code></p>
                  <textarea className="min-h-[140px] w-full rounded-md border border-input bg-background p-2 text-xs font-mono" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"name,type,category,city,state,contact_email\nAcme Co,business,Vendors,Las Vegas,NV,ap@acme.co"} />
                </div>
                <DialogFooter>
                  <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                  <Button onClick={() => importMut.mutate(parseCsv(csv))} disabled={!csv.trim() || importMut.isPending}>Import</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild><Button data-testid="button-add-payee"><Plus className="h-4 w-4 mr-1.5" /> Add payee</Button></DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader><DialogTitle>Add payee</DialogTitle></DialogHeader>
                <div className="grid gap-3">
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Name"><Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
                    <Field label="Type">
                      <Select value={form.type ?? "business"} onValueChange={(v) => setForm({ ...form, type: v })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="business">Business</SelectItem><SelectItem value="individual">Individual</SelectItem></SelectContent>
                      </Select>
                    </Field>
                    <Field label="Category"><Input value={form.category ?? ""} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="City"><Input value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
                    <Field label="State"><Input value={form.state ?? ""} onChange={(e) => setForm({ ...form, state: e.target.value })} /></Field>
                    <Field label="Contact email"><Input value={form.contactEmail ?? ""} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} /></Field>
                  </div>
                  <Field label="Default memo"><Input value={form.defaultMemo ?? ""} onChange={(e) => setForm({ ...form, defaultMemo: e.target.value })} /></Field>
                  <Field label="Tags (comma-separated)"><Input value={form.tagInput ?? ""} onChange={(e) => setForm({ ...form, tagInput: e.target.value })} placeholder="1099, recurring" /></Field>
                </div>
                <DialogFooter>
                  <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                  <Button onClick={() => createMut.mutate({ ...form, tags: (form.tagInput ?? "").split(",").map((s) => s.trim()).filter(Boolean) })} disabled={!form.name || createMut.isPending}>Add payee</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        }
      />

      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search payees…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        {dupGroups.length > 0 && (
          <Badge variant="outline" className="text-amber-400 border-amber-500/40">
            <Copy className="h-3 w-3 mr-1" /> {dupGroups.length} possible duplicate group(s)
          </Badge>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Users} title="No payees" description="Add payees manually or import from CSV." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {filtered.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/30">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${p.archived ? "text-muted-foreground line-through" : ""}`}>{p.name}</span>
                      {dupNameMap.has(p.id) && <Badge variant="outline" className="text-amber-400 border-amber-500/40 text-[10px]">possible dup</Badge>}
                      {p.archived && <Badge variant="outline" className="text-[10px]">archived</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {[p.category, p.city, p.state, p.contactEmail].filter(Boolean).join(" · ")}
                    </div>
                    {p.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {p.tags.map((t) => <Badge key={t} variant="secondary" className="text-[10px]"><Tag className="h-2.5 w-2.5 mr-0.5" />{t}</Badge>)}
                      </div>
                    )}
                  </div>
                  {!p.archived && (
                    <Button size="sm" variant="ghost" onClick={() => archiveMut.mutate(p.id)}><Archive className="h-3.5 w-3.5" /></Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import { useState } from "react";
import { useApp } from "@/context/app-context";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, Field, EmptyState } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Printer, Plus, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Printer { id: number; name: string; stockType: string; offsetX: number; offsetY: number; scale: number; notes: string | null; validatedAt: number | null; }

export default function Printers() {
  const { activeBusiness } = useApp();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Printer>>({});

  const query = useQuery<Printer[]>({
    queryKey: [`/api/businesses/${activeBusiness?.id}/printers`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/businesses/${activeBusiness!.id}/printers`);
      return (await res.json()) as Printer[];
    },
    enabled: !!activeBusiness,
  });

  const createMut = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", `/api/businesses/${activeBusiness!.id}/printers`, data);
      return (await res.json()) as Printer;
    },
    onSuccess: () => {
      toast({ title: "Printer profile saved" });
      setOpen(false);
      setForm({});
      query.refetch();
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const calibrateMut = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      await apiRequest("PATCH", `/api/businesses/${activeBusiness!.id}/printers/${id}`, data);
    },
    onSuccess: () => {
      toast({ title: "Calibration updated" });
      query.refetch();
    },
  });

  const printers = query.data ?? [];

  return (
    <div>
      <PageHeader
        title="Printers & Calibration"
        description="Each office/printer combination retains calibrated offset and scale settings."
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-1.5" /> Add printer</Button></DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader><DialogTitle>New printer profile</DialogTitle></DialogHeader>
              <div className="grid gap-3">
                <Field label="Name"><Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Office HP - Blank Stock" /></Field>
                <Field label="Stock type">
                  <Select value={form.stockType ?? "blank"} onValueChange={(v) => setForm({ ...form, stockType: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="blank">Blank</SelectItem><SelectItem value="preprinted">Pre-printed</SelectItem></SelectContent>
                  </Select>
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Offset X (mm)"><Input type="number" value={form.offsetX ?? 0} onChange={(e) => setForm({ ...form, offsetX: parseInt(e.target.value) })} /></Field>
                  <Field label="Offset Y (mm)"><Input type="number" value={form.offsetY ?? 0} onChange={(e) => setForm({ ...form, offsetY: parseInt(e.target.value) })} /></Field>
                  <Field label="Scale (%)"><Input type="number" value={form.scale ?? 100} onChange={(e) => setForm({ ...form, scale: parseInt(e.target.value) })} /></Field>
                </div>
                <Field label="Notes"><Textarea value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} /></Field>
              </div>
              <DialogFooter>
                <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                <Button onClick={() => createMut.mutate(form)} disabled={!form.name || createMut.isPending}>Save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      {printers.length === 0 ? (
        <EmptyState icon={Printer} title="No printer profiles" description="Add a printer profile to save calibration settings." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {printers.map((p) => (
            <Card key={p.id}>
              <CardHeader className="pb-3"><CardTitle className="text-base flex items-center justify-between">{p.name} {p.validatedAt && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-3">
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><div className="text-muted-foreground">Offset X</div><div className="font-mono">{p.offsetX}mm</div></div>
                  <div><div className="text-muted-foreground">Offset Y</div><div className="font-mono">{p.offsetY}mm</div></div>
                  <div><div className="text-muted-foreground">Scale</div><div className="font-mono">{p.scale}%</div></div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => calibrateMut.mutate({ id: p.id, data: { offsetX: p.offsetX + 1 } })}>Shift right +1mm</Button>
                  <Button size="sm" variant="outline" onClick={() => calibrateMut.mutate({ id: p.id, data: { offsetY: p.offsetY + 1 } })}>Shift down +1mm</Button>
                </div>
                {p.notes && <p className="text-xs text-muted-foreground">{p.notes}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

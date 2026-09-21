import { useState } from "react";
import { useApp, type SetupPayload } from "@/context/app-context";
import { Check } from "lucide-react";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
];

function Field({
  label,
  children,
  required,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-foreground">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500/50";

export default function SetupWizard() {
  const { completeSetup } = useApp();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<SetupPayload>({
    email: "",
    name: "",
    password: "",
    legalName: "",
    addressLine1: "",
    city: "",
    state: "NV",
    zip: "",
    phone: "",
    defaultSigner: "",
  });

  const update = <K extends keyof SetupPayload>(k: K, v: SetupPayload[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const valid =
    form.email.includes("@") &&
    form.name.trim().length >= 2 &&
    form.password.length >= 10 &&
    form.legalName.trim().length >= 2 &&
    form.addressLine1.trim() &&
    form.city.trim() &&
    form.state.trim() &&
    form.zip.trim().length >= 5;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await completeSetup({
        ...form,
        defaultSigner: form.defaultSigner?.trim() || form.name.trim(),
      });
    } catch (err: any) {
      const msg = err?.message || "Setup failed.";
      setError(msg.includes("already") ? "Setup has already been completed. Reload the page to sign in." : msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-red-600 text-white shadow-lg shadow-red-600/20">
            <Check className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Welcome to CheckWriter
          </h1>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            Create your administrator account and first business to get started.
            This only runs once.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-6 rounded-2xl border border-border bg-card p-6 shadow-sm"
        >
          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Your account
            </legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Your name" required>
                <input
                  className={inputCls}
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder="Jordan Mitchell"
                  autoComplete="name"
                />
              </Field>
              <Field label="Email" required>
                <input
                  type="email"
                  className={inputCls}
                  value={form.email}
                  onChange={(e) => update("email", e.target.value)}
                  placeholder="you@business.com"
                  autoComplete="email"
                />
              </Field>
            </div>
            <Field
              label="Password"
              required
              hint="At least 10 characters. This is your administrator sign-in."
            >
              <input
                type="password"
                className={inputCls}
                value={form.password}
                onChange={(e) => update("password", e.target.value)}
                placeholder="••••••••••"
                autoComplete="new-password"
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-4 border-t border-border pt-6">
            <legend className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              First business
            </legend>
            <Field label="Legal business name" required>
              <input
                className={inputCls}
                value={form.legalName}
                onChange={(e) => update("legalName", e.target.value)}
                placeholder="Summit Ridge Construction LLC"
              />
            </Field>
            <Field label="DBA / trade name (optional)">
              <input
                className={inputCls}
                value={form.dba ?? ""}
                onChange={(e) => update("dba", e.target.value)}
                placeholder="Summit Ridge"
              />
            </Field>
            <Field label="Address" required>
              <input
                className={inputCls}
                value={form.addressLine1}
                onChange={(e) => update("addressLine1", e.target.value)}
                placeholder="742 Evergreen Terrace"
                autoComplete="address-line1"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="City" required>
                <input
                  className={inputCls}
                  value={form.city}
                  onChange={(e) => update("city", e.target.value)}
                  placeholder="Las Vegas"
                  autoComplete="address-level2"
                />
              </Field>
              <Field label="State" required>
                <select
                  className={inputCls}
                  value={form.state}
                  onChange={(e) => update("state", e.target.value)}
                >
                  {US_STATES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="ZIP" required>
                <input
                  className={inputCls}
                  value={form.zip}
                  onChange={(e) => update("zip", e.target.value)}
                  placeholder="89101"
                  autoComplete="postal-code"
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Phone (optional)">
                <input
                  className={inputCls}
                  value={form.phone ?? ""}
                  onChange={(e) => update("phone", e.target.value)}
                  placeholder="(702) 555-0148"
                  autoComplete="tel"
                />
              </Field>
              <Field label="Default signer (optional)" hint="Name printed on the signature line.">
                <input
                  className={inputCls}
                  value={form.defaultSigner ?? ""}
                  onChange={(e) => update("defaultSigner", e.target.value)}
                  placeholder="Defaults to your name"
                />
              </Field>
            </div>
          </fieldset>

          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!valid || submitting}
            className="w-full rounded-lg bg-red-600 py-2.5 text-sm font-semibold text-white shadow-lg shadow-red-600/20 transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Creating account…" : "Create account & business"}
          </button>

          <p className="text-center text-xs text-muted-foreground">
            You can add bank accounts, payees, and check templates after signing in.
          </p>
        </form>
      </div>
    </div>
  );
}

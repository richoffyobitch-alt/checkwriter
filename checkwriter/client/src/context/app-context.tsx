import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, setSessionToken, clearSessionToken } from "@/lib/queryClient";
import { postJson } from "@/lib/api";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  mfaEnabled: boolean;
  stepUpActive: boolean;
  stepUpExpiresAt: number | null;
  /* True when field encryption uses a key supplied by the environment rather
     than the development fallback. Boolean only; the key is never sent. */
  encryptionKeyManaged?: boolean;
}

export interface BusinessWithRole {
  id: number;
  legalName: string;
  dba: string | null;
  status: string;
  role: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  defaultSigner: string | null;
  ein: string | null;
}

interface AppContextValue {
  user: AuthUser | undefined | null;
  isLoadingUser: boolean;
  needsSetup: boolean;
  isLoadingSetupStatus: boolean;
  activeBusiness: BusinessWithRole | null;
  businesses: BusinessWithRole[];
  setActiveBusinessId: (id: number | null) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  completeSetup: (data: SetupPayload) => Promise<void>;
  logout: () => Promise<void>;
  stepUp: (password: string) => Promise<void>;
  refreshUser: () => void;
}

export interface SetupPayload {
  email: string;
  name: string;
  password: string;
  legalName: string;
  dba?: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  phone?: string;
  defaultSigner?: string;
}

const AppContext = createContext<AppContextValue | null>(null);

const ACTIVE_BIZ_KEY = "cw.activeBusinessId";

export function AppProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [activeBusinessId, setActiveBusinessIdState] = useState<number | null>(() => {
    return null;
  });

  const userQuery = useQuery<AuthUser | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", "/api/auth/me");
        return (await res.json()) as AuthUser;
      } catch {
        return null;
      }
    },
    retry: false,
  });

  const user = userQuery.data;
  const isLoadingUser = userQuery.isLoading;

  /* System setup status: whether the first-run admin account has been created
     yet. Polled unconditionally (it is cheap and public) so the setup wizard
     can take over before any login is attempted. */
  const setupQuery = useQuery<{ needsSetup: boolean }>({
    queryKey: ["/api/system/status"],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", "/api/system/status");
        return (await res.json()) as { needsSetup: boolean };
      } catch {
        return { needsSetup: false };
      }
    },
    retry: false,
  });
  const needsSetup = !!setupQuery.data?.needsSetup;
  const isLoadingSetupStatus = setupQuery.isLoading;

  const businessesQuery = useQuery<BusinessWithRole[]>({
    queryKey: ["/api/businesses"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/businesses");
      return (await res.json()) as BusinessWithRole[];
    },
    enabled: !!user,
  });

  const businesses = businessesQuery.data ?? [];

  // pick the active business (persisted in-memory only; localStorage blocked in iframe)
  useEffect(() => {
    if (businesses.length && activeBusinessId == null) {
      setActiveBusinessIdState(businesses[0].id);
    }
    if (businesses.length && activeBusinessId != null && !businesses.find((b) => b.id === activeBusinessId)) {
      setActiveBusinessIdState(businesses[0].id);
    }
    if (businesses.length === 0) {
      setActiveBusinessIdState(null);
    }
  }, [businesses, activeBusinessId]);

  const activeBusiness = businesses.find((b) => b.id === activeBusinessId) ?? null;

  const setActiveBusinessId = (id: number | null) => setActiveBusinessIdState(id);

  const login = async (email: string, password: string) => {
    const data = await postJson<{ sessionToken?: string }>("/api/auth/login", { email, password });
    if (data.sessionToken) setSessionToken(data.sessionToken);
    await userQuery.refetch();
    await businessesQuery.refetch();
  };
  const register = async (email: string, name: string, password: string) => {
    const data = await postJson<{ sessionToken?: string }>("/api/auth/register", { email, name, password });
    if (data.sessionToken) setSessionToken(data.sessionToken);
    await userQuery.refetch();
    await businessesQuery.refetch();
  };
  const completeSetup = async (payload: SetupPayload) => {
    const data = await postJson<{ sessionToken?: string }>("/api/setup/first-admin", payload);
    if (data.sessionToken) setSessionToken(data.sessionToken);
    await setupQuery.refetch();
    await userQuery.refetch();
    await businessesQuery.refetch();
  };
  const logout = async () => {
    await postJson("/api/auth/logout");
    clearSessionToken();
    qc.clear();
    await userQuery.refetch();
  };
  const stepUp = async (password: string) => {
    await postJson("/api/auth/step-up", { password });
    await userQuery.refetch();
  };
  const refreshUser = () => userQuery.refetch();

  return (
    <AppContext.Provider
      value={{
        user,
        isLoadingUser,
        needsSetup,
        isLoadingSetupStatus,
        activeBusiness,
        businesses,
        setActiveBusinessId,
        login,
        register,
        completeSetup,
        logout,
        stepUp,
        refreshUser,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

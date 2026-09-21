import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/* Preview-safe auth: the deployed preview proxy strips the httpOnly session
   cookie, so we also carry an opaque bearer token (returned by /api/auth/login)
   in an Authorization header. Stored in memory + sessionStorage when available.
   The raw token is a handle only; every action is still authorized server-side. */
let _token: string | null = null;
function loadStorage(): string | null {
  try {
    return sessionStorage.getItem("cw.sessionToken");
  } catch {
    return null;
  }
}
function saveStorage(t: string) {
  try {
    sessionStorage.setItem("cw.sessionToken", t);
  } catch {
    /* sessionStorage blocked (opaque-origin iframe) — in-memory only */
  }
}
export function setSessionToken(token: string) {
  _token = token;
  saveStorage(token);
}
export function clearSessionToken() {
  _token = null;
  try {
    sessionStorage.removeItem("cw.sessionToken");
  } catch {
    /* ignore */
  }
}
export function getSessionToken(): string | null {
  if (_token) return _token;
  _token = loadStorage();
  return _token;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}`, ...extra } : extra;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: data ? authHeaders({ "Content-Type": "application/json" }) : authHeaders(),
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
      headers: authHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export { apiRequest };

/** Generic query helper for GET endpoints that may return null. */
export function useGet<T>(key: string[], enabled = true) {
  return useQuery<T>({
    queryKey: key,
    queryFn: getQueryFn<T>({ on401: "throw" }) as any,
    enabled,
  });
}

export function useApiMutation() {
  const qc = useQueryClient();
  return { qc };
}

export async function postJson<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await apiRequest("POST", url, body);
  return (await res.json()) as T;
}
export async function patchJson<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await apiRequest("PATCH", url, body);
  return (await res.json()) as T;
}

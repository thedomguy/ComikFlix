import { withBase } from "./paths";

/** Fired when any API call returns 401 (signed out / session expired): App shows the login. */
export const LOGIN_EVENT = "comikflix:login";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** JSON call to the app API. `path` is root-absolute (/api/...). Throws ApiError. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(withBase(path), {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers || {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401) window.dispatchEvent(new Event(LOGIN_EVENT));
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error || `HTTP ${res.status}`);
  return data as T;
}

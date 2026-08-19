const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
const BRIDGE_TOKEN = process.env.STATE_BRIDGE_TOKEN ?? "";

export function apiBase(): string {
  return DATA_URL || "http://127.0.0.1:8645";
}

export function bridgeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (BRIDGE_TOKEN) {
    headers.set("Authorization", `Bearer ${BRIDGE_TOKEN}`);
  }
  return fetch(`${apiBase()}${path}`, { ...init, headers });
}

import { PUBLIC_TERMINAL_CONN_ID } from "@/lib/terminal-access";

const DEFAULT_PUBLIC_PRICE_RELAY_URL = "https://relay.myifxacademy.com";

function normalizeUrl(value: string | undefined | null) {
  return (value ?? "").trim().replace(/\/$/, "");
}

export const PUBLIC_PRICE_RELAY_URL = normalizeUrl(
  process.env.NEXT_PUBLIC_PRICE_RELAY_URL
  ?? process.env.PRICE_RELAY_URL
  ?? DEFAULT_PUBLIC_PRICE_RELAY_URL
);

export const SERVER_PRICE_RELAY_URL = normalizeUrl(
  process.env.PRICE_RELAY_URL
  ?? process.env.NEXT_PUBLIC_PRICE_RELAY_URL
  ?? DEFAULT_PUBLIC_PRICE_RELAY_URL
);

export function relayConnectionId(connId?: string | null) {
  const normalized = (connId ?? "").trim();
  if (!normalized) return undefined;
  if (normalized === PUBLIC_TERMINAL_CONN_ID) return undefined;
  return normalized;
}
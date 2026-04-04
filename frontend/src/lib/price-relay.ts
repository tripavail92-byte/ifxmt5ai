const DEFAULT_PUBLIC_PRICE_RELAY_URL = "https://relay.myifxacademy.com";
const DEFAULT_PUBLIC_TERMINAL_CONN_ID = "200beae4-553b-4607-8653-8a15e5699865";

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

export const PUBLIC_RELAY_CONN_ID = normalizeUrl(
  process.env.NEXT_PUBLIC_PUBLIC_TERMINAL_CONN_ID
  ?? process.env.NEXT_PUBLIC_RELAY_SOURCE_CONNECTION_ID
  ?? DEFAULT_PUBLIC_TERMINAL_CONN_ID
);

export function relayConnectionId(connId?: string | null) {
  const normalized = (connId ?? "").trim();
  if (!normalized) return undefined;
  if (normalized === PUBLIC_RELAY_CONN_ID) return undefined;
  return normalized;
}
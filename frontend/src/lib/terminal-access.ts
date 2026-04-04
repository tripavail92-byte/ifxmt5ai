import { createClient } from "@/utils/supabase/server";

export type TerminalConnectionSummary = {
  id: string;
  broker_server: string;
  account_login: string;
  status: string | null;
  is_active: boolean | null;
};

export const PUBLIC_TERMINAL_CONN_ID = (
  process.env.PUBLIC_TERMINAL_CONN_ID
  ?? process.env.RELAY_SOURCE_CONNECTION_ID
  ?? "200beae4-553b-4607-8653-8a15e5699865"
).trim();

export const PUBLIC_TERMINAL_CONNECTION: TerminalConnectionSummary = {
  id: PUBLIC_TERMINAL_CONN_ID,
  broker_server: "Public Feed",
  account_login: "Guest Demo",
  status: "online",
  is_active: true,
};

export async function resolveTerminalAccess(requestedConnId?: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const requested = (requestedConnId ?? "").trim();

  if (!user) {
    return {
      supabase,
      user: null,
      isAuthenticated: false,
      authorized: true,
      connId: PUBLIC_TERMINAL_CONN_ID,
      connections: PUBLIC_TERMINAL_CONN_ID ? [PUBLIC_TERMINAL_CONNECTION] : [],
    };
  }

  const { data } = await supabase
    .from("mt5_user_connections")
    .select("id, broker_server, account_login, status, is_active")
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  const connections = (data ?? []) as TerminalConnectionSummary[];
  const authorized = !requested || connections.some((conn) => conn.id === requested);

  return {
    supabase,
    user,
    isAuthenticated: true,
    authorized,
    connId: authorized ? (requested || connections[0]?.id || "") : "",
    connections,
  };
}
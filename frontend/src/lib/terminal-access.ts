import { createClient } from "@/utils/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

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

export async function enforceSingleActiveConnection(
  supabase: ServerSupabaseClient,
  userId: string,
) {
  const { data, error } = await supabase
    .from("mt5_user_connections")
    .select("id, broker_server, account_login, status, is_active")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load active MT5 connections: ${error.message}`);
  }

  const connections = (data ?? []) as TerminalConnectionSummary[];
  if (connections.length <= 1) {
    return connections;
  }

  const staleIds = connections.slice(1).map((connection) => connection.id);
  const { error: cleanupError } = await supabase
    .from("mt5_user_connections")
    .delete()
    .eq("user_id", userId)
    .in("id", staleIds);

  if (cleanupError) {
    console.error("Failed to remove duplicate MT5 connections:", cleanupError);
  }

  return connections.slice(0, 1);
}

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

  const connections = await enforceSingleActiveConnection(supabase, user.id);
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
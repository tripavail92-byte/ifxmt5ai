import { randomUUID, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";

type JsonMap = Record<string, unknown>;
type AdminClient = ReturnType<typeof createAdminClient>;

const MANAGER_TOKEN = (process.env.TERMINAL_MANAGER_TOKEN ?? "").trim();
const DEFAULT_RELEASE_CHANNEL = (process.env.IFX_EA_RELEASE_CHANNEL ?? "stable").trim() || "stable";
const DEFAULT_EA_VERSION = (process.env.IFX_EA_RELEASE_VERSION ?? "dev-local").trim() || "dev-local";
const DEFAULT_EA_ARTIFACT_URL = (process.env.IFX_EA_ARTIFACT_URL ?? "").trim();
const DEFAULT_EA_SHA256 = (process.env.IFX_EA_RELEASE_SHA256 ?? "").trim();

function secureEquals(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function unauthorized(message: string, status = 401) {
  return NextResponse.json({ error: message }, { status });
}

function extractBearer(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return "";
  }
  return auth.slice(7).trim();
}

export function requireManagerAuth(req: NextRequest) {
  if (!MANAGER_TOKEN) {
    return unauthorized("TERMINAL_MANAGER_TOKEN not configured", 500);
  }

  const provided = extractBearer(req);
  if (!provided || !secureEquals(provided, MANAGER_TOKEN)) {
    return unauthorized("unauthorized");
  }

  return null;
}

export function isoNow() {
  return new Date().toISOString();
}

export async function parseJsonBody<T>(req: NextRequest) {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export function generateInstallToken() {
  return `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
}

export async function loadConnection(admin: AdminClient, connectionId: string) {
  const { data, error } = await admin
    .from("mt5_user_connections")
    .select("id, user_id, broker_server, account_login, password_ciphertext_b64, password_nonce_b64, status, is_active, created_at")
    .eq("id", connectionId)
    .limit(1);

  if (error) {
    throw new Error(`Failed to load MT5 connection: ${error.message}`);
  }

  return (data ?? [])[0] ?? null;
}

export async function upsertTerminalHost(
  admin: AdminClient,
  input: {
    hostName: string;
    hostType: string;
    capacity: number;
    metadata?: JsonMap;
    status?: string;
  },
) {
  const now = isoNow();
  const { data: existingRows, error: existingError } = await admin
    .from("terminal_hosts")
    .select("id")
    .eq("host_name", input.hostName)
    .limit(1);

  if (existingError) {
    throw new Error(`Failed to query terminal host: ${existingError.message}`);
  }

  const payload = {
    host_name: input.hostName,
    host_type: input.hostType,
    capacity: input.capacity,
    metadata: input.metadata ?? {},
    status: input.status ?? "online",
    last_seen_at: now,
    updated_at: now,
  };

  if ((existingRows ?? []).length > 0) {
    const hostId = existingRows?.[0]?.id as string;
    const { data, error } = await admin
      .from("terminal_hosts")
      .update(payload)
      .eq("id", hostId)
      .select("*")
      .limit(1);
    if (error) {
      throw new Error(`Failed to update terminal host: ${error.message}`);
    }
    return (data ?? [])[0];
  }

  const { data, error } = await admin
    .from("terminal_hosts")
    .insert({ ...payload, created_at: now })
    .select("*")
    .limit(1);

  if (error) {
    throw new Error(`Failed to register terminal host: ${error.message}`);
  }

  return (data ?? [])[0];
}

export async function pickProvisioningHost(admin: AdminClient) {
  const { data, error } = await admin
    .from("terminal_hosts")
    .select("id, host_name, host_type, status, capacity, last_seen_at, metadata")
    .eq("status", "online")
    .order("last_seen_at", { ascending: false })
    .limit(10);

  if (error) {
    throw new Error(`Failed to load terminal hosts: ${error.message}`);
  }

  const now = Date.now();
  const staleAfterMs = Math.max(
    45_000,
    (Number.parseFloat((process.env.TERMINAL_MANAGER_POLL_SEC ?? "10").trim()) || 10) * 3 * 1000,
  );

  return (data ?? []).find((host) => {
    const lastSeenAt = Date.parse(String(host.last_seen_at ?? ""));
    if (!Number.isFinite(lastSeenAt)) return false;
    return now - lastSeenAt <= staleAfterMs;
  }) ?? null;
}

export function buildDefaultEaConfig(connectionId: string): JsonMap {
  const symbols = (process.env.IFX_DEFAULT_ACTIVE_SYMBOLS
    ?? "EURUSDm,XAUUSDm,USDJPYm,AUDUSDm,USOILm,GBPUSDm")
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean);

  return {
    connection_id: connectionId,
    trade_enabled: false,
    symbols,
    structure: {
      timeframe: "5m",
      pivot_window: 2,
      bars_to_scan: 120,
      mode: "fractal",
    },
    risk: {
      risk_percent: 1,
      max_open_trades: 1,
      max_daily_loss_usd: 0,
      max_daily_trades: 3,
    },
    execution: {
      allow_market_orders: true,
      allow_pending_orders: true,
      sl_mode: "structure",
      tp_mode: "rr",
      rr_target: 2,
      break_even_enabled: false,
      trailing_enabled: false,
    },
    telemetry: {
      heartbeat_sec: 30,
      config_poll_sec: 30,
    },
  };
}

export async function ensureActiveConfig(admin: AdminClient, connectionId: string) {
  const { data, error } = await admin
    .from("ea_user_configs")
    .select("id, connection_id, version, config_json, is_active, created_at")
    .eq("connection_id", connectionId)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load EA config: ${error.message}`);
  }

  const existing = (data ?? [])[0];
  if (existing) {
    return existing;
  }

  const now = isoNow();
  const { data: inserted, error: insertError } = await admin
    .from("ea_user_configs")
    .insert({
      connection_id: connectionId,
      version: 1,
      config_json: buildDefaultEaConfig(connectionId),
      is_active: true,
      created_at: now,
      updated_at: now,
    })
    .select("id, connection_id, version, config_json, is_active, created_at")
    .limit(1);

  if (insertError) {
    throw new Error(`Failed to create default EA config: ${insertError.message}`);
  }

  return (inserted ?? [])[0];
}

export async function getReleaseManifest(admin: AdminClient, channel?: string) {
  const effectiveChannel = (channel ?? DEFAULT_RELEASE_CHANNEL).trim() || DEFAULT_RELEASE_CHANNEL;

  const { data, error } = await admin
    .from("ea_releases")
    .select("id, version, channel, artifact_url, sha256, metadata_json, is_active, created_at")
    .eq("channel", effectiveChannel)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load EA release manifest: ${error.message}`);
  }

  const latest = (data ?? [])[0];
  if (latest) {
    return latest;
  }

  return {
    id: null,
    version: DEFAULT_EA_VERSION,
    channel: effectiveChannel,
    artifact_url: DEFAULT_EA_ARTIFACT_URL,
    sha256: DEFAULT_EA_SHA256,
    metadata_json: {
      source: "env-fallback",
    },
    is_active: true,
    created_at: isoNow(),
  };
}

export async function ensureBootstrapAssignment(
  admin: AdminClient,
  input: {
    connectionId: string;
    hostId: string;
    releaseChannel?: string;
  },
) {
  const now = isoNow();
  const effectiveChannel = (input.releaseChannel ?? DEFAULT_RELEASE_CHANNEL).trim() || DEFAULT_RELEASE_CHANNEL;

  const { data: existingRows, error: existingError } = await admin
    .from("terminal_assignments")
    .select("*")
    .eq("connection_id", input.connectionId)
    .eq("host_id", input.hostId)
    .in("status", ["pending", "provisioning", "launched", "active"])
    .order("assigned_at", { ascending: false })
    .limit(1);

  if (existingError) {
    throw new Error(`Failed to load terminal assignment: ${existingError.message}`);
  }

  const existing = (existingRows ?? [])[0];
  if (existing) {
    return existing;
  }

  const { data, error } = await admin
    .from("terminal_assignments")
    .insert({
      connection_id: input.connectionId,
      host_id: input.hostId,
      status: "pending",
      install_token: generateInstallToken(),
      release_channel: effectiveChannel,
      assigned_at: now,
      updated_at: now,
    })
    .select("*")
    .limit(1);

  if (error) {
    throw new Error(`Failed to create terminal assignment: ${error.message}`);
  }

  return (data ?? [])[0];
}

export async function verifyEaAccess(admin: AdminClient, connectionId: string, installToken: string) {
  const { data: installationRows, error: installationError } = await admin
    .from("ea_installations")
    .select("*")
    .eq("connection_id", connectionId)
    .eq("install_token", installToken)
    .order("created_at", { ascending: false })
    .limit(1);

  if (installationError) {
    throw new Error(`Failed to verify EA installation: ${installationError.message}`);
  }

  const installation = (installationRows ?? [])[0];
  if (installation) {
    return { kind: "installation" as const, installation };
  }

  const { data: assignmentRows, error: assignmentError } = await admin
    .from("terminal_assignments")
    .select("*")
    .eq("connection_id", connectionId)
    .eq("install_token", installToken)
    .order("assigned_at", { ascending: false })
    .limit(1);

  if (assignmentError) {
    throw new Error(`Failed to verify EA assignment: ${assignmentError.message}`);
  }

  const assignment = (assignmentRows ?? [])[0];
  if (!assignment) {
    return null;
  }

  return { kind: "assignment" as const, assignment };
}

export function extractInstallToken(req: NextRequest) {
  const headerToken = (req.headers.get("x-ifx-install-token") ?? "").trim();
  if (headerToken) {
    return headerToken;
  }

  const bearer = extractBearer(req);
  if (bearer) {
    return bearer;
  }

  return "";
}

export async function requireEaAuth(req: NextRequest, connectionId: string) {
  const token = extractInstallToken(req);
  if (!token) {
    return { error: unauthorized("install token required"), admin: null, access: null, token: "" };
  }

  const admin = createAdminClient();
  const access = await verifyEaAccess(admin, connectionId, token);
  if (!access) {
    return { error: unauthorized("invalid install token"), admin: null, access: null, token };
  }

  return { error: null, admin, access, token };
}

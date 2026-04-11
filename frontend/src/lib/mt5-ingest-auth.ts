import crypto from "node:crypto";
import { createAdminClient } from "@/utils/supabase/admin";

const GLOBAL_INGEST_SIGNING_SECRET = (process.env.RELAY_SECRET ?? process.env.SIGNING_SECRET ?? "").trim();
const SIGNING_SECRET_CACHE_MS = Math.max(1000, Number(process.env.MT5_SIGNING_SECRET_CACHE_MS ?? 60_000) || 60_000);
const MISSING_SECRET_CACHE_MS = Math.max(1000, Number(process.env.MT5_SIGNING_SECRET_MISS_CACHE_MS ?? 5_000) || 5_000);

type SecretCacheEntry = {
  secret: string;
  expiresAt: number;
};

const signingSecretCache = new Map<string, SecretCacheEntry>();

function sha256HexUpper(body: string) {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex").toUpperCase();
}

function hmacHexUpper(secret: string, payload: string) {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex").toUpperCase();
}

export function hasSigningSecret() {
  return GLOBAL_INGEST_SIGNING_SECRET.length > 0;
}

export function getRelayAuthMode() {
  return hasSigningSecret() ? "signed-global" : "signed-scoped";
}

function getCachedSigningSecret(connectionId: string) {
  const cached = signingSecretCache.get(connectionId);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    signingSecretCache.delete(connectionId);
    return null;
  }

  return cached.secret;
}

function setCachedSigningSecret(connectionId: string, secret: string, ttlMs: number) {
  signingSecretCache.set(connectionId, {
    secret,
    expiresAt: Date.now() + ttlMs,
  });
}

async function lookupInstallationSigningSecret(connectionId: string) {
  const admin = createAdminClient();

  const { data: installationRows, error: installationError } = await admin
    .from("ea_installations")
    .select("install_token, updated_at")
    .eq("connection_id", connectionId)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (installationError) {
    throw new Error(`Failed to load EA installation signing secret: ${installationError.message}`);
  }

  const installationToken = (installationRows?.[0]?.install_token ?? "").trim();
  if (installationToken) {
    return installationToken;
  }

  const { data: assignmentRows, error: assignmentError } = await admin
    .from("terminal_assignments")
    .select("install_token, assigned_at")
    .eq("connection_id", connectionId)
    .in("status", ["pending", "provisioning", "launched", "active", "retry"])
    .order("assigned_at", { ascending: false })
    .limit(1);

  if (assignmentError) {
    throw new Error(`Failed to load terminal assignment signing secret: ${assignmentError.message}`);
  }

  return (assignmentRows?.[0]?.install_token ?? "").trim();
}

async function resolveSigningSecret(connectionId: string) {
  const cached = getCachedSigningSecret(connectionId);
  if (cached !== null) {
    return cached;
  }

  const scopedSecret = await lookupInstallationSigningSecret(connectionId);
  if (scopedSecret) {
    setCachedSigningSecret(connectionId, scopedSecret, SIGNING_SECRET_CACHE_MS);
    return scopedSecret;
  }

  if (GLOBAL_INGEST_SIGNING_SECRET) {
    setCachedSigningSecret(connectionId, GLOBAL_INGEST_SIGNING_SECRET, SIGNING_SECRET_CACHE_MS);
    return GLOBAL_INGEST_SIGNING_SECRET;
  }

  setCachedSigningSecret(connectionId, "", MISSING_SECRET_CACHE_MS);
  return "";
}

export async function verifySignedBody(opts: {
  connectionId: string;
  canonicalPath: string;
  bodyText: string;
  ts: string;
  nonce: string;
  signature: string;
}) {
  if (!opts.ts || !opts.nonce || !opts.signature) return false;

  const signingSecret = await resolveSigningSecret(opts.connectionId);
  if (!signingSecret) return false;

  const bodyHash = sha256HexUpper(opts.bodyText);
  const stringToSign = `POST\n${opts.canonicalPath}\n${opts.ts}\n${opts.nonce}\n${bodyHash}`;
  const expected = hmacHexUpper(signingSecret, stringToSign);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(opts.signature.toUpperCase(), "utf8");

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}
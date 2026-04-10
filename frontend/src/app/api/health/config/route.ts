import { NextResponse } from "next/server";

export const runtime = "nodejs";

function present(name: string) {
  const raw = process.env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  return {
    present: value.length > 0,
    length: value.length,
  };
}

function decodedMasterKeyLength() {
  const raw = (process.env.MT5_CREDENTIALS_MASTER_KEY_B64 ?? "").trim();
  if (!raw) return 0;
  try {
    return Buffer.from(raw, "base64").length;
  } catch {
    return -1;
  }
}

export async function GET() {
  const checks = {
    NEXT_PUBLIC_SUPABASE_URL: present("NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: present("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    SUPABASE_SERVICE_ROLE_KEY: present("SUPABASE_SERVICE_ROLE_KEY"),
    MT5_CREDENTIALS_MASTER_KEY_B64: present("MT5_CREDENTIALS_MASTER_KEY_B64"),
    RELAY_INGEST_TOKEN: present("RELAY_INGEST_TOKEN"),
    RELAY_SECRET: present("RELAY_SECRET"),
    REDIS_URL: present("REDIS_URL"),
    PRICE_RELAY_URL: present("PRICE_RELAY_URL"),
  };

  return NextResponse.json(
    {
      ok: true,
      checks,
      mt5_master_key_decoded_bytes: decodedMasterKeyLength(),
      note: "No secrets are returned; only presence/length metadata.",
    },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}

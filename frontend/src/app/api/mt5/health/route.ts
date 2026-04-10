import { handleRelayHealth } from "@/lib/mt5-ingest-service";

export const runtime = "nodejs";

export async function GET() {
  return handleRelayHealth();
}
import { NextRequest } from "next/server";
import { handleTickBatch } from "@/lib/mt5-ingest-service";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return handleTickBatch(req, "/tick-batch", "signed");
}
import { NextRequest } from "next/server";
import { handleCandleClose } from "@/lib/mt5-ingest-service";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return handleCandleClose(req, "/candle-close", "signed");
}
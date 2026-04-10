import { NextRequest } from "next/server";
import { handleHistoricalBulk } from "@/lib/mt5-ingest-service";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return handleHistoricalBulk(req, "/historical-bulk", "signed");
}
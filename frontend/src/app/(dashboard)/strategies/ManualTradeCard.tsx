"use client";

import { useState, useEffect, useTransition } from "react";
import dynamic from "next/dynamic";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { placeManualTrade } from "./actions";
import { createClient } from "@/utils/supabase/client";

// Loaded only on the client — lightweight-charts requires window/DOM
const CandlestickChart = dynamic(
  () => import("@/components/chart/CandlestickChart").then((m) => ({ default: m.CandlestickChart })),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-[340px] rounded-lg bg-[#0c0c0c] border border-[#2a2a2a] animate-pulse" />
    ),
  }
);

interface Connection {
  id: string;
  broker_server: string;
  account_login: string;
}

interface Symbol {
  symbol: string;
  description: string;
  category: string;
}

export function ManualTradeCard({ connections }: { connections: Connection[] }) {
  const [selectedConn, setSelectedConn] = useState("");
  const [symbols, setSymbols] = useState<Symbol[]>([]);
  const [symbolSearch, setSymbolSearch] = useState("");
  const [loadingSymbols, setLoadingSymbols] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  // Chart state — controlled so price lines update live as user types
  const [chartSymbol, setChartSymbol] = useState("EURUSD");
  const [slValue, setSlValue] = useState<number | undefined>();
  const [tpValue, setTpValue] = useState<number | undefined>();

  // Load symbols when connection changes
  useEffect(() => {
    if (!selectedConn) { setSymbols([]); return; }
    setLoadingSymbols(true);
    setSymbols([]);
    setSymbolSearch("");

    const supabase = createClient();
    supabase
      .from("mt5_symbols")
      .select("symbol, description, category")
      .eq("connection_id", selectedConn)
      .order("symbol")
      .then(({ data }) => {
        setSymbols(data ?? []);
        setLoadingSymbols(false);
      });
  }, [selectedConn]);

  const filtered = symbolSearch.length > 0
    ? symbols.filter(s =>
        s.symbol.toLowerCase().includes(symbolSearch.toLowerCase()) ||
        s.description?.toLowerCase().includes(symbolSearch.toLowerCase())
      ).slice(0, 80)
    : symbols.slice(0, 80);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setResult(null);
    startTransition(async () => {
      try {
        await placeManualTrade(fd);
        setResult({ ok: true, msg: "✅ Trade queued! Check Trades page for execution status." });
        (e.target as HTMLFormElement).reset();
        setSelectedConn("");
        setSymbols([]);
        setSlValue(undefined);
        setTpValue(undefined);
      } catch (err: unknown) {
        setResult({ ok: false, msg: `❌ ${err instanceof Error ? err.message : "Unknown error"}` });
      }
    });
  }

  return (
    <Card className="border-2 border-orange-500/40 shadow-md bg-orange-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">🧪 Manual Trade — Live Test</CardTitle>
        <CardDescription>
          Inject a trade job directly. The live worker claims and executes it within seconds.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Live chart — SL/TP lines update as you type */}
        <CandlestickChart
          symbol={chartSymbol}
          sl={slValue}
          tp={tpValue}
          className="mb-5"
        />
        <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6 items-end">

          {/* Account */}
          <div className="space-y-2 lg:col-span-2">
            <Label>Account</Label>
            <Select
              name="connection_id"
              required
              value={selectedConn}
              onValueChange={setSelectedConn}
            >
              <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.broker_server} — {c.account_login}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Symbol search + dropdown */}
          <div className="space-y-2 lg:col-span-2">
            <Label>Symbol</Label>
            {loadingSymbols ? (
              <div className="h-9 flex items-center text-sm text-muted-foreground px-3 border rounded-md">Loading symbols…</div>
            ) : symbols.length > 0 ? (
              <div className="relative">
                <Input
                  placeholder="Search symbol e.g. EURUSD"
                  value={symbolSearch}
                  onChange={(e) => setSymbolSearch(e.target.value)}
                  className="mb-1"
                />
                <Select name="symbol" required onValueChange={(v) => setChartSymbol(v)}>
                  <SelectTrigger><SelectValue placeholder="Select symbol" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {filtered.map((s) => (
                      <SelectItem key={s.symbol} value={s.symbol}>
                        <span className="font-mono font-semibold">{s.symbol}</span>
                        {s.description && <span className="ml-2 text-xs text-muted-foreground">{s.description}</span>}
                      </SelectItem>
                    ))}
                    {filtered.length === 0 && (
                      <div className="p-2 text-sm text-muted-foreground">No match</div>
                    )}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <Input name="symbol" placeholder={selectedConn ? "Type symbol e.g. EURUSD" : "Select account first"} required />
            )}
          </div>

          {/* Side */}
          <div className="space-y-2">
            <Label>Side</Label>
            <Select name="side" required>
              <SelectTrigger><SelectValue placeholder="Buy / Sell" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="buy">🟢 Buy</SelectItem>
                <SelectItem value="sell">🔴 Sell</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Volume */}
          <div className="space-y-2">
            <Label>Volume (lots)</Label>
            <Input name="volume" type="number" step="0.01" min="0.01" placeholder="0.01" required />
          </div>

          {/* SL / TP — controlled so chart price lines update live */}
          <div className="space-y-2">
            <Label>SL (optional)</Label>
            <Input
              name="sl"
              type="number"
              step="0.00001"
              placeholder="0.00000"
              value={slValue ?? ""}
              onChange={(e) => setSlValue(e.target.value ? parseFloat(e.target.value) : undefined)}
            />
          </div>
          <div className="space-y-2">
            <Label>TP (optional)</Label>
            <Input
              name="tp"
              type="number"
              step="0.00001"
              placeholder="0.00000"
              value={tpValue ?? ""}
              onChange={(e) => setTpValue(e.target.value ? parseFloat(e.target.value) : undefined)}
            />
          </div>

          {/* Submit */}
          <div className="lg:col-span-6">
            <Button
              type="submit"
              disabled={isPending}
              className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold"
            >
              {isPending ? "Placing…" : "🚀 Place Trade Now"}
            </Button>
          </div>
        </form>

        {result && (
          <div className={`mt-3 p-3 rounded-md text-sm font-medium ${result.ok ? "bg-green-500/10 text-green-600" : "bg-destructive/10 text-destructive"}`}>
            {result.msg}
          </div>
        )}

        <p className="mt-3 text-xs text-muted-foreground">
          After placing, check the{" "}
          <a href="/trades" className="underline">Trades page</a> and{" "}
          <a href="/logs" className="underline">System Logs</a> for real-time execution updates.
        </p>
      </CardContent>
    </Card>
  );
}

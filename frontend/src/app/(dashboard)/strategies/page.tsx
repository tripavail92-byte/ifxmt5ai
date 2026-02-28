import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createClient } from "@/utils/supabase/server";
import { saveStrategy, placeManualTrade } from "./actions";

export default async function StrategiesPage() {
  const supabase = await createClient();
  
  const { data: connections } = await supabase
    .from("mt5_user_connections")
    .select("id, broker_server, account_login")
    .eq("is_active", true);

  const { data: strategies, error } = await supabase
    .from("user_strategies")
    .select(`*, mt5_user_connections (account_login, broker_server)`)
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold md:text-2xl">Strategy Configuration</h1>

      <div className="grid gap-6 md:grid-cols-3">
        {/* CONFIGURE RISK */}
        <Card className="md:col-span-1 border shadow-sm">
          <CardHeader>
            <CardTitle>Configure Risk</CardTitle>
            <CardDescription>Set the AI trading parameters</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={saveStrategy} className="space-y-4">
              <div className="space-y-2">
                <Label>Account</Label>
                <Select name="connection_id" required>
                  <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                  <SelectContent>
                    {connections?.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.broker_server} — {c.account_login}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Risk % per trade</Label>
                <Input name="risk_percent" type="number" step="0.1" max="10" defaultValue="1.0" required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Max Daily Trades</Label>
                  <Input name="max_daily_trades" type="number" defaultValue="5" required />
                </div>
                <div className="space-y-2">
                  <Label>Max Open Trades</Label>
                  <Input name="max_open_trades" type="number" defaultValue="3" required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Min R:R</Label>
                  <Input name="rr_min" type="number" step="0.1" defaultValue="1.5" required />
                </div>
                <div className="space-y-2">
                  <Label>Max R:R</Label>
                  <Input name="rr_max" type="number" step="0.1" defaultValue="5.0" required />
                </div>
              </div>
              <Button type="submit" className="w-full">Save Configuration</Button>
            </form>
          </CardContent>
        </Card>

        {/* STRATEGIES LIST */}
        <Card className="md:col-span-2 shadow-sm">
          <CardHeader>
            <CardTitle>Active Strategies</CardTitle>
            <CardDescription>Current risk parameters across accounts</CardDescription>
          </CardHeader>
          <CardContent>
            {error ? (
              <div className="text-destructive">Error: {error.message}</div>
            ) : strategies && strategies.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Risk</TableHead>
                    <TableHead>Daily / Open</TableHead>
                    <TableHead>R:R</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {strategies.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.mt5_user_connections?.account_login}</TableCell>
                      <TableCell>{s.risk_percent}%</TableCell>
                      <TableCell>{s.max_daily_trades} / {s.max_open_trades}</TableCell>
                      <TableCell>{s.rr_min} – {s.rr_max}</TableCell>
                      <TableCell>
                        <Badge variant={s.is_active ? "default" : "secondary"}>
                          {s.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center p-8 border border-dashed rounded-lg text-muted-foreground">
                No active strategies. Configure one to let the AI trade.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── MANUAL TRADE PANEL ─────────────────────────────── */}
      <Card className="border-2 border-orange-500/40 shadow-md bg-orange-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            🧪 Manual Trade — Live Test
          </CardTitle>
          <CardDescription>
            Inject a trade job directly. The live worker will claim and execute it within seconds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={placeManualTrade} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6 items-end">
            {/* Connection */}
            <div className="space-y-2 lg:col-span-2">
              <Label>Account</Label>
              <Select name="connection_id" required>
                <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {connections?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.broker_server} — {c.account_login}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Symbol */}
            <div className="space-y-2">
              <Label>Symbol</Label>
              <Input name="symbol" placeholder="EURUSD" required />
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

            {/* SL / TP */}
            <div className="space-y-2">
              <Label>SL (optional)</Label>
              <Input name="sl" type="number" step="0.00001" placeholder="0.0" />
            </div>

            <div className="space-y-2">
              <Label>TP (optional)</Label>
              <Input name="tp" type="number" step="0.00001" placeholder="0.0" />
            </div>

            {/* Submit */}
            <div className="lg:col-span-6">
              <Button type="submit" variant="default" className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold">
                🚀 Place Trade Now
              </Button>
            </div>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            After placing, check the <a href="/trades" className="underline">Trades page</a> and <a href="/logs" className="underline">System Logs</a> to see execution status in real-time.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

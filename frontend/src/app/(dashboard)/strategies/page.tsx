import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createClient } from "@/utils/supabase/server";
import { saveStrategy } from "./actions";

export default async function StrategiesPage() {
  const supabase = await createClient();
  
  // Fetch connections for the dropdown
  const { data: connections } = await supabase
    .from("mt5_user_connections")
    .select("id, broker_server, account_login")
    .eq("is_active", true);

  // Fetch existing strategies
  const { data: strategies, error } = await supabase
    .from("user_strategies")
    .select(`
      *,
      mt5_user_connections (account_login, broker_server)
    `)
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold md:text-2xl">Strategy Configuration</h1>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* ADD STRATEGY FORM */}
        <Card className="md:col-span-1 border shadow-sm">
          <CardHeader>
            <CardTitle>Configure Risk</CardTitle>
            <CardDescription>Set the AI trading parameters</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={saveStrategy} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="connection_id">Select Account</Label>
                <Select name="connection_id" required>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an active MT5 account" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections?.map((conn) => (
                      <SelectItem key={conn.id} value={conn.id}>
                        {conn.broker_server} - {conn.account_login}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="risk_percent">Risk % per trade</Label>
                <Input id="risk_percent" name="risk_percent" type="number" step="0.1" max="10" defaultValue="1.0" required />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="max_daily_trades">Max Daily Trades</Label>
                  <Input id="max_daily_trades" name="max_daily_trades" type="number" defaultValue="5" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max_open_trades">Max Open Trades</Label>
                  <Input id="max_open_trades" name="max_open_trades" type="number" defaultValue="3" required />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rr_min">Min Reward/Risk</Label>
                  <Input id="rr_min" name="rr_min" type="number" step="0.1" defaultValue="1.5" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rr_max">Max Reward/Risk</Label>
                  <Input id="rr_max" name="rr_max" type="number" step="0.1" defaultValue="5.0" required />
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
                    <TableHead>Daily M/O</TableHead>
                    <TableHead>Target R:R</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {strategies.map((strat) => (
                    <TableRow key={strat.id}>
                      <TableCell className="font-medium">
                        {strat.mt5_user_connections?.account_login}
                      </TableCell>
                      <TableCell>{strat.risk_percent}%</TableCell>
                      <TableCell>{strat.max_daily_trades} / {strat.max_open_trades}</TableCell>
                      <TableCell>{strat.rr_min} - {strat.rr_max}</TableCell>
                      <TableCell>
                        <Badge variant={strat.is_active ? "default" : "secondary"}>
                          {strat.is_active ? "Active" : "Inactive"}
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
    </div>
  );
}

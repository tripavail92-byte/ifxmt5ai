import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Activity, Network, Clock, CheckCircle } from "lucide-react";
import { createClient } from "@/utils/supabase/server";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default async function Dashboard() {
  const supabase = await createClient();

  // Fetch summary counts
  const [{ count: activeConnections }, { count: activeStrategies }, { count: completedTrades }] = await Promise.all([
    supabase.from("mt5_user_connections").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("user_strategies").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("trade_jobs").select("*", { count: "exact", head: true }).eq("status", "success")
  ]);

  // Fetch live worker heartbeats
  const { data: heartbeats } = await supabase
    .from("mt5_worker_heartbeats")
    .select(`
      *,
      mt5_user_connections (account_login, broker_server)
    `)
    .order("last_seen_at", { ascending: false });

  // Fetch recent runtime events
  const { data: events } = await supabase
    .from("mt5_runtime_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold md:text-2xl">Dashboard</h1>
        <Button asChild>
          <Link href="/connections">
            <Network className="mr-2 h-4 w-4" />
            Connect MT5 Terminal
          </Link>
        </Button>
      </div>
      
      <div className="grid gap-4 md:grid-cols-2 md:gap-8 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Connected</CardTitle>
            <Network className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeConnections || 0}</div>
            <p className="text-xs text-muted-foreground">MT5 terminals configured</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Strategies</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeStrategies || 0}</div>
            <p className="text-xs text-muted-foreground">Across all accounts</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Trades Executed</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{completedTrades || 0}</div>
            <p className="text-xs text-muted-foreground">Total successful executions</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Live Workers</CardTitle>
            <Clock className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{heartbeats?.filter(h => h.status === 'online').length || 0}</div>
            <p className="text-xs text-muted-foreground">Online right now</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:gap-8 lg:grid-cols-2 xl:grid-cols-3">
        <Card className="xl:col-span-2 shadow-sm">
          <CardHeader>
            <CardTitle>Worker Health</CardTitle>
            <CardDescription>Live heartbeat status of all MT5 terminals</CardDescription>
          </CardHeader>
          <CardContent>
            {heartbeats && heartbeats.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>PID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {heartbeats.map((hb) => {
                    const isStale = new Date().getTime() - new Date(hb.last_seen_at).getTime() > 30000; // 30s
                    return (
                      <TableRow key={hb.connection_id}>
                        <TableCell className="font-medium">
                          {hb.account_login || hb.mt5_user_connections?.account_login}
                        </TableCell>
                        <TableCell className="font-mono text-sm">{hb.pid}</TableCell>
                        <TableCell>
                          <Badge variant={isStale ? "destructive" : hb.status === "online" ? "default" : "secondary"}>
                            {isStale ? "stale" : hb.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {new Date(hb.last_seen_at).toLocaleTimeString()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <div className="flex items-center justify-center p-8 text-muted-foreground border border-dashed rounded-lg">
                No workers currently checking in.
              </div>
            )}
          </CardContent>
        </Card>
        
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>System Events</CardTitle>
            <CardDescription>Recent runtime logs</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {events && events.length > 0 ? (
                events.map(ev => (
                  <div key={ev.id} className="flex flex-col gap-1 border-b pb-2 last:border-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold capitalize bg-muted px-2 py-0.5 rounded">
                        {ev.component}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(ev.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className={`text-sm ${ev.level === 'error' ? 'text-destructive font-medium' : ''}`}>
                      {ev.message}
                    </p>
                  </div>
                ))
              ) : (
                <div className="text-sm text-muted-foreground text-center">No recent events.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

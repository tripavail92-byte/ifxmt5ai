import { redirect } from "next/navigation";
import { Activity, AlertTriangle, Cpu, Network, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isAdminEmail } from "@/lib/authz";
import { RuntimeStatusPanel } from "../RuntimeStatusPanel";

type AuditSummary = {
  overall_status?: string;
  relay_ok?: boolean;
  supervisor_ok?: boolean;
  active_connections?: number;
  fresh_heartbeats?: number;
  stale_heartbeats?: number;
  queued_jobs?: number;
  stuck_jobs?: number;
  emitted_at?: string;
  findings?: Array<{ severity?: string; message?: string }>;
};

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdminEmail(user?.email)) {
    redirect("/");
  }

  const admin = createAdminClient();

  const [
    { count: totalConnections },
    { count: onlineConnections },
    { count: queuedJobs },
    { count: successTrades },
    { data: heartbeats },
    { data: connections },
    { data: auditEvents },
    { data: runtimeEvents },
  ] = await Promise.all([
    admin.from("mt5_user_connections").select("*", { count: "exact", head: true }),
    admin.from("mt5_user_connections").select("*", { count: "exact", head: true }).eq("status", "online"),
    admin.from("trade_jobs").select("*", { count: "exact", head: true }).in("status", ["queued", "claimed", "executing", "retry"]),
    admin.from("trade_jobs").select("*", { count: "exact", head: true }).eq("status", "success"),
    admin.from("mt5_worker_heartbeats").select("*").order("last_seen_at", { ascending: false }),
    admin.from("mt5_user_connections").select("id,user_id,broker_server,account_login,status,last_error,last_seen_at,last_ok_at,created_at").order("created_at", { ascending: false }).limit(25),
    admin.from("mt5_runtime_events").select("message,details,created_at").eq("component", "supervisor").like("message", "[runtime_audit]%").order("created_at", { ascending: false }).limit(1),
    admin.from("mt5_runtime_events").select("id,level,component,message,created_at").order("created_at", { ascending: false }).limit(12),
  ]);

  const runtimeAudit = (auditEvents?.[0]?.details as AuditSummary | undefined)
    ? {
        ...(auditEvents?.[0]?.details as AuditSummary),
        emitted_at: (auditEvents?.[0]?.details as AuditSummary).emitted_at ?? auditEvents?.[0]?.created_at,
      }
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold md:text-2xl">Admin Portal</h1>
          <p className="text-sm text-muted-foreground">Global runtime command view for relay, supervisor, workers, connections, and queue health.</p>
        </div>
        <Badge variant="secondary" className="gap-1 px-3 py-1">
          <ShieldCheck className="h-4 w-4" />
          Admin only
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="text-3xl font-bold">{totalConnections || 0}</div>
              <Network className="h-5 w-5 text-primary" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Online Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="text-3xl font-bold">{onlineConnections || 0}</div>
              <Activity className="h-5 w-5 text-emerald-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-transparent shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Queued Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="text-3xl font-bold">{queuedJobs || 0}</div>
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-sky-500/20 bg-gradient-to-br from-sky-500/5 to-transparent shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Successful Trades</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="text-3xl font-bold">{successTrades || 0}</div>
              <Cpu className="h-5 w-5 text-sky-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      <RuntimeStatusPanel summary={runtimeAudit} />

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3 shadow-sm">
          <CardHeader>
            <CardTitle>Connection Fleet</CardTitle>
            <CardDescription>Top 25 MT5 connections across all users with status and latest broker/runtime signal.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Server</TableHead>
                  <TableHead>Login</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Seen</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(connections || []).map((conn) => (
                  <TableRow key={conn.id}>
                    <TableCell className="font-medium">{conn.broker_server}</TableCell>
                    <TableCell>{conn.account_login}</TableCell>
                    <TableCell>
                      <Badge variant={conn.status === "online" ? "secondary" : conn.status === "degraded" ? "default" : "destructive"}>
                        {conn.status || "unknown"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {conn.last_seen_at ? new Date(conn.last_seen_at).toLocaleString() : "-"}
                    </TableCell>
                    <TableCell className="max-w-[240px] truncate text-sm text-muted-foreground">
                      {conn.last_error || "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2 shadow-sm">
          <CardHeader>
            <CardTitle>Worker Watch</CardTitle>
            <CardDescription>Latest worker heartbeats across the fleet.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {(heartbeats || []).slice(0, 12).map((hb) => {
                const stale = Date.now() - new Date(hb.last_seen_at).getTime() > 45000;
                return (
                  <div key={hb.connection_id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-medium">{hb.account_login || hb.connection_id}</div>
                        <div className="text-xs text-muted-foreground">PID {hb.pid} · {hb.connection_id}</div>
                      </div>
                      <Badge variant={stale ? "destructive" : hb.status === "online" ? "secondary" : "default"}>
                        {stale ? "stale" : hb.status}
                      </Badge>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Last seen {new Date(hb.last_seen_at).toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Recent Platform Events</CardTitle>
          <CardDescription>Latest runtime events across the entire system.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 font-mono text-xs">
            {(runtimeEvents || []).map((event) => (
              <div key={event.id} className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant={event.level === "error" ? "destructive" : event.level === "warn" ? "default" : "secondary"} className="uppercase">
                    {event.level}
                  </Badge>
                  <span className="text-muted-foreground">{event.component}</span>
                  <span>{event.message}</span>
                </div>
                <span className="text-muted-foreground">{new Date(event.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

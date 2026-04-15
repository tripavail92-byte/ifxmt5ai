import { redirect } from "next/navigation";
import { Activity, AlertTriangle, Cpu, Network, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isAdminEmail } from "@/lib/authz";
import { RuntimeStatusPanel } from "../RuntimeStatusPanel";

type EaCommandAckRow = {
  id: string;
  command_id: string;
  sequence_no: number;
  status: string;
  ack_payload_json?: Record<string, unknown> | null;
  acknowledged_at?: string | null;
  created_at: string;
};

type EaRuntimeEventRow = {
  id: number;
  event_type: string;
  payload?: Record<string, unknown> | null;
  created_at: string;
};

type AdminSignalItem = {
  id: string;
  kind: "ack" | "event";
  title: string;
  detail: string;
  status: string;
  timestamp: string;
};

type AuditSummary = {
  overall_status?: string;
  relay_ok?: boolean;
  terminal_manager_ok?: boolean;
  active_connections?: number;
  fresh_terminal_signals?: number;
  stale_terminal_signals?: number;
  pending_actions?: number;
  stuck_actions?: number;
  deprecated_processes?: number;
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
    { count: pendingEaCommands },
    { count: acknowledgedEaCommands },
    { count: executionEvents },
    { data: heartbeats },
    { data: connections },
    { data: auditEvents },
    { data: commandAcks },
    { data: eaEvents },
  ] = await Promise.all([
    admin.from("mt5_user_connections").select("*", { count: "exact", head: true }),
    admin.from("mt5_user_connections").select("*", { count: "exact", head: true }).eq("status", "online"),
    admin.from("ea_commands").select("*", { count: "exact", head: true }).eq("status", "pending"),
    admin.from("ea_command_acks").select("*", { count: "exact", head: true }).eq("status", "acknowledged"),
    admin.from("ea_runtime_events").select("*", { count: "exact", head: true }).eq("event_type", "armed_trade_executed"),
    admin.from("mt5_worker_heartbeats").select("*").order("last_seen_at", { ascending: false }),
    admin.from("mt5_user_connections").select("id,user_id,broker_server,account_login,status,last_error,last_seen_at,last_ok_at,created_at").order("created_at", { ascending: false }).limit(25),
    admin.from("mt5_runtime_events").select("message,details,created_at").like("message", "[runtime_audit]%").order("created_at", { ascending: false }).limit(1),
    admin.from("ea_command_acks").select("id,command_id,sequence_no,status,ack_payload_json,acknowledged_at,created_at").order("acknowledged_at", { ascending: false }).limit(12),
    admin.from("ea_runtime_events").select("id,event_type,payload,created_at").order("created_at", { ascending: false }).limit(12),
  ]);

  const eaSignalStream: AdminSignalItem[] = [
    ...((commandAcks ?? []) as EaCommandAckRow[]).map((ack) => {
      const payload = (ack.ack_payload_json ?? {}) as Record<string, unknown>;
      const reason = typeof payload.reason === "string" && payload.reason.trim()
        ? payload.reason.trim()
        : `command ${ack.command_id}`;
      return {
        id: `ack-${ack.id}`,
        kind: "ack" as const,
        title: `Ack #${ack.sequence_no}`,
        detail: `${ack.status} · ${reason}`,
        status: ack.status,
        timestamp: ack.acknowledged_at || ack.created_at,
      };
    }),
    ...((eaEvents ?? []) as EaRuntimeEventRow[]).map((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const nestedPayload = payload.payload && typeof payload.payload === "object"
        ? (payload.payload as Record<string, unknown>)
        : null;
      const symbol = typeof payload.symbol === "string" ? payload.symbol : event.event_type;
      const side = typeof payload.side === "string" ? payload.side.toUpperCase() : null;
      const volume = typeof nestedPayload?.volume === "number" ? `${nestedPayload.volume} lots` : null;
      const detail = event.event_type === "armed_trade_executed"
        ? [event.event_type, side, volume].filter(Boolean).join(" · ")
        : event.event_type === "command_processed"
          ? `${String(payload.status ?? "processed")} · ${String(payload.command_type ?? "command")}`
          : event.event_type;

      return {
        id: `event-${event.id}`,
        kind: "event" as const,
        title: symbol,
        detail,
        status: event.event_type,
        timestamp: event.created_at,
      };
    }),
  ]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, 12);

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
          <p className="text-sm text-muted-foreground">Global EA-first view for command delivery, runtime execution signals, terminal health, and connection status.</p>
        </div>
        <Badge variant="secondary" className="gap-1 px-3 py-1">
          <ShieldCheck className="h-4 w-4" />
          Admin only
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
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
            <CardTitle className="text-sm font-medium">Pending EA Commands</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="text-3xl font-bold">{pendingEaCommands || 0}</div>
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-sky-500/20 bg-gradient-to-br from-sky-500/5 to-transparent shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">EA Command Acks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="text-3xl font-bold">{acknowledgedEaCommands || 0}</div>
              <Cpu className="h-5 w-5 text-sky-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-fuchsia-500/20 bg-gradient-to-br from-fuchsia-500/5 to-transparent shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">EA Execution Events</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="text-3xl font-bold">{executionEvents || 0}</div>
              <Cpu className="h-5 w-5 text-fuchsia-500" />
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
            <CardTitle>Terminal Heartbeat Watch</CardTitle>
            <CardDescription>Latest terminal heartbeats across the fleet.</CardDescription>
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
                        <div className="text-xs text-muted-foreground">Terminal heartbeat · {hb.connection_id}</div>
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
          <CardTitle>Recent EA Delivery + Execution</CardTitle>
          <CardDescription>Latest command acknowledgements and EA runtime execution events across the fleet.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 font-mono text-xs">
            {eaSignalStream.map((event) => (
              <div key={event.id} className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant={event.kind === "ack" ? "secondary" : "default"} className="uppercase">
                    {event.kind}
                  </Badge>
                  <span className="text-muted-foreground">{event.status}</span>
                  <span>{event.title}</span>
                  <span className="text-muted-foreground">{event.detail}</span>
                </div>
                <span className="text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

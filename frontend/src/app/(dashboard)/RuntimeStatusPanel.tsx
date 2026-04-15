import { AlertTriangle, CheckCircle2, Clock3, ServerCog } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Finding = {
  severity?: string;
  message?: string;
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
  findings?: Finding[];
};

function statusVariant(status: string | undefined): "default" | "secondary" | "destructive" {
  if (status === "critical") return "destructive";
  if (status === "warning") return "default";
  return "secondary";
}

function boolVariant(ok: boolean | undefined): "default" | "secondary" | "destructive" {
  if (ok === false) return "destructive";
  if (ok === true) return "secondary";
  return "default";
}

export function RuntimeStatusPanel({ summary }: { summary: AuditSummary | null }) {
  const findings = summary?.findings ?? [];
  const updatedAt = summary?.emitted_at ? new Date(summary.emitted_at) : null;
  const isFresh = updatedAt ? Date.now() - updatedAt.getTime() <= 2 * 60 * 1000 : false;

  return (
    <Card className="shadow-sm xl:col-span-3">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Runtime Status</CardTitle>
            <CardDescription>Public relay, terminal manager heartbeat, terminal signals, and pending action health from the latest production audit</CardDescription>
          </div>
          {summary ? (
            <div className="flex items-center gap-2">
              <Badge variant={statusVariant(summary.overall_status)} className="uppercase">
                {summary.overall_status ?? "unknown"}
              </Badge>
              <Badge variant={isFresh ? "secondary" : "destructive"}>
                {isFresh ? "fresh" : "stale"}
              </Badge>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {summary ? (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <ServerCog className="h-4 w-4 text-muted-foreground" />
                  Core Services
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span>Public Relay</span>
                    <Badge variant={boolVariant(summary.relay_ok)}>{summary.relay_ok ? "online" : "down"}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Terminal Manager</span>
                    <Badge variant={boolVariant(summary.terminal_manager_ok)}>{summary.terminal_manager_ok ? "online" : "down"}</Badge>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                  Terminal Coverage
                </div>
                <div className="text-2xl font-bold">
                  {summary.fresh_terminal_signals ?? 0}/{summary.active_connections ?? 0}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  fresh terminal signals / active connections
                </p>
              </div>

              <div className="rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Clock3 className="h-4 w-4 text-muted-foreground" />
                  Pending Actions
                </div>
                <div className="text-2xl font-bold">{summary.pending_actions ?? 0}</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  pending EA commands or legacy jobs, {summary.stuck_actions ?? 0} stuck
                </p>
              </div>

              <div className="rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                  Audit Timestamp
                </div>
                <div className="text-sm font-semibold">
                  {updatedAt ? updatedAt.toLocaleString() : "No audit recorded"}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  stale if older than 2 minutes
                </p>
              </div>
            </div>

            <div className="rounded-lg border">
              <div className="border-b px-4 py-3 text-sm font-medium">Current Findings</div>
              <div className="divide-y">
                {findings.length > 0 ? (
                  findings.map((finding, index) => (
                    <div key={`${finding.message}-${index}`} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
                      <span className="text-foreground">{finding.message}</span>
                      <Badge variant={finding.severity === "critical" ? "destructive" : "default"} className="uppercase">
                        {finding.severity}
                      </Badge>
                    </div>
                  ))
                ) : (
                  <div className="px-4 py-3 text-sm text-muted-foreground">
                    No active warnings. Latest audit is clean.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No runtime audit has been recorded yet.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, Clock3, Link2, Network, TrendingUp } from "lucide-react";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { Button } from "@/components/ui/button";
import { enforceSingleActiveConnection } from "@/lib/terminal-access";
import { getConnectionExecutionMode } from "@/lib/ea-control-plane";
import Link from "next/link";

export default async function Dashboard() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const activeConnection = user?.id
    ? (await enforceSingleActiveConnection(supabase, user.id))[0] ?? null
    : null;

  const executionMode = activeConnection
    ? await getConnectionExecutionMode(admin, activeConnection.id).catch(() => "legacy-worker")
    : null;

  const [{ count: completedTrades }, { count: queuedTrades }, { count: eaRecordedTrades }, { count: pendingEaCommands }, heartbeatResult, eventsResult] = await Promise.all([
    supabase.from("trade_jobs").select("*", { count: "exact", head: true }).eq("status", "success"),
    supabase.from("trade_jobs").select("*", { count: "exact", head: true }).in("status", ["queued", "claimed", "executing", "retry"]),
    activeConnection
      ? supabase.from("ea_trade_audit").select("*", { count: "exact", head: true }).eq("connection_id", activeConnection.id)
      : Promise.resolve({ count: 0 }),
    activeConnection
      ? supabase.from("ea_commands").select("*", { count: "exact", head: true }).eq("connection_id", activeConnection.id).eq("status", "pending")
      : Promise.resolve({ count: 0 }),
    activeConnection
      ? supabase
          .from("mt5_worker_heartbeats")
          .select(`
            *,
            mt5_user_connections (account_login, broker_server)
          `)
          .eq("connection_id", activeConnection.id)
          .order("last_seen_at", { ascending: false })
          .limit(1)
      : Promise.resolve({ data: [] as never[] }),
    activeConnection
      ? supabase
          .from("mt5_runtime_events")
          .select("*")
          .eq("connection_id", activeConnection.id)
          .order("created_at", { ascending: false })
          .limit(8)
      : supabase.from("mt5_runtime_events").select("*").order("created_at", { ascending: false }).limit(8),
  ]);

  const heartbeats = heartbeatResult.data ?? [];
  const events = eventsResult.data ?? [];
  const latestHeartbeat = heartbeats[0] ?? null;
  const executionCount = executionMode === "ea-first" ? Number(eaRecordedTrades ?? 0) : Number(completedTrades ?? 0);
  const pendingCount = executionMode === "ea-first" ? Number(pendingEaCommands ?? 0) : Number(queuedTrades ?? 0);
  const executionCaption = executionMode === "ea-first"
    ? "Trade audit rows recorded by the EA for this connection."
    : "Successful legacy trade jobs recorded for this workspace.";
  const pendingCaption = executionMode === "ea-first"
    ? "Pending EA commands waiting to be acknowledged by the terminal."
    : "Queued, claimed, executing, or retry jobs still in flight.";
  const isStale = latestHeartbeat
    ? new Date().getTime() - new Date(latestHeartbeat.last_seen_at).getTime() > 30000
    : false;
  const runtimeState = !activeConnection
    ? "Disconnected"
    : !latestHeartbeat
      ? (activeConnection.status || "offline")
      : isStale
        ? "stale"
        : latestHeartbeat.status;
  const runtimeTone = !activeConnection
    ? "border-[#2a2a2a] bg-[#111111] text-gray-300"
    : runtimeState === "online"
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
      : runtimeState === "stale"
        ? "border-amber-500/20 bg-amber-500/10 text-amber-200"
        : "border-red-500/20 bg-red-500/10 text-red-200";

  return (
    <div className="space-y-6 text-white">
      <section className="overflow-hidden rounded-[28px] border border-[#181818] bg-[#090909] shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
        <div className="border-b border-[#171717] bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.24),_transparent_40%),linear-gradient(180deg,#101010_0%,#090909_100%)] px-6 py-6 lg:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#252525] bg-[#121212] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-400">
                <TrendingUp className="size-3.5" /> Terminal Overview
              </div>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-white">Runtime Dashboard</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-400">
                  A terminal-style command deck for the single MT5 connection attached to this user. Status, execution queue, and broker runtime signals stay centered on the same account.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button asChild className="h-11 bg-blue-600 px-5 text-white hover:bg-blue-500">
                <Link href="/terminal">Open Terminal</Link>
              </Button>
              <Button asChild variant="outline" className="h-11 border-[#2b2b2b] bg-transparent px-5 text-gray-200 hover:bg-[#111111] hover:text-white">
                <Link href="/connections">Manage Connection</Link>
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-6 md:grid-cols-2 xl:grid-cols-4 lg:p-8">
          <div className="rounded-3xl border border-[#1f1f1f] bg-[#101010] p-5">
            <div className="flex items-center justify-between text-xs uppercase tracking-[0.18em] text-gray-500">
              <span>Terminal Link</span>
              <Link2 className="size-4 text-blue-300" />
            </div>
            <div className="mt-4 text-3xl font-semibold text-white">{activeConnection ? "1" : "0"}</div>
            <div className="mt-2 text-sm text-gray-400">Single-connection policy enforced for this user.</div>
          </div>

          <div className="rounded-3xl border border-[#1f1f1f] bg-[#101010] p-5">
            <div className="flex items-center justify-between text-xs uppercase tracking-[0.18em] text-gray-500">
              <span>Terminal Status</span>
              <Network className="size-4 text-emerald-300" />
            </div>
            <div className="mt-4">
              <Badge className={`border ${runtimeTone}`}>
                {runtimeState}
              </Badge>
            </div>
            <div className="mt-2 text-sm text-gray-400">
              {latestHeartbeat?.last_seen_at ? `Last terminal heartbeat ${new Date(latestHeartbeat.last_seen_at).toLocaleTimeString()}` : "Waiting for terminal heartbeat."}
            </div>
          </div>

          <div className="rounded-3xl border border-[#1f1f1f] bg-[#101010] p-5">
            <div className="flex items-center justify-between text-xs uppercase tracking-[0.18em] text-gray-500">
              <span>{executionMode === "ea-first" ? "EA Trade Audit" : "Legacy Executions"}</span>
              <CheckCircle2 className="size-4 text-emerald-300" />
            </div>
            <div className="mt-4 text-3xl font-semibold text-white">{executionCount}</div>
            <div className="mt-2 text-sm text-gray-400">{executionCaption}</div>
          </div>

          <div className="rounded-3xl border border-[#1f1f1f] bg-[#101010] p-5">
            <div className="flex items-center justify-between text-xs uppercase tracking-[0.18em] text-gray-500">
              <span>{executionMode === "ea-first" ? "Pending EA Commands" : "Legacy Queue Pressure"}</span>
              <Clock3 className="size-4 text-amber-300" />
            </div>
            <div className="mt-4 text-3xl font-semibold text-white">{pendingCount}</div>
            <div className="mt-2 text-sm text-gray-400">{pendingCaption}</div>
          </div>
        </div>

        <div className="grid gap-6 px-6 pb-6 lg:grid-cols-[minmax(0,1.1fr)_360px] lg:px-8 lg:pb-8">
          <section className="rounded-3xl border border-[#1f1f1f] bg-[#101010] p-5">
            <div className="flex items-center justify-between gap-3 border-b border-[#1a1a1a] pb-4">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-gray-500">Primary Account</div>
                <h2 className="mt-1 text-xl font-semibold text-white">Connection Health</h2>
              </div>
              {activeConnection ? (
                <Badge className="border border-[#2a2a2a] bg-[#111111] text-gray-200 hover:bg-[#111111]">
                  {activeConnection.account_login} · {activeConnection.broker_server}
                </Badge>
              ) : null}
            </div>

            {activeConnection ? (
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <div className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Connection</div>
                  <div className="mt-2 text-sm font-medium text-white">{activeConnection.account_login}</div>
                  <div className="text-xs text-gray-500">{activeConnection.broker_server}</div>
                </div>
                <div className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Terminal Signal</div>
                  <div className="mt-2 text-sm font-medium text-white">{runtimeState}</div>
                  <div className="text-xs text-gray-500">{latestHeartbeat ? new Date(latestHeartbeat.last_seen_at).toLocaleString() : "No heartbeat yet"}</div>
                </div>
                <div className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Account Status</div>
                  <div className="mt-2 text-sm font-medium text-white">{activeConnection.status || "offline"}</div>
                  <div className="text-xs text-gray-500">Provisioned terminal link</div>
                </div>
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-dashed border-[#2b2b2b] bg-[#0d0d0d] px-4 py-10 text-center text-sm text-gray-500">
                No MT5 account is connected. Open Connections to link a terminal before using the command deck.
              </div>
            )}

            {isStale ? (
              <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                The terminal heartbeat is stale. Check MT5 or reopen the terminal session.
              </div>
            ) : null}
          </section>

          <aside className="rounded-3xl border border-[#1f1f1f] bg-[#101010] p-5">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-gray-500">
              <AlertTriangle className="size-4 text-amber-300" /> Runtime Events
            </div>
            <div className="mt-4 space-y-3">
              {events.length > 0 ? (
                events.map((event) => (
                  <div key={event.id} className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="rounded-full border border-[#292929] bg-[#111111] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                        {event.component}
                      </span>
                      <span className="text-[11px] text-gray-500">{new Date(event.created_at).toLocaleTimeString()}</span>
                    </div>
                    <p className={`mt-2 text-sm leading-6 ${event.level === "error" ? "text-red-200" : "text-gray-300"}`}>
                      {event.message}
                    </p>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-[#2b2b2b] bg-[#0d0d0d] px-4 py-10 text-center text-sm text-gray-500">
                  No recent runtime events.
                </div>
              )}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

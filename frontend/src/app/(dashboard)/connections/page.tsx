import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { AlertTriangle, Link2, Network, Shield, Trash2 } from "lucide-react";
import { createClient } from "@/utils/supabase/server";
import { enforceSingleActiveConnection } from "@/lib/terminal-access";
import { addConnection, deleteConnection } from "./actions";

export default async function ConnectionsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  
  let currentConnection = null;
  let loadError: string | null = null;

  if (user?.id) {
    try {
      const connections = await enforceSingleActiveConnection(supabase, user.id);
      currentConnection = connections[0] ?? null;
    } catch (error) {
      loadError = error instanceof Error ? error.message : "Unknown connection load error";
    }
  }

  const connectionCreatedAt = currentConnection?.created_at
    ? new Date(currentConnection.created_at).toLocaleString()
    : null;

  return (
    <div className="space-y-6 text-white">
      <section className="overflow-hidden rounded-[28px] border border-[#181818] bg-[#090909] shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
        <div className="border-b border-[#171717] bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.24),_transparent_38%),linear-gradient(180deg,#101010_0%,#090909_100%)] px-6 py-6 lg:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#252525] bg-[#121212] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-400">
                <Network className="size-3.5" /> Terminal Link
              </div>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-white">Connection Control</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-400">
                  This workspace now runs with a single MT5 terminal link per user. Connect one account, trade from the terminal workspace, and remove it before switching to another login.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-[#202020] bg-[#111111]/90 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Active Slot</div>
                <div className="mt-2 text-2xl font-semibold text-white">{currentConnection ? "1 / 1" : "0 / 1"}</div>
                <div className="text-xs text-gray-500">Only one terminal connection is supported.</div>
              </div>
              <div className="rounded-2xl border border-[#202020] bg-[#111111]/90 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Execution Surface</div>
                <div className="mt-2 text-2xl font-semibold text-white">Terminal</div>
                <div className="text-xs text-gray-500">The connected account feeds the terminal workspace directly.</div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1.1fr)_360px] lg:p-8">
          <div className="space-y-6">
            {loadError ? (
              <div className="rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-4 text-sm text-red-200">
                Failed to load your MT5 connection: {loadError}
              </div>
            ) : currentConnection ? (
              <div className="rounded-3xl border border-[#1f1f1f] bg-[#101010] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="flex size-12 items-center justify-center rounded-2xl border border-[#27324a] bg-[#101828] text-blue-300">
                        <Link2 className="size-5" />
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-gray-500">Current MT5 Account</div>
                        <div className="text-2xl font-semibold text-white">{currentConnection.account_login}</div>
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Broker Server</div>
                        <div className="mt-2 text-sm font-medium text-white">{currentConnection.broker_server}</div>
                      </div>
                      <div className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Runtime Status</div>
                        <div className="mt-2">
                          <Badge className="border border-[#2a2a2a] bg-[#111111] text-gray-200 hover:bg-[#111111]">
                            {currentConnection.status || "offline"}
                          </Badge>
                        </div>
                      </div>
                      <div className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Provisioned</div>
                        <div className="mt-2 text-sm font-medium text-white">{connectionCreatedAt || "Unknown"}</div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 md:min-w-[180px]">
                    <Button asChild className="h-11 bg-blue-600 text-white hover:bg-blue-500">
                      <Link href="/terminal">Open Terminal</Link>
                    </Button>
                    <form action={deleteConnection}>
                      <input type="hidden" name="id" value={currentConnection.id} />
                      <Button type="submit" variant="outline" className="h-11 w-full border-red-500/30 bg-transparent text-red-200 hover:bg-red-500/10 hover:text-red-100">
                        <Trash2 className="mr-2 size-4" />
                        Disconnect Account
                      </Button>
                    </form>
                  </div>
                </div>

                <div className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  One account is active. To connect another MT5 login, disconnect this account first or sign out and use a different user session.
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-[#1f1f1f] bg-[#101010] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                <div className="mb-5 flex items-center gap-3">
                  <div className="flex size-12 items-center justify-center rounded-2xl border border-[#27324a] bg-[#101828] text-blue-300">
                    <Network className="size-5" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-gray-500">Link MT5 Runtime</div>
                    <div className="text-2xl font-semibold text-white">Add Your Terminal Account</div>
                  </div>
                </div>

                <form action={addConnection} className="grid gap-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="broker_server" className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Broker Server</Label>
                      <Input id="broker_server" name="broker_server" placeholder="Exness-MT5Trial" required className="h-11 border-[#2b2b2b] bg-[#0f0f0f] text-white placeholder:text-gray-600" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="account_login" className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Account Login</Label>
                      <Input id="account_login" name="account_login" type="number" placeholder="12345678" required className="h-11 border-[#2b2b2b] bg-[#0f0f0f] text-white placeholder:text-gray-600" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Password</Label>
                    <Input id="password" name="password" type="password" required className="h-11 border-[#2b2b2b] bg-[#0f0f0f] text-white placeholder:text-gray-600" />
                    <p className="text-xs text-gray-500">Credentials are encrypted on the server before storage and only one active connection is allowed.</p>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="inline-flex items-center gap-2 text-xs text-gray-500">
                      <Shield className="size-4 text-blue-300" />
                      This account becomes the only terminal link for your user.
                    </div>
                    <Button type="submit" className="h-11 bg-blue-600 px-6 text-white hover:bg-blue-500">Connect Account</Button>
                  </div>
                </form>
              </div>
            )}
          </div>

          <aside className="space-y-4 rounded-3xl border border-[#1f1f1f] bg-[#101010] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-gray-500">Operating Rules</div>
              <h2 className="mt-2 text-xl font-semibold text-white">Single Connection Policy</h2>
            </div>

            <div className="space-y-3 text-sm text-gray-400">
              <div className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                One user session supports one MT5 account at a time. The terminal, chart data, and execution controls all follow that single account.
              </div>
              <div className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                If you need a different account, disconnect the current one first. That keeps the dashboard, runtime state, and terminal feed aligned.
              </div>
              <div className="rounded-2xl border border-[#202020] bg-[#151515] px-4 py-3">
                Guest users can still preview public terminal data, but private MT5 execution requires a signed-in account with exactly one linked connection.
              </div>
            </div>

            <div className="rounded-2xl border border-[#2c2418] bg-[#19120a] px-4 py-3 text-sm text-amber-100">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                <span>Multiple hardcoded terminal options have been removed from this workflow. The active connection is now the only account exposed in the private UI.</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

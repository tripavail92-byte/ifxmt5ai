import { createClient } from "@/utils/supabase/server";
import { ManualTradeCard } from "./ManualTradeCard";
import { SetupStatePanel } from "./SetupStatePanel";
import { EaLivePanel } from "./EaLivePanel";

export default async function StrategiesPage() {
  const supabase = await createClient();

  const { data: connections } = await supabase
    .from("mt5_user_connections")
    .select("id, broker_server, account_login, status")
    .eq("is_active", true);

  // Prefer the connection that's actually online to avoid picking an arbitrary
  // "first" row when multiple connections are active.
  const STATUS_RANK: Record<string, number> = {
    online: 0,
    degraded: 1,
    connecting: 2,
    offline: 3,
    error: 4,
    disabled: 5,
  };
  const ranked = (connections ?? []).slice().sort((a, b) => {
    const ra = STATUS_RANK[(a as { status?: string }).status ?? "offline"] ?? 99;
    const rb = STATUS_RANK[(b as { status?: string }).status ?? "offline"] ?? 99;
    if (ra !== rb) return ra - rb;
    const aKey = `${a.broker_server ?? ""}-${a.account_login ?? ""}`;
    const bKey = `${b.broker_server ?? ""}-${b.account_login ?? ""}`;
    return aKey.localeCompare(bKey);
  });

  const firstConn = ranked[0] ?? null;

  return (
    <div className="space-y-4">
      <ManualTradeCard connections={ranked} />
      {firstConn && (
        <EaLivePanel connectionId={firstConn.id} />
      )}
      {firstConn && (
        <SetupStatePanel connectionId={firstConn.id} />
      )}
    </div>
  );
}


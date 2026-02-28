import { createClient } from "@/utils/supabase/server";
import { ManualTradeCard } from "./ManualTradeCard";
import { SetupStatePanel } from "./SetupStatePanel";

export default async function StrategiesPage() {
  const supabase = await createClient();

  const { data: connections } = await supabase
    .from("mt5_user_connections")
    .select("id, broker_server, account_login")
    .eq("is_active", true);

  const firstConn = (connections ?? [])[0] ?? null;

  return (
    <div className="space-y-4">
      <ManualTradeCard connections={connections ?? []} />
      {firstConn && (
        <SetupStatePanel connectionId={firstConn.id} />
      )}
    </div>
  );
}


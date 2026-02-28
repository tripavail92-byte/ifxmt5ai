import { createClient } from "@/utils/supabase/server";
import { ManualTradeCard } from "./ManualTradeCard";

export default async function StrategiesPage() {
  const supabase = await createClient();
  
  const { data: connections } = await supabase
    .from("mt5_user_connections")
    .select("id, broker_server, account_login")
    .eq("is_active", true);

  return (
    <div>
      <ManualTradeCard connections={connections ?? []} />
    </div>
  );
}


import { redirect } from "next/navigation";

import { getTerminalSettings } from "@/app/terminal/actions";
import { TerminalWorkspace } from "@/app/terminal/TerminalWorkspace";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ConnectionRow = {
  id: string;
  broker_server: string;
  account_login: string;
  status: string | null;
  is_active: boolean | null;
};

export default async function TerminalPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: connections } = await supabase
    .from("mt5_user_connections")
    .select("id, broker_server, account_login, status, is_active")
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  const initialSettings = await getTerminalSettings();

  return <TerminalWorkspace initialConnections={(connections ?? []) as ConnectionRow[]} initialSettings={initialSettings} />;
}

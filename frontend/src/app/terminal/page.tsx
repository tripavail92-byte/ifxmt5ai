import { getTerminalSettings } from "@/app/terminal/actions";
import { TerminalWorkspace } from "@/app/terminal/TerminalWorkspace";
import { resolveTerminalAccess } from "@/lib/terminal-access";
import { redirect } from "next/navigation";

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
  const viewer = await resolveTerminalAccess();

  if (!viewer.isAuthenticated) {
    redirect("/login?next=%2Fterminal");
  }

  const initialSettings = await getTerminalSettings();
  const initialConnections = viewer.connections as ConnectionRow[];

  return (
    <TerminalWorkspace
      initialConnections={initialConnections}
      initialSettings={initialSettings}
      isAuthenticated={true}
    />
  );
}

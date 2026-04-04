import { getTerminalSettings } from "@/app/terminal/actions";
import { TerminalWorkspace } from "@/app/terminal/TerminalWorkspace";
import { PUBLIC_TERMINAL_CONNECTION, resolveTerminalAccess } from "@/lib/terminal-access";

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
  const initialSettings = viewer.isAuthenticated ? await getTerminalSettings() : null;
  const initialConnections = viewer.isAuthenticated
    ? (viewer.connections as ConnectionRow[])
    : ([PUBLIC_TERMINAL_CONNECTION] as ConnectionRow[]);

  return (
    <TerminalWorkspace
      initialConnections={initialConnections}
      initialSettings={initialSettings}
      isAuthenticated={viewer.isAuthenticated}
    />
  );
}

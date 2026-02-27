import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/utils/supabase/server";

const levelVariant: Record<string, "default" | "secondary" | "destructive"> = {
  info: "secondary",
  warn: "default",
  error: "destructive",
};

export default async function LogsPage() {
  const supabase = await createClient();

  const { data: events, error } = await supabase
    .from("mt5_runtime_events")
    .select(`
      *,
      mt5_user_connections (account_login, broker_server)
    `)
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold md:text-2xl">System Logs</h1>
        <span className="text-sm text-muted-foreground">Last 100 events</span>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Runtime Events</CardTitle>
          <CardDescription>Live log stream from all MT5 workers and supervisors</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="p-4 text-sm text-destructive bg-destructive/10 rounded-md">
              Failed to load logs: {error.message}
            </div>
          ) : events && events.length > 0 ? (
            <div className="space-y-2 font-mono text-xs">
              {events.map((ev) => (
                <div
                  key={ev.id}
                  className="flex flex-col sm:flex-row sm:items-start gap-2 border-b py-2 last:border-0"
                >
                  <span className="text-muted-foreground shrink-0 w-44">
                    {new Date(ev.created_at).toLocaleString()}
                  </span>
                  <Badge
                    variant={levelVariant[ev.level] ?? "secondary"}
                    className="shrink-0 uppercase text-[10px] h-5"
                  >
                    {ev.level}
                  </Badge>
                  <span className="text-muted-foreground shrink-0 w-24">{ev.component}</span>
                  <span className={ev.level === "error" ? "text-destructive font-semibold" : ""}>
                    {ev.message}
                  </span>
                  {ev.mt5_user_connections && (
                    <span className="text-muted-foreground ml-auto shrink-0">
                      {ev.mt5_user_connections.account_login}@{ev.mt5_user_connections.broker_server}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center p-8 border border-dashed rounded-lg text-muted-foreground">
              No events logged yet.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

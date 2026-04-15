import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/utils/supabase/server";
import { unstable_noStore as noStore } from "next/cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function TradesPage() {
  noStore();
  const supabase = await createClient();
  
  const [{ data: auditRows, error: auditError }, { data: legacyTrades, error: legacyError }] = await Promise.all([
    supabase
      .from("ea_trade_audit")
      .select("id, connection_id, symbol, side, entry, sl, tp, volume, broker_ticket, status, decision_reason, payload, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
    .from("trade_jobs")
    .select(`
      *,
      mt5_user_connections (account_login, broker_server)
    `)
    .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const hasAnyRows = (auditRows?.length ?? 0) > 0 || (legacyTrades?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold md:text-2xl">Trade History</h1>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>EA Trade Audit</CardTitle>
          <CardDescription>Primary execution history for EA-first terminals. Legacy worker jobs remain visible below when present.</CardDescription>
        </CardHeader>
        <CardContent>
          {auditError ? (
            <div className="text-destructive">Failed to load EA trade audit: {auditError.message}</div>
          ) : auditRows && auditRows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Volume</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>SL / TP</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditRows.map((trade) => (
                  <TableRow key={trade.id}>
                    <TableCell className="font-bold">{trade.symbol}</TableCell>
                    <TableCell>
                      <Badge variant={trade.side === "buy" ? "default" : "destructive"}>
                        {trade.side.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell>{trade.volume}</TableCell>
                    <TableCell>{trade.entry ? trade.entry : "--"}</TableCell>
                    <TableCell>
                      {trade.sl ? trade.sl : "--"} / {trade.tp ? trade.tp : "--"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={
                        trade.status === "accepted" || trade.status === "open" || trade.status === "closed"
                          ? "default"
                          : trade.status === "failed" || trade.status === "rejected"
                            ? "destructive"
                            : "secondary"
                      }>
                        {trade.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{trade.decision_reason || "--"}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(trade.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center p-8 border border-dashed rounded-lg text-muted-foreground">
              No EA trade audit rows recorded yet.
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Legacy Worker Jobs</CardTitle>
          <CardDescription>Backward-compatible visibility for connections still using the legacy worker execution path.</CardDescription>
        </CardHeader>
        <CardContent>
          {legacyError ? (
            <div className="text-destructive">Failed to load legacy trade jobs: {legacyError.message}</div>
          ) : legacyTrades && legacyTrades.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Volume</TableHead>
                  <TableHead>SL / TP</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Timestamp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {legacyTrades.map((trade) => (
                  <TableRow key={trade.id}>
                    <TableCell className="font-medium">
                      {trade.mt5_user_connections?.account_login}
                    </TableCell>
                    <TableCell className="font-bold">{trade.symbol}</TableCell>
                    <TableCell>
                      <Badge variant={trade.side === "buy" ? "default" : "destructive"}>
                        {trade.side.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell>{trade.volume}</TableCell>
                    <TableCell>
                      {trade.sl ? trade.sl : "--"} / {trade.tp ? trade.tp : "--"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={
                        trade.status === "success" ? "default" : 
                        trade.status === "failed" ? "destructive" : "secondary"
                      }>
                        {trade.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(trade.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : hasAnyRows ? (
            <div className="text-center p-8 border border-dashed rounded-lg text-muted-foreground">
              No legacy worker jobs recorded.
            </div>
          ) : (
            <div className="text-center p-8 border border-dashed rounded-lg text-muted-foreground">
              No trade activity recorded yet.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

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
  
  const { data: trades, error } = await supabase
    .from("trade_jobs")
    .select(`
      *,
      mt5_user_connections (account_login, broker_server)
    `)
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold md:text-2xl">Trade History</h1>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Recent Trades</CardTitle>
          <CardDescription>Latest execution jobs dispatched to the MT5 runtime</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="text-destructive">Failed to load trades: {error.message}</div>
          ) : trades && trades.length > 0 ? (
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
                {trades.map((trade) => (
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
          ) : (
            <div className="text-center p-8 border border-dashed rounded-lg text-muted-foreground">
              No trades requested or executed yet.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";
import { createClient } from "@/utils/supabase/server";
import { addConnection, deleteConnection } from "./actions";

export default async function ConnectionsPage() {
  const supabase = await createClient();
  
  const { data: connections, error } = await supabase
    .from("mt5_user_connections")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold md:text-2xl">MT5 Connections</h1>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* ADD CONNECTION FORM */}
        <Card className="md:col-span-1 border shadow-sm">
          <CardHeader>
            <CardTitle>Add Account</CardTitle>
            <CardDescription>Connect a new MetaTrader 5 terminal</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={addConnection} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="broker_server">Broker Server</Label>
                <Input id="broker_server" name="broker_server" placeholder="Exness-MT5Trial" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="account_login">Account Login</Label>
                <Input id="account_login" name="account_login" type="number" placeholder="12345678" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" name="password" type="password" required />
                <p className="text-[0.8rem] text-muted-foreground mt-1">
                  Password is AES-256 encrypted before storage.
                </p>
              </div>
              <Button type="submit" className="w-full">Connect Account</Button>
            </form>
          </CardContent>
        </Card>

        {/* CONNECTION LIST */}
        <Card className="md:col-span-2 shadow-sm">
          <CardHeader>
            <CardTitle>Active Terminals</CardTitle>
            <CardDescription>Accounts provisioned for the AI runtime</CardDescription>
          </CardHeader>
          <CardContent>
            {error ? (
              <div className="p-4 text-sm text-destructive bg-destructive/10 rounded-md">
                Failed to load connections: {error.message}
              </div>
            ) : connections && connections.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Server</TableHead>
                    <TableHead>Login</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map((conn) => (
                    <TableRow key={conn.id}>
                      <TableCell className="font-medium">{conn.broker_server}</TableCell>
                      <TableCell>{conn.account_login}</TableCell>
                      <TableCell>
                        <Badge variant={conn.is_active ? "default" : "secondary"}>
                          {conn.status || "offline"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(conn.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <form action={deleteConnection}>
                          <input type="hidden" name="id" value={conn.id} />
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            type="submit" 
                            title="Delete connection" 
                            className="text-destructive hover:bg-destructive/10 h-8 w-8"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center p-8 border border-dashed rounded-lg text-muted-foreground">
                No MT5 accounts connected yet. Add one to get started.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

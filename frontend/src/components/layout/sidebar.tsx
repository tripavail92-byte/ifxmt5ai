"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LayoutDashboard, Network, History, Activity, ShieldCheck, TrendingUp, CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";

const baseNavItems = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Terminal", href: "/terminal", icon: TrendingUp },
  { name: "Connections", href: "/connections", icon: Network },
  { name: "Economic Calendar", href: "/calendar", icon: CalendarDays },
  { name: "Trade History", href: "/trades", icon: History },
  { name: "System Logs", href: "/logs", icon: Activity },
];

export function Sidebar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);

  const navItems = isAdmin
    ? [...baseNavItems, { name: "Admin Portal", href: "/admin", icon: ShieldCheck }]
    : baseNavItems;

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="hidden border-r bg-muted/40 md:block md:w-64 lg:w-72 shrink-0 h-screen sticky top-0">
      <div className="flex h-full max-h-screen flex-col gap-2">
        <div className="flex h-14 items-center border-b px-4 lg:h-[60px] lg:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Activity className="h-6 w-6 text-primary" />
            <span className="">IFX AI Portal</span>
          </Link>
        </div>
        <div className="flex-1 overflow-auto py-2">
          <nav className="grid items-start px-2 text-sm font-medium lg:px-4 gap-1">
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-muted-foreground transition-all hover:text-primary hover:bg-muted",
                    isActive && "bg-muted text-primary font-semibold"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.name}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </div>
  );
}

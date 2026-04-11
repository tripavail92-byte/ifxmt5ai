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
    <div className="hidden h-screen shrink-0 border-r border-[#171717] bg-[linear-gradient(180deg,#101010_0%,#0a0a0a_100%)] md:sticky md:top-0 md:block md:w-64 lg:w-72">
      <div className="flex h-full max-h-screen flex-col gap-2 text-white">
        <div className="flex h-14 items-center border-b border-[#1b1b1b] px-4 lg:h-[60px] lg:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold text-white">
            <Activity className="h-6 w-6 text-blue-400" />
            <span>IFX AI Portal</span>
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
                    "flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-gray-400 transition-all hover:border-[#232323] hover:bg-[#141414] hover:text-white",
                    isActive && "border-[#27324a] bg-[#101828] text-blue-300 font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
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

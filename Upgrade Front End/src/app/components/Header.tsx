import { Activity } from 'lucide-react';

interface HeaderProps {
  balance: number;
  equity: number;
  pnl: number;
}

export function Header({ balance, equity, pnl }: HeaderProps) {
  const pnlColor = pnl >= 0 ? 'text-emerald-500' : 'text-red-500';
  const pnlSign = pnl >= 0 ? '+' : '';

  return (
    <div className="bg-[#111] border-b border-gray-800 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-blue-500" />
          <span className="text-lg font-semibold">FDM 6-Gate Sniper Terminal</span>
        </div>
        <div className="h-5 w-px bg-gray-700" />
        <span className="text-sm text-gray-400">v9.30 Turbo</span>
      </div>

      <div className="flex items-center gap-8">
        <div>
          <div className="text-xs text-gray-500">Balance</div>
          <div className="text-base font-mono">${balance.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Equity</div>
          <div className="text-base font-mono">${equity.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">P/L</div>
          <div className={`text-base font-mono ${pnlColor}`}>
            {pnlSign}${Math.abs(pnl).toFixed(2)}
          </div>
        </div>
        <button className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm transition">
          Back to Portal
        </button>
      </div>
    </div>
  );
}

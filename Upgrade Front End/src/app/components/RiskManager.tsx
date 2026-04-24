import { Shield, AlertTriangle } from 'lucide-react';

export function RiskManager() {
  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-4">
        <Shield className="w-4 h-4 text-gray-400" />
        <h3 className="text-sm text-gray-400">RISK MANAGER</h3>
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-gray-500 block mb-1">Risk Per Trade (%)</label>
          <input
            type="text"
            defaultValue="2.0"
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono"
          />
        </div>

        <div>
          <label className="text-xs text-gray-500 block mb-1">Minimum R:R</label>
          <input
            type="text"
            defaultValue="1.0"
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono"
          />
        </div>

        <div>
          <label className="text-xs text-gray-500 block mb-1">Max Trades Per Day</label>
          <input
            type="text"
            defaultValue="3"
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono"
          />
        </div>

        <div className="flex items-center justify-between py-2">
          <span className="text-xs text-gray-400">Death by SL Cooldown</span>
          <div className="w-10 h-5 bg-emerald-600 rounded-full flex items-center px-0.5">
            <div className="w-4 h-4 bg-white rounded-full ml-auto" />
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-500 block mb-1">Cooldown (Minutes)</label>
          <input
            type="text"
            defaultValue="30"
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono"
          />
        </div>

        <div className="bg-orange-950/30 border border-orange-900/50 rounded p-3 flex gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-orange-400 leading-relaxed">
            Automatic circuit breaker locks all entries after SL hits. Prevents revenge trading.
          </p>
        </div>
      </div>
    </div>
  );
}

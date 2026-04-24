import { BarChart3, CheckCircle2 } from 'lucide-react';

export function TradeStats() {
  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 className="w-4 h-4 text-gray-400" />
        <h3 className="text-sm text-gray-400">TERMS + EXECUTION</h3>
      </div>

      <div className="bg-[#1a1a1a] border border-gray-800 rounded p-4 mb-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <div className="mt-0.5">
            <div className="w-4 h-4 border-2 border-gray-600 rounded flex items-center justify-center">
              <div className="w-2 h-2 bg-white rounded-sm" />
            </div>
          </div>
          <span className="text-xs text-gray-300 leading-relaxed">
            I accept the trading risk terms required before queueing MT5 execution from this terminal route.
          </span>
        </label>
      </div>

      <button className="w-full bg-[#1a1a1a] hover:bg-[#222] border border-gray-700 text-white py-2.5 rounded transition mb-4">
        Review Terms
      </button>

      <div className="bg-blue-950/30 border border-blue-900/50 rounded p-3">
        <p className="text-xs text-blue-400 leading-relaxed">
          Terms acceptance is persisted locally and synced to the server under version{' '}
          <span className="font-mono">2026-03-28-v1</span>. Acceptance is required before any MT5 order can be queued.
        </p>
      </div>

      <div className="mt-4 pt-4 border-t border-gray-800 space-y-2">
        <div className="flex justify-between items-center text-sm">
          <span className="text-gray-400">Today's Trades</span>
          <span className="font-mono">0 / 3</span>
        </div>
        <div className="flex justify-between items-center text-sm">
          <span className="text-gray-400">Win Rate</span>
          <span className="font-mono text-emerald-500">0.0%</span>
        </div>
        <div className="flex justify-between items-center text-sm">
          <span className="text-gray-400">Avg R:R</span>
          <span className="font-mono">---</span>
        </div>
      </div>
    </div>
  );
}

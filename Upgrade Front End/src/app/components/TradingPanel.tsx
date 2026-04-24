import { useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

export function TradingPanel() {
  const [bias, setBias] = useState<'buy' | 'sell' | null>(null);
  const [lots, setLots] = useState('0.10');

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
      <div className="mb-4">
        <h3 className="text-sm text-gray-400 mb-3">TRADE EXECUTION</h3>

        <div className="grid grid-cols-2 gap-2 mb-4">
          <button
            onClick={() => setBias('buy')}
            className={`py-3 rounded flex items-center justify-center gap-2 transition ${
              bias === 'buy'
                ? 'bg-emerald-600 text-white'
                : 'bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-500'
            }`}
          >
            <TrendingUp className="w-4 h-4" />
            <span>BUY</span>
          </button>
          <button
            onClick={() => setBias('sell')}
            className={`py-3 rounded flex items-center justify-center gap-2 transition ${
              bias === 'sell'
                ? 'bg-red-600 text-white'
                : 'bg-red-600/20 hover:bg-red-600/30 text-red-500'
            }`}
          >
            <TrendingDown className="w-4 h-4" />
            <span>SELL</span>
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-gray-500 block mb-1">Symbol</label>
          <select className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm">
            <option>EURUSD</option>
            <option>GBPUSD</option>
            <option>USDJPY</option>
            <option>XAUUSD</option>
          </select>
        </div>

        <div>
          <label className="text-xs text-gray-500 block mb-1">Lots</label>
          <input
            type="text"
            value={lots}
            onChange={(e) => setLots(e.target.value)}
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-gray-500 block mb-1">TP1 (75%)</label>
            <input
              type="text"
              placeholder="0.00000"
              className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">TP2 (Final)</label>
            <input
              type="text"
              placeholder="0.00000"
              className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-500 block mb-1">Stop Loss</label>
          <input
            type="text"
            placeholder="0.00000"
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono"
          />
        </div>

        <button className="w-full bg-orange-600 hover:bg-orange-700 text-white py-2.5 rounded transition mt-4">
          Execute Order
        </button>
      </div>
    </div>
  );
}

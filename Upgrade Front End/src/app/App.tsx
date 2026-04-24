import { useState } from 'react';
import { Activity, TrendingUp, TrendingDown, Settings, Power, Shield, Calendar, BarChart3 } from 'lucide-react';

export default function App() {
  const [balance] = useState(30000.00);
  const [equity] = useState(30500.00);
  const [pnl] = useState(500.00);
  const [bias, setBias] = useState<'buy' | 'sell' | null>(null);

  // Settings state
  const [settings, setSettings] = useState({
    aiText: '',
    manualBias: 'Neutral',
    manualPivot: '0.0',
    manualTP1: '0.0',
    manualTP2: '0.0',
    minConfidence: '70',
    zoneThickness: '30.0',
    slPadding: '0.2',
    useAsia: false,
    asiaStart: '19:00',
    asiaEnd: '03:00',
    useLondon: true,
    londonStart: '03:00',
    londonEnd: '11:00',
    useNY: true,
    nyStart: '08:00',
    nyEnd: '17:00',
    engineTF: '5 Minutes',
    bossTF: '1 Hour',
    useMTFSL: true,
    slTF: '5 Minutes',
    beTF: '10 Minutes',
    riskPct: '2.0',
    strictRisk: false,
    minRR: '1.0',
    maxTrades: '3',
    useDeadSL: true,
    slCooldown: '30',
    useAutoRR: true,
    autoRR1: '1.0',
    autoRR2: '2.0',
    baseMagic: '9180',
    pivotLen: '5',
    usePartial: true,
    tp1Pct: '75.0',
    useBE: true,
    beAfterTP1: true,
    exitOnFlip: true,
    useEOD: true,
    eodTime: '23:50',
    showStruct: false,
    structLookback: '400',
    enableDiscord: true,
    notifySL: false,
    notifyTP: true,
    notifyDaily: true,
    discordURL: '',
    challengeBalance: '1000.0',
    reportHour: '20',
    reportMin: '0',
  });

  const updateSetting = (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const pnlColor = pnl >= 0 ? 'text-emerald-500' : 'text-red-500';
  const pnlSign = pnl >= 0 ? '+' : '';

  return (
    <div className="size-full bg-[#0a0a0a] text-white flex flex-col">
      {/* Header */}
      <div className="bg-[#111] border-b border-gray-800 px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <Activity className="w-5 h-5 text-blue-500" />
          <span className="font-semibold">FDM 6-Gate Sniper Terminal</span>
          <span className="text-xs text-gray-500">v9.30</span>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Balance:</span>
            <span className="font-mono">${balance.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Equity:</span>
            <span className="font-mono">${equity.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">P/L:</span>
            <span className={`font-mono ${pnlColor}`}>{pnlSign}${Math.abs(pnl).toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden flex">
        {/* Left Sidebar - Compact Settings */}
        <div className="w-80 bg-[#0d0d0d] border-r border-gray-800 overflow-y-auto">
          <div className="p-3 space-y-2">

            {/* AI Brain */}
            <div className="bg-[#111] border border-gray-800 rounded p-3">
              <div className="text-xs font-semibold text-gray-400 mb-2 flex items-center gap-2">
                <Settings className="w-3 h-3" />
                AI MASTER BRAIN
              </div>
              <textarea
                value={settings.aiText}
                onChange={(e) => updateSetting('aiText', e.target.value)}
                placeholder="Paste Master Brain JSON..."
                rows={3}
                className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1.5 text-xs font-mono resize-none mb-2"
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">Bias</label>
                  <select value={settings.manualBias} onChange={(e) => updateSetting('manualBias', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs">
                    <option>Neutral</option>
                    <option>Long</option>
                    <option>Short</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">Confidence %</label>
                  <input type="text" value={settings.minConfidence} onChange={(e) => updateSetting('minConfidence', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">Pivot</label>
                  <input type="text" value={settings.manualPivot} onChange={(e) => updateSetting('manualPivot', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">Zone %</label>
                  <input type="text" value={settings.zoneThickness} onChange={(e) => updateSetting('zoneThickness', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">TP1</label>
                  <input type="text" value={settings.manualTP1} onChange={(e) => updateSetting('manualTP1', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">TP2</label>
                  <input type="text" value={settings.manualTP2} onChange={(e) => updateSetting('manualTP2', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
              </div>
            </div>

            {/* Sessions */}
            <div className="bg-[#111] border border-gray-800 rounded p-3">
              <div className="text-xs font-semibold text-gray-400 mb-2">SESSIONS</div>
              {[
                { key: 'useLondon', label: 'London', start: 'londonStart', end: 'londonEnd' },
                { key: 'useNY', label: 'New York', start: 'nyStart', end: 'nyEnd' },
                { key: 'useAsia', label: 'Asia', start: 'asiaStart', end: 'asiaEnd' }
              ].map(({ key, label, start, end }) => (
                <div key={key} className="mb-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-400">{label}</span>
                    <div onClick={() => updateSetting(key, !settings[key as keyof typeof settings])} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer ${settings[key as keyof typeof settings] ? 'bg-blue-600' : 'bg-gray-700'}`}>
                      <div className={`w-3 h-3 bg-white rounded-full transition transform ${settings[key as keyof typeof settings] ? 'translate-x-4' : 'translate-x-0'}`} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input type="time" value={settings[start as keyof typeof settings] as string} onChange={(e) => updateSetting(start, e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-0.5 text-[10px]" />
                    <input type="time" value={settings[end as keyof typeof settings] as string} onChange={(e) => updateSetting(end, e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-0.5 text-[10px]" />
                  </div>
                </div>
              ))}
            </div>

            {/* Timeframes */}
            <div className="bg-[#111] border border-gray-800 rounded p-3">
              <div className="text-xs font-semibold text-gray-400 mb-2">TIMEFRAMES</div>
              <div className="space-y-2">
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">Engine TF</label>
                  <select value={settings.engineTF} onChange={(e) => updateSetting('engineTF', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs">
                    <option>1 Minute</option>
                    <option>5 Minutes</option>
                    <option>15 Minutes</option>
                    <option>1 Hour</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-gray-600 block mb-0.5">SL TF</label>
                    <select value={settings.slTF} onChange={(e) => updateSetting('slTF', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs">
                      <option>1 Minute</option>
                      <option>5 Minutes</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-600 block mb-0.5">BE TF</label>
                    <select value={settings.beTF} onChange={(e) => updateSetting('beTF', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs">
                      <option>5 Minutes</option>
                      <option>10 Minutes</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            {/* Risk */}
            <div className="bg-[#111] border border-gray-800 rounded p-3">
              <div className="text-xs font-semibold text-gray-400 mb-2 flex items-center gap-2">
                <Shield className="w-3 h-3" />
                RISK & PSYCHOLOGY
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">Risk %</label>
                  <input type="text" value={settings.riskPct} onChange={(e) => updateSetting('riskPct', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">Min R:R</label>
                  <input type="text" value={settings.minRR} onChange={(e) => updateSetting('minRR', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">Max Trades</label>
                  <input type="text" value={settings.maxTrades} onChange={(e) => updateSetting('maxTrades', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">CD Mins</label>
                  <input type="text" value={settings.slCooldown} onChange={(e) => updateSetting('slCooldown', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">SL Cooldown</span>
                <div onClick={() => updateSetting('useDeadSL', !settings.useDeadSL)} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer ${settings.useDeadSL ? 'bg-emerald-600' : 'bg-gray-700'}`}>
                  <div className={`w-3 h-3 bg-white rounded-full transition transform ${settings.useDeadSL ? 'translate-x-4' : 'translate-x-0'}`} />
                </div>
              </div>
            </div>

            {/* Trade Management */}
            <div className="bg-[#111] border border-gray-800 rounded p-3">
              <div className="text-xs font-semibold text-gray-400 mb-2">TRADE MANAGEMENT</div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">Magic ID</label>
                  <input type="text" value={settings.baseMagic} onChange={(e) => updateSetting('baseMagic', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
                <div>
                  <label className="text-[10px] text-gray-600 block mb-0.5">TP1 %</label>
                  <input type="text" value={settings.tp1Pct} onChange={(e) => updateSetting('tp1Pct', e.target.value)} className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs font-mono" />
                </div>
              </div>
              <div className="space-y-1.5 text-xs">
                {[
                  { key: 'usePartial', label: 'Partial Close' },
                  { key: 'useBE', label: 'Break-Even' },
                  { key: 'exitOnFlip', label: 'Exit on Flip' },
                  { key: 'useEOD', label: 'EOD Close' }
                ].map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-gray-400">{label}</span>
                    <div onClick={() => updateSetting(key, !settings[key as keyof typeof settings])} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer ${settings[key as keyof typeof settings] ? 'bg-blue-600' : 'bg-gray-700'}`}>
                      <div className={`w-3 h-3 bg-white rounded-full transition transform ${settings[key as keyof typeof settings] ? 'translate-x-4' : 'translate-x-0'}`} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Discord */}
            <div className="bg-[#111] border border-gray-800 rounded p-3">
              <div className="text-xs font-semibold text-gray-400 mb-2">DISCORD</div>
              <div className="space-y-1.5 text-xs mb-2">
                {[
                  { key: 'enableDiscord', label: 'Enable' },
                  { key: 'notifyTP', label: 'TP Alerts' },
                  { key: 'notifyDaily', label: 'Daily Report' }
                ].map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-gray-400">{label}</span>
                    <div onClick={() => updateSetting(key, !settings[key as keyof typeof settings])} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer ${settings[key as keyof typeof settings] ? 'bg-emerald-600' : 'bg-gray-700'}`}>
                      <div className={`w-3 h-3 bg-white rounded-full transition transform ${settings[key as keyof typeof settings] ? 'translate-x-4' : 'translate-x-0'}`} />
                    </div>
                  </div>
                ))}
              </div>
              <input
                type="text"
                value={settings.discordURL}
                onChange={(e) => updateSetting('discordURL', e.target.value)}
                placeholder="Webhook URL..."
                className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs"
              />
            </div>

          </div>
        </div>

        {/* Center - Trading Interface */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-4 max-w-6xl mx-auto grid grid-cols-3 gap-4">

            {/* Order Entry */}
            <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-4">EXECUTE ORDER</h3>
              <div className="grid grid-cols-2 gap-2 mb-4">
                <button onClick={() => setBias('buy')} className={`py-3 rounded flex items-center justify-center gap-2 transition ${bias === 'buy' ? 'bg-emerald-600 text-white' : 'bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-500'}`}>
                  <TrendingUp className="w-4 h-4" />
                  <span className="font-semibold">BUY</span>
                </button>
                <button onClick={() => setBias('sell')} className={`py-3 rounded flex items-center justify-center gap-2 transition ${bias === 'sell' ? 'bg-red-600 text-white' : 'bg-red-600/20 hover:bg-red-600/30 text-red-500'}`}>
                  <TrendingDown className="w-4 h-4" />
                  <span className="font-semibold">SELL</span>
                </button>
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
                  <input type="text" defaultValue="0.10" className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono" />
                </div>
                <button className="w-full bg-orange-600 hover:bg-orange-700 text-white py-2.5 rounded transition font-semibold">
                  Execute
                </button>
              </div>
            </div>

            {/* Zone Monitor */}
            <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-4">ZONE MONITOR</h3>
              <button className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded mb-4 transition font-semibold">
                Monitor Zone
              </button>
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Power className="w-4 h-4 text-gray-500" />
                  <span className="text-xs text-gray-400">SETUP STATE</span>
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {['IDLE', 'STALKING', 'PURGATORY', 'DEAD'].map((state) => (
                    <button key={state} className="py-1.5 px-2 rounded text-[10px] bg-[#1a1a1a] text-gray-500 hover:bg-[#222] transition">
                      {state}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">Live Zone</span>
                  <span className="font-mono">0.00</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Snapshot</span>
                  <span className="font-mono text-orange-500">INACTIVE</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Invalidation</span>
                  <span className="font-mono">---</span>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-300">STATISTICS</h3>
              </div>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Today's Trades</span>
                  <span className="font-mono">0 / 3</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Win Rate</span>
                  <span className="font-mono text-emerald-500">0.0%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Avg R:R</span>
                  <span className="font-mono">---</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Max DD</span>
                  <span className="font-mono text-red-500">$0.00</span>
                </div>
              </div>
            </div>

            {/* Economic Calendar */}
            <div className="col-span-3 bg-[#111] border border-gray-800 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Calendar className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-300">ECONOMIC CALENDAR</h3>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { currency: 'USD', event: 'FOMC Press Release', date: 'Sat 25 Apr 05:00', impact: 'high' },
                  { currency: 'USD', event: 'FOMC Press Release', date: 'Sun 26 Apr 05:00', impact: 'high' }
                ].map((event, idx) => (
                  <div key={idx} className="bg-[#1a1a1a] border border-gray-800 rounded p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-2 h-2 rounded-full bg-red-500" />
                      <span className="text-xs font-mono text-gray-400">{event.currency}</span>
                      <span className="text-xs text-white">{event.event}</span>
                    </div>
                    <div className="text-xs text-gray-500">{event.date}</div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
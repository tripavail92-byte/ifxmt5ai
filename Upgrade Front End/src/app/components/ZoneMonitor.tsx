import { Power } from 'lucide-react';

interface ZoneMonitorProps {
  zoneActive: boolean;
  setZoneActive: (active: boolean) => void;
  setupState: string;
  setSetupState: (state: string) => void;
}

export function ZoneMonitor({ zoneActive, setZoneActive, setupState, setSetupState }: ZoneMonitorProps) {
  const states = ['IDLE', 'STALKING', 'PURGATORY', 'DEAD'];

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm text-gray-400">ZONES</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Active</span>
          <div className="w-8 h-4 bg-blue-600 rounded-full flex items-center px-0.5">
            <div className="w-3 h-3 bg-white rounded-full" />
          </div>
        </div>
      </div>

      <button
        onClick={() => setZoneActive(!zoneActive)}
        className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-lg mb-6 transition"
      >
        Monitor Zone
      </button>

      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Power className="w-4 h-4 text-gray-500" />
          <span className="text-sm text-gray-400">SETUP STATE</span>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {states.map((state) => (
            <button
              key={state}
              onClick={() => setSetupState(state.toLowerCase())}
              className={`py-2 px-3 rounded text-xs transition ${
                setupState === state.toLowerCase()
                  ? 'bg-gray-700 text-white border border-gray-600'
                  : 'bg-[#1a1a1a] text-gray-500 hover:bg-[#222]'
              }`}
            >
              {state}
            </button>
          ))}
        </div>

        <p className="text-xs text-gray-500 mt-3">
          Press Monitor Zone to start runtime state tracking for this setup.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-400">Live Execution Zone</span>
          <span className="text-sm font-mono">0.00</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-400">Runtime Snapshot</span>
          <span className="text-sm font-mono text-orange-500">INACTIVE</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-400">Invalidation Level</span>
          <span className="text-sm font-mono">---</span>
        </div>
      </div>
    </div>
  );
}

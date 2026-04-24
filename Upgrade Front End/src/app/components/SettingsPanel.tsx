import { useState } from 'react';
import { Settings, ChevronDown, ChevronRight } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function CollapsibleSection({ title, children, defaultOpen = true }: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full bg-[#1a1a1a] hover:bg-[#222] px-4 py-3 flex items-center justify-between transition"
      >
        <span className="text-sm font-medium text-gray-300">{title}</span>
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-500" />
        )}
      </button>
      {isOpen && (
        <div className="p-4 space-y-3 bg-[#111]">
          {children}
        </div>
      )}
    </div>
  );
}

interface FieldProps {
  label: string;
  type?: 'text' | 'number' | 'time' | 'select' | 'boolean' | 'textarea';
  value?: string | number | boolean;
  onChange?: (value: any) => void;
  options?: string[];
  placeholder?: string;
}

function Field({ label, type = 'text', value, onChange, options, placeholder }: FieldProps) {
  if (type === 'boolean') {
    return (
      <div className="flex items-center justify-between py-1">
        <label className="text-sm text-gray-400">{label}</label>
        <div
          onClick={() => onChange?.(!value)}
          className={`w-10 h-5 rounded-full flex items-center px-0.5 cursor-pointer transition ${
            value ? 'bg-emerald-600' : 'bg-gray-700'
          }`}
        >
          <div
            className={`w-4 h-4 bg-white rounded-full transition transform ${
              value ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </div>
      </div>
    );
  }

  if (type === 'select') {
    return (
      <div>
        <label className="text-xs text-gray-500 block mb-1">{label}</label>
        <select
          value={value as string}
          onChange={(e) => onChange?.(e.target.value)}
          className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-1.5 text-sm"
        >
          {options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (type === 'textarea') {
    return (
      <div>
        <label className="text-xs text-gray-500 block mb-1">{label}</label>
        <textarea
          value={value as string}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          rows={4}
          className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2 text-sm font-mono resize-none"
        />
      </div>
    );
  }

  return (
    <div>
      <label className="text-xs text-gray-500 block mb-1">{label}</label>
      <input
        type={type}
        value={value as string | number}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-3 py-1.5 text-sm font-mono"
      />
    </div>
  );
}

export function SettingsPanel() {
  const [settings, setSettings] = useState({
    // AI MASTER BRAIN
    aiText: '',
    manualBias: 'Neutral',
    manualPivot: '0.0',
    manualTP1: '0.0',
    manualTP2: '0.0',
    minConfidence: '70',
    zoneThickness: '30.0',
    slPadding: '0.2',

    // TRADING SESSIONS
    useAsia: false,
    asiaStart: '19:00',
    asiaEnd: '03:00',
    useLondon: true,
    londonStart: '03:00',
    londonEnd: '11:00',
    useNY: true,
    nyStart: '08:00',
    nyEnd: '17:00',

    // SYSTEM TIMEFRAMES
    engineTF: '5 Minutes',
    bossTF: '1 Hour',
    useMTFSL: true,
    slTF: '5 Minutes',
    beTF: '10 Minutes',

    // RISK & PSYCHOLOGY
    riskPct: '2.0',
    strictRisk: false,
    minRR: '1.0',
    maxTrades: '3',
    useDeadSL: true,
    slCooldown: '30',
    useAutoRR: true,
    autoRR1: '1.0',
    autoRR2: '2.0',

    // TRADE MANAGEMENT
    baseMagic: '9180',
    pivotLen: '5',
    usePartial: true,
    tp1Pct: '75.0',
    useBE: true,
    beAfterTP1: true,
    exitOnFlip: true,
    useEOD: true,
    eodTime: '23:50',

    // VISUALS & DISCORD
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

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg">
      <div className="border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm text-gray-300 font-medium">System Configuration</h3>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-1 bg-[#1a1a1a] hover:bg-[#222] border border-gray-700 rounded text-xs transition">
            Load
          </button>
          <button className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs transition">
            Save
          </button>
        </div>
      </div>

      <div className="p-4 space-y-3 max-h-[calc(100vh-200px)] overflow-y-auto">
        {/* AI MASTER BRAIN */}
        <CollapsibleSection title="1. AI MASTER BRAIN">
          <Field
            label="Paste Master Brain JSON/Text"
            type="textarea"
            value={settings.aiText}
            onChange={(v) => updateSetting('aiText', v)}
            placeholder="Paste AI-generated trade analysis here..."
          />
          <Field
            label="Manual Bias"
            type="select"
            value={settings.manualBias}
            onChange={(v) => updateSetting('manualBias', v)}
            options={['Neutral', 'Long', 'Short']}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Manual Pivot"
              type="number"
              value={settings.manualPivot}
              onChange={(v) => updateSetting('manualPivot', v)}
            />
            <Field
              label="Min AI Confidence (%)"
              type="number"
              value={settings.minConfidence}
              onChange={(v) => updateSetting('minConfidence', v)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Manual Target 1 (Partial)"
              type="number"
              value={settings.manualTP1}
              onChange={(v) => updateSetting('manualTP1', v)}
            />
            <Field
              label="Manual Target 2 (Final)"
              type="number"
              value={settings.manualTP2}
              onChange={(v) => updateSetting('manualTP2', v)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Zone Thickness (% Daily ATR)"
              type="number"
              value={settings.zoneThickness}
              onChange={(v) => updateSetting('zoneThickness', v)}
            />
            <Field
              label="SL Padding (Spread Mult)"
              type="number"
              value={settings.slPadding}
              onChange={(v) => updateSetting('slPadding', v)}
            />
          </div>
        </CollapsibleSection>

        {/* TRADING SESSIONS */}
        <CollapsibleSection title="2. TRADING SESSIONS">
          <Field
            label="Use Asia Session"
            type="boolean"
            value={settings.useAsia}
            onChange={(v) => updateSetting('useAsia', v)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Asia Start"
              type="time"
              value={settings.asiaStart}
              onChange={(v) => updateSetting('asiaStart', v)}
            />
            <Field
              label="Asia End"
              type="time"
              value={settings.asiaEnd}
              onChange={(v) => updateSetting('asiaEnd', v)}
            />
          </div>
          <Field
            label="Use London Session"
            type="boolean"
            value={settings.useLondon}
            onChange={(v) => updateSetting('useLondon', v)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="London Start"
              type="time"
              value={settings.londonStart}
              onChange={(v) => updateSetting('londonStart', v)}
            />
            <Field
              label="London End"
              type="time"
              value={settings.londonEnd}
              onChange={(v) => updateSetting('londonEnd', v)}
            />
          </div>
          <Field
            label="Use New York Session"
            type="boolean"
            value={settings.useNY}
            onChange={(v) => updateSetting('useNY', v)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="NY Start"
              type="time"
              value={settings.nyStart}
              onChange={(v) => updateSetting('nyStart', v)}
            />
            <Field
              label="NY End"
              type="time"
              value={settings.nyEnd}
              onChange={(v) => updateSetting('nyEnd', v)}
            />
          </div>
        </CollapsibleSection>

        {/* SYSTEM TIMEFRAMES */}
        <CollapsibleSection title="3. SYSTEM TIMEFRAMES">
          <Field
            label="ENGINE TF (Independent of Chart TF)"
            type="select"
            value={settings.engineTF}
            onChange={(v) => updateSetting('engineTF', v)}
            options={['1 Minute', '5 Minutes', '15 Minutes', '30 Minutes', '1 Hour', '4 Hours', '1 Day']}
          />
          <Field
            label="Boss Timeframe"
            type="select"
            value={settings.bossTF}
            onChange={(v) => updateSetting('bossTF', v)}
            options={['1 Minute', '5 Minutes', '15 Minutes', '30 Minutes', '1 Hour', '4 Hours', '1 Day']}
          />
          <Field
            label="Use MTF Stop Loss Anchor"
            type="boolean"
            value={settings.useMTFSL}
            onChange={(v) => updateSetting('useMTFSL', v)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="SL Timeframe"
              type="select"
              value={settings.slTF}
              onChange={(v) => updateSetting('slTF', v)}
              options={['1 Minute', '5 Minutes', '15 Minutes', '30 Minutes', '1 Hour']}
            />
            <Field
              label="BE Timeframe"
              type="select"
              value={settings.beTF}
              onChange={(v) => updateSetting('beTF', v)}
              options={['1 Minute', '5 Minutes', '10 Minutes', '15 Minutes', '30 Minutes']}
            />
          </div>
        </CollapsibleSection>

        {/* RISK, RR & PSYCHOLOGY */}
        <CollapsibleSection title="4. RISK, RR & PSYCHOLOGY">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Risk Per Trade (%)"
              type="number"
              value={settings.riskPct}
              onChange={(v) => updateSetting('riskPct', v)}
            />
            <Field
              label="Minimum R:R Required"
              type="number"
              value={settings.minRR}
              onChange={(v) => updateSetting('minRR', v)}
            />
          </div>
          <Field
            label="Strict Risk (Abort if < Min Lot)"
            type="boolean"
            value={settings.strictRisk}
            onChange={(v) => updateSetting('strictRisk', v)}
          />
          <Field
            label="Max Trades Per Day"
            type="number"
            value={settings.maxTrades}
            onChange={(v) => updateSetting('maxTrades', v)}
          />
          <Field
            label="Death by SL Cooldown"
            type="boolean"
            value={settings.useDeadSL}
            onChange={(v) => updateSetting('useDeadSL', v)}
          />
          <Field
            label="CD Wait Time (Minutes)"
            type="number"
            value={settings.slCooldown}
            onChange={(v) => updateSetting('slCooldown', v)}
          />
          <Field
            label="Enable Auto RR Target Multipliers"
            type="boolean"
            value={settings.useAutoRR}
            onChange={(v) => updateSetting('useAutoRR', v)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Auto RR TP1"
              type="number"
              value={settings.autoRR1}
              onChange={(v) => updateSetting('autoRR1', v)}
            />
            <Field
              label="Auto RR TP2"
              type="number"
              value={settings.autoRR2}
              onChange={(v) => updateSetting('autoRR2', v)}
            />
          </div>
        </CollapsibleSection>

        {/* TRADE MANAGEMENT */}
        <CollapsibleSection title="5. TRADE MANAGEMENT">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Base Magic ID"
              type="number"
              value={settings.baseMagic}
              onChange={(v) => updateSetting('baseMagic', v)}
            />
            <Field
              label="Structure Pivot Length"
              type="number"
              value={settings.pivotLen}
              onChange={(v) => updateSetting('pivotLen', v)}
            />
          </div>
          <Field
            label="Use Partial Close"
            type="boolean"
            value={settings.usePartial}
            onChange={(v) => updateSetting('usePartial', v)}
          />
          <Field
            label="Split Order TP1 %"
            type="number"
            value={settings.tp1Pct}
            onChange={(v) => updateSetting('tp1Pct', v)}
          />
          <Field
            label="Enable MTF Break-Even Trailing"
            type="boolean"
            value={settings.useBE}
            onChange={(v) => updateSetting('useBE', v)}
          />
          <Field
            label="Move to BE after TP1 Hit"
            type="boolean"
            value={settings.beAfterTP1}
            onChange={(v) => updateSetting('beAfterTP1', v)}
          />
          <Field
            label="Auto-Exit if AI Bias Flips?"
            type="boolean"
            value={settings.exitOnFlip}
            onChange={(v) => updateSetting('exitOnFlip', v)}
          />
          <Field
            label="Force Close End of Day"
            type="boolean"
            value={settings.useEOD}
            onChange={(v) => updateSetting('useEOD', v)}
          />
          <Field
            label="EOD Time"
            type="time"
            value={settings.eodTime}
            onChange={(v) => updateSetting('eodTime', v)}
          />
        </CollapsibleSection>

        {/* VISUALS & DISCORD */}
        <CollapsibleSection title="6. VISUALS & DISCORD">
          <Field
            label="Show Live Structure (SMS/BOS)"
            type="boolean"
            value={settings.showStruct}
            onChange={(v) => updateSetting('showStruct', v)}
          />
          <Field
            label="Structure History Lookback (Candles)"
            type="number"
            value={settings.structLookback}
            onChange={(v) => updateSetting('structLookback', v)}
          />
          <Field
            label="Enable Discord Notifications?"
            type="boolean"
            value={settings.enableDiscord}
            onChange={(v) => updateSetting('enableDiscord', v)}
          />
          <Field
            label="[DISCREET] Post SL Protection Alerts?"
            type="boolean"
            value={settings.notifySL}
            onChange={(v) => updateSetting('notifySL', v)}
          />
          <Field
            label="Post Profit Alerts?"
            type="boolean"
            value={settings.notifyTP}
            onChange={(v) => updateSetting('notifyTP', v)}
          />
          <Field
            label="Post Daily Performance?"
            type="boolean"
            value={settings.notifyDaily}
            onChange={(v) => updateSetting('notifyDaily', v)}
          />
          <Field
            label="Discord Webhook URL"
            type="text"
            value={settings.discordURL}
            onChange={(v) => updateSetting('discordURL', v)}
            placeholder="https://discord.com/api/webhooks/..."
          />
          <Field
            label="Imaginary Account Size ($)"
            type="number"
            value={settings.challengeBalance}
            onChange={(v) => updateSetting('challengeBalance', v)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Daily Report Hour (0-23)"
              type="number"
              value={settings.reportHour}
              onChange={(v) => updateSetting('reportHour', v)}
            />
            <Field
              label="Daily Report Minute (0-59)"
              type="number"
              value={settings.reportMin}
              onChange={(v) => updateSetting('reportMin', v)}
            />
          </div>
        </CollapsibleSection>
      </div>

      <div className="border-t border-gray-800 px-4 py-3 flex gap-2">
        <button className="flex-1 bg-[#1a1a1a] hover:bg-[#222] border border-gray-700 py-2 rounded text-sm transition">
          Reset to Defaults
        </button>
        <button className="flex-1 bg-blue-600 hover:bg-blue-700 py-2 rounded text-sm transition">
          Apply Settings
        </button>
      </div>
    </div>
  );
}

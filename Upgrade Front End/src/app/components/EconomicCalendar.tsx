import { Calendar, RefreshCw } from 'lucide-react';

export function EconomicCalendar() {
  const events = [
    {
      currency: 'USD',
      event: 'FOMC Press Release',
      date: 'Sat 25 Apr 05:00',
      impact: 'high',
      timeLeft: 'in 10.7h'
    },
    {
      currency: 'USD',
      event: 'FOMC Press Release',
      date: 'Sun 26 Apr 05:00',
      impact: 'high',
      timeLeft: ''
    }
  ];

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm text-gray-400">ECONOMIC CALENDAR</h3>
        </div>
        <button className="text-gray-500 hover:text-gray-300">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-2">
        {events.map((event, idx) => (
          <div key={idx} className="bg-[#1a1a1a] border border-gray-800 rounded p-3">
            <div className="flex items-start justify-between mb-1">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${
                  event.impact === 'high' ? 'bg-red-500' : 'bg-yellow-500'
                }`} />
                <span className="text-xs font-mono text-gray-400">{event.currency}</span>
                <span className="text-xs text-white">{event.event}</span>
              </div>
            </div>
            <div className="text-xs text-gray-500">
              {event.date} {event.timeLeft && <span className="text-orange-500">({event.timeLeft})</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 text-xs text-gray-600 leading-relaxed">
        Data from ECB · ONS · BOJ · SNB · RBA · BOC · RBNZ · BLS (+ FRED when key configured). Refresh weekly via python runtime/news_refresh.py.
      </div>
    </div>
  );
}

interface Session {
  asia: boolean;
  london: boolean;
  newYork: boolean;
}

interface SessionControlsProps {
  sessions: Session;
  setSessions: (sessions: Session) => void;
}

export function SessionControls({ sessions, setSessions }: SessionControlsProps) {
  const toggleSession = (session: keyof Session) => {
    setSessions({ ...sessions, [session]: !sessions[session] });
  };

  return (
    <div className="bg-[#111] border border-gray-800 rounded-lg p-6">
      <h3 className="text-sm text-gray-400 mb-4">TRADING SESSIONS</h3>

      <div className="flex gap-3 mb-6">
        <button
          onClick={() => toggleSession('london')}
          className={`flex-1 py-2 px-4 rounded transition ${
            sessions.london
              ? 'bg-blue-600 text-white border border-blue-500'
              : 'bg-blue-600/20 text-blue-400 border border-blue-800 hover:bg-blue-600/30'
          }`}
        >
          London
        </button>
        <button
          onClick={() => toggleSession('newYork')}
          className={`flex-1 py-2 px-4 rounded transition ${
            sessions.newYork
              ? 'bg-blue-600 text-white border border-blue-500'
              : 'bg-blue-600/20 text-blue-400 border border-blue-800 hover:bg-blue-600/30'
          }`}
        >
          New York
        </button>
        <button
          onClick={() => toggleSession('asia')}
          className={`flex-1 py-2 px-4 rounded transition ${
            sessions.asia
              ? 'bg-blue-600 text-white border border-blue-500'
              : 'bg-blue-600/20 text-blue-400 border border-blue-800 hover:bg-blue-600/30'
          }`}
        >
          Asia
        </button>
      </div>

      <div className="text-xs text-gray-500 leading-relaxed">
        Sessions are enforced server-side before every job insert. If none are enabled, execution is blocked.
      </div>
    </div>
  );
}

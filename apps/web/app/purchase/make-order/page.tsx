'use client';
import React from 'react';

export default function PurchaseMakeOrderPage() {
  const STORAGE_KEYS = React.useMemo(() => ({
    started: 'makeOrder.process1.started',
    returnPath: 'makeOrder.process1.returnPath',
    step1Note: 'makeOrder.process1.step1.note',
  }), []);

  const [started, setStarted] = React.useState<boolean>(false);
  const [note, setNote] = React.useState<string>('');
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [returnPath, setReturnPath] = React.useState<string | null>(null);

  // Load persisted state
  React.useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEYS.started);
      const n = localStorage.getItem(STORAGE_KEYS.step1Note);
      const r = localStorage.getItem(STORAGE_KEYS.returnPath);
      if (s === '1') setStarted(true);
      if (typeof n === 'string') setNote(n);
      if (typeof r === 'string') setReturnPath(r);
    } catch {}
  }, [STORAGE_KEYS.started, STORAGE_KEYS.step1Note, STORAGE_KEYS.returnPath]);

  // Persist note (debounced)
  React.useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEYS.step1Note, note || '');
        setSavedAt(Date.now());
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [note, STORAGE_KEYS.step1Note]);

  function startProcess() {
    try {
      // Determine where the user came from (same-origin only)
      let from: string | null = null;
      try {
        const ref = document.referrer || '';
        if (ref) {
          const u = new URL(ref);
          const cur = new URL(window.location.href);
          if (u.origin === cur.origin) from = u.pathname + u.search + u.hash;
        }
      } catch {}
      // Fallback to home if referrer is missing or cross-origin
      if (!from) from = '/';
      localStorage.setItem(STORAGE_KEYS.returnPath, from);
      localStorage.setItem(STORAGE_KEYS.started, '1');
      setReturnPath(from);
      setStarted(true);
    } catch {}
  }

  return (
    <div className="p-4 space-y-4">
      <div className="text-xs text-slate-500">Purchase</div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Make Order</h1>
        {returnPath && (
          <a href={returnPath} className="text-sm underline text-blue-700">Back to previous page</a>
        )}
      </div>

      {!started && (
        <div className="rounded-md border p-4 bg-white">
          <div className="text-sm text-slate-700">Process #1</div>
          <div className="mt-1 text-slate-500 text-sm">Start the guided, multi-step order flow.</div>
          <button
            className="mt-3 rounded border px-3 py-1.5 text-sm bg-slate-900 text-white hover:opacity-90"
            onClick={startProcess}
          >
            Start Process #1
          </button>
        </div>
      )}

      {started && (
        <div className="rounded-md border p-4 bg-white space-y-3">
          <div className="text-lg font-semibold">Welcome to step #1</div>
          <div className="text-sm text-slate-600">
            This step is saved locally. If you leave and come back, your progress remains.
          </div>
          <label className="block text-sm text-slate-700">
            Confirm persistence
            <input
              type="text"
              value={note}
              onChange={(e) => { setNote(e.target.value); setSaving(true); }}
              onBlur={() => setSaving(false)}
              className="mt-1 w-full max-w-md rounded border px-2 py-1 text-sm"
              placeholder="Type something, refresh, and see it persist"
            />
          </label>
          <div className="text-xs text-slate-500">
            {saving ? 'Saving…' : (savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()}` : 'Not saved yet')}
          </div>
          <div className="pt-2">
            <button
              className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
              onClick={() => alert('Next step coming soon')}
            >
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}



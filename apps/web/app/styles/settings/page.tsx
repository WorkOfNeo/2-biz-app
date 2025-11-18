'use client';
import * as React from 'react';

type TabKey = 'scraping' | 'stock-lists';

export default function StylesSettingsPage() {
  const [tab, setTab] = React.useState<TabKey>('scraping');

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      <div className="rounded-md border bg-white">
        <div className="flex items-center gap-1 border-b px-2 pt-2">
          <TabButton active={tab==='scraping'} onClick={()=>setTab('scraping')}>Scraping</TabButton>
          <TabButton active={tab==='stock-lists'} onClick={()=>setTab('stock-lists')}>Stock Lists</TabButton>
        </div>
        <div className="p-4">
          {tab === 'scraping' && (
            <div className="text-sm text-gray-700">
              Placeholder — Scraping settings and tools will live here.
              <div className="mt-2">
                <a href="/styles/runs" className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800">Open runs</a>
              </div>
            </div>
          )}
          {tab === 'stock-lists' && (
            <div className="text-sm text-gray-700">
              Placeholder — Stock Lists management will live here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={
        "rounded-t-md px-3 py-1.5 text-xs " +
        (active ? "bg-slate-900 text-white" : "bg-white text-slate-900 border")
      }
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}



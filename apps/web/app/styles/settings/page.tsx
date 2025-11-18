'use client';
import Link from 'next/link';

export default function StylesSettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>
      <div className="rounded-md border bg-white p-6 text-sm text-gray-700">
        Placeholder — Styles settings are being redesigned. Please use Runs to manage style-related jobs for now.
      </div>
      <div>
        <a href="/styles/runs" className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800">Open runs</a>
      </div>
    </div>
  );
}



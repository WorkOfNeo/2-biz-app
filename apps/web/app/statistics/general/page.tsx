'use client';
import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import { Menu, Eye, EyeOff, Trash2 } from 'lucide-react';

const salespersons: string[] = [
  'All',
  'John Anderson',
  'Sarah Nielsen',
  'Michael Jensen',
  'Emma Larsen',
  'David Olsen',
  'Lisa Hansen',
  'Thomas Pedersen',
];

type MockRow = {
  customer: string;
  city: string;
  season1Qty: number;
  season1Price: number;
  season2Qty: number;
  season2Price: number;
};

const mockData: MockRow[] = [
  {
    customer: 'Nordic Retail AS',
    city: 'Oslo',
    season1Qty: 145,
    season1Price: 125000,
    season2Qty: 132,
    season2Price: 118000,
  },
  {
    customer: 'Copenhagen Trading',
    city: 'Copenhagen',
    season1Qty: 198,
    season1Price: 165000,
    season2Qty: 175,
    season2Price: 152000,
  },
  {
    customer: 'Stockholm Supplies',
    city: 'Stockholm',
    season1Qty: 167,
    season1Price: 142000,
    season2Qty: 156,
    season2Price: 135000,
  },
  {
    customer: 'Helsinki Distribution',
    city: 'Helsinki',
    season1Qty: 123,
    season1Price: 98000,
    season2Qty: 115,
    season2Price: 92000,
  },
];

export default function StatisticsGeneralPage() {
  const { data: seasons } = useSWR('seasons-all', async () => {
    const { data, error } = await supabase.from('seasons').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null }[];
  });
  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');
  const [activePerson, setActivePerson] = useState<string>('All');
  const [showSave, setShowSave] = useState(false);
  useEffect(() => {
    if (saved?.value) {
      setS1(saved.value.s1 ?? '');
      setS2(saved.value.s2 ?? '');
    }
  }, [saved?.id]);
  useEffect(() => {
    if (s1 || s2) setShowSave(true);
  }, [s1, s2]);

  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }

  function calculateDevelopment(s1Qty: number, s2Qty: number) {
    const diff = s1Qty - s2Qty;
    const percentage = s2Qty === 0 ? 0 : (diff / s2Qty) * 100;
    return { diff, percentage: Number.isFinite(percentage) ? percentage : 0 };
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-balance">General Statistics</h1>
          <p className="mt-2 text-gray-500">Compare seasonal performance across salespersons</p>
        </div>
        <div className="relative">
          <details>
            <summary className="list-none inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm hover:bg-slate-50"><Menu className="h-4 w-4" /></summary>
            <div className="absolute right-0 z-10 mt-2 w-56 rounded-md border bg-white shadow">
              <div className="py-1 text-sm">
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50">Export Data</button>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50">Print Report</button>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50">Download PDF</button>
                <Link className="block px-3 py-2 hover:bg-gray-50" href="/statistics/general/import">Import Statistic</Link>
              </div>
            </div>
          </details>
        </div>
      </div>

      <div className="rounded-lg border bg-white">
        <div className="p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1 min-w-[220px]">
              <label className="text-sm font-medium text-gray-600">Season 1</label>
              <select className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm" value={s1} onChange={(e) => setS1(e.target.value)}>
                <option value="">—</option>
                {(seasons ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
                ))}
              </select>
            </div>
            <div className="hidden text-gray-500 sm:block">vs</div>
            <div className="flex-1 min-w-[220px]">
              <label className="text-sm font-medium text-gray-600">Season 2</label>
              <select className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm" value={s2} onChange={(e) => setS2(e.target.value)}>
                <option value="">—</option>
                {(seasons ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
                ))}
              </select>
            </div>
            {showSave && (
              <button
                className="ml-auto text-sm underline"
                onClick={async () => {
                  const value = { s1, s2 };
                  if (saved) {
                    await supabase.from('app_settings').update({ value }).eq('id', saved.id);
                  } else {
                    await supabase.from('app_settings').insert({ key: 'season_compare', value });
                  }
                  setShowSave(false);
                }}
              >Save to settings?</button>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex w-full gap-2 overflow-x-auto">
          {salespersons.map((person) => {
            const active = person === activePerson;
            return (
              <button
                key={person}
                onClick={() => setActivePerson(person)}
                className={
                  'whitespace-nowrap rounded-md border px-3 py-1.5 text-sm ' +
                  (active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-slate-50')
                }
              >
                {person}
              </button>
            );
          })}
        </div>

        <div className="rounded-lg border bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b-2">
                  <th className="p-2 text-left font-semibold">Customer</th>
                  <th className="p-2 text-left font-semibold">City</th>
                  <th className="p-2 text-center font-semibold" colSpan={2}>{getSeasonLabel(s1) || 'Season 1'}</th>
                  <th className="p-2 text-center font-semibold" colSpan={2}>{getSeasonLabel(s2) || 'Season 2'}</th>
                  <th className="p-2 text-center font-semibold" colSpan={2}>Development</th>
                  <th className="p-2 text-left font-semibold">Actions</th>
                </tr>
                <tr className="bg-gray-50">
                  <th className="p-2 text-left"></th>
                  <th className="p-2 text-left"></th>
                  <th className="p-2 text-center">Qty</th>
                  <th className="p-2 text-center">Price</th>
                  <th className="p-2 text-center">Qty</th>
                  <th className="p-2 text-center">Price</th>
                  <th className="p-2 text-center">Qty</th>
                  <th className="p-2 text-center">Price</th>
                  <th className="p-2 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">Null</button>
                      <button className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">Hide</button>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {mockData.map((row, idx) => {
                  const dev = calculateDevelopment(row.season1Qty, row.season2Qty);
                  const pct = Number.isFinite(dev.percentage) ? dev.percentage : 0;
                  return (
                    <tr key={idx} className="border-t">
                      <td className="p-2 font-medium">{row.customer}</td>
                      <td className="p-2">{row.city}</td>
                      <td className="p-2 text-center">{row.season1Qty}</td>
                      <td className="p-2 text-center">{row.season1Price.toLocaleString()} DKK</td>
                      <td className="p-2 text-center">{row.season2Qty}</td>
                      <td className="p-2 text-center">{row.season2Price.toLocaleString()} DKK</td>
                      <td className="p-2 text-center">
                        <span className={dev.diff > 0 ? 'text-green-600' : dev.diff < 0 ? 'text-red-600' : ''}>
                          {dev.diff > 0 ? '+' : ''}{dev.diff}
                        </span>
                      </td>
                      <td className="p-2 text-center">
                        <span className={pct > 0 ? 'text-green-600' : pct < 0 ? 'text-red-600' : ''}>
                          {pct.toFixed(1)}%
                        </span>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center justify-center gap-1.5">
                          <button className="rounded p-1 hover:bg-gray-100" aria-label="Show"><Eye className="h-4 w-4" /></button>
                          <button className="rounded p-1 hover:bg-gray-100" aria-label="Hide"><EyeOff className="h-4 w-4" /></button>
                          <button className="rounded p-1 hover:bg-gray-100" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}



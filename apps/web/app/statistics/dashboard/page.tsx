'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';

export default function StatisticsDashboardPage() {
  const { data: salespersons } = useSWR('salespersons:list', async () => {
    const { data, error } = await supabase.from('salespersons').select('id, name, email, currency').order('sort_index', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string; email?: string | null; currency?: string | null }>;
  });

  const { data: latestExports } = useSWR('exports:latest', async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, kind, title, path, public_url, meta, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as any[];
  }, { refreshInterval: 10000 });

  const latestByKind = React.useMemo(() => {
    const map = new Map<string, any>();
    for (const row of (latestExports ?? [])) { if (!map.has(row.kind)) map.set(row.kind, row); }
    return map;
  }, [latestExports]);

  // Box #1 - Salesperson Statistics
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [includeCountries, setIncludeCountries] = React.useState(true);
  const [sendingSp, setSendingSp] = React.useState(false);

  function toggleSp(id: string) {
    setSelected((p) => ({ ...p, [id]: !p[id] }));
  }

  async function sendSalespersonEmails() {
    if (sendingSp) return;
    setSendingSp(true);
    try {
      const spExport = latestByKind.get('general_salesmen_pdfs');
      if (!spExport) { alert('No salesperson PDFs found. Please run exports first.'); return; }
      const files = (spExport.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null; salesperson_id?: string }>) || [];
      const chosen = (salespersons ?? []).filter((s) => selected[s.id]);
      if (chosen.length === 0) { alert('Select at least one salesperson.'); return; }

      const byId: Record<string, { name: string; email?: string | null }> = Object.fromEntries((salespersons ?? []).map(s => [s.id, { name: s.name, email: s.email }]));
      const countries = includeCountries ? latestByKind.get('countries_pdf') : null;
      for (const sp of chosen) {
        const my = files.find((f) => f.salesperson_id === sp.id);
        const link = my?.publicUrl ? my.publicUrl : (my?.path ? `https://` : '');
        if (!my || (!my.publicUrl && !my.path)) continue;
        const links: string[] = [];
        if (my.publicUrl) links.push(`<a href="${my.publicUrl}" target="_blank" rel="noopener">Download PDF</a>`);
        if (!my.publicUrl && my.path) links.push(`${my.path}`);
        if (countries?.public_url) links.push(`<a href="${countries.public_url}" target="_blank" rel="noopener">Countries PDF</a>`);
        const recipient = byId[sp.id]?.email || '';
        if (!recipient) continue;
        const html = `
          <div>
            <p>Hi ${byId[sp.id]?.name || 'Salesperson'},</p>
            <p>Your latest statistics PDF is ready.</p>
            <p>${links.join(' · ')}</p>
          </div>
        `;
        await fetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: [recipient], subject: 'Your latest statistics', html }) });
      }
      alert('Emails queued for sending.');
    } finally {
      setSendingSp(false);
    }
  }

  // Box #2 - Overall Statistics
  const [receivers, setReceivers] = React.useState('');
  const [overallType, setOverallType] = React.useState<'all' | 'overview' | 'countries' | 'top10styles' | 'top10vendors'>('all');
  const [sendingOverall, setSendingOverall] = React.useState(false);

  async function sendOverall() {
    if (sendingOverall) return;
    setSendingOverall(true);
    try {
      const to = receivers.split(',').map(s => s.trim()).filter(Boolean);
      if (to.length === 0) { alert('Enter at least one receiver email.'); return; }
      const parts: string[] = [];
      if (overallType === 'all' || overallType === 'overview') {
        const row = latestByKind.get('overview_pdf');
        if (row?.public_url) parts.push(`<a href="${row.public_url}" target="_blank" rel="noopener">Overview PDF</a>`);
      }
      if (overallType === 'all' || overallType === 'countries') {
        const row = latestByKind.get('countries_pdf');
        if (row?.public_url) parts.push(`<a href="${row.public_url}" target="_blank" rel="noopener">Countries PDF</a>`);
      }
      if (overallType === 'top10styles') parts.push('Top 10 Styles - coming soon');
      if (overallType === 'top10vendors') parts.push('Top 10 Vendors - coming soon');
      if (parts.length === 0) { alert('No exports available yet.'); return; }
      const html = `<div><p>Latest statistics:</p><p>${parts.join(' · ')}</p></div>`;
      await fetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, subject: 'Statistics Update', html }) });
      alert('Email sent');
    } finally {
      setSendingOverall(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-xs text-gray-500">Statistics</div>
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-md border p-3 space-y-3">
          <div className="text-sm font-semibold">Send out statistics</div>
          <div className="text-sm font-medium">Salesperson Statistics</div>
          <div className="max-h-64 overflow-auto border rounded">
            <table className="min-w-full text-sm">
              <tbody>
                {(salespersons ?? []).map((sp) => (
                  <tr key={sp.id}>
                    <td className="p-2 border-b w-8">
                      <input type="checkbox" checked={!!selected[sp.id]} onChange={() => toggleSp(sp.id)} />
                    </td>
                    <td className="p-2 border-b">{sp.name}</td>
                    <td className="p-2 border-b text-xs text-gray-500">{sp.email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeCountries} onChange={(e) => setIncludeCountries(e.target.checked)} />
            Include Countries
          </label>
          <div>
            <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50" disabled={sendingSp} onClick={sendSalespersonEmails}>Send</button>
          </div>
        </div>

        <div className="rounded-md border p-3 space-y-3">
          <div className="text-sm font-medium">Overall Statistics</div>
          <label className="block text-sm">
            <div className="text-gray-600 mb-1">Receivers</div>
            <input className="w-full rounded border px-2 py-1 text-sm" placeholder="comma,separated@example.com" value={receivers} onChange={(e) => setReceivers(e.target.value)} />
          </label>
          <div className="text-sm space-y-1">
            <label className="flex items-center gap-2"><input type="radio" name="overall_type" checked={overallType==='all'} onChange={() => setOverallType('all')} />All salespeople</label>
            <label className="flex items-center gap-2"><input type="radio" name="overall_type" checked={overallType==='overview'} onChange={() => setOverallType('overview')} />Overview</label>
            <label className="flex items-center gap-2"><input type="radio" name="overall_type" checked={overallType==='countries'} onChange={() => setOverallType('countries')} />Countries</label>
            <label className="flex items-center gap-2"><input type="radio" name="overall_type" checked={overallType==='top10styles'} onChange={() => setOverallType('top10styles')} />Top 10 Styles</label>
            <label className="flex items-center gap-2"><input type="radio" name="overall_type" checked={overallType==='top10vendors'} onChange={() => setOverallType('top10vendors')} />Top 10 Vendors</label>
          </div>
          <div>
            <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50" disabled={sendingOverall} onClick={sendOverall}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}



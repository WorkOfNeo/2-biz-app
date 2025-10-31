'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';
const EMAILJS_SERVICE_ID = process.env.NEXT_PUBLIC_EMAILJS_SERVICE_ID || process.env.NEXT_PUBLIC_EMAILJS_SERVICE_KEY || '';
const EMAILJS_TEMPLATE_ID = process.env.NEXT_PUBLIC_EMAILJS_TEMPLATE_ID || '';
const EMAILJS_PUBLIC_KEY = process.env.NEXT_PUBLIC_EMAILJS_PUBLIC_KEY || '';
const EMAILJS_FROM_NAME = process.env.NEXT_PUBLIC_EMAILJS_FROM_NAME || '2-BIZ';
const EMAILJS_FROM_EMAIL = process.env.NEXT_PUBLIC_EMAILJS_FROM_EMAIL || '';

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
        if (!my || !my.publicUrl) continue;
        const recipient = byId[sp.id]?.email || '';
        if (!recipient) continue;
        const attachments: Array<{ name: string; data: string }> = [];
        try {
          const dataUrl = await fetchToDataUrl(my.publicUrl);
          const base64 = dataUrl.split(',')[1] || '';
          const name = (my.name ? `${my.name}.pdf` : (my.path?.split('/').pop() || 'statistics.pdf'));
          attachments.push({ name, data: base64 });
        } catch {}
        if (includeCountries && countries?.public_url) {
          try {
            const dataUrl = await fetchToDataUrl(countries.public_url);
            const base64 = dataUrl.split(',')[1] || '';
            attachments.push({ name: 'Countries.pdf', data: base64 });
          } catch {}
        }
        if (attachments.length === 0) continue;
        const msg = `Hi ${byId[sp.id]?.name || 'Salesperson'},\nYour latest statistics are attached.`;
        await sendEmailJs([recipient], 'Your latest statistics', msg, attachments);
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
      const attachments: Array<{ name: string; data: string }> = [];
      if (overallType === 'all' || overallType === 'overview') {
        const row = latestByKind.get('overview_pdf');
        if (row?.public_url) { try { const du = await fetchToDataUrl(row.public_url); attachments.push({ name: 'Overview.pdf', data: du.split(',')[1] || '' }); } catch {} }
      }
      if (overallType === 'all' || overallType === 'countries') {
        const row = latestByKind.get('countries_pdf');
        if (row?.public_url) { try { const du = await fetchToDataUrl(row.public_url); attachments.push({ name: 'Countries.pdf', data: du.split(',')[1] || '' }); } catch {} }
      }
      if (attachments.length === 0) { alert('No exports available yet.'); return; }
      const msg = 'Latest statistics are attached.';
      await sendEmailJs(to, 'Statistics Update', msg, attachments);
      alert('Email sent');
    } finally {
      setSendingOverall(false);
    }
  }

  async function sendEmailJs(to: string[], subject: string, message: string, attachments?: Array<{ name: string; data: string }>) {
    if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
      throw new Error('EmailJS browser env missing. Set NEXT_PUBLIC_EMAILJS_* variables.');
    }
    for (const recipient of to) {
      const payload = {
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email: recipient,
          subject,
          message_html: message,
          from_name: EMAILJS_FROM_NAME,
          from_email: EMAILJS_FROM_EMAIL,
        },
        attachments: (attachments || []).map((a) => ({ name: a.name, data: a.data })),
      } as any;
      const res = await fetch(EMAILJS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'EmailJS send failed');
      }
    }
  }

  async function fetchToDataUrl(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch file');
    const blob = await res.blob();
    return await blobToDataUrl(blob);
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
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



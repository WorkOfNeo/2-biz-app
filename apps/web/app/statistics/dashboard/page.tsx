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
  const [includeTop10Salesmen, setIncludeTop10Salesmen] = React.useState(false);
  const [sendingSp, setSendingSp] = React.useState(false);
  

  function toggleSp(id: string) {
    setSelected((p) => ({ ...p, [id]: !p[id] }));
  }

  async function sendSalespersonEmails() {
    if (sendingSp) return;
    setSendingSp(true);
    try {
      const spExport = latestByKind.get('general_salesmen_pdfs');
      const top10Salesmen = latestByKind.get('top_styles_pdf_salesmen');
      const stockListRows = (latestExports ?? []).filter((r: any) => r.kind === 'stock_list_pdf');
      // Keep only the most recent entry per list name
      const seenLists = new Set<string>();
      const latestStockLists: Array<any> = [];
      for (const r of stockListRows) {
        const listName = String(r?.meta?.list || '');
        if (!listName || seenLists.has(listName)) continue;
        seenLists.add(listName);
        latestStockLists.push(r);
      }
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
        if (includeTop10Salesmen && top10Salesmen?.public_url) {
          try {
            const dataUrl = await fetchToDataUrl(top10Salesmen.public_url);
            const base64 = dataUrl.split(',')[1] || '';
            attachments.push({ name: 'Top 10 - Salesmen.pdf', data: base64 });
          } catch {}
        }
        // Attach up to two latest stock list PDFs
        for (const r of latestStockLists.slice(0, 2)) {
          const pub = r?.public_url;
          const title = String(r?.title || 'Stock List');
          if (!pub) continue;
          try {
            const dataUrl = await fetchToDataUrl(pub);
            const base64 = dataUrl.split(',')[1] || '';
            const fname = (title.endsWith('.pdf') ? title : `${title}.pdf`);
            attachments.push({ name: fname, data: base64 });
          } catch {}
        }
        if (attachments.length === 0) continue;
        const subject = 'Din statistik';
        const firstName = String(byId[sp.id]?.name || '');
        const hej = firstName ? `Hej ${firstName.split(' ')[0]},` : 'Hej,';
        const bodyHtml = `${hej}\n\nHermed statistik :)`;
        // Send with attachments array (avoids relying on template param names)
        await sendEmailJs([recipient], subject, bodyHtml, attachments, undefined);
      }
      alert('Emails queued for sending.');
    } finally {
      setSendingSp(false);
    }
  }

  // Box #2 - Overall Statistics
  const [receivers, setReceivers] = React.useState('');
  const [overallOpts, setOverallOpts] = React.useState<{ all: boolean; overview: boolean; countries: boolean; top10overall: boolean; top10vendors: boolean }>({ all: false, overview: true, countries: true, top10overall: false, top10vendors: false });
  const [sendingOverall, setSendingOverall] = React.useState(false);

  async function sendOverall() {
    if (sendingOverall) return;
    setSendingOverall(true);
    try {
      const to = receivers.split(',').map(s => s.trim()).filter(Boolean);
      if (to.length === 0) { alert('Enter at least one receiver email.'); return; }
      const attachments: Array<{ name: string; data: string }> = [];
      if (overallOpts.overview) {
        const row = latestByKind.get('overview_pdf');
        if (row?.public_url) { try { const du = await fetchToDataUrl(row.public_url); attachments.push({ name: 'Overview.pdf', data: du.split(',')[1] || '' }); } catch {} }
      }
      if (overallOpts.countries) {
        const row = latestByKind.get('countries_pdf');
        if (row?.public_url) { try { const du = await fetchToDataUrl(row.public_url); attachments.push({ name: 'Countries.pdf', data: du.split(',')[1] || '' }); } catch {} }
      }
      if (overallOpts.top10overall) {
        const row = latestByKind.get('top_styles_pdf_overall');
        if (row?.public_url) { try { const du = await fetchToDataUrl(row.public_url); attachments.push({ name: 'Top 10 - Overall.pdf', data: du.split(',')[1] || '' }); } catch {} }
      }
      if (attachments.length === 0) { alert('No exports available yet or no options selected.'); return; }
      const subject = 'Statistik opdatering';
      const bodyHtml = 'Hermed statistik :)';
      await sendEmailJs(to, subject, bodyHtml, attachments, undefined);
      alert('Email sent');
    } finally {
      setSendingOverall(false);
    }
  }

  async function sendEmailJs(
    to: string[],
    subject: string,
    message: string,
    attachments?: Array<{ name: string; data: string }>,
    extraTemplateParams?: Record<string, string>
  ) {
    if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
      throw new Error('EmailJS browser env missing. Set NEXT_PUBLIC_EMAILJS_* variables.');
    }
    for (const recipient of to) {
      // Prefer Dynamic Attachments via template params; fall back to attachments shapes if needed
      const basePayload = {
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email: recipient,
          subject,
          message_html: message,
          from_name: EMAILJS_FROM_NAME,
          from_email: EMAILJS_FROM_EMAIL,
          ...(extraTemplateParams || {}),
        },
      } as any;
      const shapes: Array<any> = extraTemplateParams && Object.keys(extraTemplateParams).length > 0
        ? [ basePayload ]
        : [
            { // filename/content (base64)
              ...basePayload,
              attachments: (attachments || []).map((a) => ({ filename: a.name, content: a.data }))
            },
            { // name/data (base64)
              ...basePayload,
              attachments: (attachments || []).map((a) => ({ name: a.name, data: a.data }))
            },
            { // name/data with data URL prefix
              ...basePayload,
              attachments: (attachments || []).map((a) => ({ name: a.name, data: `data:application/pdf;base64,${a.data}` }))
            }
          ];
      let sent = false; let lastErr: string | null = null;
      for (const payload of shapes) {
        const res = await fetch(EMAILJS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.ok) { sent = true; break; }
        lastErr = await res.text();
        try { console.error('[EmailJS error]', lastErr); } catch {}
      }
      if (!sent) {
        throw new Error(lastErr || 'EmailJS send failed');
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

  // Errors: Missing DG for Top 10 (current season)
  const { data: currentSeason } = useSWR('season:current', async () => {
    const { data } = await supabase.from('seasons').select('id, name, year, is_current').eq('is_current', true).maybeSingle();
    return (data as any) || null;
  });
  const { data: top10Current } = useSWR(currentSeason ? ['top10:current', currentSeason.id] : null, async () => {
    const { data, error } = await supabase.from('top_styles').select('style_no, dg, qty').eq('season_id', currentSeason.id).order('qty', { ascending: false }).limit(10);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ style_no: string; dg?: string | null; qty: number }>;
  });
  const { data: stylesForTop } = useSWR(top10Current && top10Current.length ? ['styles:forTop10', top10Current.map(r=>r.style_no).join(',')] : null, async () => {
    const nos = (top10Current ?? []).map(r => r.style_no);
    const { data, error } = await supabase.from('styles').select('style_no, dg, style_name').in('style_no', nos);
    if (error) throw new Error(error.message);
    const map = new Map<string, { dg: string | null; name: string | null }>();
    for (const r of (data ?? []) as any[]) map.set(r.style_no, { dg: r.dg ?? null, name: r.style_name ?? null });
    return map;
  });
  const missingDgList = React.useMemo(() => {
    const out: Array<{ style_no: string; name: string | null }> = [];
    for (const r of (top10Current ?? [])) {
      const dgTop = (r as any).dg as string | null | undefined;
      const fromStyle = stylesForTop?.get(r.style_no);
      const dgStyle = fromStyle?.dg ?? null;
      const val = (dgTop || dgStyle || '').toString().trim();
      if (!val) out.push({ style_no: r.style_no, name: fromStyle?.name ?? null });
    }
    return out;
  }, [top10Current?.length, stylesForTop]);

  return (
    <div className="space-y-6">
      <div className="text-xs text-gray-500">Statistics</div>
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-md border p-3 space-y-3">
          <div className="text-sm font-semibold">Send out statistics</div>
          <div className="text-sm font-medium">Salesperson Statistics</div>
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const allOn = !Object.values(selected).every(Boolean);
                  const next: Record<string, boolean> = {};
                  for (const sp of (salespersons ?? [])) next[sp.id] = allOn;
                  setSelected(next);
                }}
                className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors bg-slate-200"
              >
                <span className="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform translate-x-0" />
              </button>
              <span>Vælg alle</span>
            </div>
          </div>
          <div className="max-h-64 overflow-auto border rounded mt-2">
            <table className="min-w-full text-sm">
              <tbody>
                {(salespersons ?? []).map((sp) => (
                  <tr key={sp.id}>
                    <td className="p-2 border-b w-28">
                      <button
                        type="button"
                        onClick={() => toggleSp(sp.id)}
                        className={"relative inline-flex h-5 w-9 items-center rounded-full transition-colors " + (selected[sp.id] ? 'bg-slate-900' : 'bg-slate-200')}
                        aria-pressed={!!selected[sp.id]}
                      >
                        <span className={"inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " + (selected[sp.id] ? 'translate-x-4' : 'translate-x-0')} />
                      </button>
                    </td>
                    <td className="p-2 border-b">{sp.name}</td>
                    <td className="p-2 border-b text-xs text-gray-500">{sp.email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => setIncludeCountries((v) => !v)}
              className={"relative inline-flex h-5 w-9 items-center rounded-full transition-colors " + (includeCountries ? 'bg-slate-900' : 'bg-slate-200')}
              aria-pressed={includeCountries}
            >
              <span className={"inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " + (includeCountries ? 'translate-x-4' : 'translate-x-0')} />
            </button>
            <span>Include Countries</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => setIncludeTop10Salesmen((v) => !v)}
              className={"relative inline-flex h-5 w-9 items-center rounded-full transition-colors " + (includeTop10Salesmen ? 'bg-slate-900' : 'bg-slate-200')}
              aria-pressed={includeTop10Salesmen}
            >
              <span className={"inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " + (includeTop10Salesmen ? 'translate-x-4' : 'translate-x-0')} />
            </button>
            <span>Include Top 10 - Salesmen</span>
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
          <div className="text-sm space-y-2">
            {[
              { key: 'all', label: 'All salespeople' },
              { key: 'overview', label: 'Overview' },
              { key: 'countries', label: 'Countries' },
              { key: 'top10overall', label: 'Top 10 - Overall' },
              { key: 'top10vendors', label: 'Top 10 Vendors' }
            ].map((opt: any) => (
              <div key={opt.key} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOverallOpts((p) => ({ ...p, [opt.key]: !p[opt.key as keyof typeof p] }))}
                  className={"relative inline-flex h-5 w-9 items-center rounded-full transition-colors " + (overallOpts[opt.key as keyof typeof overallOpts] ? 'bg-slate-900' : 'bg-slate-200')}
                  aria-pressed={overallOpts[opt.key as keyof typeof overallOpts] as boolean}
                >
                  <span className={"inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " + ((overallOpts[opt.key as keyof typeof overallOpts] as boolean) ? 'translate-x-4' : 'translate-x-0')} />
                </button>
                <span>{opt.label}</span>
              </div>
            ))}
          </div>
          <div>
            <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50" disabled={sendingOverall} onClick={sendOverall}>Send</button>
          </div>
        </div>
      </div>
      {/* Info / Errors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-md border p-3 space-y-2">
          <div className="text-sm font-semibold">Info</div>
          <div className="text-xs text-gray-600">—</div>
        </div>
        <div className="rounded-md border p-3 space-y-2">
          <div className="text-sm font-semibold">Errors</div>
          <div className="text-xs text-gray-700">
            {(missingDgList && missingDgList.length > 0) ? (
              <div>
                <div className="font-medium mb-1">Missing DG in Top 10 (Current Season):</div>
                <ul className="list-disc pl-5">
                  {missingDgList.map((row) => (<li key={row.style_no}>{row.style_no}{row.name ? ` — ${row.name}` : ''}</li>))}
                </ul>
              </div>
            ) : (
              <div className="text-gray-500">No errors</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}



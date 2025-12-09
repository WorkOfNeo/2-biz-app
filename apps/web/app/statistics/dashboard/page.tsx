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
  // Build latest stock list exports by list name (unique per schema)
  const latestStockListByName = React.useMemo(() => {
    const map = new Map<string, any>(); // name -> export row
    for (const row of (latestExports ?? [])) {
      if (row.kind === 'stock_list_pdf') {
        const name = String(row?.meta?.list || row?.title || '').replace(/^Stock List ·\s*/i, '');
        if (name && !map.has(name)) map.set(name, row);
      }
    }
    return map;
  }, [latestExports]);
  // Available stock lists from DB
  const { data: stockListsAll } = useSWR('stock-lists:names', async () => {
    const { data, error } = await supabase.from('stock_lists').select('id, name').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string }>
  });
  // Separate stock lists for each section
  const [selectedStockListsSalesmen, setSelectedStockListsSalesmen] = React.useState<Set<string>>(new Set());
  const [selectedStockListsOverall, setSelectedStockListsOverall] = React.useState<Set<string>>(new Set());
  const [selectedStockListsForEmail, setSelectedStockListsForEmail] = React.useState<Set<string>>(new Set());
  
  function toggleStockListSalesmen(name: string) {
    setSelectedStockListsSalesmen((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  }
  
  function toggleStockListOverall(name: string) {
    setSelectedStockListsOverall((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  }
  
  function toggleStockListForEmail(name: string) {
    setSelectedStockListsForEmail((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  }

  // Load/save Stock List email prefs
  useSWR('dashboard:stock_list_email', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'dashboard_stock_list_email').maybeSingle();
    const val = ((data?.value as any) || {}) as { receivers?: string; body?: string };
    if (val.receivers !== undefined) setStockListReceivers(val.receivers);
    if (val.body !== undefined) setStockListBodyText(val.body);
    return data;
  });

  // Errors: Missing DG for Top 10 (current season)
  const { data: currentSeason } = useSWR('season:current', async () => {
    const { data } = await supabase.from('seasons').select('id, name, year, is_current').eq('is_current', true).maybeSingle();
    return (data as any) || null;
  });
  const { data: top10Current } = useSWR(currentSeason ? ['top10:current', currentSeason.id] : null, async () => {
    const { data, error } = await supabase.from('top_styles').select('style_no, dg, qty').eq('season_id', currentSeason.id).order('qty', { ascending: false }).limit(15);
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

  // Box #1 - Salesperson Statistics
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [includeCountries, setIncludeCountries] = React.useState(true);
  const [includeTop15Salesmen, setIncludeTop15Salesmen] = React.useState(true);
  
  // Initialize all salespersons as selected by default
  React.useEffect(() => {
    if (salespersons && salespersons.length > 0 && Object.keys(selected).length === 0) {
      const allSelected: Record<string, boolean> = {};
      for (const sp of salespersons) {
        allSelected[sp.id] = true;
      }
      setSelected(allSelected);
    }
  }, [salespersons, selected]);
  const [sendingSp, setSendingSp] = React.useState(false);
  const [salesmenBodyText, setSalesmenBodyText] = React.useState('Hermed statistik :)');
  const [savingSalesmenPrefs, setSavingSalesmenPrefs] = React.useState(false);
  // Load/save Salesmen email prefs (body only)
  useSWR('dashboard:salesmen_email', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'dashboard_salesmen_email').maybeSingle();
    const val = ((data?.value as any) || {}) as { body?: string };
    if (val.body !== undefined) setSalesmenBodyText(val.body);
    return data;
  });
  async function saveSalesmenPrefs() {
    setSavingSalesmenPrefs(true);
    try {
      const value = { body: salesmenBodyText };
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', 'dashboard_salesmen_email').maybeSingle();
      if (existing?.id) await supabase.from('app_settings').update({ value }).eq('id', existing.id);
      else await supabase.from('app_settings').insert({ key: 'dashboard_salesmen_email', value } as any);
    } finally {
      setSavingSalesmenPrefs(false);
    }
  }

  function toggleSp(id: string) {
    setSelected((p) => ({ ...p, [id]: !p[id] }));
  }

  async function sendSalespersonEmails() {
    if (sendingSp) return;
    setSendingSp(true);
    try {
      const spExport = latestByKind.get('general_salesmen_pdfs');
      const top15Salesmen = latestByKind.get('top_styles_pdf_salesmen');
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
        // Use template variable names the email expects:
        // salesman_pdf (per-salesperson), top15_salesmen_pdf, countries_pdf_url
        const dynamicParams: Record<string, string> = {
          salesman_pdf: '',
          countries_pdf_url: '',
          top15_salesmen_pdf: ''
        };
        dynamicParams.salesman_pdf = my.publicUrl || '';
        if (includeCountries && countries?.public_url) {
          dynamicParams.countries_pdf_url = countries.public_url;
        }
        if (includeTop15Salesmen && top15Salesmen?.public_url) {
          dynamicParams.top15_salesmen_pdf = top15Salesmen.public_url;
        }
        // Include selected stock lists as URL parameters (for Dynamic Attachments)
        // Add each stock list as a separate parameter: stock_list_1_url, stock_list_2_url, etc.
        if (selectedStockListsSalesmen.size > 0) {
          let idx = 1;
          for (const name of Array.from(selectedStockListsSalesmen)) {
            const exp = latestStockListByName.get(name);
            if (exp?.public_url) {
              dynamicParams[`stock_list_${idx}_url`] = exp.public_url;
              dynamicParams[`stock_list_${idx}_name`] = name;
              idx++;
            }
          }
        }
        try {
          const summarize = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { len: (v || '').length, head: (v || '').slice(0, 32) }]));
          console.log('[email:salesperson] prepared: using template params', {
            recipient,
            includeCountries: !!(includeCountries && countries?.public_url),
            includeTop15Salesmen: !!(includeTop15Salesmen && top15Salesmen?.public_url),
            params: summarize(dynamicParams)
          });
        } catch {}
        // Check if we have any PDFs to send (including stock lists)
        const hasStockLists = Object.keys(dynamicParams).some(k => k.startsWith('stock_list_') && k.endsWith('_url'));
        const anyParam =
          Boolean(dynamicParams.salesman_pdf) ||
          Boolean(dynamicParams.countries_pdf_url) ||
          Boolean(dynamicParams.top15_salesmen_pdf) ||
          hasStockLists;
        if (!anyParam) continue;
        const subject = 'Din statistik';
        const fullName = String(byId[sp.id]?.name || '');
        // Capitalize name properly (convert from ALL CAPS to Title Case)
        const toTitleCase = (str: string) => {
          return str.toLowerCase().split(' ').map(word => 
            word.charAt(0).toUpperCase() + word.slice(1)
          ).join(' ');
        };
        const firstName = fullName ? toTitleCase(fullName).split(' ')[0] : '';
        const hej = firstName ? `Hej ${firstName},` : 'Hej,';
        const bodyHtml = `${hej}\n\n${salesmenBodyText || 'Hermed statistik :)'}`;
        // Send with dynamic template params (EmailJS will download PDFs from URLs)
        await sendEmailJs([recipient], subject, bodyHtml, undefined, dynamicParams);
      }
      alert('Emails queued for sending.');
    } finally {
      setSendingSp(false);
    }
  }

  // Box #2 - Overall Statistics
  const [receivers, setReceivers] = React.useState('');
  const [bodyText, setBodyText] = React.useState('Hermed statistik :)');
  const [overallOpts, setOverallOpts] = React.useState<{ all: boolean; countries: boolean; top10overall: boolean }>({ all: false, countries: true, top10overall: false });
  const [sendingOverall, setSendingOverall] = React.useState(false);
  const [savingOverallPrefs, setSavingOverallPrefs] = React.useState(false);

  // Box #3 - Send Stock Lists
  const [stockListReceivers, setStockListReceivers] = React.useState('');
  const [stockListBodyText, setStockListBodyText] = React.useState('Hermed stock list :)');
  const [sendingStockList, setSendingStockList] = React.useState(false);
  const [savingStockListPrefs, setSavingStockListPrefs] = React.useState(false);

  // Load/save Overall email prefs
  useSWR('dashboard:overall_email', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'dashboard_overall_email').maybeSingle();
    const val = ((data?.value as any) || {}) as { receivers?: string; body?: string };
    if (val.receivers !== undefined) setReceivers(val.receivers);
    if (val.body !== undefined) setBodyText(val.body);
    return data;
  });
  async function saveOverallPrefs() {
    setSavingOverallPrefs(true);
    try {
      const value = { receivers, body: bodyText };
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', 'dashboard_overall_email').maybeSingle();
      if (existing?.id) await supabase.from('app_settings').update({ value }).eq('id', existing.id);
      else await supabase.from('app_settings').insert({ key: 'dashboard_overall_email', value } as any);
    } finally {
      setSavingOverallPrefs(false);
    }
  }

  async function sendOverall() {
    if (sendingOverall) return;
    setSendingOverall(true);
    try {
      const to = receivers.split(',').map(s => s.trim()).filter(Boolean);
      if (to.length === 0) { alert('Enter at least one receiver email.'); return; }
      const dynamicParams: Record<string, string> = { all_salesmen_pdf_url: '', countries_pdf_url: '', top15_overall_pdf: '' };
      if (overallOpts.all) {
        const salesmen = latestByKind.get('general_salesmen_pdfs');
        const allUrl = salesmen?.meta?.all?.publicUrl || null;
        if (allUrl) { dynamicParams.all_salesmen_pdf_url = allUrl; }
      }
      if (overallOpts.countries) {
        const row = latestByKind.get('countries_pdf');
        if (row?.public_url) { dynamicParams.countries_pdf_url = row.public_url; }
      }
      if (overallOpts.top10overall) {
        const row = latestByKind.get('top_styles_pdf_overall');
        if (row?.public_url) { dynamicParams.top15_overall_pdf = row.public_url; }
      }
      // Add selected stock lists as URL parameters (for Dynamic Attachments)
      if (selectedStockListsOverall.size > 0) {
        let idx = 1;
        for (const name of Array.from(selectedStockListsOverall)) {
          const exp = latestStockListByName.get(name);
          if (exp?.public_url) {
            dynamicParams[`stock_list_${idx}_url`] = exp.public_url;
            dynamicParams[`stock_list_${idx}_name`] = name;
            idx++;
          }
        }
      }
      const hasStockLists = Object.keys(dynamicParams).some(k => k.startsWith('stock_list_') && k.endsWith('_url'));
      if (!overallOpts.all && !overallOpts.countries && !overallOpts.top10overall && !hasStockLists) { alert('No options selected.'); return; }
      try {
        const summarize = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { len: (v || '').length, head: (v || '').slice(0, 32) }]));
        console.log('[email:overall] prepared', {
          to,
          include: { all: overallOpts.all, countries: overallOpts.countries, top10overall: overallOpts.top10overall, stockLists: Array.from(selectedStockListsOverall) },
          params: summarize(dynamicParams)
        });
      } catch {}
      const subject = 'Statistik opdatering';
      const bodyHtml = bodyText || 'Hermed statistik :)';
      await sendEmailJs(to, subject, bodyHtml, undefined, dynamicParams, true); // Send as ONE email
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
    extraTemplateParams?: Record<string, string>,
    sendAsOne?: boolean  // If true, send ONE email to all recipients (BCC)
  ) {
    if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
      throw new Error('EmailJS browser env missing. Set NEXT_PUBLIC_EMAILJS_* variables.');
    }
    const summarizeParams = (p?: Record<string, string>) => {
      const out: any = {};
      if (!p) return out;
      for (const k of Object.keys(p)) {
        const v = p[k] || '';
        out[k] = { len: v.length, head: v.slice(0, 24) };
      }
      return out;
    };
    
    // If sendAsOne is true, send ONE email with all recipients in BCC
    if (sendAsOne && to.length > 1) {
      const basePayload = {
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email: to[0], // First recipient as "to"
          bcc_email: to.slice(1).join(','), // Rest as BCC
          subject,
          message_html: message,
          from_name: EMAILJS_FROM_NAME,
          from_email: EMAILJS_FROM_EMAIL,
          ...(extraTemplateParams || {}),
        },
      } as any;
      
      try {
        console.log('[EmailJS:request:preview:BCC]', {
          to: to[0],
          bcc_count: to.length - 1,
          hasAttachments: 0,
          templateParams: summarizeParams(basePayload.template_params)
        });
      } catch {}
      
      const res = await fetch(EMAILJS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(basePayload) });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const lastErr = `${res.status} ${res.statusText} :: ${body}`;
        console.error('[EmailJS:error]', lastErr);
        throw new Error(lastErr || 'EmailJS send failed');
      }
      return; // Success - sent one email to all recipients
    }
    
    // Otherwise, send individual emails (original behavior)
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
      for (let idx = 0; idx < shapes.length; idx++) {
        const payload = shapes[idx];
        try {
          console.log('[EmailJS:request:preview]', {
            to: recipient,
            shapeIndex: idx,
            hasAttachments: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
            templateParams: summarizeParams(payload.template_params)
          });
        } catch {}
        const res = await fetch(EMAILJS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.ok) { sent = true; break; }
        const body = await res.text().catch(() => '');
        lastErr = `${res.status} ${res.statusText} :: ${body}`;
        try { console.error('[EmailJS:error]', lastErr); } catch {}
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

  async function saveStockListPrefs() {
    setSavingStockListPrefs(true);
    try {
      const value = { receivers: stockListReceivers, body: stockListBodyText };
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', 'dashboard_stock_list_email').maybeSingle();
      if (existing?.id) await supabase.from('app_settings').update({ value }).eq('id', existing.id);
      else await supabase.from('app_settings').insert({ key: 'dashboard_stock_list_email', value } as any);
    } finally {
      setSavingStockListPrefs(false);
    }
  }

  async function sendStockLists() {
    if (sendingStockList) return;
    setSendingStockList(true);
    try {
      // Parse semicolon-separated emails
      const to = stockListReceivers.split(';').map(s => s.trim()).filter(Boolean);
      if (to.length === 0) { alert('Enter at least one recipient email.'); return; }
      
      if (selectedStockListsForEmail.size === 0) { alert('Select at least one stock list.'); return; }
      
      const dynamicParams: Record<string, string> = {};
      // Add selected stock lists as URL parameters (for Dynamic Attachments)
      let idx = 1;
      for (const name of Array.from(selectedStockListsForEmail)) {
        const exp = latestStockListByName.get(name);
        if (exp?.public_url) {
          dynamicParams[`stock_list_${idx}_url`] = exp.public_url;
          dynamicParams[`stock_list_${idx}_name`] = name;
          idx++;
        }
      }
      
      if (Object.keys(dynamicParams).length === 0) { alert('No available stock list exports found. Please export stock lists first.'); return; }
      
      try {
        const summarize = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { len: (v || '').length, head: (v || '').slice(0, 32) }]));
        console.log('[email:stock_list] prepared', {
          to,
          stockLists: Array.from(selectedStockListsForEmail),
          params: summarize(dynamicParams)
        });
      } catch {}
      
      const subject = 'Stock List';
      const bodyHtml = stockListBodyText || 'Hermed stock list :)';
      await sendEmailJs(to, subject, bodyHtml, undefined, dynamicParams, true); // Send as ONE email
      alert('Email sent');
    } finally {
      setSendingStockList(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-xs text-gray-500">Statistics</div>
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-md border p-3 space-y-3">
          <div className="text-sm font-semibold">Salesmen Statistics</div>
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
              onClick={() => setIncludeTop15Salesmen((v) => !v)}
              className={"relative inline-flex h-5 w-9 items-center rounded-full transition-colors " + (includeTop15Salesmen ? 'bg-slate-900' : 'bg-slate-200')}
              aria-pressed={includeTop15Salesmen}
            >
              <span className={"inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " + (includeTop15Salesmen ? 'translate-x-4' : 'translate-x-0')} />
            </button>
            <span>Include Top 15 - Salesmen</span>
          </label>
          {/* Stock lists toggles for Salesmen emails */}
          <div className="mt-3">
            <div className="text-xs text-gray-600 mb-1">Stock Lists</div>
            <div className="flex flex-wrap gap-2">
              {(stockListsAll ?? []).map((l) => {
                const on = selectedStockListsSalesmen.has(l.name);
                const available = Boolean(latestStockListByName.get(l.name)?.public_url);
                return (
                  <label key={l.id} className={"inline-flex items-center gap-1 px-2 py-1 rounded border " + (on ? 'bg-slate-900 text-white border-slate-900' : '')}>
                    <input type="checkbox" className="h-3 w-3" checked={on} disabled={!available} onChange={() => toggleStockListSalesmen(l.name)} />
                    <span className="text-xs">{l.name}</span>
                    {!available && <span className="text-[10px] text-gray-500 ml-1">(no export)</span>}
                  </label>
                );
              })}
            </div>
          </div>
          {/* Salesmen email body */}
          <label className="block text-sm">
            <div className="text-gray-600 mb-1">Email body</div>
            <textarea className="w-full rounded border px-2 py-1 text-sm h-28" placeholder="Write your message…" value={salesmenBodyText} onChange={(e)=>setSalesmenBodyText(e.target.value)} />
          </label>
          <div>
            <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 mr-2" disabled={savingSalesmenPrefs} onClick={saveSalesmenPrefs}>{savingSalesmenPrefs ? 'Saving…' : 'Save body'}</button>
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
              { key: 'countries', label: 'Countries' },
              { key: 'top10overall', label: 'Top 15 - Overall' }
            ].map((opt: any) => (
              <div key={opt.key} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOverallOpts((p: any) => ({ ...p, [opt.key]: !p[opt.key] }))}
                  className={"relative inline-flex h-5 w-9 items-center rounded-full transition-colors " + ((overallOpts as any)[opt.key] ? 'bg-slate-900' : 'bg-slate-200')}
                  aria-pressed={(overallOpts as any)[opt.key]}
                >
                  <span className={"inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " + (((overallOpts as any)[opt.key]) ? 'translate-x-4' : 'translate-x-0')} />
                </button>
                <span>{opt.label}</span>
              </div>
            ))}
          {/* Stock lists toggles */}
          <div className="mt-3">
            <div className="text-xs text-gray-600 mb-1">Stock Lists</div>
            <div className="flex flex-wrap gap-2">
              {(stockListsAll ?? []).map((l) => {
                const on = selectedStockListsOverall.has(l.name);
                const available = Boolean(latestStockListByName.get(l.name)?.public_url);
                return (
                  <label key={l.id} className={"inline-flex items-center gap-1 px-2 py-1 rounded border " + (on ? 'bg-slate-900 text-white border-slate-900' : '')}>
                    <input type="checkbox" className="h-3 w-3" checked={on} disabled={!available} onChange={() => toggleStockListOverall(l.name)} />
                    <span className="text-xs">{l.name}</span>
                    {!available && <span className="text-[10px] text-gray-500 ml-1">(no export)</span>}
                  </label>
                );
              })}
            </div>
          </div>
          <label className="block text-sm">
            <div className="text-gray-600 mb-1">Email body</div>
            <textarea className="w-full rounded border px-2 py-1 text-sm h-28" placeholder="Write your message…" value={bodyText} onChange={(e)=>setBodyText(e.target.value)} />
          </label>
          <div className="flex items-center gap-2">
            <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50" disabled={savingOverallPrefs} onClick={saveOverallPrefs}>{savingOverallPrefs ? 'Saving…' : 'Save recipients + body'}</button>
            <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50" disabled={sendingOverall} onClick={sendOverall}>Send</button>
          </div>
        </div>
      </div>

      {/* Box #3 - Send Stock Lists */}
      <div className="rounded-md border p-3 space-y-3">
        <div className="text-sm font-medium">Send Stock Lists</div>
        <label className="block text-sm">
          <div className="text-gray-600 mb-1">Recipients (semicolon separated)</div>
          <input 
            className="w-full rounded border px-2 py-1 text-sm" 
            placeholder="email1@example.com; email2@example.com" 
            value={stockListReceivers} 
            onChange={(e) => setStockListReceivers(e.target.value)} 
          />
        </label>
        <div className="text-sm space-y-2">
          <div className="text-xs text-gray-600 mb-1">Select Stock Lists</div>
          <div className="flex flex-wrap gap-2">
            {(stockListsAll ?? []).map((l) => {
              const on = selectedStockListsForEmail.has(l.name);
              const available = Boolean(latestStockListByName.get(l.name)?.public_url);
              return (
                <label key={l.id} className={"inline-flex items-center gap-1 px-2 py-1 rounded border " + (on ? 'bg-slate-900 text-white border-slate-900' : '')}>
                  <input type="checkbox" className="h-3 w-3" checked={on} disabled={!available} onChange={() => toggleStockListForEmail(l.name)} />
                  <span className="text-xs">{l.name}</span>
                  {!available && <span className="text-[10px] text-gray-500 ml-1">(no export)</span>}
                </label>
              );
            })}
          </div>
        </div>
        <label className="block text-sm">
          <div className="text-gray-600 mb-1">Email body</div>
          <textarea className="w-full rounded border px-2 py-1 text-sm h-28" placeholder="Write your message…" value={stockListBodyText} onChange={(e)=>setStockListBodyText(e.target.value)} />
        </label>
        <div className="flex items-center gap-2">
          <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50" disabled={savingStockListPrefs} onClick={saveStockListPrefs}>{savingStockListPrefs ? 'Saving…' : 'Save recipients + body'}</button>
          <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50" disabled={sendingStockList} onClick={sendStockLists}>Send</button>
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
                <div className="font-medium mb-1">Missing DG in Top 15 (Current Season):</div>
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



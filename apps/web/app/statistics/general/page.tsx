'use client';
import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import { Menu, EyeOff, Trash2, Ban } from 'lucide-react';
import { ProgressBar } from '../../../components/ProgressBar';
import { Modal } from '../../../components/Modal';

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
  const { data: salespersons } = useSWR('salespersons-all', async () => {
    const { data, error } = await supabase
      .from('salespersons')
      .select('id, name, currency, sort_index')
      .order('sort_index', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string; currency?: string | null; sort_index?: number | null }[];
  });
  // Customer city index to ensure city is shown even if missing on stats rows
  const { data: customerIndex } = useSWR('customers-index', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, company, city');
    if (error) throw new Error(error.message);
    const byId: Record<string, string> = {};
    const byName: Record<string, string> = {};
    for (const c of (data ?? []) as any[]) {
      if (c.customer_id) byId[c.customer_id] = c.city ?? '';
      if (c.company) byName[c.company] = c.city ?? '';
    }
    return { byId, byName } as { byId: Record<string, string>; byName: Record<string, string> };
  }, { refreshInterval: 0 });
  // Currency rates (from Misc settings) – 1 unit equals how many DKK
  const { data: currencyRatesRow } = useSWR('app-settings:currency-rates', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as Record<string, number> | undefined) ?? {};
  });
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');
  const [activePerson, setActivePerson] = useState<string>('');
  const [showSave, setShowSave] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatePct, setUpdatePct] = useState(0);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [doneToast, setDoneToast] = useState(false);
  const [nullByInputOpen, setNullByInputOpen] = useState(false);
  const [nullByInputText, setNullByInputText] = useState('');
  const [nullByInputResult, setNullByInputResult] = useState<string | null>(null);
  const spNameById = useMemo(() => Object.fromEntries(((salespersons ?? []) as { id: string; name: string }[]).map(s => [s.id, s.name])), [salespersons]);
  const spCurrencyById = useMemo(() => Object.fromEntries(((salespersons ?? []) as { id: string; currency?: string | null }[]).map(s => [s.id, s.currency ?? 'DKK'])), [salespersons]);
  useEffect(() => {
    if (saved?.value) {
      setS1(saved.value.s1 ?? '');
      setS2(saved.value.s2 ?? '');
    }
  }, [saved?.id]);
  useEffect(() => {
    if (s1 || s2) setShowSave(true);
  }, [s1, s2]);

  // Read salesperson from URL hash on load; default to first salesperson
  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const m = hash.match(/(^#|&)sp=([^&]+)/);
    if (m && m[2]) {
      try {
        const decoded = decodeURIComponent(m[2]);
        const exists = (salespersons ?? []).some(sp => sp.name === decoded);
        if (exists) setActivePerson(decoded);
        console.log('[stats] read salesperson from hash', decoded);
      } catch {}
    }
    if ((!m || !m[2]) && (salespersons ?? []).length > 0 && !activePerson) {
      const first = ((salespersons ?? [])[0] as any)?.name as string | undefined;
      if (first) {
        setActivePerson(first);
        console.log('[stats] default salesperson', first);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salespersons?.length]);
  // Update hash when selecting a salesperson
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activePerson) {
      const url = new URL(window.location.href);
      url.hash = `sp=${encodeURIComponent(activePerson)}`;
      window.history.replaceState(null, '', url.toString());
      console.log('[stats] set salesperson hash', activePerson);
    } else {
      const url = new URL(window.location.href);
      url.hash = '';
      window.history.replaceState(null, '', url.toString());
      console.log('[stats] cleared salesperson hash');
    }
  }, [activePerson]);

  function getSeasonLabel(seasonId: string | undefined) {
    if (!seasonId) return '';
    const s = (seasons ?? []).find((x) => x.id === seasonId);
    if (!s) return '';
    return `${s.name}${s.year ? ' ' + s.year : ''}`;
  }

  async function handleUpdateStatistic() {
    if (!s1) return alert('Select Season 1 to update');
    try {
      setUpdating(true);
      setUpdatePct(5);
      setElapsedSec(0);
      if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); }
      elapsedTimerRef.current = setInterval(() => setElapsedSec((v) => v + 1), 1000);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const token = session.access_token;
      const orch = (process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '').replace(/\/$/, '');
      setUpdatePct(15);
      const body = { type: 'scrape_statistics', payload: { toggles: { deep: true }, requestedBy: session.user.email, seasonId: s1 } };
      const res = await fetch(`/api/enqueue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      setLastJobId(json.jobId);
      setUpdatePct(35);
      // Poll logs to reflect steps
      const start = Date.now();
      const stepMap: Record<string, number> = {
        'STEP:begin_deep': 35,
        'STEP:topseller_ready': 50,
        'STEP:salespersons_total': 60,
        'STEP:salesperson_start': 65,
        'STEP:salesperson_done': 85,
        'STEP:complete': 100
      };
      const timer = setInterval(async () => {
        try {
          const { data: logs } = await supabase
            .from('job_logs')
            .select('msg, ts')
            .eq('job_id', json.jobId)
            .order('ts', { ascending: false })
            .limit(50);
          for (const l of (logs ?? [])) {
            const msg = (l as any).msg as string;
            if (stepMap[msg] !== undefined) {
              setUpdatePct((prev) => {
                const nextVal = stepMap[msg] ?? prev;
                return Math.max(prev, nextVal);
              });
              if (msg === 'STEP:complete') {
                clearInterval(timer);
                if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); }
                setDoneToast(true);
                setTimeout(() => { setDoneToast(false); setUpdating(false); }, 1500);
              }
              break;
            }
          }
          // Safety cap
          if (Date.now() - start > 5 * 60 * 1000) {
            clearInterval(timer);
            if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); }
            setUpdating(false);
          }
        } catch {}
      }, 1500);
    } catch (e: any) {
      alert(e?.message || 'Failed to enqueue');
      if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); }
      setUpdating(false);
    }
  }

  function calculateDevelopment(s1Qty: number, s2Qty: number) {
    const diff = s1Qty - s2Qty;
    const percentage = s2Qty === 0 ? 0 : (diff / s2Qty) * 100;
    return { diff, percentage: Number.isFinite(percentage) ? percentage : 0 };
  }

  // Resolve selected salesperson id (optional filter)
  const selectedSalespersonId = activePerson
    ? (salespersons ?? []).find((sp) => sp.name === activePerson)?.id ?? null
    : null;

  type RowOut = {
    account_no: string;
    customer: string;
    city: string;
    s1Qty: number;
    s1Price: number;
    s2Qty: number;
    s2Price: number;
    salespersonId: string | null;
    salespersonName: string;
  };

  // Details modal state
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsRow, setDetailsRow] = useState<RowOut | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsS1, setDetailsS1] = useState<any[]>([]);
  const [detailsS2, setDetailsS2] = useState<any[]>([]);

  async function openDetails(row: RowOut) {
    if (!s1 && !s2) return;
    setDetailsRow(row);
    setDetailsOpen(true);
    setDetailsLoading(true);
    try {
      const hasAccount = !!row.account_no && !row.account_no.includes(':');
          const buildQuery = (seasonId: string | undefined) => {
        // Fetch both aggregated stats (sales_stats) and raw invoice rows (sales_invoices)
        const stats = supabase
          .from('sales_stats')
          .select('account_no, customer_name, city, qty, price, season_id, salesperson_id, updated_at')
          .eq('season_id', seasonId ?? '');
        const invoices = supabase
              .from('sales_invoices')
              .select('id, account_no, customer_name, qty, amount, currency, invoice_no, invoice_date, created_at, manual_edited')
          .eq('season_id', seasonId ?? '');
        if (row.salespersonId) { stats.eq('salesperson_id', row.salespersonId); }
        if (hasAccount) {
          stats.eq('account_no', row.account_no); invoices.eq('account_no', row.account_no);
        } else {
          stats.eq('customer_name', row.customer).eq('city', row.city);
        }
        return Promise.all([stats.limit(10000), invoices.limit(10000)]);
      };
      const [r1, r2] = await Promise.all([
        s1 ? buildQuery(s1) : Promise.resolve([{ data: [], error: null }, { data: [], error: null }] as any),
        s2 ? buildQuery(s2) : Promise.resolve([{ data: [], error: null }, { data: [], error: null }] as any)
      ]);
      const [s1Stats, s1Invoices] = r1 as any[];
      const [s2Stats, s2Invoices] = r2 as any[];
      if (s1Stats.error) throw new Error(s1Stats.error.message);
      if (s2Stats.error) throw new Error(s2Stats.error.message);
      // Combine: show stats row plus each invoice as its own line (with invoice_no)
      const s1Combined = [...(s1Stats.data ?? [])];
      for (const inv of (s1Invoices?.data ?? [])) {
        s1Combined.push({ id: inv.id, account_no: inv.account_no, customer_name: inv.customer_name, city: '-', qty: Number(inv.qty||0), price: Number(inv.amount||0), season_id: s1, salesperson_id: row.salespersonId, updated_at: inv.created_at, invoice_no: inv.invoice_no, manual_edited: inv.manual_edited });
      }
      const s2Combined = [...(s2Stats.data ?? [])];
      for (const inv of (s2Invoices?.data ?? [])) {
        s2Combined.push({ id: inv.id, account_no: inv.account_no, customer_name: inv.customer_name, city: '-', qty: Number(inv.qty||0), price: Number(inv.amount||0), season_id: s2, salesperson_id: row.salespersonId, updated_at: inv.created_at, invoice_no: inv.invoice_no, manual_edited: inv.manual_edited });
      }
      setDetailsS1(s1Combined as any[]);
      setDetailsS2(s2Combined as any[]);
    } catch (e: any) {
      alert(e?.message || 'Failed to load details');
    } finally {
      setDetailsLoading(false);
    }
  }

  const { data: rows } = useSWR(
    s1 && s2 ? ['general-stats', s1, s2, selectedSalespersonId ?? 'all'] : null,
    async () => {
      // Fetch both seasons at once and aggregate client-side by account_no
      const query = supabase
        .from('sales_stats')
        .select('account_no, customer_name, city, qty, price, season_id, salesperson_id')
        .in('season_id', [s1, s2]);
      if (selectedSalespersonId) {
        query.eq('salesperson_id', selectedSalespersonId);
      }
      const { data, error } = await query.limit(100000);
      if (error) throw new Error(error.message);
      console.log('[stats] fetched raw rows', (data ?? []).length);

      const map = new Map<string, RowOut>();
      for (const r of (data ?? []) as any[]) {
        const key: string = r.account_no ?? `${r.customer_name ?? ''}:${r.city ?? ''}`;
        const rawCity = r.city ?? '';
        let itemCity: string = rawCity && rawCity !== '-' ? rawCity : '';
        if (!itemCity && r.account_no) itemCity = customerIndex?.byId?.[r.account_no] ?? '';
        if (!itemCity && r.customer_name) itemCity = customerIndex?.byName?.[r.customer_name] ?? '';
        if (!itemCity) itemCity = '-';
        const item = map.get(key) ?? {
          account_no: r.account_no ?? key,
          customer: r.customer_name ?? '-',
          city: itemCity,
          s1Qty: 0,
          s1Price: 0,
          s2Qty: 0,
          s2Price: 0,
          salespersonId: r.salesperson_id ?? null,
          salespersonName: spNameById[r.salesperson_id as string] ?? (r.salesperson_id ? 'Unknown' : '—')
        };
        const qty = Number(r.qty ?? 0) || 0;
        const price = Number(r.price ?? 0) || 0;
        if (r.season_id === s1) {
          item.s1Qty += qty;
          item.s1Price += price;
        } else if (r.season_id === s2) {
          item.s2Qty += qty;
          item.s2Price += price;
        }
        map.set(key, item);
      }
      const out = Array.from(map.values()).sort((a, b) => a.customer.localeCompare(b.customer));
      console.log('[stats] aggregated rows', out.length, 'sample', out[0]);
      return out;
    },
    { refreshInterval: 20000 }
  );

  // Seasonal overrides (null/hidden) stored in app_settings per season
  const overridesKey = s1 ? `season_overrides:${s1}` : null;
  const { data: overrides, mutate: mutateOverrides } = useSWR(overridesKey, async () => {
    if (!overridesKey) return { id: null, value: { nulled: [], hidden: [] as string[] } };
    const { data, error } = await supabase.from('app_settings').select('id, value').eq('key', overridesKey).maybeSingle();
    if (error) throw new Error(error.message);
    const val = (data?.value as any) || {};
    return { id: data?.id ?? null, value: { nulled: Array.isArray(val.nulled) ? val.nulled : [], hidden: Array.isArray(val.hidden) ? val.hidden : [] } } as { id: string | null, value: { nulled: string[]; hidden: string[] } };
  }, { refreshInterval: 0 });
  useEffect(() => {
    if (overridesKey) console.log('[stats] overrides', overridesKey, overrides);
  }, [overridesKey, overrides?.id, overrides?.value]);

  const { data: closedCustomers } = useSWR('customers-closed', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, permanently_closed, excluded, nulled');
    if (error) throw new Error(error.message);
    const setClosed = new Set<string>();
    const setExcluded = new Set<string>();
    const setNulled = new Set<string>();
    for (const c of (data ?? []) as any[]) {
      if (c.permanently_closed) setClosed.add(c.customer_id);
      if (c.excluded) setExcluded.add(c.customer_id);
      if (c.nulled) setNulled.add(c.customer_id);
    }
    return { setClosed, setExcluded, setNulled };
  });

  async function saveOverrides(next: { nulled: string[]; hidden: string[] }) {
    if (!overridesKey) return;
    console.log('[stats] saveOverrides', overridesKey, next);
    if (overrides?.id) {
      const { error } = await supabase.from('app_settings').update({ value: next }).eq('id', overrides.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from('app_settings').insert({ key: overridesKey, value: next });
      if (error) throw new Error(error.message);
    }
    await mutateOverrides();
  }


  function isHidden(account: string): boolean {
    return Boolean(overrides?.value.hidden.includes(account)) || Boolean(closedCustomers?.setExcluded.has(account));
  }
  function isNulled(account: string): boolean {
    return Boolean(overrides?.value.nulled.includes(account)) || Boolean(closedCustomers?.setNulled.has(account)) || Boolean(closedCustomers?.setClosed.has(account));
  }

  async function toggleHide(account: string) {
    if (!s1) return alert('Select Season 1 first');
    const hidden = new Set(overrides?.value.hidden ?? []);
    if (hidden.has(account)) hidden.delete(account); else hidden.add(account);
    console.log('[stats] toggleHide', account, '->', Array.from(hidden));
    await saveOverrides({ nulled: overrides?.value.nulled ?? [], hidden: Array.from(hidden) });
  }
  async function toggleNull(account: string) {
    if (!s1) return alert('Select Season 1 first');
    const nulled = new Set(overrides?.value.nulled ?? []);
    if (nulled.has(account)) nulled.delete(account); else nulled.add(account);
    console.log('[stats] toggleNull', account, '->', Array.from(nulled));
    await saveOverrides({ nulled: Array.from(nulled), hidden: overrides?.value.hidden ?? [] });
  }
  async function permanentClose(account: string) {
    // Mark customer globally; also add seasonal null
    const { error } = await supabase.from('customers').update({ permanently_closed: true, nulled: true }).eq('customer_id', account);
    if (error) return alert(error.message);
    console.log('[stats] permanentClose', account);
    await toggleNull(account);
  }

  function ActionBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
    const [show, setShow] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    return (
      <button
        className="relative rounded p-1 hover:bg-gray-100"
        onMouseEnter={() => { timer.current = setTimeout(() => setShow(true), 2000); }}
        onMouseLeave={() => { if (timer.current) clearTimeout(timer.current); setShow(false); }}
        onClick={onClick}
      >
        {children}
        {show && (
          <span className="absolute left-1/2 -translate-x-1/2 translate-y-2 text-[10px] bg-black text-white rounded px-1.5 py-0.5 shadow">
            {label}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-balance text-slate-700">General statistics</h1>
          <div className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</div>
        </div>
        <div className="relative">
          <details>
            <summary className="list-none inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm hover:bg-slate-50"><Menu className="h-4 w-4" /></summary>
            <div className="absolute right-0 z-10 mt-2 w-56 rounded-md border bg-white shadow">
              <div className="py-1 text-sm">
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50">Export Data</button>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50">Print Report</button>
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                  onClick={async () => {
                    try {
                      const { default: JSZip } = await import('jszip');
                      const { jsPDF } = await import('jspdf');
                      const { default: autoTable } = await import('jspdf-autotable');
                      const { default: saveAs } = await import('file-saver');
                      const zip = new JSZip();
                      const s1Label = getSeasonLabel(s1) || 'Season 1';
                      const s2Label = getSeasonLabel(s2) || 'Season 2';
                      const visibleRows = (rows ?? []).filter(r => !isHidden(r.account_no));
                      const bySp = new Map<string, any[]>();
                      for (const r of visibleRows) {
                        const name = r.salespersonName || 'Unknown';
                        const arr = bySp.get(name) || [];
                        arr.push(r);
                        bySp.set(name, arr);
                      }
                      for (const [spName, list] of bySp.entries()) {
                        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
                        doc.setFontSize(14);
                        doc.text(`General · ${spName}`, 40, 40);
                        const head = [[
                          'Customer', 'City',
                          `${s1Label} Qty`, `${s1Label} Price`,
                          `${s2Label} Qty`, `${s2Label} Price`,
                          'Dev Qty', 'Dev Price'
                        ]];
                        const body = (list as any[]).map((row) => {
                          const currency = row.salespersonId ? (spCurrencyById[row.salespersonId] ?? 'DKK') : 'DKK';
                          const devQty = row.s1Qty - row.s2Qty;
                          const devPrice = row.s1Price - row.s2Price;
                          return [
                            row.customer,
                            row.city,
                            String(row.s1Qty), `${Math.round(row.s1Price).toLocaleString('da-DK')} ${currency}`,
                            String(row.s2Qty), `${Math.round(row.s2Price).toLocaleString('da-DK')} ${currency}`,
                            (devQty>0?'+':'') + String(devQty), `${(devPrice>0?'+':'') + Math.round(devPrice).toLocaleString('da-DK')} ${currency}`
                          ];
                        });
                        autoTable(doc, {
                          head,
                          body,
                          startY: 60,
                          styles: { fontSize: 10, lineColor: [219,234,254], lineWidth: 0.5 },
                          headStyles: { fillColor: [29,78,216], textColor: [255,255,255] },
                          alternateRowStyles: { fillColor: [239,246,255] },
                          theme: 'grid'
                        });
                        const pdfBlob = doc.output('blob');
                        zip.file(`${spName.replace(/[^a-z0-9_-]+/gi,'_')}.pdf`, pdfBlob);
                      }
                      const blob = await zip.generateAsync({ type: 'blob' });
                      saveAs(blob, `general_export.zip`);
                    } catch (e) {
                      console.error('general export failed', e);
                    }
                  }}
                >Export PDF (ZIP)</button>
                <Link className="block px-3 py-2 hover:bg-gray-50" href="/statistics/general/import">Import Statistic</Link>
                <Link className="block px-3 py-2 hover:bg-gray-50" href={'/statistics/general/last-runs' as any}>Last Runs</Link>
                <Link className="block px-3 py-2 hover:bg-gray-50" href="/settings/seasons">Season Settings</Link>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50" onClick={() => { setNullByInputText(''); setNullByInputResult(null); setNullByInputOpen(true); }}>Null Customers by Input</button>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50" onClick={handleUpdateStatistic}>Update Statistic</button>
              </div>
            </div>
          </details>
        </div>
      </div>


      <div className="space-y-4">
        {/* Toast removed per request */}
        <div className="flex flex-wrap w-full gap-2">
          {(((salespersons ?? []).map((sp) => sp.name)) as string[]).map((person) => {
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

        {/* Single section for selected salesperson */}
        {(() => {
          const visibleRows = (rows ?? []).filter(r => !isHidden(r.account_no));
          const items = activePerson ? visibleRows.filter(r => r.salespersonName === activePerson) : visibleRows;
          console.log('[stats] table items', items.length);
          const tableCurrency = activePerson && selectedSalespersonId ? (spCurrencyById[selectedSalespersonId] ?? 'DKK') : 'DKK';
          return (
            <>
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
                      <th className="p-2 text-center"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => {
                      const devQty = row.s1Qty - row.s2Qty;
                      const devPrice = row.s1Price - row.s2Price;
                      const nulled = isNulled(row.account_no);
                      const currency = row.salespersonId ? (spCurrencyById[row.salespersonId] ?? 'DKK') : 'DKK';
                      return (
                        <tr key={row.account_no} className={"border-t hover:bg-slate-50 " + (nulled ? 'opacity-80' : '')}>
                          <td className={"relative p-2 font-medium " + (nulled ? '' : '')}>
                            {row.customer}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className={"relative p-2 " + (nulled ? '' : '')}>
                            {row.city}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className={"relative p-2 text-center " + (row.s1Qty < row.s2Qty ? 'text-red-600' : '')}>
                            {row.s1Qty}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className={"relative p-2 text-center " + (row.s1Price < row.s2Price ? 'text-red-600' : '')}>
                            {row.s1Price.toLocaleString('da-DK')} {currency}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className="relative p-2 text-center">
                            {row.s2Qty}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className="relative p-2 text-center">
                            {row.s2Price.toLocaleString('da-DK')} {currency}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className="p-2 text-center">
                            <span className={devQty > 0 ? 'text-green-600' : devQty < 0 ? 'text-red-600' : ''}>
                              {devQty > 0 ? '+' : ''}{devQty}
                            </span>
                          </td>
                          <td className="p-2 text-center">
                            <span className={devPrice > 0 ? 'text-green-600' : devPrice < 0 ? 'text-red-600' : ''}>
                              {devPrice > 0 ? '+' : ''}{devPrice.toLocaleString()} {currency}
                            </span>
                          </td>
                          <td className="p-2">
                            <div className="relative flex items-center justify-center gap-1.5">
                              <button
                                className="rounded border px-2 py-0.5 text-xs"
                                onClick={() => openDetails(row)}
                              >Details</button>
                              <ActionBtn label="Hide" onClick={() => toggleHide(row.account_no)}>
                                <Ban className="h-4 w-4" />
                              </ActionBtn>
                              <ActionBtn label="Null (season)" onClick={() => toggleNull(row.account_no)}>
                                <EyeOff className="h-4 w-4" />
                              </ActionBtn>
                              <ActionBtn label="Close (perm)" onClick={() => permanentClose(row.account_no)}>
                                <Trash2 className="h-4 w-4" />
                              </ActionBtn>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot></tfoot>
                </table>
              </div>
              {/* Removed sticky overlay totals; separate TOTALS section below */}
              {/* KPI cards when a salesperson is selected */}
              {activePerson && (
                <div className="border-t p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {(() => {
                    const rates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
                    const s1Local = items.reduce((a,b)=>a+b.s1Price,0);
                    const s2Local = items.reduce((a,b)=>a+b.s2Price,0);
                    const s1Dkk = Math.round(items.reduce((a, r) => { const c = r.salespersonId ? (spCurrencyById[r.salespersonId] ?? 'DKK') : 'DKK'; const rate = rates[c] ?? 1; return a + r.s1Price * rate; }, 0));
                    const s2Dkk = Math.round(items.reduce((a, r) => { const c = r.salespersonId ? (spCurrencyById[r.salespersonId] ?? 'DKK') : 'DKK'; const rate = rates[c] ?? 1; return a + r.s2Price * rate; }, 0));
                    const nulledSeasonal = new Set(overrides?.value.nulled ?? []);
                    const nulledCount = items.reduce((a, r) => a + (nulledSeasonal.has(r.account_no) ? 1 : 0), 0);
                    const permClosedCount = items.reduce((a, r) => a + (closedCustomers?.setClosed.has(r.account_no) ? 1 : 0), 0);
                    return (
                      <>
                        <div className="rounded-md border p-3">
                          <div className="text-xs text-gray-500">Total customers</div>
                          <div className="text-xl font-semibold">{items.length}</div>
                        </div>
                        <div className="rounded-md border p-3">
                          <div className="text-xs text-gray-500">Season 1 total</div>
                          <div className="text-xl font-semibold">{s1Dkk.toLocaleString('da-DK')} DKK</div>
                          <div className="text-[11px] text-gray-400">{s1Local.toLocaleString('da-DK')} local</div>
                        </div>
                        <div className="rounded-md border p-3">
                          <div className="text-xs text-gray-500">Season 2 total</div>
                          <div className="text-xl font-semibold">{s2Dkk.toLocaleString('da-DK')} DKK</div>
                          <div className="text-[11px] text-gray-400">{s2Local.toLocaleString('da-DK')} local</div>
                        </div>
                        <div className="rounded-md border p-3">
                          <div className="text-xs text-gray-500">Growth</div>
                          <div className={"text-xl font-semibold " + ((s1Dkk - s2Dkk)>=0? 'text-green-700':'text-red-700')}>
                            {(s1Dkk - s2Dkk).toLocaleString('da-DK')} DKK
                          </div>
                          <div className="text-[11px] text-gray-400">based on visible customers</div>
                        </div>
                        <div className="rounded-md border p-3">
                          <div className="text-xs text-gray-500">Nulled · Perm Closed</div>
                          <div className="text-xl font-semibold">{nulledCount} · {permClosedCount}</div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
              {/* Totals section removed per request */}
            </div>
            {/* Details modal */}
            <Modal
              open={detailsOpen}
              onClose={() => setDetailsOpen(false)}
              title={detailsRow ? `${detailsRow.customer} · ${detailsRow.city}` : 'Details'}
              footer={
                <button className="rounded border px-3 py-1.5 text-sm" onClick={() => setDetailsOpen(false)}>Close</button>
              }
            >
              {detailsLoading ? (
                <div className="text-sm text-gray-600">Loading…</div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <div className="font-medium mb-1">{getSeasonLabel(s1) || 'Season 1'}</div>
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50">
                          <th className="text-left p-2 border-b">Account</th>
                          <th className="text-left p-2 border-b">Customer</th>
                          <th className="text-left p-2 border-b">City</th>
                          <th className="text-right p-2 border-b">Qty</th>
                          <th className="text-right p-2 border-b">Price</th>
                          <th className="text-left p-2 border-b">Invoice</th>
                          <th className="text-right p-2 border-b">Scraped</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailsS1.map((r, idx) => (
                          <tr key={idx}>
                            <td className="p-2 border-b">{r.account_no}</td>
                            <td className="p-2 border-b">{r.customer_name}</td>
                            <td className="p-2 border-b">{r.city}</td>
                            <td className="p-2 border-b text-right">
                              {r.invoice_no ? (
                                <input
                                  className="w-20 border rounded px-1 text-right"
                                  defaultValue={Number(r.qty ?? 0)}
                                  onBlur={async (e) => {
                                    try {
                                      const v = Number(e.target.value || 0) || 0;
                                      await supabase.from('sales_invoices').update({ qty: v, manual_edited: true }).eq('id', (r as any).id);
                                    } catch {}
                                  }}
                                />
                              ) : (
                                Number(r.qty ?? 0)
                              )}
                            </td>
                            <td className="p-2 border-b text-right">
                              {r.invoice_no ? (
                                <input
                                  className="w-28 border rounded px-1 text-right"
                                  defaultValue={Number(r.price ?? 0)}
                                  onBlur={async (e) => {
                                    try {
                                      const v = Number(e.target.value || 0) || 0;
                                      await supabase.from('sales_invoices').update({ amount: v, manual_edited: true }).eq('id', (r as any).id);
                                    } catch {}
                                  }}
                                />
                              ) : (
                                Number(r.price ?? 0).toLocaleString('da-DK')
                              )}
                            </td>
                            <td className="p-2 border-b">{(r as any).invoice_no ?? '—'}</td>
                            <td className="p-2 border-b text-right">{r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        {(() => {
                          const s = detailsS1.reduce((a, r) => ({ qty: a.qty + Number(r.qty ?? 0), price: a.price + Number(r.price ?? 0) }), { qty: 0, price: 0 });
                          return (
                            <tr className="bg-gray-50 font-semibold">
                              <td className="p-2" colSpan={3}>TOTAL</td>
                              <td className="p-2 text-right">{s.qty}</td>
                              <td className="p-2 text-right">{s.price.toLocaleString('da-DK')}</td>
                            </tr>
                          );
                        })()}
                      </tfoot>
                    </table>
                  </div>
                  <div>
                    <div className="font-medium mb-1">{getSeasonLabel(s2) || 'Season 2'}</div>
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50">
                          <th className="text-left p-2 border-b">Account</th>
                          <th className="text-left p-2 border-b">Customer</th>
                          <th className="text-left p-2 border-b">City</th>
                          <th className="text-right p-2 border-b">Qty</th>
                          <th className="text-right p-2 border-b">Price</th>
                          <th className="text-left p-2 border-b">Invoice</th>
                          <th className="text-right p-2 border-b">Scraped</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailsS2.map((r, idx) => (
                          <tr key={idx}>
                            <td className="p-2 border-b">{r.account_no}</td>
                            <td className="p-2 border-b">{r.customer_name}</td>
                            <td className="p-2 border-b">{r.city}</td>
                            <td className="p-2 border-b text-right">{Number(r.qty ?? 0)}</td>
                            <td className="p-2 border-b text-right">{Number(r.price ?? 0).toLocaleString('da-DK')}</td>
                            <td className="p-2 border-b">{(r as any).invoice_no ?? '—'}</td>
                            <td className="p-2 border-b text-right">{r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        {(() => {
                          const s = detailsS2.reduce((a, r) => ({ qty: a.qty + Number(r.qty ?? 0), price: a.price + Number(r.price ?? 0) }), { qty: 0, price: 0 });
                          return (
                            <tr className="bg-gray-50 font-semibold">
                              <td className="p-2" colSpan={3}>TOTAL</td>
                              <td className="p-2 text-right">{s.qty}</td>
                              <td className="p-2 text-right">{s.price.toLocaleString('da-DK')}</td>
                            </tr>
                          );
                        })()}
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}
            </Modal>

            {/* Null By Input modal */}
            <Modal
              open={nullByInputOpen}
              onClose={() => setNullByInputOpen(false)}
              title="Null Customers by Input"
              footer={(
                <div className="flex items-center gap-2">
                  <button className="rounded border px-3 py-1.5 text-sm" onClick={() => setNullByInputOpen(false)}>Close</button>
                  <button
                    className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
                    onClick={async () => {
                      try {
                        if (!s1) { alert('Select Season 1 first'); return; }
                        const names = nullByInputText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                        const byName = new Map<string, string[]>();
                        for (const r of (rows ?? []) as any[]) {
                          const name = String(r.customer || '').trim().toLowerCase();
                          if (!name) continue;
                          const arr = byName.get(name) || [];
                          arr.push(r.account_no);
                          byName.set(name, arr);
                        }
                        const toNull = new Set<string>(overrides?.value.nulled ?? []);
                        const matched: string[] = [];
                        const unmatched: string[] = [];
                        for (const raw of names) {
                          const key = raw.toLowerCase();
                          const accounts = byName.get(key);
                          if (accounts && accounts.length > 0) {
                            for (const acc of accounts) toNull.add(acc);
                            matched.push(`${raw} (${accounts.join(',')})`);
                          } else {
                            unmatched.push(raw);
                          }
                        }
                        await saveOverrides({ nulled: Array.from(toNull), hidden: overrides?.value.hidden ?? [] });
                        setNullByInputResult(`Matched: ${matched.length}. Unmatched: ${unmatched.length}${unmatched.length? ' → ' + unmatched.join(', ') : ''}`);
                        console.log('[null-by-input] matched', matched, 'unmatched', unmatched);
                      } catch (e: any) {
                        setNullByInputResult(e?.message || String(e));
                      }
                    }}
                  >Apply</button>
                </div>
              )}
            >
              <div className="space-y-2">
                <div className="text-sm text-gray-600">Enter one customer name per line. Matching is case-insensitive against the Customer column shown in the table. Matches will be nulled for the selected Season 1.</div>
                <textarea className="w-full h-48 border rounded-md p-2 text-sm" value={nullByInputText} onChange={(e) => setNullByInputText(e.target.value)} placeholder={"Customer A\nCustomer B"} />
                {nullByInputResult && <div className="text-sm">{nullByInputResult}</div>}
              </div>
            </Modal>
            </>
          );
        })()}
      </div>
    </div>
  );
}



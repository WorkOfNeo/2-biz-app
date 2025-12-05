'use client';
import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import { Menu, EyeOff, Trash2, Ban, MessageCircle } from 'lucide-react';
import { SearchSelect } from '../../../components/SearchSelect';
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
    const { data, error } = await supabase.from('customers').select('customer_id, company, city, group_name');
    if (error) throw new Error(error.message);
    const byId: Record<string, string> = {};
    const byName: Record<string, string> = {};
    const groupById: Record<string, string> = {};
    for (const c of (data ?? []) as any[]) {
      if (c.customer_id) byId[c.customer_id] = c.city ?? '';
      if (c.company) byName[c.company] = c.city ?? '';
      if (c.customer_id) groupById[c.customer_id] = c.group_name ?? '';
    }
    return { byId, byName, groupById } as { byId: Record<string, string>; byName: Record<string, string>; groupById: Record<string, string> };
  }, { refreshInterval: 0 });
  // Full customers list to allow showing baseline rows even when no stats exist for a season
  const { data: allCustomers } = useSWR('general:customers', async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('customer_id, company, city, salesperson_id, group_name');
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ customer_id: string; company: string | null; city: string | null; salesperson_id: string | null; group_name?: string | null }>;
  });
  // Global currency rates (fallback) and season-specific rates
  const { data: currencyRatesRow } = useSWR('app-settings:currency-rates', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as Record<string, number> | undefined) ?? {};
  });
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');
  const { data: ratesS1 } = useSWR(s1 ? `season:${s1}:currency-rates` : null, async () => {
    const key = `currency_rates:${s1}`;
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    return ((data?.value as any) || {}) as Record<string, number>;
  });
  const { data: ratesS2 } = useSWR(s2 ? `season:${s2}:currency-rates` : null, async () => {
    const key = `currency_rates:${s2}`;
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    return ((data?.value as any) || {}) as Record<string, number>;
  });
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
  // Import Statistics modal state
  const [importOpen, setImportOpen] = useState(false);
  const [importSeasonId, setImportSeasonId] = useState<string>('');
  const [importLookup, setImportLookup] = useState<'account' | 'name_city'>('account');
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importRows, setImportRows] = useState<any[]>([]);
  const [mapAccount, setMapAccount] = useState<string>('');
  const [mapCustomer, setMapCustomer] = useState<string>('');
  const [mapCity, setMapCity] = useState<string>('');
  const [mapQty, setMapQty] = useState<string>('');
  const [mapPrice, setMapPrice] = useState<string>('');
  const [mapNulled, setMapNulled] = useState<string>('');
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<any | null>(null);
  // Manual entry modal state
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSeasonId, setManualSeasonId] = useState<string>('');
  const [manualCustomerId, setManualCustomerId] = useState<string>('');
  const [manualQty, setManualQty] = useState<string>('');
  const [manualPrice, setManualPrice] = useState<string>('');
  const { data: customersAll } = useSWR('general:customers-all', async () => {
    const { data, error } = await supabase.from('customers').select('customer_id, company').order('company', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ customer_id: string; company: string | null }>;
  });
  const spNameById = useMemo(() => Object.fromEntries(((salespersons ?? []) as { id: string; name: string }[]).map(s => [s.id, s.name])), [salespersons]);
  const spCurrencyById = useMemo(() => Object.fromEntries(((salespersons ?? []) as { id: string; currency?: string | null }[]).map(s => [s.id, s.currency ?? 'DKK'])), [salespersons]);
  useEffect(() => {
    if (saved?.value) {
      setS1(saved.value.s1 ?? '');
      setS2(saved.value.s2 ?? '');
    }
    // Fallback to current season if defaults are missing
    if ((!saved?.value?.s1 || !saved?.value?.s2) && (seasons ?? []).length) {
      const list = (seasons ?? []) as any[];
      const current = list.find((x) => x.is_current);
      const first = list[0];
      const second = list[1] || list.find((x) => x.id !== (current?.id || first?.id));
      if (!saved?.value?.s1) setS1((current?.id || first?.id) ?? '');
      if (!saved?.value?.s2) setS2((second?.id) ?? '');
    }
  }, [saved?.id, seasons?.length]);
  useEffect(() => {
    if (s1 || s2) setShowSave(true);
  }, [s1, s2]);

  // Read salesperson from URL hash on load and listen for hash changes
  useEffect(() => {
    if (typeof window === 'undefined' || !salespersons || salespersons.length === 0) return;

    const readHashFromURL = (): string | null => {
      const hash = window.location.hash || '';
      // Match #sp=value
      const m = hash.match(/^#sp=([^&]+)/);
      if (m && m[1]) {
        try {
          const decoded = decodeURIComponent(m[1]);
          const exists = salespersons.some(sp => sp.name === decoded);
          if (exists) {
            return decoded;
          }
        } catch (err) {
          console.warn('[stats] failed to decode hash', err);
        }
      }
      return null;
    };

    const handleHashChange = () => {
      const decoded = readHashFromURL();
      if (decoded) {
        // Hash found - use it (this takes priority)
        setActivePerson(decoded);
        console.log('[stats] read salesperson from hash', decoded);
      } else {
        // No valid hash found - check if we should default
        const hasSpHash = window.location.hash && window.location.hash.includes('sp=');
        if (!hasSpHash && !activePerson) {
          // Only default if no hash parameter exists and activePerson is not set
          const first = (salespersons[0] as any)?.name as string | undefined;
          if (first) {
            setActivePerson(first);
            console.log('[stats] default salesperson (no hash)', first);
          }
        }
      }
    };

    // Check hash immediately
    handleHashChange();

    // Listen for hashchange events (e.g., when navigating from homepage)
    window.addEventListener('hashchange', handleHashChange);
    
    // Also check after a short delay to catch Next.js client-side navigation
    const timeoutId = setTimeout(handleHashChange, 100);
    
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salespersons?.length]); // Re-run when salespersons list loads/changes
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
      try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('job-started', { detail: { jobId: json.jobId, label: 'Update statistics — job started' } })); } catch {}
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
    groupName?: string | null;
    s1Qty: number;
    s1Price: number;
    s2Qty: number;
    s2Price: number;
    salespersonId: string | null;
    salespersonName: string;
    isGroupTotal?: boolean;
  };

  // Details modal state
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsRow, setDetailsRow] = useState<RowOut | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsS1, setDetailsS1] = useState<any[]>([]);
  const [detailsS2, setDetailsS2] = useState<any[]>([]);
  const [detailsS1NewRows, setDetailsS1NewRows] = useState<any[]>([]);
  const [detailsS2NewRows, setDetailsS2NewRows] = useState<any[]>([]);
  // Comment modal state
  const [commentModalOpen, setCommentModalOpen] = useState(false);
  const [commentCustomerId, setCommentCustomerId] = useState<string>('');
  const [commentText, setCommentText] = useState<string>('');
  const [commentIsPermanent, setCommentIsPermanent] = useState(false);
  const [commentLoading, setCommentLoading] = useState(false);

  async function openDetails(row: RowOut) {
    if (!s1 && !s2) return;
    setDetailsRow(row);
    setDetailsOpen(true);
    setDetailsLoading(true);
    setDetailsS1NewRows([]);
    setDetailsS2NewRows([]);
    try {
      const hasAccount = !!row.account_no && !row.account_no.includes(':');
          const buildQuery = (seasonId: string | undefined) => {
        // Fetch both aggregated stats (sales_stats) and raw invoice rows (sales_invoices)
        const stats = supabase
          .from('sales_stats')
          .select('id, account_no, customer_name, city, qty, price, currency, season_id, salesperson_id, updated_at, frozen')
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

  function addNewRowToSeason(season: 's1' | 's2') {
    if (!detailsRow) return;
    const seasonId = season === 's1' ? s1 : s2;
    if (!seasonId) return;
    const invoiceNo = `2BIZ-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Date.now().toString().slice(-6)}`;
    const newRow = {
      id: `temp-${Date.now()}-${Math.random()}`,
      account_no: detailsRow.account_no,
      customer_name: detailsRow.customer,
      city: detailsRow.city || '-',
      qty: 0,
      price: 0,
      season_id: seasonId,
      salesperson_id: detailsRow.salespersonId,
      invoice_no: invoiceNo,
      manual_edited: true,
      isNew: true
    };
    if (season === 's1') {
      setDetailsS1NewRows([...detailsS1NewRows, newRow]);
    } else {
      setDetailsS2NewRows([...detailsS2NewRows, newRow]);
    }
  }

  async function saveNewRow(row: any, season: 's1' | 's2') {
    const seasonId = season === 's1' ? s1 : s2;
    if (!seasonId || !row) return;
    const qty = Number(row.qty ?? 0) || 0;
    const price = Number(row.price ?? 0) || 0;
    if (!qty && !price) return; // Skip if both are zero/empty
    
    // Check if this row is already being saved (has been saved flag)
    if ((row as any).saving) return;
    
    try {
      // Mark as saving to prevent duplicate saves
      if (season === 's1') {
        setDetailsS1NewRows(detailsS1NewRows.map(r => r.id === row.id ? { ...r, saving: true } : r));
      } else {
        setDetailsS2NewRows(detailsS2NewRows.map(r => r.id === row.id ? { ...r, saving: true } : r));
      }
      
      const { error } = await supabase.from('sales_invoices').insert({
        invoice_no: row.invoice_no,
        account_no: row.account_no,
        customer_name: row.customer_name,
        qty,
        amount: price,
        season_id: seasonId,
        manual_edited: true
      } as any);
      if (error) throw new Error(error.message);
      
      // Remove from temporary state
      if (season === 's1') {
        setDetailsS1NewRows(detailsS1NewRows.filter(r => r.id !== row.id));
      } else {
        setDetailsS2NewRows(detailsS2NewRows.filter(r => r.id !== row.id));
      }
      
      // Refresh details data
      if (detailsRow) {
        await openDetails(detailsRow);
      }
      
      // Refresh main table
      await mutateGeneralRows();
    } catch (e: any) {
      // Remove saving flag on error
      if (season === 's1') {
        setDetailsS1NewRows(detailsS1NewRows.map(r => r.id === row.id ? { ...r, saving: false } : r));
      } else {
        setDetailsS2NewRows(detailsS2NewRows.map(r => r.id === row.id ? { ...r, saving: false } : r));
      }
      alert(e?.message || 'Failed to save row');
    }
  }

  function removeNewRow(rowId: string, season: 's1' | 's2') {
    if (season === 's1') {
      setDetailsS1NewRows(detailsS1NewRows.filter(r => r.id !== rowId));
    } else {
      setDetailsS2NewRows(detailsS2NewRows.filter(r => r.id !== rowId));
    }
  }

  // Fetch comments for visible customers (season-specific or permanent)
  const { data: commentsMap, mutate: mutateComments } = useSWR(
    s1 ? ['customer-comments', s1] : null,
    async () => {
      if (!s1) return {};
      const { data, error } = await supabase
        .from('customer_comments')
        .select('customer_id, comment, is_permanent, season_id')
        .or(`season_id.eq.${s1},is_permanent.eq.true`);
      if (error) throw new Error(error.message);
      const map: Record<string, { comment: string; is_permanent: boolean; season_id: string | null }> = {};
      // Prioritize season-specific comments over permanent ones
      for (const c of (data ?? []) as any[]) {
        const existing = map[c.customer_id];
        if (!existing || (c.season_id === s1 && existing.season_id !== s1)) {
          map[c.customer_id] = { comment: c.comment, is_permanent: c.is_permanent, season_id: c.season_id };
        }
      }
      return map;
    },
    { refreshInterval: 0 }
  );

  async function openCommentModal(customerId: string) {
    setCommentCustomerId(customerId);
    setCommentModalOpen(true);
    setCommentLoading(true);
    try {
      // Fetch existing comment (season-specific or permanent)
      const { data: seasonComment } = await supabase
        .from('customer_comments')
        .select('id, comment, is_permanent, season_id')
        .eq('customer_id', customerId)
        .eq('season_id', s1)
        .maybeSingle();
      const { data: permanentComment } = await supabase
        .from('customer_comments')
        .select('id, comment, is_permanent, season_id')
        .eq('customer_id', customerId)
        .eq('is_permanent', true)
        .maybeSingle();
      // Prioritize season-specific over permanent
      const existing = seasonComment || permanentComment;
      if (existing) {
        setCommentText(existing.comment || '');
        setCommentIsPermanent(existing.is_permanent || false);
      } else {
        setCommentText('');
        setCommentIsPermanent(false);
      }
    } catch (e: any) {
      console.error('Failed to load comment', e);
      setCommentText('');
      setCommentIsPermanent(false);
    } finally {
      setCommentLoading(false);
    }
  }

  async function fixMissingCustomer(account_no: string, customer_name: string, city: string, salesperson_id: string | null) {
    if (!account_no) {
      alert('No account number available');
      return;
    }
    if (!confirm(`Create customer "${customer_name}" (${account_no}) in the customers database?`)) {
      return;
    }
    try {
      const { error } = await supabase.from('customers').insert({
        customer_id: account_no,
        company: customer_name || account_no,
        city: city || null,
        salesperson_id: salesperson_id || null,
        country: null, // Will need to be set manually later
      });
      if (error) throw error;
      alert(`✓ Customer created successfully!\n\nAccount: ${account_no}\nName: ${customer_name}\nSalesperson: ${salesperson_id || 'None'}`);
      // Refresh customers list
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch (err: any) {
      alert(`Failed to create customer: ${err.message}`);
      console.error('[general] fixMissingCustomer error', err);
    }
  }

  async function saveComment() {
    if (!commentCustomerId || !s1) return;
    try {
      setCommentLoading(true);
      const commentTextTrimmed = commentText.trim();
      
      if (!commentTextTrimmed) {
        // Delete comment if empty
        await supabase
          .from('customer_comments')
          .delete()
          .or(`and(customer_id.eq.${commentCustomerId},season_id.eq.${s1}),and(customer_id.eq.${commentCustomerId},is_permanent.eq.true)`);
      } else {
        const seasonId = commentIsPermanent ? null : s1;
        // Check if comment exists
        const { data: existing } = await supabase
          .from('customer_comments')
          .select('id')
          .eq('customer_id', commentCustomerId)
          .eq(commentIsPermanent ? 'is_permanent' : 'season_id', commentIsPermanent ? true : s1)
          .maybeSingle();
        
        if (existing) {
          // Update existing
          await supabase
            .from('customer_comments')
            .update({
              comment: commentTextTrimmed,
              is_permanent: commentIsPermanent,
              season_id: seasonId
            })
            .eq('id', existing.id);
        } else {
          // Insert new
          await supabase
            .from('customer_comments')
            .insert({
              customer_id: commentCustomerId,
              season_id: seasonId,
              comment: commentTextTrimmed,
              is_permanent: commentIsPermanent
            });
        }
      }
      setCommentModalOpen(false);
      // Refresh comments
      await mutateComments();
    } catch (e: any) {
      alert(e?.message || 'Failed to save comment');
    } finally {
      setCommentLoading(false);
    }
  }

  const { data: rows, mutate: mutateGeneralRows } = useSWR(
    s1 && s2 ? ['general-stats', s1, s2, selectedSalespersonId ?? 'all'] : null,
    async () => {
      // Fetch both seasons at once and aggregate client-side by account_no
      const statsQuery = supabase
        .from('sales_stats')
        .select('account_no, customer_name, city, qty, price, season_id, salesperson_id')
        .in('season_id', [s1, s2]);
      if (selectedSalespersonId) {
        statsQuery.eq('salesperson_id', selectedSalespersonId);
      }
      
      // Build invoices query - need to filter by salesperson via customer lookup
      // First get customer IDs for the selected salesperson
      let targetCustomerIds: string[] = [];
      if (selectedSalespersonId) {
        const customerIds = (allCustomers ?? [])
          .filter(c => c.salesperson_id === selectedSalespersonId && c.customer_id)
          .map(c => c.customer_id!);
        targetCustomerIds = customerIds;
      }
      
      const invoicesQuery = supabase
        .from('sales_invoices')
        .select('account_no, customer_name, qty, amount, season_id')
        .in('season_id', [s1, s2]);
      
      // Filter invoices by customer IDs when a salesperson is selected
      if (selectedSalespersonId && targetCustomerIds.length > 0) {
        invoicesQuery.in('account_no', targetCustomerIds);
      }

      const [statsRes, invoicesRes] = await Promise.all([
        statsQuery.limit(100000),
        invoicesQuery.limit(100000)
      ]);
      if (statsRes.error) throw new Error(statsRes.error.message);
      if (invoicesRes.error) throw new Error(invoicesRes.error.message);
      const statsData = statsRes.data ?? [];
      // Debug: surface salesperson mapping issues and season filters
      try {
        const bySp = new Map<string, number>();
        for (const r of statsData as any[]) {
          const id = String(r.salesperson_id || 'null');
          bySp.set(id, (bySp.get(id) || 0) + 1);
        }
        console.log('[stats] salesperson_id counts', Object.fromEntries(bySp));
        console.log('[stats] selectedSalespersonId', selectedSalespersonId, 'seasons', s1, s2);
      } catch {}
      const invoicesData = invoicesRes.data ?? [];
      console.log('[stats] fetched raw rows', statsData.length, 'invoices', invoicesData.length);

      const map = new Map<string, RowOut>();
      // Seed baseline rows from customers so empty seasons still show the full customer list
      for (const c of (allCustomers ?? [])) {
        if (selectedSalespersonId && c.salesperson_id !== selectedSalespersonId) continue;
        const key: string = c.customer_id || `${c.company ?? ''}:${c.city ?? ''}`;
        if (!key) continue;
        if (!map.has(key)) {
          const spId = c.salesperson_id;
          map.set(key, {
            account_no: c.customer_id || key,
            customer: c.company ?? '-',
            city: (c.city && c.city !== '-') ? c.city : (c.customer_id ? (customerIndex?.byId?.[c.customer_id] ?? '-') : (c.company ? (customerIndex?.byName?.[c.company] ?? '-') : '-')),
            groupName: (c as any).group_name ?? (c.customer_id ? (customerIndex as any)?.groupById?.[c.customer_id] ?? null : null),
            s1Qty: 0,
            s1Price: 0,
            s2Qty: 0,
            s2Price: 0,
            salespersonId: spId ?? null,
            salespersonName: spId ? (spNameById[spId] ?? 'Unknown') : '—'
          });
        }
      }
      // Aggregate TopSeller (sales_stats)
      for (const r of statsData as any[]) {
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
          groupName: r.account_no ? (customerIndex as any)?.groupById?.[r.account_no] ?? null : null,
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
      // Aggregate Invoices (sales_invoices) into same keys to make top table equal sum of details
      for (const inv of invoicesData as any[]) {
        const key: string = inv.account_no ?? `${inv.customer_name ?? ''}:-`;
        const itemExisting = map.get(key);
        // Derive city if possible
        let itemCity: string = itemExisting?.city ?? '';
        if (!itemCity && inv.account_no) itemCity = customerIndex?.byId?.[inv.account_no] ?? '';
        if (!itemCity && inv.customer_name) itemCity = customerIndex?.byName?.[inv.customer_name] ?? '';
        if (!itemCity) itemCity = '-';
        const item = itemExisting ?? {
          account_no: inv.account_no ?? key,
          customer: inv.customer_name ?? '-',
          city: itemCity,
          groupName: inv.account_no ? (customerIndex as any)?.groupById?.[inv.account_no] ?? null : null,
          s1Qty: 0,
          s1Price: 0,
          s2Qty: 0,
          s2Price: 0,
          salespersonId: null,
          salespersonName: '—'
        } as RowOut;
        const qty = Number(inv.qty ?? 0) || 0;
        const amount = Number(inv.amount ?? 0) || 0;
        if (inv.season_id === s1) {
          item.s1Qty += qty;
          item.s1Price += amount;
        } else if (inv.season_id === s2) {
          item.s2Qty += qty;
          item.s2Price += amount;
        }
        map.set(key, item);
      }

      const out = Array.from(map.values()).sort((a, b) => a.customer.localeCompare(b.customer));
      console.log('[stats] aggregated rows (stats+invoices)', out.length, 'sample', out[0]);
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

  const { data: closedCustomers, mutate: mutateClosedCustomers } = useSWR('customers-closed', async () => {
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
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                  onClick={async () => {
                    try {
                      const [XLSX, { default: saveAs }] = await Promise.all([
                        import('xlsx'),
                        import('file-saver')
                      ]);
                      const s1Label = getSeasonLabel(s1) || 'Season 1';
                      const s2Label = getSeasonLabel(s2) || 'Season 2';
                      // Re-query ALL rows across all salespersons to avoid active-person filtering
                      const statsRes = await supabase
                        .from('sales_stats')
                        .select('account_no, customer_name, city, qty, price, season_id, salesperson_id')
                        .in('season_id', [s1, s2])
                        .limit(200000);
                      if (statsRes.error) throw new Error(statsRes.error.message);
                      const statsData = statsRes.data ?? [];
                      const mapAll = new Map<string, { account_no: string; customer: string; city: string; s1Qty: number; s1Price: number; s2Qty: number; s2Price: number; salespersonId: string | null }>();
                      for (const r of statsData as any[]) {
                        const key: string = r.account_no ?? `${r.customer_name ?? ''}:${r.city ?? ''}`;
                        const base = mapAll.get(key) || { account_no: r.account_no ?? '', customer: r.customer_name ?? '', city: r.city ?? '', s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0, salespersonId: r.salesperson_id ?? null };
                        if (r.season_id === s1) { base.s1Qty += Number(r.qty||0); base.s1Price += Number(r.price||0); }
                        else if (r.season_id === s2) { base.s2Qty += Number(r.qty||0); base.s2Price += Number(r.price||0); }
                        if (!base.salespersonId && r.salesperson_id) base.salespersonId = r.salesperson_id;
                        mapAll.set(key, base);
                      }
                      const allRows = Array.from(mapAll.values());
                      const header = [
                        'Salesperson', 'Customer', 'City',
                        `${s1Label} Qty`, `${s1Label} Price`,
                        `${s2Label} Qty`, `${s2Label} Price`,
                        'Dev Qty', 'Dev Price', 'Currency'
                      ];
                      const data = allRows.map((row) => {
                        const salespersonName = row.salespersonId ? (spNameById[row.salespersonId] || 'Unknown') : 'Unknown';
                        const currency = row.salespersonId ? (spCurrencyById[row.salespersonId] ?? 'DKK') : 'DKK';
                        const devQty = row.s1Qty - row.s2Qty;
                        const devPrice = row.s1Price - row.s2Price;
                        return [
                          salespersonName,
                          row.customer,
                          row.city,
                          row.s1Qty,
                          Math.round(row.s1Price),
                          row.s2Qty,
                          Math.round(row.s2Price),
                          devQty,
                          Math.round(devPrice),
                          currency
                        ];
                      });
                      const wb = XLSX.utils.book_new();
                      const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
                      XLSX.utils.book_append_sheet(wb, ws, 'General');
                      const filename = `general_${s1Label.replace(/\s+/g,'_')}_vs_${s2Label.replace(/\s+/g,'_')}.xlsx`;
                      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
                      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                      saveAs(blob, filename);
                    } catch (e) {
                      console.error('xlsx export failed', e);
                    }
                  }}
                >Export XLSX (All)</button>
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
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                  onClick={() => { setImportOpen(true); }}
                >Import Statistic</button>
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                  onClick={() => { setManualOpen(true); }}
                >Add manual entry</button>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50" onClick={() => { setNullByInputText(''); setNullByInputResult(null); setNullByInputOpen(true); }}>Null Customers by Input</button>
              </div>
            </div>
          </details>
        </div>
      </div>


      <div className="space-y-4">
        <div className="flex items-center justify-end gap-2">
          <label className="text-xs text-gray-600">Season 1</label>
          <select className="rounded border px-2 py-1 text-sm" value={s1} onChange={(e) => setS1(e.target.value)}>
            <option value="">Select…</option>
            {(seasons ?? []).map((s:any) => (
              <option key={s.id} value={s.id}>{s.name}{s.year ? ' ' + s.year : ''}</option>
            ))}
          </select>
          <label className="text-xs text-gray-600">Season 2</label>
          <select className="rounded border px-2 py-1 text-sm" value={s2} onChange={(e) => setS2(e.target.value)}>
            <option value="">Select…</option>
            {(seasons ?? []).map((s:any) => (
              <option key={s.id} value={s.id}>{s.name}{s.year ? ' ' + s.year : ''}</option>
            ))}
          </select>
        </div>
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
          const items = activePerson && selectedSalespersonId
            ? visibleRows.filter(r => r.salespersonId === selectedSalespersonId)
            : visibleRows;
          console.log('[stats] table items', items.length);
          const tableCurrency = activePerson && selectedSalespersonId ? (spCurrencyById[selectedSalespersonId] ?? 'DKK') : 'DKK';
          // Grouped view: sort by group then customer, insert subtotal rows per group
          const sorted = [...items].sort((a, b) => {
            const ga = (a.groupName || '').toLowerCase(); const gb = (b.groupName || '').toLowerCase();
            if (ga !== gb) return ga < gb ? -1 : 1;
            return a.customer.localeCompare(b.customer);
          });
          const withSubtotals: RowOut[] = [];
          let curGroup: string | null = null;
          let acc = { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 };
          function flushSubtotal() {
            if (!curGroup) return;
            withSubtotals.push({
              account_no: `__group_total:${curGroup}`,
              customer: `Group total — ${curGroup}`,
              city: '',
              groupName: curGroup,
              s1Qty: acc.s1Qty,
              s1Price: acc.s1Price,
              s2Qty: acc.s2Qty,
              s2Price: acc.s2Price,
              salespersonId: null,
              salespersonName: '',
              isGroupTotal: true
            });
          }
          for (const r of sorted) {
            const g = (r.groupName || '').trim();
            if (g && curGroup && g !== curGroup) { flushSubtotal(); acc = { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 }; }
            if (g && !curGroup) { acc = { s1Qty: 0, s1Price: 0, s2Qty: 0, s2Price: 0 }; }
            if (g) curGroup = g;
            withSubtotals.push(r);
            if (g) {
              acc.s1Qty += r.s1Qty; acc.s1Price += r.s1Price; acc.s2Qty += r.s2Qty; acc.s2Price += r.s2Price;
            }
          }
          if (curGroup) flushSubtotal();
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
                    {withSubtotals.map((row) => {
                      const devQty = row.s1Qty - row.s2Qty;
                      const devPrice = row.s1Price - row.s2Price;
                      const nulled = isNulled(row.account_no);
                      const currency = row.salespersonId ? (spCurrencyById[row.salespersonId] ?? 'DKK') : 'DKK';
                      const s1QtyClass = row.s1Qty === 0 ? '' : (row.s1Qty > row.s2Qty ? 'text-green-600' : row.s1Qty < row.s2Qty ? 'text-red-600' : '');
                      const s1PriceClass = row.s1Price === 0 ? '' : (row.s1Price > row.s2Price ? 'text-green-600' : row.s1Price < row.s2Price ? 'text-red-600' : '');
                      return (
                        <tr key={row.account_no} className={(row.isGroupTotal ? 'bg-slate-100 font-semibold ' : '') + "border-t hover:bg-slate-50 group " + (nulled ? 'opacity-80' : '')}>
                          <td className={"relative p-2 font-medium " + (nulled ? '' : '')}>
                            <div className="flex items-center gap-1.5">
                              {row.customer}
                              {!row.isGroupTotal && (() => {
                                const customerExists = (allCustomers ?? []).some(c => c.customer_id === row.account_no);
                                return (
                                  <>
                                    {!customerExists && row.account_no && (
                                      <button
                                        onClick={() => fixMissingCustomer(row.account_no, row.customer, row.city, row.salespersonId)}
                                        className="px-2 py-0.5 text-xs bg-orange-500 text-white rounded hover:bg-orange-600"
                                        title="This customer doesn't exist in the customers table. Click to create."
                                      >
                                        Fix
                                      </button>
                                    )}
                                    <button
                                      onClick={() => openCommentModal(row.account_no)}
                                      className={commentsMap?.[row.account_no] ? "text-blue-600 hover:text-blue-800" : "text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100"}
                                      title={commentsMap?.[row.account_no]?.comment || 'Add comment'}
                                    >
                                      <MessageCircle className="h-4 w-4" />
                                    </button>
                                  </>
                                );
                              })()}
                            </div>
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className={"relative p-2 " + (nulled ? '' : '')}>
                            {row.city}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className={"relative p-2 text-center " + s1QtyClass}>
                            {row.s1Qty}
                            {nulled && <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-500/70" />}
                          </td>
                          <td className={"relative p-2 text-center " + s1PriceClass}>
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
                            <span className={(devQty > 0 ? 'text-green-600' : devQty < 0 ? 'text-red-600' : '') + (nulled ? ' line-through' : '')}>
                              {devQty > 0 ? '+' : ''}{devQty}
                            </span>
                          </td>
                          <td className="p-2 text-center">
                            <span className={(devPrice > 0 ? 'text-green-600' : devPrice < 0 ? 'text-red-600' : '') + (nulled ? ' line-through' : '')}>
                              {devPrice > 0 ? '+' : ''}{devPrice.toLocaleString()} {currency}
                            </span>
                          </td>
                          <td className="p-2">
                            <div className="relative flex items-center justify-center gap-1.5">
                              {!row.isGroupTotal && (
                                <button
                                  className="rounded border px-2 py-0.5 text-xs"
                                  onClick={() => openDetails(row)}
                                >Details</button>
                              )}
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
                  <tfoot>
                    {(() => {
                      const baseRates = { DKK: 1, ...(currencyRatesRow ?? {}) } as Record<string, number>;
                      const nulledSeasonal = new Set(overrides?.value.nulled ?? []);
                      const totals = items.reduce((a, r) => {
                        const cur = r.salespersonId ? (spCurrencyById[r.salespersonId] ?? 'DKK') : 'DKK';
                        const rateS1 = { ...baseRates, ...(ratesS1 ?? {}) }[cur] ?? 1;
                        const rateS2 = { ...baseRates, ...(ratesS2 ?? {}) }[cur] ?? 1;
                        const isNullS1 = nulledSeasonal.has(r.account_no) || Boolean(closedCustomers?.setClosed.has(r.account_no)) || Boolean(closedCustomers?.setNulled.has(r.account_no));
                        a.s1Qty += isNullS1 ? 0 : r.s1Qty; a.s2Qty += r.s2Qty;
                        a.s1Local += isNullS1 ? 0 : r.s1Price; a.s2Local += r.s2Price;
                        a.s1Dkk += (isNullS1 ? 0 : r.s1Price) * rateS1; a.s2Dkk += r.s2Price * rateS2;
                        return a;
                      }, { s1Qty: 0, s2Qty: 0, s1Local: 0, s2Local: 0, s1Dkk: 0, s2Dkk: 0 });
                      const devQty = totals.s1Qty - totals.s2Qty;
                      const devLocal = totals.s1Local - totals.s2Local;
                      const devDkk = totals.s1Dkk - totals.s2Dkk;
                      const rowCurrency = tableCurrency;
                      return (
                        <>
                          {activePerson && (
                            <tr className="bg-gray-50 font-semibold">
                              <td className="p-2" colSpan={2}>TOTAL (Local)</td>
                              <td className="p-2 text-center">{totals.s1Qty.toLocaleString('da-DK')}</td>
                              <td className="p-2 text-center">{Math.round(totals.s1Local).toLocaleString('da-DK')} {rowCurrency}</td>
                              <td className="p-2 text-center">{totals.s2Qty.toLocaleString('da-DK')}</td>
                              <td className="p-2 text-center">{Math.round(totals.s2Local).toLocaleString('da-DK')} {rowCurrency}</td>
                              <td className="p-2 text-center">{(devQty>0?'+':'')+devQty.toLocaleString('da-DK')}</td>
                              <td className="p-2 text-center">{(devLocal>0?'+':'')+Math.round(devLocal).toLocaleString('da-DK')} {rowCurrency}</td>
                              <td className="p-2"></td>
                            </tr>
                          )}
                          <tr className="bg-gray-50 font-semibold">
                            <td className="p-2" colSpan={2}>TOTAL (DKK)</td>
                            <td className="p-2 text-center">{totals.s1Qty.toLocaleString('da-DK')}</td>
                            <td className="p-2 text-center">{Math.round(totals.s1Dkk).toLocaleString('da-DK')} DKK</td>
                            <td className="p-2 text-center">{totals.s2Qty.toLocaleString('da-DK')}</td>
                            <td className="p-2 text-center">{Math.round(totals.s2Dkk).toLocaleString('da-DK')} DKK</td>
                            <td className="p-2 text-center">{(devQty>0?'+':'')+devQty.toLocaleString('da-DK')}</td>
                            <td className="p-2 text-center">{(devDkk>0?'+':'')+Math.round(devDkk).toLocaleString('da-DK')} DKK</td>
                            <td className="p-2"></td>
                          </tr>
                        </>
                      );
                    })()}
                  </tfoot>
                </table>
              </div>
              {/* Removed sticky overlay totals; separate TOTALS section below */}
              {/* KPI cards when a salesperson is selected */}
              {activePerson && (
                <div className="border-t p-4 space-y-4">
                  {(() => {
                    const nulledSeasonal = new Set(overrides?.value.nulled ?? []);
                    
                    // Total customers (already filtered by visibility)
                    const totalCustomers = items.length;
                    
                    // Customers visited: has any S1 activity
                    const visitedRows = items.filter(r => r.s1Qty > 0 || r.s1Price > 0);
                    const customersVisited = visitedRows.length;
                    
                    // Customers to visit: no S1 activity AND not nulled/closed
                    const customersToVisit = items.filter(r => {
                      const hasS1Activity = r.s1Qty > 0 || r.s1Price > 0;
                      const isExcluded = isNulled(r.account_no);
                      return !hasS1Activity && !isExcluded;
                    }).length;
                    
                    // Nulled and permanently closed counts
                    const nulledCount = items.reduce((a, r) => a + (nulledSeasonal.has(r.account_no) ? 1 : 0), 0);
                    const permClosedCount = items.reduce((a, r) => a + (closedCustomers?.setClosed.has(r.account_no) ? 1 : 0), 0);
                    
                    // Aggregate visited customers S1/S2 totals for index calculation
                    const visitedS1Qty = visitedRows.reduce((a, r) => a + r.s1Qty, 0);
                    const visitedS2Qty = visitedRows.reduce((a, r) => a + r.s2Qty, 0);
                    const visitedS1Price = visitedRows.reduce((a, r) => a + r.s1Price, 0);
                    const visitedS2Price = visitedRows.reduce((a, r) => a + r.s2Price, 0);
                    
                    // Index ratios (visited S1 vs S2, with safe zero-div handling)
                    const qtyIndexRatio = visitedS2Qty === 0 ? 1 : visitedS1Qty / visitedS2Qty;
                    const priceIndexRatio = visitedS2Price === 0 ? 1 : visitedS1Price / visitedS2Price;
                    const indexQty = visitedS2Qty === 0 ? 100 : (qtyIndexRatio * 100);
                    const indexPrice = visitedS2Price === 0 ? 100 : (priceIndexRatio * 100);
                    
                    // Prognosis: apply current index to unvisited customers' S2 totals, add visited S1 totals
                    const unvisitedRows = items.filter(r => {
                      const hasS1Activity = r.s1Qty > 0 || r.s1Price > 0;
                      const isExcluded = isNulled(r.account_no);
                      return !hasS1Activity && !isExcluded;
                    });
                    const unvisitedS2Qty = unvisitedRows.reduce((a, r) => a + r.s2Qty, 0);
                    const unvisitedS2Price = unvisitedRows.reduce((a, r) => a + r.s2Price, 0);
                    
                    const prognosedQty = visitedS1Qty + (unvisitedS2Qty * qtyIndexRatio);
                    const prognosedPrice = visitedS1Price + (unvisitedS2Price * priceIndexRatio);
                    
                    return (
                      <>
                        {/* GENERAL Section */}
                        <div className="rounded-lg border bg-white p-4">
                          <h3 className="text-sm font-semibold text-gray-700 mb-3">GENERAL</h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Total customers</div>
                              <div className="text-xl font-semibold">{totalCustomers}</div>
                            </div>
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Customers visited</div>
                              <div className="text-xl font-semibold">{customersVisited}</div>
                              <div className="text-[11px] text-gray-400">with Season 1 entry</div>
                            </div>
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Customers to visit</div>
                              <div className="text-xl font-semibold">{customersToVisit}</div>
                              <div className="text-[11px] text-gray-400">not nulled/closed</div>
                            </div>
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Nulled · Perm Closed</div>
                              <div className="text-xl font-semibold">{nulledCount} · {permClosedCount}</div>
                            </div>
                          </div>
                        </div>
                        
                        {/* CALCULATIONS Section */}
                        <div className="rounded-lg border bg-white p-4">
                          <h3 className="text-sm font-semibold text-gray-700 mb-3">CALCULATIONS</h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Index QTY</div>
                              <div className="text-xl font-semibold">{indexQty.toFixed(1)}</div>
                              <div className="text-[11px] text-gray-400">{visitedS1Qty} vs {visitedS2Qty} (visited)</div>
                            </div>
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Index PRICE</div>
                              <div className="text-xl font-semibold">{indexPrice.toFixed(1)}</div>
                              <div className="text-[11px] text-gray-400">{Math.round(visitedS1Price).toLocaleString('da-DK')} vs {Math.round(visitedS2Price).toLocaleString('da-DK')} (visited)</div>
                            </div>
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Prognose QTY</div>
                              <div className="text-xl font-semibold">{Math.round(prognosedQty).toLocaleString('da-DK')}</div>
                              <div className="text-[11px] text-gray-400">if index holds</div>
                            </div>
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Prognose PRICE</div>
                              <div className="text-xl font-semibold">{Math.round(prognosedPrice).toLocaleString('da-DK')}</div>
                              <div className="text-[11px] text-gray-400">if index holds</div>
                            </div>
                          </div>
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
              onClose={() => {
                setDetailsOpen(false);
                setDetailsS1NewRows([]);
                setDetailsS2NewRows([]);
              }}
              title={detailsRow ? `${detailsRow.customer} · ${detailsRow.city}` : 'Details'}
              maxWidth="max-w-5xl"
              footer={
                <button className="rounded border px-3 py-1.5 text-sm" onClick={() => {
                  setDetailsOpen(false);
                  setDetailsS1NewRows([]);
                  setDetailsS2NewRows([]);
                }}>Close</button>
              }
            >
              {detailsLoading ? (
                <div className="text-sm text-gray-600">Loading…</div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="font-medium">{getSeasonLabel(s1) || 'Season 1'}</div>
                      <button
                        className="rounded border px-2 py-1 text-xs hover:bg-gray-50"
                        onClick={() => addNewRowToSeason('s1')}
                        disabled={!s1}
                      >Add</button>
                    </div>
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
                          <th className="text-left p-2 border-b">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...detailsS1, ...detailsS1NewRows].map((r, idx) => {
                          const isNew = (r as any).isNew;
                          return (
                          <tr key={r.id || idx} className={isNew ? 'bg-blue-50' : ''}>
                            <td className="p-2 border-b">{r.account_no}</td>
                            <td className="p-2 border-b">{r.customer_name}</td>
                            <td className="p-2 border-b">{r.city}</td>
                            <td className="p-2 border-b text-right">
                              <input
                                className="w-20 border rounded px-1 text-right"
                                defaultValue={Number(r.qty ?? 0)}
                                onChange={(e) => {
                                  if (isNew) {
                                    const v = Number(e.target.value || 0) || 0;
                                    setDetailsS1NewRows(prevRows => 
                                      prevRows.map(row => 
                                        row.id === r.id ? { ...row, qty: v } : row
                                      )
                                    );
                                  }
                                }}
                                onBlur={async (e) => {
                                  try {
                                    const v = Number(e.target.value || 0) || 0;
                                    if (!isNew) {
                                      if ((r as any).invoice_no) {
                                        await supabase.from('sales_invoices').update({ qty: v, manual_edited: true }).eq('id', (r as any).id);
                                      } else {
                                        await supabase.from('sales_stats').update({ qty: v }).eq('id', (r as any).id);
                                      }
                                    }
                                  } catch {}
                                }}
                              />
                            </td>
                            <td className="p-2 border-b text-right">
                              <input
                                className="w-28 border rounded px-1 text-right"
                                defaultValue={Number(r.price ?? 0)}
                                onChange={(e) => {
                                  if (isNew) {
                                    const v = Number(e.target.value || 0) || 0;
                                    setDetailsS1NewRows(prevRows => 
                                      prevRows.map(row => 
                                        row.id === r.id ? { ...row, price: v } : row
                                      )
                                    );
                                  }
                                }}
                                onBlur={async (e) => {
                                  try {
                                    const v = Number(e.target.value || 0) || 0;
                                    if (!isNew) {
                                      if ((r as any).invoice_no) {
                                        await supabase.from('sales_invoices').update({ amount: v, manual_edited: true }).eq('id', (r as any).id);
                                      } else {
                                        await supabase.from('sales_stats').update({ price: v }).eq('id', (r as any).id);
                                      }
                                    }
                                  } catch {}
                                }}
                              />
                            </td>
                            <td className="p-2 border-b">{(r as any).invoice_no ?? '—'}</td>
                            <td className="p-2 border-b text-right">{r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}</td>
                            <td className="p-2 border-b">
                              {isNew ? (
                                <div className="flex items-center gap-2">
                                  <button
                                    className="text-xs rounded border px-2 py-0.5 hover:bg-gray-50"
                                    onClick={async () => {
                                      const currentRow = detailsS1NewRows.find(row => row.id === r.id);
                                      if (currentRow) {
                                        await saveNewRow(currentRow, 's1');
                                      }
                                    }}
                                  >Save</button>
                                  <button
                                    className="text-xs text-red-600 hover:text-red-800"
                                    onClick={() => removeNewRow(r.id, 's1')}
                                  >Remove</button>
                                </div>
                              ) : (
                                <label className="inline-flex items-center gap-1 text-xs">
                                  <input
                                    type="checkbox"
                                    defaultChecked={(r as any).invoice_no ? Boolean((r as any).manual_edited) : Boolean((r as any).frozen)}
                                    onChange={async (e) => {
                                      try {
                                        if ((r as any).invoice_no) {
                                          await supabase.from('sales_invoices').update({ manual_edited: e.target.checked }).eq('id', (r as any).id);
                                        } else {
                                          await supabase.from('sales_stats').update({ frozen: e.target.checked }).eq('id', (r as any).id);
                                        }
                                      } catch {}
                                    }}
                                  /> Freeze
                                </label>
                              )}
                            </td>
                          </tr>
                        )})}
                      </tbody>
                      <tfoot>
                        {(() => {
                          const allRows = [...detailsS1, ...detailsS1NewRows];
                          const s = allRows.reduce((a, r) => ({ qty: a.qty + Number(r.qty ?? 0), price: a.price + Number(r.price ?? 0) }), { qty: 0, price: 0 });
                          return (
                            <tr className="bg-gray-50 font-semibold">
                              <td className="p-2" colSpan={3}>TOTAL</td>
                              <td className="p-2 text-right">{s.qty}</td>
                              <td className="p-2 text-right">{s.price.toLocaleString('da-DK')}</td>
                              <td className="p-2" colSpan={2}></td>
                            </tr>
                          );
                        })()}
                      </tfoot>
                    </table>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="font-medium">{getSeasonLabel(s2) || 'Season 2'}</div>
                      <button
                        className="rounded border px-2 py-1 text-xs hover:bg-gray-50"
                        onClick={() => addNewRowToSeason('s2')}
                        disabled={!s2}
                      >Add</button>
                    </div>
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
                          <th className="text-left p-2 border-b">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...detailsS2, ...detailsS2NewRows].map((r, idx) => {
                          const isNew = (r as any).isNew;
                          return (
                          <tr key={r.id || idx} className={isNew ? 'bg-blue-50' : ''}>
                            <td className="p-2 border-b">{r.account_no}</td>
                            <td className="p-2 border-b">{r.customer_name}</td>
                            <td className="p-2 border-b">{r.city}</td>
                            <td className="p-2 border-b text-right">
                              <input
                                className="w-20 border rounded px-1 text-right"
                                defaultValue={Number(r.qty ?? 0)}
                                onChange={(e) => {
                                  if (isNew) {
                                    const v = Number(e.target.value || 0) || 0;
                                    setDetailsS2NewRows(prevRows => 
                                      prevRows.map(row => 
                                        row.id === r.id ? { ...row, qty: v } : row
                                      )
                                    );
                                  }
                                }}
                                onBlur={async (e) => {
                                  try {
                                    const v = Number(e.target.value || 0) || 0;
                                    if (!isNew) {
                                      if ((r as any).invoice_no) {
                                        await supabase.from('sales_invoices').update({ qty: v, manual_edited: true }).eq('id', (r as any).id);
                                      } else {
                                        await supabase.from('sales_stats').update({ qty: v }).eq('id', (r as any).id);
                                      }
                                    }
                                  } catch {}
                                }}
                              />
                            </td>
                            <td className="p-2 border-b text-right">
                              <input
                                className="w-28 border rounded px-1 text-right"
                                defaultValue={Number(r.price ?? 0)}
                                onChange={(e) => {
                                  if (isNew) {
                                    const v = Number(e.target.value || 0) || 0;
                                    setDetailsS2NewRows(prevRows => 
                                      prevRows.map(row => 
                                        row.id === r.id ? { ...row, price: v } : row
                                      )
                                    );
                                  }
                                }}
                                onBlur={async (e) => {
                                  try {
                                    const v = Number(e.target.value || 0) || 0;
                                    if (!isNew) {
                                      if ((r as any).invoice_no) {
                                        await supabase.from('sales_invoices').update({ amount: v, manual_edited: true }).eq('id', (r as any).id);
                                      } else {
                                        await supabase.from('sales_stats').update({ price: v }).eq('id', (r as any).id);
                                      }
                                    }
                                  } catch {}
                                }}
                              />
                            </td>
                            <td className="p-2 border-b">{(r as any).invoice_no ?? '—'}</td>
                            <td className="p-2 border-b text-right">{r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}</td>
                            <td className="p-2 border-b">
                              {isNew ? (
                                <div className="flex items-center gap-2">
                                  <button
                                    className="text-xs rounded border px-2 py-0.5 hover:bg-gray-50"
                                    onClick={async () => {
                                      const currentRow = detailsS2NewRows.find(row => row.id === r.id);
                                      if (currentRow) {
                                        await saveNewRow(currentRow, 's2');
                                      }
                                    }}
                                  >Save</button>
                                  <button
                                    className="text-xs text-red-600 hover:text-red-800"
                                    onClick={() => removeNewRow(r.id, 's2')}
                                  >Remove</button>
                                </div>
                              ) : (
                                <label className="inline-flex items-center gap-1 text-xs">
                                  <input
                                    type="checkbox"
                                    defaultChecked={(r as any).invoice_no ? Boolean((r as any).manual_edited) : Boolean((r as any).frozen)}
                                    onChange={async (e) => {
                                      try {
                                        if ((r as any).invoice_no) {
                                          await supabase.from('sales_invoices').update({ manual_edited: e.target.checked }).eq('id', (r as any).id);
                                        } else {
                                          await supabase.from('sales_stats').update({ frozen: e.target.checked }).eq('id', (r as any).id);
                                        }
                                      } catch {}
                                    }}
                                  /> Freeze
                                </label>
                              )}
                            </td>
                          </tr>
                        )})}
                      </tbody>
                      <tfoot>
                        {(() => {
                          const allRows = [...detailsS2, ...detailsS2NewRows];
                          const s = allRows.reduce((a, r) => ({ qty: a.qty + Number(r.qty ?? 0), price: a.price + Number(r.price ?? 0) }), { qty: 0, price: 0 });
                          return (
                            <tr className="bg-gray-50 font-semibold">
                              <td className="p-2" colSpan={3}>TOTAL</td>
                              <td className="p-2 text-right">{s.qty}</td>
                              <td className="p-2 text-right">{s.price.toLocaleString('da-DK')}</td>
                              <td className="p-2" colSpan={2}></td>
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
            {/* Import Statistic modal */}
            <Modal
              open={importOpen}
              onClose={() => setImportOpen(false)}
              title="Import Statistic"
              footer={(
                <div className="flex items-center gap-2">
                  <button className="rounded border px-3 py-1.5 text-sm" onClick={() => setImportOpen(false)}>Close</button>
                  <button
                    className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
                    disabled={importBusy || !importSeasonId || !mapQty || !mapPrice || (importLookup==='account' ? !mapAccount : (!mapCustomer || !mapCity))}
                    onClick={async () => {
                      try {
                        if (!importSeasonId) { alert('Select target season'); return; }
                        setImportBusy(true);
                        const { data: { session } } = await supabase.auth.getSession();
                        if (!session) throw new Error('Not signed in');
                        // Normalize rows according to mapping
                        const rows = importRows.map((r, idx) => {
                          const account_no = mapAccount ? String(r[mapAccount] ?? '').trim() : '';
                          const customer_name = mapCustomer ? String(r[mapCustomer] ?? '').trim() : '';
                          const city = mapCity ? String(r[mapCity] ?? '').trim() : '';
                          const qty = Number(r[mapQty] ?? 0) || 0;
                          const price = Number(r[mapPrice] ?? 0) || 0;
                          const rawNull = mapNulled ? String(r[mapNulled] ?? '').trim().toLowerCase() : '';
                          const isPerm = rawNull === 'perm' || rawNull === 'permanent' || rawNull === 'permanently';
                          const isYes = rawNull === 'yes';
                          const isNo = rawNull === 'no';
                          const nulled = !!(isPerm || isYes); // ignore any other values
                          if (idx < 10) { try { console.log('[import:map]', { idx, account_no, customer_name, city, qty, price, rawNull, nulled, perm: isPerm }); } catch {} }
                          return { account_no, customer_name, city, qty, price, nulled, perm: isPerm };
                        }).filter((x) => (x.qty || x.price));
                        try {
                          console.log('[import:summaryBeforeSend]', {
                            total: importRows.length,
                            mapped: rows.length,
                            seasonId: importSeasonId,
                            lookup: importLookup,
                            sample: rows.slice(0, 5)
                          });
                        } catch {}
                        const res = await fetch('/api/statistics/import', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                          body: JSON.stringify({ seasonId: importSeasonId, lookup: importLookup, rows })
                        });
                        if (!res.ok) throw new Error(await res.text());
                        const js = await res.json();
                        try { console.log('[import:result]', js); } catch {}
                        setImportResult(js);
                        // Revalidate views so UI reflects seasonal nulls and permanent closures
                        try {
                          if (importSeasonId && (importSeasonId === s1 || importSeasonId === s2)) {
                            await mutateGeneralRows();
                          }
                          if (importSeasonId && importSeasonId === s1) {
                            await mutateOverrides();
                          }
                          await mutateClosedCustomers();
                        } catch {}
                      } catch (e: any) {
                        alert(e?.message || 'Import failed');
                      } finally {
                        setImportBusy(false);
                      }
                    }}
                  >
                    {importBusy ? 'Importing…' : 'Import'}
                  </button>
                </div>
              )}
            >
              <div className="space-y-3">
                {importResult && (
                  <div className="rounded border p-3 text-sm">
                    <div className="font-medium mb-1">Import overview</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                      <div>Total rows: {importResult.totalRows ?? '—'}</div>
                      <div>Resolved accounts: {importResult.resolvedAccounts ?? 0} ({importResult.resolvedByNameCity ?? 0} by Name+City)</div>
                      <div>Unresolved (no match): {importResult.unresolved ?? 0}</div>
                      <div>Skipped zero qty/price: {importResult.skippedZeroValues ?? 0}</div>
                      <div>Aggregated accounts: {importResult.aggregatedAccounts ?? 0}</div>
                      <div>Upserted: {importResult.upserted ?? 0}</div>
                      <div>Seasonal nulled applied: {importResult.seasonalNulled ?? 0}</div>
                      <div>Permanently closed: {importResult.permClosed ?? 0}</div>
                      <div>Un-nulled (with sales): {importResult.unnulled ?? 0}</div>
                    </div>
                    {(importResult.unmatchedSamples?.length ?? 0) > 0 && (
                      <div className="mt-2">
                        <div className="text-xs text-gray-600 mb-1">Unmatched samples (first {Math.min(25, importResult.unmatchedSamples.length)}):</div>
                        <ul className="list-disc pl-5 text-xs">
                          {importResult.unmatchedSamples.slice(0, 25).map((r:any, i:number) => (
                            <li key={i}>{(r.customer_name || '—')} · {(r.city || '—')}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="mt-3">
                      <button className="rounded border px-3 py-1.5 text-sm" onClick={() => { setImportResult(null); setImportOpen(false); }}>Close</button>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-700">Target season</label>
                  <select className="rounded border px-2 py-1 text-sm" value={importSeasonId} onChange={(e)=>setImportSeasonId(e.target.value)}>
                    <option value="">Select…</option>
                    {(seasons ?? []).map((s:any) => (
                      <option key={s.id} value={s.id}>{s.name}{s.year ? ' ' + s.year : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-700">Account lookup</label>
                  <select className="rounded border px-2 py-1 text-sm" value={importLookup} onChange={(e)=>setImportLookup(e.target.value as any)}>
                    <option value="account">Account No</option>
                    <option value="name_city">Customer + City</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Upload CSV/XLSX</label>
                  <input
                    type="file"
                    accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      // Use XLSX to parse both CSV and XLSX
                      const XLSX = await import('xlsx');
                      const buf = await file.arrayBuffer();
                      const wb = XLSX.read(buf, { type: 'array' });
                      const sheetNames: string[] = Array.isArray(wb.SheetNames) ? (wb.SheetNames as string[]) : [];
                      const first = sheetNames.length > 0 ? sheetNames[0] : null;
                      if (!first) { setImportRows([]); setImportHeaders([]); return; }
                      const ws = (wb.Sheets as any)[first as string];
                      const rows = XLSX.utils.sheet_to_json(ws as any) as any[];
                      setImportRows(rows);
                      const headers = Object.keys(rows[0] || {});
                      setImportHeaders(headers);
                    }}
                  />
                </div>
                {importHeaders.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Column mapping</div>
                      <label className="text-sm">Account No</label>
                      <select className="rounded border px-2 py-1 text-sm w-full" value={mapAccount} onChange={(e)=>setMapAccount(e.target.value)}>
                        <option value="">—</option>
                        {importHeaders.map((h) => (<option key={h} value={h}>{h}</option>))}
                      </select>
                      <label className="text-sm">Customer</label>
                      <select className="rounded border px-2 py-1 text-sm w-full" value={mapCustomer} onChange={(e)=>setMapCustomer(e.target.value)}>
                        <option value="">—</option>
                        {importHeaders.map((h) => (<option key={h} value={h}>{h}</option>))}
                      </select>
                      <label className="text-sm">City</label>
                      <select className="rounded border px-2 py-1 text-sm w-full" value={mapCity} onChange={(e)=>setMapCity(e.target.value)}>
                        <option value="">—</option>
                        {importHeaders.map((h) => (<option key={h} value={h}>{h}</option>))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-medium">Values</div>
                      <label className="text-sm">Qty</label>
                      <select className="rounded border px-2 py-1 text-sm w-full" value={mapQty} onChange={(e)=>setMapQty(e.target.value)}>
                        <option value="">—</option>
                        {importHeaders.map((h) => (<option key={h} value={h}>{h}</option>))}
                      </select>
                      <label className="text-sm">Price</label>
                      <select className="rounded border px-2 py-1 text-sm w-full" value={mapPrice} onChange={(e)=>setMapPrice(e.target.value)}>
                        <option value="">—</option>
                        {importHeaders.map((h) => (<option key={h} value={h}>{h}</option>))}
                      </select>
                      <label className="text-sm">Nulled (Yes/Perm/blank)</label>
                      <select className="rounded border px-2 py-1 text-sm w-full" value={mapNulled} onChange={(e)=>setMapNulled(e.target.value)}>
                        <option value="">—</option>
                        {importHeaders.map((h) => (<option key={h} value={h}>{h}</option>))}
                      </select>
                    </div>
                  </div>
                )}
                {importRows.length > 0 && (
                  <div className="text-xs text-gray-600">Loaded {importRows.length} rows.</div>
                )}
              </div>
            </Modal>
            {/* Add manual entry modal */}
            <Modal
              open={manualOpen}
              onClose={() => setManualOpen(false)}
              title="Add manual entry"
              footer={(
                <div className="flex items-center gap-2">
                  <button className="rounded border px-3 py-1.5 text-sm" onClick={() => setManualOpen(false)}>Close</button>
                  <button
                    className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
                    disabled={!manualSeasonId || !manualCustomerId || (!Number(manualQty) && !Number(manualPrice))}
                    onClick={async () => {
                      try {
                        if (!manualSeasonId || !manualCustomerId) { alert('Select season and customer'); return; }
                        const qty = Number(manualQty) || 0;
                        const price = Number(manualPrice) || 0;
                        if (!qty && !price) { alert('Enter Qty or Price'); return; }
                        const cust = (customersAll ?? []).find(c => c.customer_id === manualCustomerId);
                        const customer_name = cust?.company || '';
                        const invoice_no = `2BIZ-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Date.now().toString().slice(-6)}`;
                        const ins = await supabase.from('sales_invoices').insert({
                          invoice_no,
                          account_no: manualCustomerId,
                          customer_name,
                          qty,
                          amount: price,
                          season_id: manualSeasonId,
                          manual_edited: true
                        } as any);
                        if (ins.error) throw new Error(ins.error.message);
                        setManualOpen(false);
                        setManualSeasonId(''); setManualCustomerId(''); setManualQty(''); setManualPrice('');
                        try { await mutateGeneralRows(); } catch {}
                      } catch (e: any) {
                        alert(e?.message || 'Failed to add entry');
                      }
                    }}
                  >Add</button>
                </div>
              )}
            >
              <div className="space-y-3">
                <label className="block text-sm">
                  <div className="text-gray-600 mb-1">Season</div>
                  <select className="w-full rounded border px-2 py-1 text-sm" value={manualSeasonId} onChange={(e)=>setManualSeasonId(e.target.value)}>
                    <option value="">Select…</option>
                    {(seasons ?? []).map((s:any) => (
                      <option key={s.id} value={s.id}>{s.name}{s.year ? ' ' + s.year : ''}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <div className="text-gray-600 mb-1">Customer</div>
                  <select className="w-full rounded border px-2 py-1 text-sm" value={manualCustomerId} onChange={(e)=>setManualCustomerId(e.target.value)}>
                    <option value="">Select…</option>
                    {(customersAll ?? []).map((c:any) => (
                      <option key={c.customer_id} value={c.customer_id}>{c.company || c.customer_id}</option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-sm">
                    <div className="text-gray-600 mb-1">Qty</div>
                    <input type="number" className="w-full rounded border px-2 py-1 text-sm" value={manualQty} onChange={(e)=>setManualQty(e.target.value)} />
                  </label>
                  <label className="block text-sm">
                    <div className="text-gray-600 mb-1">Price</div>
                    <input type="number" className="w-full rounded border px-2 py-1 text-sm" value={manualPrice} onChange={(e)=>setManualPrice(e.target.value)} />
                  </label>
                </div>
                <div className="text-xs text-gray-500">Invoice number will be generated with 2BIZ- prefix.</div>
              </div>
            </Modal>
            {/* Comment modal */}
            <Modal
              open={commentModalOpen}
              onClose={() => {
                setCommentModalOpen(false);
                setCommentText('');
                setCommentIsPermanent(false);
              }}
              title="Customer Comment"
              footer={(
                <div className="flex items-center gap-2">
                  <button className="rounded border px-3 py-1.5 text-sm" onClick={() => {
                    setCommentModalOpen(false);
                    setCommentText('');
                    setCommentIsPermanent(false);
                  }}>Cancel</button>
                  <button
                    className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
                    disabled={commentLoading}
                    onClick={saveComment}
                  >
                    {commentLoading ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            >
              <div className="space-y-3">
                <label className="block text-sm">
                  <div className="text-gray-600 mb-1">Comment</div>
                  <textarea
                    className="w-full rounded border px-2 py-1 text-sm min-h-[100px]"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Enter comment for this customer..."
                    disabled={commentLoading}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={commentIsPermanent}
                    onChange={(e) => setCommentIsPermanent(e.target.checked)}
                    disabled={commentLoading}
                  />
                  <span className="text-gray-700">Permanent (applies to all seasons)</span>
                </label>
                <div className="text-xs text-gray-500">
                  {commentIsPermanent 
                    ? 'This comment will be visible for all seasons.' 
                    : `This comment will only be visible for ${getSeasonLabel(s1) || 'Season 1'}.`}
                </div>
              </div>
            </Modal>
            </>
          );
        })()}
      </div>
    </div>
  );
}



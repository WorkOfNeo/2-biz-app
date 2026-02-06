'use client';
// General Statistics Page - Season comparison and analysis
import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import { Menu, EyeOff, Trash2, Ban, MessageCircle, RefreshCw, Layers } from 'lucide-react';
import { SearchSelect } from '../../../components/SearchSelect';
import { ProgressBar } from '../../../components/ProgressBar';
import { Modal } from '../../../components/Modal';
import { useStatisticsData } from '../_shared/StatisticsDataContext';

export default function StatisticsGeneralPage() {
  const {
    ready,
    seasons,
    mutateSeasons,
    s1,
    s2,
    setS1,
    setS2,
    salespersons,
    customers: allCustomers,
    customerIndex,
    closedCustomers,
    overrides,
    currencyRatesRow,
    ratesS1,
    ratesS2,
    stats,
    invoices,
    refreshAll,
  } = useStatisticsData();

  // Fetch latest general salesmen PDF export
  const { data: latestExport } = useSWR('exports:latest-general-salesmen', async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, kind, title, path, public_url, meta, created_at')
      .eq('kind', 'general_salesmen_pdfs')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; kind: string; title: string | null; path: string; public_url: string | null; meta: any; created_at: string } | null;
  }, { refreshInterval: 10000 });
  const [activePerson, setActivePerson] = useState<string>('');
  const [calcTab, setCalcTab] = useState<'visited' | 'visited_incl'>('visited_incl');
  const [indexBasisModal, setIndexBasisModal] = useState<{ mode: 'visited' | 'visited_incl'; rows: any[] } | null>(null);
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
  // PDF Export state
  const [pdfExporting, setPdfExporting] = useState(false);
  const [pdfExportJobId, setPdfExportJobId] = useState<string | null>(null);
  const [pdfExportProgress, setPdfExportProgress] = useState<{ index: number; total: number } | null>(null);
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
  const customersAll = useMemo(() => {
    const list = (allCustomers ?? []).map((c) => ({ customer_id: c.customer_id, company: c.company ?? null }));
    list.sort((a, b) => String(a.company ?? '').localeCompare(String(b.company ?? ''), 'da-DK'));
    return list;
  }, [allCustomers]);
  const spNameById = useMemo(() => Object.fromEntries(((salespersons ?? []) as { id: string; name: string }[]).map(s => [s.id, s.name])), [salespersons]);
  const spCurrencyById = useMemo(() => Object.fromEntries(((salespersons ?? []) as { id: string; currency?: string | null }[]).map(s => [s.id, s.currency ?? 'DKK'])), [salespersons]);

  // Fetch which customers have style details for Season 1 (for showing flag)
  const { data: styleDetailsAccounts } = useSWR(
    s1 ? ['style-details-accounts', s1] : null,
    async () => {
      if (!s1) return new Set<string>();
      // Select distinct account_no values that have style details for this season
      const { data, error } = await supabase
        .from('sales_style_details_rows')
        .select('account_no')
        .eq('season_id', s1)
        .limit(50000);
      if (error) {
        console.error('Failed to fetch style details accounts:', error.message);
        return new Set<string>();
      }
      const set = new Set<string>();
      for (const r of (data ?? []) as { account_no: string }[]) {
        if (r.account_no) set.add(r.account_no);
      }
      return set;
    },
    { refreshInterval: 60000, revalidateOnFocus: false }
  );
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

  // Get the selected s1 season object for freeze state
  const s1Season = useMemo(() => {
    if (!s1 || !seasons) return null;
    return (seasons ?? []).find((x) => x.id === s1) ?? null;
  }, [s1, seasons]);
  const isS1Frozen = s1Season?.is_frozen ?? false;

  // Toggle freeze state for Season 1
  const [togglingFreeze, setTogglingFreeze] = useState(false);
  async function toggleS1Freeze() {
    if (!s1 || !s1Season) return alert('Select Season 1 first');
    const action = isS1Frozen ? 'unmark' : 'mark';
    const confirmed = confirm(
      isS1Frozen
        ? `Unmark "${getSeasonLabel(s1)}" as Complete?\n\nThis will allow scrape jobs to write data to this season again.`
        : `Mark "${getSeasonLabel(s1)}" as Complete?\n\nThis will prevent any scrape jobs (cron or manual) from overwriting data for this season.`
    );
    if (!confirmed) return;
    try {
      setTogglingFreeze(true);
      const { data: { session } } = await supabase.auth.getSession();
      const email = session?.user?.email ?? null;
      const updates = isS1Frozen
        ? { is_frozen: false, frozen_at: null, frozen_by: null }
        : { is_frozen: true, frozen_at: new Date().toISOString(), frozen_by: email };
      const { error } = await supabase.from('seasons').update(updates).eq('id', s1);
      if (error) throw new Error(error.message);
      await mutateSeasons();
    } catch (e: any) {
      alert(e?.message || 'Failed to update freeze state');
    } finally {
      setTogglingFreeze(false);
    }
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
  // Style details state (grouped by style_no + color)
  const [detailsStyleRows, setDetailsStyleRows] = useState<Array<{ style_no: string; style_name: string | null; color: string | null; totalQty: number; image_url: string | null; rows: any[] }>>([]);
  const [styleDetailsExpanded, setStyleDetailsExpanded] = useState<Set<string>>(new Set());
  const [detailsScrapeInfo, setDetailsScrapeInfo] = useState<{ first_scraped_at: string | null; force_rescrape: boolean } | null>(null);
  // Comment modal state
  const [commentModalOpen, setCommentModalOpen] = useState(false);
  const [commentCustomerId, setCommentCustomerId] = useState<string>('');
  const [commentText, setCommentText] = useState<string>('');
  const [commentIsPermanent, setCommentIsPermanent] = useState(false);
  const [commentLoading, setCommentLoading] = useState(false);
  // Detailed logging section state
  const [showLogging, setShowLogging] = useState(false);
  const [fixingLogging, setFixingLogging] = useState(false);

  async function openDetails(row: RowOut) {
    if (!s1 && !s2) return;
    setDetailsRow(row);
    setDetailsOpen(true);
    setDetailsLoading(true);
    setDetailsS1NewRows([]);
    setDetailsS2NewRows([]);
    setDetailsStyleRows([]);
    setStyleDetailsExpanded(new Set());
    setDetailsScrapeInfo(null);
    try {
      const hasAccount = !!row.account_no && !row.account_no.includes(':');
      const debugDetails =
        typeof window !== 'undefined' &&
        window?.localStorage?.getItem('debug:general-details') === '1';
      const debugPrefix = '[general/details]';
      if (debugDetails) {
        console.groupCollapsed(`${debugPrefix} openDetails()`, {
          account_no: row.account_no,
          customer: row.customer,
          city: row.city,
          salespersonId: row.salespersonId,
          s1,
          s2,
          hasAccount,
        });
      }
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
        // IMPORTANT:
        // If we have a concrete account_no, do NOT filter by salesperson_id.
        // Otherwise, customers that were serviced by another salesperson will "disappear" in Details,
        // even though the table shows totals for the customer.
        if (!hasAccount && row.salespersonId) { stats.eq('salesperson_id', row.salespersonId); }
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
      // Always log a short summary so we can see why a customer looks "unvisited".
      console.log(`${debugPrefix} fetched season rows`, {
        account_no: row.account_no,
        customer: row.customer,
        city: row.city,
        salespersonId: row.salespersonId,
        s1,
        s2,
        hasAccount,
        s1StatsCount: (s1Stats.data ?? []).length,
        s1InvoicesCount: (s1Invoices?.data ?? []).length,
        s2StatsCount: (s2Stats.data ?? []).length,
        s2InvoicesCount: (s2Invoices?.data ?? []).length,
      });
      // If other salespeople have rows for this account, highlight it.
      try {
        const uniq = (arr: any[]) => Array.from(new Set((arr ?? []).map((r) => r?.salesperson_id).filter(Boolean)));
        const s1Sp = uniq(s1Stats.data ?? []);
        const s2Sp = uniq(s2Stats.data ?? []);
        const expected = row.salespersonId;
        const mismatch =
          Boolean(expected) &&
          (s1Sp.some((id) => id !== expected) || s2Sp.some((id) => id !== expected));
        if (mismatch) {
          console.warn(`${debugPrefix} salesperson mismatch in sales_stats rows`, {
            account_no: row.account_no,
            expectedSalespersonId: expected,
            s1SalespersonIds: s1Sp,
            s2SalespersonIds: s2Sp,
          });
        }
      } catch {}
      if (debugDetails) {
        console.log(`${debugPrefix} s1Stats rows`, s1Stats.data ?? []);
        console.log(`${debugPrefix} s1Invoices rows`, s1Invoices?.data ?? []);
        console.log(`${debugPrefix} s2Stats rows`, s2Stats.data ?? []);
        console.log(`${debugPrefix} s2Invoices rows`, s2Invoices?.data ?? []);
      }

      // Optional deep debug: fetch ALL seasons for this account_no.
      // Enable via: localStorage.setItem('debug:general-details','1')
      if (debugDetails && hasAccount) {
        try {
          const [allStats, allInv] = await Promise.all([
            supabase
              .from('sales_stats')
              .select('id, account_no, customer_name, city, qty, price, currency, season_id, salesperson_id, updated_at, frozen')
              .eq('account_no', row.account_no)
              .limit(10000),
            supabase
              .from('sales_invoices')
              .select('id, account_no, customer_name, qty, amount, currency, invoice_no, invoice_date, created_at, manual_edited, season_id')
              .eq('account_no', row.account_no)
              .limit(10000),
          ]);
          console.log(`${debugPrefix} ALL-SEASONS by account_no`, {
            account_no: row.account_no,
            allStatsCount: (allStats.data ?? []).length,
            allInvoicesCount: (allInv.data ?? []).length,
            seasonsInStats: Array.from(new Set((allStats.data ?? []).map((r: any) => r?.season_id))).filter(Boolean),
            seasonsInInvoices: Array.from(new Set((allInv.data ?? []).map((r: any) => r?.season_id))).filter(Boolean),
          });
          console.log(`${debugPrefix} allStats rows`, allStats.data ?? []);
          console.log(`${debugPrefix} allInvoices rows`, allInv.data ?? []);
        } catch (e: any) {
          console.warn(`${debugPrefix} ALL-SEASONS debug fetch failed`, e?.message || e);
        }
      }
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

      // Fetch style details for Season 1 if available
      if (s1 && hasAccount && styleDetailsAccounts?.has(row.account_no)) {
        try {
          const { data: styleRows, error: styleErr } = await supabase
            .from('sales_style_details_rows')
            .select('style_no, style_name, quality, color, size, qty, barcode')
            .eq('season_id', s1)
            .eq('account_no', row.account_no)
            .limit(10000);
          if (!styleErr && styleRows && styleRows.length > 0) {
            // Helper to strip quotes from values
            const stripQuotes = (s: string | null): string | null => {
              if (!s) return null;
              const trimmed = s.trim();
              if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
                return trimmed.slice(1, -1).trim();
              }
              return trimmed;
            };

            // Get unique style numbers to fetch images
            const uniqueStyleNos = Array.from(new Set((styleRows as any[]).map(sr => stripQuotes(sr.style_no)).filter(Boolean))) as string[];
            
            // Fetch style images
            let styleImages: Map<string, string | null> = new Map();
            if (uniqueStyleNos.length > 0) {
              const { data: stylesData } = await supabase
                .from('styles')
                .select('style_no, image_url')
                .in('style_no', uniqueStyleNos);
              for (const s of (stylesData ?? []) as any[]) {
                if (s.style_no) styleImages.set(s.style_no, s.image_url || null);
              }
            }

            // Group by style_no + color
            const grouped = new Map<string, { style_no: string; style_name: string | null; color: string | null; totalQty: number; image_url: string | null; rows: any[] }>();
            for (const sr of styleRows as any[]) {
              const cleanStyleNo = stripQuotes(sr.style_no) || '';
              const cleanColor = stripQuotes(sr.color) || '';
              const key = `${cleanStyleNo}|${cleanColor}`;
              const existing = grouped.get(key);
              if (existing) {
                existing.totalQty += Number(sr.qty || 0);
                existing.rows.push(sr);
              } else {
                grouped.set(key, {
                  style_no: cleanStyleNo,
                  style_name: stripQuotes(sr.style_name),
                  color: cleanColor || null,
                  totalQty: Number(sr.qty || 0),
                  image_url: styleImages.get(cleanStyleNo) || null,
                  rows: [sr]
                });
              }
            }
            // Sort by total qty descending
            const sortedGroups = Array.from(grouped.values()).sort((a, b) => b.totalQty - a.totalQty);
            setDetailsStyleRows(sortedGroups);
          }

          // Fetch scrape tracking info
          const { data: scrapeInfo } = await supabase
            .from('sales_style_details_scraped')
            .select('first_scraped_at, force_rescrape')
            .eq('season_id', s1)
            .eq('account_no', row.account_no)
            .maybeSingle();
          if (scrapeInfo) {
            setDetailsScrapeInfo({
              first_scraped_at: scrapeInfo.first_scraped_at,
              force_rescrape: scrapeInfo.force_rescrape
            });
          }
        } catch (e: any) {
          console.error('Failed to fetch style details:', e?.message);
        }
      }
    } catch (e: any) {
      alert(e?.message || 'Failed to load details');
    } finally {
      setDetailsLoading(false);
      // Only end group if we started it
      try {
        const debugDetails =
          typeof window !== 'undefined' &&
          window?.localStorage?.getItem('debug:general-details') === '1';
        if (debugDetails) console.groupEnd();
      } catch {}
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
    
    // Check if customer exists
    const existingCustomer = (allCustomers ?? []).find(c => c.customer_id === account_no);
    const isUpdate = !!existingCustomer;
    const hasMismatch = existingCustomer && existingCustomer.salesperson_id !== salesperson_id;
    
    let confirmMessage = '';
    if (isUpdate && hasMismatch) {
      const currentSp = existingCustomer.salesperson_id ? (spNameById[existingCustomer.salesperson_id] || 'Unknown') : 'None';
      const newSp = salesperson_id ? (spNameById[salesperson_id] || 'Unknown') : 'None';
      confirmMessage = `Update customer "${customer_name}" (${account_no})?\n\nCurrent salesperson: ${currentSp}\nNew salesperson: ${newSp}`;
    } else {
      confirmMessage = `Create customer "${customer_name}" (${account_no}) in the customers database?\n\nSalesperson: ${salesperson_id ? (spNameById[salesperson_id] || 'Unknown') : 'None'}`;
    }
    
    if (!confirm(confirmMessage)) {
      return;
    }
    
    try {
      if (isUpdate) {
        // Update existing customer with correct salesperson_id
        const { error } = await supabase
          .from('customers')
          .update({
            salesperson_id: salesperson_id || null,
            // Also update name and city if they're missing
            company: existingCustomer.company || customer_name || account_no,
            city: existingCustomer.city || city || null,
          })
          .eq('customer_id', account_no);
        if (error) throw error;
        alert(`✓ Customer updated successfully!\n\nAccount: ${account_no}\nSalesperson: ${salesperson_id ? (spNameById[salesperson_id] || 'Unknown') : 'None'}`);
      } else {
        // Insert new customer
        const { error } = await supabase.from('customers').insert({
          customer_id: account_no,
          company: customer_name || account_no,
          city: city || null,
          salesperson_id: salesperson_id || null,
          country: null, // Will need to be set manually later
        });
        if (error) throw error;
        alert(`✓ Customer created successfully!\n\nAccount: ${account_no}\nName: ${customer_name}\nSalesperson: ${salesperson_id ? (spNameById[salesperson_id] || 'Unknown') : 'None'}`);
      }
      
      // Refresh customers list and rows
      await Promise.all([
        mutateGeneralRows(),
        // Refresh allCustomers SWR cache
        ...(typeof window !== 'undefined' ? [] : [])
      ]);
      
      // Force a page refresh to update the UI
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch (err: any) {
      alert(`Failed to ${isUpdate ? 'update' : 'create'} customer: ${err.message}`);
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

  const mutateGeneralRows = refreshAll;

  const rows = useMemo(() => {
    if (!s1 || !s2) return [] as RowOut[];
    if (!allCustomers) return [] as RowOut[];

    const statsDataAll = (stats ?? []) as any[];
    const invoicesDataAll = (invoices ?? []) as any[];

    // Filter by selected salesperson by constraining to their customer_id list.
    let statsData = statsDataAll;
    let invoicesData = invoicesDataAll;
    if (selectedSalespersonId) {
      const targetCustomerIds = (allCustomers ?? [])
        .filter((c) => c.salesperson_id === selectedSalespersonId && c.customer_id)
        .map((c) => c.customer_id);
      const set = new Set(targetCustomerIds);
      statsData = statsDataAll.filter((r) => r.account_no && set.has(String(r.account_no)));
      invoicesData = invoicesDataAll.filter((inv) => inv.account_no && set.has(String(inv.account_no)));
      console.log('[stats] selectedSalespersonId:', selectedSalespersonId, 'targetCustomerIds count:', targetCustomerIds.length, 'sample:', targetCustomerIds.slice(0, 5));
    }

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
      const customer = r.account_no ? (allCustomers ?? []).find(c => {
        const cId = String(c.customer_id || '');
        const rAccount = String(r.account_no || '');
        return cId === rAccount || cId === String(Number(rAccount)) || String(Number(cId)) === rAccount;
      }) : null;
      const customerSalespersonId = customer?.salesperson_id ?? null;
      if (r.account_no && !customer && (allCustomers ?? []).length > 0) {
        console.warn('[stats] Customer not found in allCustomers for account_no:', r.account_no, 'customer_name:', r.customer_name, 'allCustomers sample:', (allCustomers ?? []).slice(0, 3).map(c => c.customer_id));
      }
      const item = map.get(key) ?? {
        account_no: r.account_no ?? key,
        customer: r.customer_name ?? '-',
        city: itemCity,
        groupName: r.account_no ? (customerIndex as any)?.groupById?.[r.account_no] ?? null : null,
        s1Qty: 0,
        s1Price: 0,
        s2Qty: 0,
        s2Price: 0,
        salespersonId: customerSalespersonId,
        salespersonName: customerSalespersonId ? (spNameById[customerSalespersonId] ?? 'Unknown') : '—'
      };
      if (customerSalespersonId) {
        item.salespersonId = customerSalespersonId;
        item.salespersonName = spNameById[customerSalespersonId] ?? 'Unknown';
      }
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

    // Aggregate Invoices (sales_invoices)
    for (const inv of invoicesData as any[]) {
      const key: string = inv.account_no ?? `${inv.customer_name ?? ''}:-`;
      const itemExisting = map.get(key);
      let itemCity: string = itemExisting?.city ?? '';
      if (!itemCity && inv.account_no) itemCity = customerIndex?.byId?.[inv.account_no] ?? '';
      if (!itemCity && inv.customer_name) itemCity = customerIndex?.byName?.[inv.customer_name] ?? '';
      if (!itemCity) itemCity = '-';
      let invoiceSalespersonId: string | null = null;
      let invoiceSalespersonName = '—';
      if (inv.account_no) {
        const customer = (allCustomers ?? []).find(c => c.customer_id === inv.account_no);
        if (customer?.salesperson_id) {
          invoiceSalespersonId = customer.salesperson_id;
          invoiceSalespersonName = spNameById[customer.salesperson_id] ?? 'Unknown';
        }
      }
      const item = itemExisting ?? {
        account_no: inv.account_no ?? key,
        customer: inv.customer_name ?? '-',
        city: itemCity,
        groupName: inv.account_no ? (customerIndex as any)?.groupById?.[inv.account_no] ?? null : null,
        s1Qty: 0,
        s1Price: 0,
        s2Qty: 0,
        s2Price: 0,
        salespersonId: invoiceSalespersonId,
        salespersonName: invoiceSalespersonName
      } as RowOut;
      if (item.salespersonId === null && invoiceSalespersonId) {
        item.salespersonId = invoiceSalespersonId;
        item.salespersonName = invoiceSalespersonName;
      }
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
  }, [s1, s2, selectedSalespersonId, allCustomers, customerIndex, spNameById, stats, invoices]);

  // Seasonal overrides (null/hidden) stored in app_settings per season
  const overridesKey = s1 ? `season_overrides:${s1}` : null;

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
    await refreshAll();
  }


  function isHidden(account: string): boolean {
    return Boolean(overrides?.value.hidden.includes(account)) || Boolean(closedCustomers?.setExcluded.has(account));
  }
  function isNulled(account: string): boolean {
    return Boolean(overrides?.value.nulled.includes(account)) || Boolean(closedCustomers?.setNulled.has(account)) || Boolean(closedCustomers?.setClosed.has(account));
  }

  // Detailed logging: For each salesperson, list all customers and their table status
  type CustomerLogEntry = {
    customer_id: string;
    company: string | null | undefined;
    city: string | null | undefined;
    inTable: boolean;
    reason: string;
    hasS1Data: boolean;
    hasS2Data: boolean;
    excluded: boolean;
    nulled: boolean;
    permanentlyClosed: boolean;
    hidden: boolean;
  };

  type SalespersonLog = {
    salespersonId: string;
    salespersonName: string;
    customers: CustomerLogEntry[];
    totalCustomers: number;
    inTableCount: number;
    notInTableCount: number;
  };

  const detailedLogging = useMemo((): SalespersonLog[] => {
    if (!salespersons || !allCustomers || !rows || !s1 || !s2) return [];

    // Create a map of account_no to row data for quick lookup
    const rowsByAccount = new Map<string, RowOut>();
    for (const row of rows) {
      if (row.account_no && !row.isGroupTotal) {
        rowsByAccount.set(row.account_no, row);
      }
    }

    const logs: SalespersonLog[] = [];

    for (const sp of salespersons) {
      // Get all customers for this salesperson
      const spCustomers = (allCustomers ?? []).filter(c => c.salesperson_id === sp.id);

      const customerLogs: CustomerLogEntry[] = spCustomers.map(customer => {
        const accountNo = customer.customer_id || '';
        const rowInTable = accountNo ? rowsByAccount.get(accountNo) : null;
        // Customer is "in table" if they have data AND are not hidden
        // Note: Even if hidden, they still have data, so we check both conditions
        const inTable = !!rowInTable && !isHidden(accountNo);

        // Determine reason if not in table
        let reason = '';
        if (inTable) {
          reason = 'In table';
        } else {
          const reasons: string[] = [];
          
          // If rowInTable is null, there's no sales data for this customer in the selected seasons
          if (!rowInTable) {
            reasons.push('No sales data for selected seasons');
          } else {
            // Customer has data but is not visible in table
            if (isHidden(accountNo)) {
              reasons.push('Hidden (excluded from view)');
            }
          }
          
          if (isNulled(accountNo)) {
            if (closedCustomers?.setClosed.has(accountNo)) {
              reasons.push('Permanently closed');
            } else if (closedCustomers?.setNulled.has(accountNo)) {
              reasons.push('Nulled (permanent)');
            } else {
              reasons.push('Nulled (seasonal)');
            }
          }
          
          if (closedCustomers?.setExcluded.has(accountNo) && !isHidden(accountNo)) {
            reasons.push('Excluded');
          }

          reason = reasons.length > 0 ? reasons.join(', ') : 'Unknown reason';
        }

        // Check if customer has data in each season
        const hasS1Data = rowInTable ? (rowInTable.s1Qty > 0 || rowInTable.s1Price > 0) : false;
        const hasS2Data = rowInTable ? (rowInTable.s2Qty > 0 || rowInTable.s2Price > 0) : false;

        return {
          customer_id: accountNo,
          company: customer.company,
          city: customer.city,
          inTable,
          reason,
          hasS1Data,
          hasS2Data,
          excluded: closedCustomers?.setExcluded.has(accountNo) ?? false,
          nulled: closedCustomers?.setNulled.has(accountNo) ?? false,
          permanentlyClosed: closedCustomers?.setClosed.has(accountNo) ?? false,
          hidden: isHidden(accountNo),
        };
      });

      logs.push({
        salespersonId: sp.id,
        salespersonName: sp.name,
        customers: customerLogs.sort((a, b) => (a.company || a.customer_id || '').localeCompare(b.company || b.customer_id || '')),
        totalCustomers: customerLogs.length,
        inTableCount: customerLogs.filter(c => c.inTable).length,
        notInTableCount: customerLogs.filter(c => !c.inTable).length,
      });
    }

    return logs.sort((a, b) => a.salespersonName.localeCompare(b.salespersonName));
  }, [salespersons, allCustomers, rows, s1, s2, closedCustomers, overrides]);

  // Filter logging to only show the currently selected salesperson
  const filteredLogging = useMemo(() => {
    if (!selectedSalespersonId) return [];
    return detailedLogging.filter(log => log.salespersonId === selectedSalespersonId);
  }, [detailedLogging, selectedSalespersonId]);

  async function toggleHide(account: string) {
    if (!s1) return alert('Select Season 1 first');
    const hidden = new Set(overrides?.value.hidden ?? []);
    if (hidden.has(account)) hidden.delete(account); else hidden.add(account);
    console.log('[stats] toggleHide', account, '->', Array.from(hidden));
    await saveOverrides({ nulled: overrides?.value.nulled ?? [], hidden: Array.from(hidden) });
    await mutateGeneralRows();
  }
  async function toggleNull(account: string) {
    if (!s1) return alert('Select Season 1 first');
    const nulled = new Set(overrides?.value.nulled ?? []);
    if (nulled.has(account)) nulled.delete(account); else nulled.add(account);
    console.log('[stats] toggleNull', account, '->', Array.from(nulled));
    await saveOverrides({ nulled: Array.from(nulled), hidden: overrides?.value.hidden ?? [] });
    await mutateGeneralRows();
  }
  async function permanentClose(account: string) {
    // Mark customer globally; also add seasonal null
    const { error } = await supabase.from('customers').update({ permanently_closed: true, nulled: true }).eq('customer_id', account);
    if (error) return alert(error.message);
    console.log('[stats] permanentClose', account);
    await toggleNull(account);
    await refreshAll();
  }

  /**
   * Fix Logging: For all customers who have S2 data, unhide and unnull them for this season.
   * Permanently closed customers remain visible but keep their perm closed flag.
   */
  async function fixLogging() {
    if (!s1) return alert('Select Season 1 first');
    if (!selectedSalespersonId) return alert('Select a salesperson first');
    
    setFixingLogging(true);
    try {
      // Get all customers for the selected salesperson from the logging data
      const spLog = filteredLogging.find(log => log.salespersonId === selectedSalespersonId);
      if (!spLog) {
        alert('No logging data found for this salesperson');
        setFixingLogging(false);
        return;
      }

      // Find all customers who have S2 data (meaning they exist in the S2 season stats)
      const customersWithS2 = spLog.customers.filter(c => c.hasS2Data && c.customer_id);
      
      console.log('[fixLogging] Salesperson:', selectedSalespersonId, 'Total customers:', spLog.customers.length);
      console.log('[fixLogging] Customers with S2 data:', customersWithS2.length);
      console.log('[fixLogging] Sample customers with S2:', customersWithS2.slice(0, 5).map(c => ({
        id: c.customer_id,
        company: c.company,
        hasS2Data: c.hasS2Data,
        hidden: c.hidden,
        nulled: c.nulled,
        excluded: c.excluded,
        permanentlyClosed: c.permanentlyClosed
      })));
      
      if (customersWithS2.length === 0) {
        // Also show customers that are hidden/nulled to help debug
        const hiddenOrNulled = spLog.customers.filter(c => c.hidden || c.nulled || c.excluded);
        console.log('[fixLogging] Hidden/nulled customers:', hiddenOrNulled.length, hiddenOrNulled.slice(0, 10).map(c => ({
          id: c.customer_id,
          company: c.company,
          hasS1Data: c.hasS1Data,
          hasS2Data: c.hasS2Data,
          hidden: c.hidden,
          nulled: c.nulled,
          excluded: c.excluded,
          permanentlyClosed: c.permanentlyClosed
        })));
        alert(`No customers with S2 data found for this salesperson.\n\nTotal customers: ${spLog.customers.length}\nHidden/nulled: ${hiddenOrNulled.length}\n\nCheck browser console for details.`);
        setFixingLogging(false);
        return;
      }

      // Get current overrides
      const currentNulled = new Set(overrides?.value.nulled ?? []);
      const currentHidden = new Set(overrides?.value.hidden ?? []);
      
      let unhiddenCount = 0;
      let unnulledCount = 0;
      const customerIds = customersWithS2.map(c => c.customer_id);

      for (const customer of customersWithS2) {
        const accountNo = customer.customer_id;
        
        // Unhide if hidden (in seasonal overrides)
        if (currentHidden.has(accountNo)) {
          currentHidden.delete(accountNo);
          unhiddenCount++;
        }
        
        // Unnull if nulled seasonally
        if (currentNulled.has(accountNo)) {
          currentNulled.delete(accountNo);
          unnulledCount++;
        }
      }

      // Save the updated overrides
      console.log('[fixLogging] Saving overrides - removing from nulled:', unnulledCount, 'removing from hidden:', unhiddenCount);
      await saveOverrides({
        nulled: Array.from(currentNulled),
        hidden: Array.from(currentHidden)
      });

      // Update customers table: unnull AND un-exclude customers with S2 data (except perm closed)
      // This makes them visible in the table
      const toUpdateInDb = customersWithS2
        .filter(c => (c.nulled || c.excluded) && !c.permanentlyClosed)
        .map(c => c.customer_id);
      
      let dbUpdated = 0;
      if (toUpdateInDb.length > 0) {
        console.log('[fixLogging] Updating customers in DB:', toUpdateInDb.length, toUpdateInDb.slice(0, 10));
        const { error, count } = await supabase
          .from('customers')
          .update({ nulled: false, excluded: false })
          .in('customer_id', toUpdateInDb);
        if (error) {
          console.error('[fixLogging] Error updating customers in DB:', error);
        } else {
          dbUpdated = toUpdateInDb.length;
        }
      }

      // Force refresh all data
      console.log('[fixLogging] Refreshing all data...');
      await refreshAll();
      
      // Small delay to let React re-render
      await new Promise(resolve => setTimeout(resolve, 100));
      
      console.log('[fixLogging] Complete:', {
        customersWithS2: customersWithS2.length,
        unhiddenCount,
        unnulledCount,
        dbUpdated
      });
      
      alert(`Fixed logging:\n- Customers with S2 data: ${customersWithS2.length}\n- Unhidden (seasonal): ${unhiddenCount}\n- Unnulled (seasonal): ${unnulledCount}\n- Updated in DB (unnulled + un-excluded): ${dbUpdated}\n\nThe view should now update. If not, try refreshing the page.`);
    } catch (err: any) {
      console.error('[fixLogging] Error:', err);
      alert(err?.message || 'Failed to fix logging');
    } finally {
      setFixingLogging(false);
    }
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

  function timeAgo(iso: string): string {
    const d = new Date(iso).getTime();
    const diff = Math.floor((Date.now() - d) / 1000);
    const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
      [60, 'second'],
      [60, 'minute'],
      [24, 'hour'],
      [7, 'day'],
      [4.34524, 'week'],
      [12, 'month'],
      [Number.POSITIVE_INFINITY, 'year']
    ];
    let unit: Intl.RelativeTimeFormatUnit = 'second';
    let value = -diff; // past -> negative
    let acc = diff;
    for (let i = 0, n = diff; i < units.length; i++) {
      const pair = units[i];
      if (!pair) break;
      const [step, u] = pair;
      if (n < step) { unit = u; value = -Math.round(acc); break; }
      n = Math.floor(n / step);
      acc = n;
      unit = u;
      value = -Math.round(acc);
    }
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    return rtf.format(value as number, unit);
  }

  async function downloadLatestPdf() {
    if (!latestExport || !selectedSalespersonId) return;
    
    // Find the specific salesperson's PDF from meta.files
    const files = (latestExport.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null; salesperson_id: string }>) ?? [];
    const salespersonFile = files.find(f => f.salesperson_id === selectedSalespersonId);
    
    if (!salespersonFile) {
      alert('PDF for denne sælger er ikke tilgængelig.');
      return;
    }
    
    // Try to download the salesperson's individual PDF
    if (salespersonFile.path) {
      try {
        const { data: file, error } = await supabase.storage.from('exports').download(salespersonFile.path);
        if (!error && file) {
          const blobUrl = URL.createObjectURL(file as unknown as Blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = `${salespersonFile.name || 'salesperson'}.pdf`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(blobUrl);
          return;
        }
      } catch {}
    }
    
    // Fallback to public URL
    if (salespersonFile.publicUrl) {
      window.open(salespersonFile.publicUrl, '_blank', 'noopener');
      return;
    }
    
    alert('Filen er ikke klar endnu. Prøv igen om et øjeblik.');
  }

  // Manual refresh function - reloads all SWR caches
  const [isRefreshing, setIsRefreshing] = useState(false);
  async function refreshAllData() {
    setIsRefreshing(true);
    try {
      // Refresh all SWR caches in parallel
      await Promise.all([
        refreshAll(),
        mutateComments()
      ]);
      console.log('[stats] All data refreshed');
    } catch (e: any) {
      console.error('[stats] Error refreshing data:', e);
    } finally {
      setIsRefreshing(false);
    }
  }

  const isPageReady = ready && typeof commentsMap !== 'undefined';

  return !isPageReady ? (
    <div className="page-container flex items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" />
    </div>
  ) : (
    <div className="page-container space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-balance text-slate-700">General statistics</h1>
          <div className="mt-1 flex items-center gap-3">
            <span className="text-2xl sm:text-3xl font-bold tracking-tight">{getSeasonLabel(s1) || 'Season 1'} vs {getSeasonLabel(s2) || 'Season 2'}</span>
            {isS1Frozen && (
              <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                S1 Complete
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshAllData}
            disabled={isRefreshing}
            className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Refresh all data (cache refreshes automatically every 30 minutes)"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing...' : 'Refresh Data'}
          </button>
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
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50 disabled:opacity-60"
                  disabled={pdfExporting}
                  onClick={async () => {
                    if (!s1 || !s2) {
                      alert('Please select both seasons before exporting.');
                      return;
                    }
                    setPdfExporting(true);
                    setPdfExportProgress(null);
                    try {
                      const { data: { session } } = await supabase.auth.getSession();
                      if (!session) throw new Error('Not signed in');
                      const token = session.access_token;
                      const body = {
                        type: 'export_overview',
                        payload: { mode: 'general_salesmen_react_pdf', requestedBy: session.user.email, s1, s2 }
                      };
                      const res = await fetch('/api/enqueue', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify(body)
                      });
                      if (!res.ok) throw new Error(await res.text());
                      const { jobId } = await res.json();
                      setPdfExportJobId(jobId);
                      // Poll for progress
                      const pollInterval = setInterval(async () => {
                        try {
                          const { data: logs } = await supabase
                            .from('job_logs')
                            .select('msg, data')
                            .eq('job_id', jobId)
                            .order('ts', { ascending: false })
                            .limit(20);
                          for (const l of (logs ?? []) as any[]) {
                            if (l.msg === 'STEP:export_general_progress' && l.data) {
                              setPdfExportProgress({ index: Number(l.data.index || 0), total: Number(l.data.total || 0) });
                              break;
                            }
                          }
                          const { data: jobRow } = await supabase.from('jobs').select('status').eq('id', jobId).maybeSingle();
                          const st = (jobRow as any)?.status;
                          if (st === 'succeeded' || st === 'failed' || st === 'cancelled') {
                            clearInterval(pollInterval);
                            setPdfExporting(false);
                            setPdfExportJobId(null);
                            setPdfExportProgress(null);
                            if (st === 'succeeded') {
                              alert('PDF export completed! Check the Exports page.');
                            } else {
                              alert(`PDF export ${st}.`);
                            }
                          }
                        } catch {}
                      }, 1500);
                    } catch (e: any) {
                      console.error('PDF export failed', e);
                      alert(e?.message || 'Failed to start PDF export');
                      setPdfExporting(false);
                    }
                  }}
                >{pdfExporting ? `Exporting PDF${pdfExportProgress ? ` (${pdfExportProgress.index}/${pdfExportProgress.total})` : '...'}` : 'Export PDF (Server)'}</button>
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                  onClick={() => { setImportOpen(true); }}
                >Import Statistic</button>
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                  onClick={() => { setManualOpen(true); }}
                >Add manual entry</button>
                <button className="block w-full px-3 py-2 text-left hover:bg-gray-50" onClick={() => { setNullByInputText(''); setNullByInputResult(null); setNullByInputOpen(true); }}>Null Customers by Input</button>
                <div className="border-t my-1" />
                <button
                  className="block w-full px-3 py-2 text-left hover:bg-gray-50 disabled:opacity-50"
                  disabled={!s1 || togglingFreeze}
                  onClick={toggleS1Freeze}
                >
                  {!s1
                    ? 'Mark Season 1 as Complete (select first)'
                    : isS1Frozen
                      ? `Unmark ${getSeasonLabel(s1)} as Complete`
                      : `Mark ${getSeasonLabel(s1)} as Complete`}
                </button>
              </div>
            </div>
          </details>
          </div>
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

        {/* Latest PDF Export Info */}
        {latestExport && activePerson && selectedSalespersonId && (() => {
          // Check if the active salesperson has a PDF in the latest export
          const files = (latestExport.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null; salesperson_id: string }>) ?? [];
          const salespersonFile = files.find(f => f.salesperson_id === selectedSalespersonId);
          
          if (!salespersonFile) return null;
          
          return (
            <div className="flex items-center justify-end gap-3">
              <div className="text-sm text-gray-600">
                <span className="font-medium">Seneste PDF:</span>{' '}
                <span>{timeAgo(latestExport.created_at)}</span>
              </div>
              <button
                onClick={downloadLatestPdf}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Download PDF
              </button>
            </div>
          );
        })()}

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
                              {/* Customer name - clickable link to open details if style details exist */}
                              {!row.isGroupTotal && styleDetailsAccounts?.has(row.account_no) ? (
                                <>
                                  <button
                                    onClick={() => openDetails(row)}
                                    className="text-left hover:underline cursor-pointer"
                                    title="Click to view style details"
                                  >
                                    {row.customer}
                                  </button>
                                  <span className="text-gray-400 text-xs" title="Style details available">✓</span>
                                </>
                              ) : (
                                <span>{row.customer}</span>
                              )}
                              {!row.isGroupTotal && (() => {
                                const existingCustomer = (allCustomers ?? []).find(c => c.customer_id === row.account_no);
                                const customerExists = !!existingCustomer;
                                const salespersonMismatch = customerExists && existingCustomer.salesperson_id !== row.salespersonId;
                                // Only show fix button if salesperson exists in salespersons table
                                const salespersonExists = row.salespersonId ? (salespersons ?? []).some(sp => sp.id === row.salespersonId) : false;
                                const needsFix = (!customerExists || salespersonMismatch) && row.account_no && row.salespersonId && salespersonExists;
                                
                                return (
                                  <>
                                    {needsFix && (
                                      <button
                                        onClick={() => fixMissingCustomer(row.account_no, row.customer, row.city, row.salespersonId)}
                                        className="px-2 py-0.5 text-xs bg-orange-500 text-white rounded hover:bg-orange-600"
                                        title={
                                          !customerExists 
                                            ? `This customer doesn't exist in the customers table. Click to create and attach salesperson: ${row.salespersonId ? (spNameById[row.salespersonId] || 'Unknown') : 'Unknown'}`
                                            : `Customer exists but salesperson mismatch. Current: ${existingCustomer.salesperson_id ? (spNameById[existingCustomer.salesperson_id] || 'Unknown') : 'None'}, Expected: ${row.salespersonId ? (spNameById[row.salespersonId] || 'Unknown') : 'Unknown'}. Click to fix.`
                                        }
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
                    const customersVisitedOnly = items.filter(r => r.s1Qty > 0 || r.s1Price > 0);
                    const customersVisited = customersVisitedOnly.length;
                    
                    // Customers to visit: no S1 activity AND not nulled/closed
                    const customersToVisit = items.filter(r => {
                      const hasS1Activity = r.s1Qty > 0 || r.s1Price > 0;
                      const isExcluded = isNulled(r.account_no);
                      return !hasS1Activity && !isExcluded;
                    }).length;
                    
                    // Nulled and permanently closed counts
                    const nulledCount = items.reduce((a, r) => a + (nulledSeasonal.has(r.account_no) ? 1 : 0), 0);
                    const permClosedCount = items.reduce((a, r) => a + (closedCustomers?.setClosed.has(r.account_no) ? 1 : 0), 0);
                    
                    // Index calculation (visited-only)
                    const visitedOnlyRows = items.filter(r => (r.s1Qty > 0 || r.s1Price > 0));
                    const visitedOnlyS1Qty = visitedOnlyRows.reduce((a, r) => a + r.s1Qty, 0);
                    const visitedOnlyS2Qty = visitedOnlyRows.reduce((a, r) => a + r.s2Qty, 0);
                    const visitedOnlyS1Price = visitedOnlyRows.reduce((a, r) => a + r.s1Price, 0);
                    const visitedOnlyS2Price = visitedOnlyRows.reduce((a, r) => a + r.s2Price, 0);

                    const qtyIndexRatio = visitedOnlyS2Qty === 0 ? 1 : visitedOnlyS1Qty / visitedOnlyS2Qty;
                    const priceIndexRatio = visitedOnlyS2Price === 0 ? 1 : visitedOnlyS1Price / visitedOnlyS2Price;
                    const indexQty = visitedOnlyS2Qty === 0 ? 100 : (qtyIndexRatio * 100);
                    const indexPrice = visitedOnlyS2Price === 0 ? 100 : (priceIndexRatio * 100);

                    // Index calculation (incl. NULLED + PERM CLOSED)
                    const visitedInclRows = items.filter(r => (r.s1Qty > 0 || r.s1Price > 0) || isNulled(r.account_no));
                    const visitedInclS1Qty = visitedInclRows.reduce((a, r) => a + r.s1Qty, 0);
                    const visitedInclS2Qty = visitedInclRows.reduce((a, r) => a + r.s2Qty, 0);
                    const visitedInclS1Price = visitedInclRows.reduce((a, r) => a + r.s1Price, 0);
                    const visitedInclS2Price = visitedInclRows.reduce((a, r) => a + r.s2Price, 0);

                    const qtyIndexRatioIncl = visitedInclS2Qty === 0 ? 1 : visitedInclS1Qty / visitedInclS2Qty;
                    const priceIndexRatioIncl = visitedInclS2Price === 0 ? 1 : visitedInclS1Price / visitedInclS2Price;
                    const indexQtyIncl = visitedInclS2Qty === 0 ? 100 : (qtyIndexRatioIncl * 100);
                    const indexPriceIncl = visitedInclS2Price === 0 ? 100 : (priceIndexRatioIncl * 100);
                    
                    // Prognosis (index-independent): treat current S1 (visited) as final, and add missing S2 totals for customers not yet visited.
                    const unvisitedRows = items.filter(r => {
                      const hasS1Activity = r.s1Qty > 0 || r.s1Price > 0;
                      const isExcluded = isNulled(r.account_no);
                      return !hasS1Activity && !isExcluded;
                    });
                    const unvisitedS2Qty = unvisitedRows.reduce((a, r) => a + r.s2Qty, 0);
                    const unvisitedS2Price = unvisitedRows.reduce((a, r) => a + r.s2Price, 0);
                    
                    const prognosedQty = visitedOnlyS1Qty + unvisitedS2Qty;
                    const prognosedPrice = visitedOnlyS1Price + unvisitedS2Price;
                    
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
                          <div className="flex items-start justify-between gap-3 mb-3">
                            <h3 className="text-sm font-semibold text-gray-700">CALCULATIONS</h3>
                            <div className="inline-flex rounded-md border bg-white p-0.5 text-xs">
                              <button
                                type="button"
                                onClick={() => setCalcTab('visited_incl')}
                                className={'rounded px-3 py-1.5 ' + (calcTab === 'visited_incl' ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50')}
                              >
                                Visited + Nulled
                              </button>
                              <button
                                type="button"
                                onClick={() => setCalcTab('visited')}
                                className={'rounded px-3 py-1.5 ' + (calcTab === 'visited' ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50')}
                              >
                                Visited
                              </button>
                            </div>
                          </div>
                          <div className="text-xs text-gray-600 mb-3">
                            {calcTab === 'visited'
                              ? 'Visited: Index is calculated from customers that have Season 1 activity.'
                              : 'Visited + Nulled: Index basis includes visited customers plus customers that are nulled / permanently closed (may have last-year numbers).'}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                            {calcTab === 'visited' ? (
                              <>
                                <div className="rounded-md border p-3">
                                  <div className="text-xs text-gray-500">Index QTY</div>
                                  <div className="text-xl font-semibold">{indexQty.toFixed(1)}</div>
                                  <div className="text-[11px] text-gray-400">{visitedOnlyS1Qty} vs {visitedOnlyS2Qty} (visited)</div>
                                  <div className="text-[11px] text-gray-400">
                                    {visitedOnlyS2Qty === 0 ? 'Calc: visited S2 is 0 → 100.0' : 'Calc: (visited S1 / visited S2) × 100'}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setIndexBasisModal({ mode: 'visited', rows: visitedOnlyRows })}
                                    className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                                    disabled={visitedOnlyRows.length === 0}
                                  >
                                    View records
                                  </button>
                                </div>
                                <div className="rounded-md border p-3">
                                  <div className="text-xs text-gray-500">Index PRICE</div>
                                  <div className="text-xl font-semibold">{indexPrice.toFixed(1)}</div>
                                  <div className="text-[11px] text-gray-400">{Math.round(visitedOnlyS1Price).toLocaleString('da-DK')} vs {Math.round(visitedOnlyS2Price).toLocaleString('da-DK')} (visited)</div>
                                  <div className="text-[11px] text-gray-400">
                                    {visitedOnlyS2Price === 0 ? 'Calc: visited S2 is 0 → 100.0' : 'Calc: (visited S1 / visited S2) × 100'}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setIndexBasisModal({ mode: 'visited', rows: visitedOnlyRows })}
                                    className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                                    disabled={visitedOnlyRows.length === 0}
                                  >
                                    View records
                                  </button>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="rounded-md border p-3">
                                  <div className="text-xs text-gray-500">Index QTY</div>
                                  <div className="text-xl font-semibold">{indexQtyIncl.toFixed(1)}</div>
                                  <div className="text-[11px] text-gray-400">{visitedInclS1Qty} vs {visitedInclS2Qty} (visited + nulled + perm closed)</div>
                                  <div className="text-[11px] text-gray-400">
                                    {visitedInclS2Qty === 0 ? 'Calc: visited+excluded S2 is 0 → 100.0' : 'Calc: (visited+excluded S1 / visited+excluded S2) × 100'}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setIndexBasisModal({ mode: 'visited_incl', rows: visitedInclRows })}
                                    className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                                    disabled={visitedInclRows.length === 0}
                                  >
                                    View records
                                  </button>
                                </div>
                                <div className="rounded-md border p-3">
                                  <div className="text-xs text-gray-500">Index PRICE</div>
                                  <div className="text-xl font-semibold">{indexPriceIncl.toFixed(1)}</div>
                                  <div className="text-[11px] text-gray-400">{Math.round(visitedInclS1Price).toLocaleString('da-DK')} vs {Math.round(visitedInclS2Price).toLocaleString('da-DK')} (visited + nulled + perm closed)</div>
                                  <div className="text-[11px] text-gray-400">
                                    {visitedInclS2Price === 0 ? 'Calc: visited+excluded S2 is 0 → 100.0' : 'Calc: (visited+excluded S1 / visited+excluded S2) × 100'}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setIndexBasisModal({ mode: 'visited_incl', rows: visitedInclRows })}
                                    className="mt-1 text-xs text-blue-600 underline underline-offset-2 disabled:text-gray-400 disabled:no-underline"
                                    disabled={visitedInclRows.length === 0}
                                  >
                                    View records
                                  </button>
                                </div>
                              </>
                            )}
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Prognose QTY</div>
                              <div className="text-xl font-semibold">{Math.round(prognosedQty).toLocaleString('da-DK')}</div>
                              <div className="text-[11px] text-gray-400">visited S1 + missing S2 (unvisited)</div>
                              <div className="text-[11px] text-gray-400">
                                Calc: visited S1 + unvisited S2
                              </div>
                            </div>
                            <div className="rounded-md border p-3">
                              <div className="text-xs text-gray-500">Prognose PRICE</div>
                              <div className="text-xl font-semibold">{Math.round(prognosedPrice).toLocaleString('da-DK')}</div>
                              <div className="text-[11px] text-gray-400">visited S1 + missing S2 (unvisited)</div>
                              <div className="text-[11px] text-gray-400">
                                Calc: visited S1 + unvisited S2
                              </div>
                            </div>
                          </div>

                          <Modal
                            open={Boolean(indexBasisModal)}
                            onClose={() => setIndexBasisModal(null)}
                            title={indexBasisModal?.mode === 'visited' ? 'Visited customers · Index basis' : 'Visited + nulled/closed · Index basis'}
                            maxWidth="max-w-4xl"
                            footer={
                              <button
                                type="button"
                                className="rounded border px-3 py-1.5 text-sm"
                                onClick={() => setIndexBasisModal(null)}
                              >
                                Close
                              </button>
                            }
                          >
                            {(() => {
                              if (!indexBasisModal) return null;
                              const rows = indexBasisModal.rows ?? [];
                              if (rows.length === 0) return <div className="p-4 text-sm text-gray-600">Nothing to show.</div>;
                              return (
                                <div className="max-h-[60vh] overflow-auto">
                                  <table className="min-w-full text-sm">
                                    <thead>
                                      <tr className="bg-gray-50 text-left">
                                        <th className="p-2 font-semibold">Customer</th>
                                        <th className="p-2 font-semibold">City</th>
                                        <th className="p-2 text-right font-semibold">S1 Qty</th>
                                        <th className="p-2 text-right font-semibold">S1 Price</th>
                                        <th className="p-2 text-right font-semibold">S2 Qty</th>
                                        <th className="p-2 text-right font-semibold">S2 Price</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {rows.map((row) => {
                                        const nulled = isNulled(row.account_no);
                                        return (
                                          <tr key={row.account_no} className={`border-t hover:bg-gray-50 ${nulled ? 'bg-amber-50' : ''}`}>
                                            <td className="p-2">
                                              <div className="flex items-center gap-2">
                                                <span>{row.customer ?? row.account_no ?? '-'}</span>
                                                {nulled && <span className="text-[10px] rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">nulled/closed</span>}
                                              </div>
                                            </td>
                                            <td className="p-2">{row.city ?? '-'}</td>
                                            <td className="p-2 text-right">{Number(row.s1Qty || 0).toLocaleString('da-DK')}</td>
                                            <td className="p-2 text-right">{Math.round(row.s1Price || 0).toLocaleString('da-DK')}</td>
                                            <td className="p-2 text-right">{Number(row.s2Qty || 0).toLocaleString('da-DK')}</td>
                                            <td className="p-2 text-right">{Math.round(row.s2Price || 0).toLocaleString('da-DK')}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              );
                            })()}
                          </Modal>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
              {/* Totals section removed per request */}
            </div>

            {/* Detailed Logging Section */}
            {activePerson && selectedSalespersonId && (
              <div className="rounded-lg border bg-white">
                <div className="p-4 border-b">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">Customer Logging: {activePerson}</h2>
                    <div className="flex items-center gap-2">
                      {showLogging && (
                        <button
                          onClick={fixLogging}
                          disabled={fixingLogging}
                          className="rounded-md bg-green-600 text-white px-3 py-1.5 text-sm hover:bg-green-700 disabled:opacity-50"
                          title="Unhide and unnull all customers with S2 data for this season"
                        >
                          {fixingLogging ? 'Fixing...' : 'Fix Logging'}
                        </button>
                      )}
                      <button
                        onClick={() => setShowLogging(!showLogging)}
                        className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50"
                      >
                        {showLogging ? 'Hide' : 'Show'} Logging
                      </button>
                    </div>
                  </div>
                  {showLogging && (
                    <div className="mt-2 text-sm text-gray-600">
                      This section shows all customers for the selected salesperson and whether each customer appears in the table above with reasons if they don't. You can make changes directly from this view.
                    </div>
                  )}
                </div>
                {showLogging && (
                  <div className="p-4">
                    {filteredLogging.length > 0 ? (
                      filteredLogging.map((spLog) => (
                        <div key={spLog.salespersonId} className="space-y-4">
                          <div className="pb-2 border-b">
                            <h3 className="text-base font-semibold">{spLog.salespersonName}</h3>
                            <div className="text-sm text-gray-600 mt-1">
                              Total customers: {spLog.totalCustomers} | 
                              In table: <span className="text-green-600 font-medium">{spLog.inTableCount}</span> | 
                              Not in table: <span className="text-red-600 font-medium">{spLog.notInTableCount}</span>
                            </div>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="min-w-full text-sm">
                              <thead>
                                <tr className="bg-gray-50 border-b">
                                  <th className="text-left p-2 font-semibold">Customer ID</th>
                                  <th className="text-left p-2 font-semibold">Company</th>
                                  <th className="text-left p-2 font-semibold">City</th>
                                  <th className="text-center p-2 font-semibold">In Table</th>
                                  <th className="text-center p-2 font-semibold">S1 Data</th>
                                  <th className="text-center p-2 font-semibold">S2 Data</th>
                                  <th className="text-left p-2 font-semibold">Status Flags</th>
                                  <th className="text-left p-2 font-semibold">Reason</th>
                                  <th className="text-center p-2 font-semibold">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {spLog.customers.map((customer, idx) => (
                                  <tr key={customer.customer_id || idx} className="border-b hover:bg-gray-50">
                                    <td className="p-2 font-mono text-xs">{customer.customer_id || '—'}</td>
                                    <td className="p-2">{customer.company || '—'}</td>
                                    <td className="p-2">{customer.city || '—'}</td>
                                    <td className="p-2 text-center">
                                      {customer.inTable ? (
                                        <span className="text-green-600 font-medium">✓ Yes</span>
                                      ) : (
                                        <span className="text-red-600 font-medium">✗ No</span>
                                      )}
                                    </td>
                                    <td className="p-2 text-center">
                                      {customer.hasS1Data ? (
                                        <span className="text-green-600">✓</span>
                                      ) : (
                                        <span className="text-gray-400">—</span>
                                      )}
                                    </td>
                                    <td className="p-2 text-center">
                                      {customer.hasS2Data ? (
                                        <span className="text-green-600">✓</span>
                                      ) : (
                                        <span className="text-gray-400">—</span>
                                      )}
                                    </td>
                                    <td className="p-2">
                                      <div className="flex flex-wrap gap-1">
                                        {customer.excluded && (
                                          <span className="px-1.5 py-0.5 text-xs bg-red-100 text-red-700 rounded">Excluded</span>
                                        )}
                                        {customer.nulled && (
                                          <span className="px-1.5 py-0.5 text-xs bg-orange-100 text-orange-700 rounded">Nulled</span>
                                        )}
                                        {customer.permanentlyClosed && (
                                          <span className="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-700 rounded">Closed</span>
                                        )}
                                        {customer.hidden && (
                                          <span className="px-1.5 py-0.5 text-xs bg-yellow-100 text-yellow-700 rounded">Hidden</span>
                                        )}
                                        {!customer.excluded && !customer.nulled && !customer.permanentlyClosed && !customer.hidden && (
                                          <span className="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-500 rounded">—</span>
                                        )}
                                      </div>
                                    </td>
                                    <td className="p-2 text-xs text-gray-600">
                                      {customer.inTable ? (
                                        <span className="text-green-600">{customer.reason}</span>
                                      ) : (
                                        <span className="text-red-600">{customer.reason}</span>
                                      )}
                                    </td>
                                    <td className="p-2">
                                      <div className="flex items-center justify-center gap-1">
                                        {customer.customer_id && (
                                          <>
                                            <ActionBtn label="Hide" onClick={() => toggleHide(customer.customer_id)}>
                                              <Ban className="h-4 w-4" />
                                            </ActionBtn>
                                            <ActionBtn label="Null (season)" onClick={() => toggleNull(customer.customer_id)}>
                                              <EyeOff className="h-4 w-4" />
                                            </ActionBtn>
                                            <ActionBtn label="Close (perm)" onClick={() => permanentClose(customer.customer_id)}>
                                              <Trash2 className="h-4 w-4" />
                                            </ActionBtn>
                                            <button
                                              onClick={() => openCommentModal(customer.customer_id)}
                                              className={commentsMap?.[customer.customer_id] ? "text-blue-600 hover:text-blue-800" : "text-gray-400 hover:text-gray-600"}
                                              title={commentsMap?.[customer.customer_id]?.comment || 'Add comment'}
                                            >
                                              <MessageCircle className="h-4 w-4" />
                                            </button>
                                          </>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-8 text-gray-500">
                        {!s1 || !s2 ? 'Please select Season 1 and Season 2.' : 'No customers found for this salesperson.'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

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

                  {/* Style Details Section (only shown when data exists) */}
                  {detailsStyleRows.length > 0 && (
                    <div className="mt-6 pt-4 border-t">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Layers className="h-4 w-4 text-indigo-500" />
                          <span className="font-medium text-indigo-700">Style Details ({getSeasonLabel(s1) || 'Season 1'})</span>
                          <span className="text-xs text-gray-500">({detailsStyleRows.reduce((sum, g) => sum + g.totalQty, 0)} total qty across {detailsStyleRows.length} style/color combinations)</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          {detailsScrapeInfo?.first_scraped_at && (
                            <span className="text-gray-500">
                              First scraped: {new Date(detailsScrapeInfo.first_scraped_at).toLocaleDateString('da-DK')}
                            </span>
                          )}
                          <button
                            className={`px-2 py-1 rounded text-xs ${
                              detailsScrapeInfo?.force_rescrape 
                                ? 'bg-orange-100 text-orange-700 border border-orange-300' 
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                            onClick={async () => {
                              if (!s1 || !detailsRow) return;
                              const newValue = !detailsScrapeInfo?.force_rescrape;
                              await supabase
                                .from('sales_style_details_scraped')
                                .update({ force_rescrape: newValue })
                                .eq('season_id', s1)
                                .eq('account_no', detailsRow.account_no);
                              setDetailsScrapeInfo(prev => prev ? { ...prev, force_rescrape: newValue } : null);
                            }}
                            title={detailsScrapeInfo?.force_rescrape ? 'Will re-scrape on next job run' : 'Click to enable re-scrape on next job run'}
                          >
                            {detailsScrapeInfo?.force_rescrape ? '⟳ Re-scrape queued' : 'Queue re-scrape'}
                          </button>
                        </div>
                      </div>
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="bg-indigo-50">
                            <th className="text-left p-2 border-b w-16">Image</th>
                            <th className="text-left p-2 border-b">Style Name</th>
                            <th className="text-left p-2 border-b">Color</th>
                            <th className="text-right p-2 border-b">Total Qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailsStyleRows.map((group) => {
                            const groupKey = `${group.style_no}|${group.color || ''}`;
                            return (
                              <tr key={groupKey} className="hover:bg-indigo-50/50">
                                <td className="p-2 border-b">
                                  {group.image_url ? (
                                    <img 
                                      src={group.image_url} 
                                      alt={group.style_no} 
                                      className="w-12 h-12 object-cover rounded"
                                      title={group.style_no}
                                    />
                                  ) : (
                                    <div className="w-12 h-12 bg-gray-100 rounded flex items-center justify-center text-[10px] text-gray-400 font-mono">
                                      {group.style_no}
                                    </div>
                                  )}
                                </td>
                                <td className="p-2 border-b">{group.style_name || '—'}</td>
                                <td className="p-2 border-b">{group.color || '—'}</td>
                                <td className="p-2 border-b text-right font-medium">{group.totalQty}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="bg-indigo-50 font-semibold">
                            <td className="p-2" colSpan={3}>TOTAL</td>
                            <td className="p-2 text-right">{detailsStyleRows.reduce((sum, g) => sum + g.totalQty, 0)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
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
                          await refreshAll();
                          await mutateComments();
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



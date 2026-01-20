'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRoles } from '../../../lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs';
import { Card, CardHeader, CardTitle, CardContent } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import React from 'react';

type StockRow = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  scraped_at: string;
};

type StyleMeta = {
  id: string;
  style_no: string;
  style_name: string | null;
  supplier: string | null;
  image_url: string | null;
  link_href: string | null;
  style_type: string | null;
  cost_price: number | null;
  cost_price_currency: string | null;
  customs_tariff_no: string | null;
  country_of_origin: string | null;
  inactive: boolean;
  needs_enrichment: boolean;
  missing_from_spy: boolean;
  stock_all_zeros: boolean;
  scrape_enabled: boolean;
  size_set: any;
  dg: string | null;
  created_at: string;
  updated_at: string;
};

type StyleColor = {
  id: string;
  color: string;
  maybe_inactive: boolean;
  inactive: boolean;
  is_noos: boolean;
  visible: boolean;
  image_url: string | null;
  updated_at: string | null;
};

export default function StyleDetailPage({ params }: { params: { styleNo: string } }) {
  const supabase = createClientComponentClient();
  const router = useRouter();
  const styleNo = decodeURIComponent(params.styleNo);
  const [updatingColorId, setUpdatingColorId] = React.useState<string | null>(null);
  const [scraping, setScraping] = React.useState<boolean>(false);
  const [fullScraping, setFullScraping] = React.useState<boolean>(false);
  const [scrapeMessage, setScrapeMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [expandedColors, setExpandedColors] = React.useState<Set<string>>(new Set());

  // Fetch style meta with all columns
  const { data: meta, mutate: mutateMeta } = useSWR(['style:meta', styleNo], async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url, link_href, style_type, cost_price, cost_price_currency, customs_tariff_no, country_of_origin, inactive, needs_enrichment, missing_from_spy, stock_all_zeros, scrape_enabled, size_set, dg, created_at, updated_at')
      .eq('style_no', styleNo)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as StyleMeta | null;
  });

  // Fetch colors with graceful fallback for missing is_noos column
  const { data: colors, mutate: mutateColors } = useSWR(['style:colors', styleNo, meta?.id], async () => {
    if (!meta?.id) return [] as StyleColor[];
    
    // Try fetching with is_noos first
    const { data, error } = await supabase
      .from('style_colors')
      .select('id, color, maybe_inactive, inactive, is_noos, visible, image_url, updated_at')
      .eq('style_id', meta.id)
      .order('color');
    
    if (error) {
      // If is_noos column doesn't exist, fetch without it
      if (error.message.includes('is_noos')) {
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('style_colors')
          .select('id, color, maybe_inactive, inactive, visible, image_url, updated_at')
          .eq('style_id', meta.id)
          .order('color');
        
        if (fallbackError) throw fallbackError as any;
        // Add is_noos: false as default
        return ((fallbackData ?? []) as any[]).map(c => ({ ...c, is_noos: false })) as StyleColor[];
      }
      throw error as any;
    }
    return (data ?? []) as StyleColor[];
  });
  
  const { has } = useRoles();

  const { data: colorSeasons } = useSWR(meta?.id ? ['style:color-seasons', meta.id] : null, async () => {
    const { data: sc, error: scErr } = await supabase.from('style_colors').select('id, color').eq('style_id', meta!.id).order('color');
    if (scErr) throw scErr as any;
    const ids = (sc ?? []).map((r: any) => r.id as string);
    if (ids.length === 0) return { map: new Map<string, string[]>(), seasons: new Map<string, { name: string; year: number | null }>() };
    const { data: links } = await supabase.from('style_color_seasons').select('style_color_id, season_id').in('style_color_id', ids).limit(100000);
    const seasonIds = Array.from(new Set((links ?? []).map((r: any) => r.season_id as string))).filter(Boolean);
    const { data: seas } = await supabase.from('seasons').select('id, name, year').in('id', seasonIds).limit(100000);
    const map = new Map<string, string[]>();
    for (const r of (links ?? []) as any[]) {
      const arr = map.get(r.style_color_id) || [];
      arr.push(r.season_id as string);
      map.set(r.style_color_id, arr);
    }
    const sMap = new Map<string, { name: string; year: number | null }>();
    for (const s of (seas ?? []) as any[]) sMap.set(s.id as string, { name: s.name as string, year: (s.year as number | null) ?? null });
    return { map, seasons: sMap } as { map: Map<string, string[]>; seasons: Map<string, { name: string; year: number | null }> };
  }, { refreshInterval: 0 });

  // Fetch EAN codes for this style
  const { data: eans } = useSWR(['style:eans', styleNo], async () => {
    const { data, error } = await supabase
      .from('style_color_eans')
      .select('color, size, ean, scraped_at')
      .eq('style_no', styleNo)
      .order('color, size');
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ color: string; size: string; ean: string; scraped_at: string }>;
  }, { refreshInterval: 30000 });

  // Fetch stock data
  const { data: stockData, mutate: mutateStockData } = useSWR(['style:stock', styleNo], async () => {
    const { data, error } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .eq('style_no', styleNo)
      .order('scraped_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as StockRow[];
  }, { refreshInterval: 30000 });

  // Scrape this style
  async function scrapeThisStyle() {
    try {
      setScraping(true);
      setScrapeMessage(null);
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Not signed in');
      }

      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          Authorization: `Bearer ${session.access_token}` 
        },
        body: JSON.stringify({
          type: 'update_style_stock',
          payload: { 
            styleNos: [styleNo],
            requestedBy: session.user.email || 'style-detail-page'
          }
        })
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `Failed (${res.status})`);
      }

      const { jobId } = await res.json();
      setScrapeMessage({ type: 'success', text: `Scrape job enqueued (Job ID: ${jobId.slice(0, 8)}...)` });

      const pollInterval = setInterval(async () => {
        try {
          const { data: jobData, error: jobError } = await supabase
            .from('jobs')
            .select('status')
            .eq('id', jobId)
            .single();

          if (jobError) {
            console.error('Error checking job status:', jobError);
            return;
          }

          if (jobData?.status === 'succeeded' || jobData?.status === 'failed' || jobData?.status === 'cancelled') {
            clearInterval(pollInterval);
            setScraping(false);
            
            if (jobData.status === 'succeeded') {
              setScrapeMessage({ type: 'success', text: 'Stock data updated successfully!' });
              await mutateStockData();
              await mutateColors();
              setTimeout(() => setScrapeMessage(null), 3000);
            } else {
              setScrapeMessage({ type: 'error', text: `Job ${jobData.status}. Check the Jobs page for details.` });
            }
          }
        } catch (err) {
          console.error('Error polling job status:', err);
        }
      }, 2000);

      setTimeout(() => {
        clearInterval(pollInterval);
        if (scraping) {
          setScraping(false);
          setScrapeMessage({ type: 'error', text: 'Scrape is taking longer than expected. Check the Jobs page for status.' });
        }
      }, 300000);
    } catch (e: any) {
      setScraping(false);
      setScrapeMessage({ type: 'error', text: e?.message || 'Failed to enqueue scrape job' });
    }
  }

  // Full scrape: Stock + Deep Scrape (enrichment, colors, seasons) + EANs
  async function fullScrapeStyle() {
    try {
      setFullScraping(true);
      setScrapeMessage(null);
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Not signed in');
      }

      const basePayload = {
        styleNos: [styleNo],
        requestedBy: session.user.email || 'style-detail-page-full'
      };

      // Enqueue all three jobs
      const jobs = [
        { type: 'update_style_stock', payload: basePayload },
        { type: 'deep_scrape_styles', payload: basePayload },
        { type: 'scrape_eans', payload: basePayload }
      ];

      const jobIds: string[] = [];
      for (const job of jobs) {
        const res = await fetch('/api/enqueue', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json', 
            Authorization: `Bearer ${session.access_token}` 
          },
          body: JSON.stringify(job)
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`Failed to enqueue ${job.type}: ${txt || res.status}`);
        }

        const { jobId } = await res.json();
        jobIds.push(jobId);
      }

      setScrapeMessage({ type: 'success', text: `Full scrape started (3 jobs: Stock, Deep Enrich, EANs)` });

      // Poll for all jobs to complete
      const pollInterval = setInterval(async () => {
        try {
          const { data: jobsData, error: jobsError } = await supabase
            .from('jobs')
            .select('id, type, status')
            .in('id', jobIds);

          if (jobsError) {
            console.error('Error checking job status:', jobsError);
            return;
          }

          const statuses = (jobsData ?? []).map((j: any) => j.status);
          const allDone = statuses.every((s: string) => ['succeeded', 'failed', 'cancelled'].includes(s));

          if (allDone) {
            clearInterval(pollInterval);
            setFullScraping(false);
            
            const succeeded = statuses.filter((s: string) => s === 'succeeded').length;
            const failed = statuses.filter((s: string) => s === 'failed').length;
            
            if (failed === 0) {
              setScrapeMessage({ type: 'success', text: `Full scrape completed! All ${succeeded} jobs succeeded.` });
              // Refresh all data
              await mutateStockData();
              await mutateColors();
              await mutateMeta();
              setTimeout(() => setScrapeMessage(null), 5000);
            } else {
              setScrapeMessage({ type: 'error', text: `Full scrape finished: ${succeeded} succeeded, ${failed} failed. Check Jobs page.` });
            }
          }
        } catch (err) {
          console.error('Error polling job status:', err);
        }
      }, 3000);

      // Stop polling after 10 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        if (fullScraping) {
          setFullScraping(false);
          setScrapeMessage({ type: 'error', text: 'Full scrape is taking longer than expected. Check the Jobs page for status.' });
        }
      }, 600000);
    } catch (e: any) {
      setFullScraping(false);
      setScrapeMessage({ type: 'error', text: e?.message || 'Failed to enqueue full scrape' });
    }
  }

  async function onDelete() {
    if (!meta?.style_no) return;
    const ok = window.confirm(`Permanently delete style ${meta.style_no} and all related data?\nThis cannot be undone.`);
    if (!ok) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch('/api/styles/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ styleNo: meta.style_no })
      });
      if (!res.ok) {
        const js = await res.json().catch(() => ({}));
        throw new Error(js?.error || 'Delete failed');
      }
      router.push('/styles');
    } catch (e: any) {
      alert(e?.message || 'Failed to delete style');
    }
  }

  // Process stock data per color
  const stockByColor = React.useMemo(() => {
    const map = new Map<string, StockRow[]>();
    for (const row of (stockData ?? [])) {
      const color = row.color.trim().toLowerCase();
      if (!map.has(color)) map.set(color, []);
      map.get(color)!.push(row);
    }
    
    const result = new Map<string, { stock: number[]; soldSum: number[]; purchaseSum: number[]; available: number[]; sizes: string[] }>();
    for (const [color, rows] of map.entries()) {
      const latestMap = new Map<string, StockRow>();
      let uniqueIdCounter = 0;
      
      for (const r of rows) {
        const normalizedLabel = String(r.row_label ?? '').trim();
        if (normalizedLabel) {
          const key = `${r.section}|${normalizedLabel}`;
          const curr = latestMap.get(key);
          if (!curr || new Date(r.scraped_at).getTime() > new Date(curr.scraped_at).getTime()) {
            latestMap.set(key, r);
          }
        } else {
          latestMap.set(`${r.section}|__unnamed_${uniqueIdCounter++}`, r);
        }
      }
      
      const latestRows = Array.from(latestMap.values());
      const sizes = (latestRows.find(r => r.section === 'Stock') || latestRows[0])?.sizes || [];
      const num = sizes.length;
      const zero = Array.from({ length: num }, () => 0);
      
      const stockRow = latestRows.find(r => r.section === 'Stock');
      const stock = stockRow ? (Array.isArray(stockRow.values) ? stockRow.values : JSON.parse(String(stockRow.values || '[]'))) : zero;
      
      const soldRows = latestRows.filter(r => r.section === 'Sold');
      const purchaseRows = latestRows.filter(r => r.section === 'Purchase (Running + Shipped)');
      
      const soldSum = soldRows.reduce((acc, r) => {
        const vals = Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]'));
        return acc.map((v: number, i: number) => v + (Number(vals[i]) || 0));
      }, zero.slice());
      
      const purchaseSum = purchaseRows.reduce((acc, r) => {
        const vals = Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]'));
        return acc.map((v: number, i: number) => v + (Number(vals[i]) || 0));
      }, zero.slice());
      
      const available = stock.map((v: number, i: number) => v - (soldSum[i] ?? 0) + (purchaseSum[i] ?? 0));
      
      result.set(color, { stock, soldSum, purchaseSum, available, sizes });
    }
    return result;
  }, [stockData]);

  // Group EANs by color
  const eansByColor = React.useMemo(() => {
    const map = new Map<string, Array<{ size: string; ean: string }>>();
    for (const ean of (eans ?? [])) {
      const color = ean.color.trim().toLowerCase();
      if (!map.has(color)) map.set(color, []);
      map.get(color)!.push({ size: ean.size, ean: ean.ean });
    }
    return map;
  }, [eans]);

  const toggleColorExpanded = (colorId: string) => {
    setExpandedColors(prev => {
      const next = new Set(prev);
      if (next.has(colorId)) {
        next.delete(colorId);
      } else {
        next.add(colorId);
      }
      return next;
    });
  };

  const expandAllColors = () => {
    setExpandedColors(new Set((colors ?? []).map(c => c.id)));
  };

  const collapseAllColors = () => {
    setExpandedColors(new Set());
  };

  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  const SPY_BASE_URL = 'https://2-biz.spysystem.dk';

  // Toggle NOOS
  async function toggleNoos(c: StyleColor) {
    try {
      setUpdatingColorId(c.id);
      const newNoos = !c.is_noos;
      
      mutateColors((current) => {
        if (!current) return current;
        return current.map(color => 
          color.id === c.id ? { ...color, is_noos: newNoos } : color
        );
      }, false);
      
      const { error } = await supabase
        .from('style_colors')
        .update({ is_noos: newNoos })
        .eq('id', c.id);
      
      if (error) throw error;
      
      await mutateColors();
      
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('toast', { 
          detail: { 
            message: newNoos ? 'Marked as NOOS item' : 'Removed from NOOS',
            type: 'success' 
          } 
        }));
      }
    } catch (err) {
      console.error('Failed to toggle NOOS', err);
      alert('Failed to update NOOS status');
      await mutateColors();
    } finally {
      setUpdatingColorId(null);
    }
  }

  // Toggle Inactive
  async function toggleInactive(c: StyleColor) {
    try {
      setUpdatingColorId(c.id);
      const newInactive = !c.inactive;
      
      mutateColors((current) => {
        if (!current) return current;
        return current.map(color => 
          color.id === c.id ? { ...color, inactive: newInactive } : color
        );
      }, false);
      
      const { error } = await supabase
        .from('style_colors')
        .update({ inactive: newInactive })
        .eq('id', c.id);
      
      if (error) throw error;
      
      await mutateColors();
      
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('toast', { 
          detail: { 
            message: newInactive ? 'Color marked as inactive' : 'Color activated',
            type: 'success' 
          } 
        }));
      }
    } catch (err) {
      console.error('Failed to toggle inactive', err);
      alert('Failed to update inactive status');
      await mutateColors();
    } finally {
      setUpdatingColorId(null);
    }
  }

  return (
    <div className="space-y-6 w-full max-w-full overflow-hidden">
      {/* Header Section */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-5">
          {meta?.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img 
              src={meta.image_url} 
              alt={meta.style_name ?? meta.style_no} 
              className="h-28 w-28 object-cover rounded-lg border-2 border-slate-200 shadow-sm" 
            />
          ) : (
            <div className="h-28 w-28 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 flex items-center justify-center">
              <span className="text-slate-400 text-xs">No image</span>
            </div>
          )}
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{styleNo}</h1>
              {meta?.style_type && (
                <Badge className="bg-indigo-100 text-indigo-700 border-indigo-200 font-medium">
                  {meta.style_type}
                </Badge>
              )}
            </div>
            <div className="text-lg text-slate-600">{meta?.style_name ?? '—'}</div>
            {meta?.supplier && (
              <div className="text-sm text-slate-500">
                <span className="font-medium">Supplier:</span> {meta.supplier}
              </div>
            )}
            {meta?.link_href && (() => {
              try {
                const url = new URL(meta.link_href, SPY_BASE_URL).toString();
                const statUrl = url.replace(/#.*$/, '') + '#tab=statandstock';
                return (
                  <div className="flex items-center gap-4 mt-2">
                    <a className="text-sm text-blue-600 hover:text-blue-800 hover:underline transition-colors" href={url} target="_blank" rel="noopener noreferrer">
                      Open in 2-Biz →
                    </a>
                    <a className="text-sm text-blue-600 hover:text-blue-800 hover:underline transition-colors" href={statUrl} target="_blank" rel="noopener noreferrer">
                      Stat & Stock →
                    </a>
                  </div>
                );
              } catch { return null; }
            })()}
            {/* Status Flags inline with header */}
            <div className="flex items-center gap-2 flex-wrap mt-2">
              {meta?.inactive && (
                <Badge className="bg-red-100 text-red-700 border-red-200">Inactive</Badge>
              )}
              {meta?.needs_enrichment && (
                <Badge className="bg-blue-100 text-blue-700 border-blue-200">Needs Enrichment</Badge>
              )}
              {meta?.missing_from_spy && (
                <Badge className="bg-orange-100 text-orange-700 border-orange-200">Missing from SPY</Badge>
              )}
              {meta?.stock_all_zeros && (
                <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200">Stock All Zeros</Badge>
              )}
              {meta?.scrape_enabled === false && (
                <Badge className="bg-slate-100 text-slate-700 border-slate-200">Scrape Disabled</Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors shadow-sm"
            onClick={fullScrapeStyle}
            disabled={fullScraping || scraping}
            title="Full scrape: Stock + Deep Enrich + EANs"
          >
            {fullScraping ? 'Full Scraping...' : 'Full Scrape'}
          </button>
          <button
            className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors shadow-sm"
            onClick={scrapeThisStyle}
            disabled={scraping || fullScraping}
            title="Scrape stock data only"
          >
            {scraping ? 'Scraping...' : 'Stock Only'}
          </button>
          {has('admin') && (
            <button
              className="text-sm px-4 py-2 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 transition-colors shadow-sm"
              onClick={onDelete}
              title="Permanently delete this style"
            >
              Delete Style
            </button>
          )}
        </div>
      </div>

      {/* Scrape message */}
      {scrapeMessage && (
        <div className={`rounded-lg border px-4 py-3 text-sm font-medium ${
          scrapeMessage.type === 'success' 
            ? 'bg-green-50 text-green-700 border-green-200' 
            : 'bg-red-50 text-red-700 border-red-200'
        }`}>
          {scrapeMessage.text}
        </div>
      )}

      {/* Main Content Tabs */}
      <Tabs defaultValue="general" className="w-full">
        <TabsList className="mb-4 bg-slate-100 p-1 rounded-lg">
          <TabsTrigger value="general" className="px-6 py-2 rounded-md data-[state=active]:bg-white data-[state=active]:shadow-sm">
            General
          </TabsTrigger>
          <TabsTrigger value="colors" className="px-6 py-2 rounded-md data-[state=active]:bg-white data-[state=active]:shadow-sm">
            Colors ({(colors ?? []).length})
          </TabsTrigger>
        </TabsList>

        {/* General Tab */}
        <TabsContent value="general" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Basic Information */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold text-slate-900">Basic Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Style Number</span>
                  <span className="text-sm font-medium text-slate-900 font-mono">{meta?.style_no ?? '—'}</span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Style Name</span>
                  <span className="text-sm font-medium text-slate-900 text-right max-w-[60%]">{meta?.style_name ?? '—'}</span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Style Type</span>
                  <span className="text-sm font-medium text-slate-900">{meta?.style_type ?? '—'}</span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Supplier</span>
                  <span className="text-sm font-medium text-slate-900">{meta?.supplier ?? '—'}</span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Designer/Group</span>
                  <span className="text-sm font-medium text-slate-900">{meta?.dg ?? '—'}</span>
                </div>
                {meta?.size_set && (
                  <div className="flex justify-between items-start">
                    <span className="text-sm text-slate-500">Size Set</span>
                    <span className="text-sm font-medium text-slate-900">
                      {Array.isArray(meta.size_set) ? meta.size_set.join(', ') : String(meta.size_set)}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Financial Information */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold text-slate-900">Financial Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Cost Price</span>
                  <span className="text-sm font-medium text-slate-900">
                    {meta?.cost_price != null 
                      ? `${meta.cost_price.toFixed(2)} ${meta.cost_price_currency ?? ''}`
                      : '—'
                    }
                  </span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Currency</span>
                  <span className="text-sm font-medium text-slate-900">{meta?.cost_price_currency ?? '—'}</span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Customs Tariff</span>
                  <span className="text-sm font-medium text-slate-900 font-mono">{meta?.customs_tariff_no ?? '—'}</span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Country of Origin</span>
                  <span className="text-sm font-medium text-slate-900">{meta?.country_of_origin ?? '—'}</span>
                </div>
              </CardContent>
            </Card>

            {/* Metadata */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold text-slate-900">Metadata</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Created</span>
                  <span className="text-sm font-medium text-slate-900">
                    {meta?.created_at ? new Date(meta.created_at).toLocaleDateString() : '—'}
                  </span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Last Updated</span>
                  <span className="text-sm font-medium text-slate-900">
                    {meta?.updated_at ? new Date(meta.updated_at).toLocaleString() : '—'}
                  </span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Scrape Enabled</span>
                  <span className={`text-sm font-medium ${meta?.scrape_enabled !== false ? 'text-green-600' : 'text-red-600'}`}>
                    {meta?.scrape_enabled !== false ? 'Yes' : 'No'}
                  </span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">Colors</span>
                  <span className="text-sm font-medium text-slate-900">{(colors ?? []).length}</span>
                </div>
                <div className="flex justify-between items-start">
                  <span className="text-sm text-slate-500">EAN Codes</span>
                  <span className="text-sm font-medium text-slate-900">{(eans ?? []).length}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Stock Summary - All Colors Combined */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold text-slate-900">Stock Summary (All Colors)</CardTitle>
            </CardHeader>
            <CardContent>
              {stockByColor.size > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="p-3 text-left font-medium text-slate-700 border-b">Color</th>
                        <th className="p-3 text-right font-medium text-slate-700 border-b">Stock</th>
                        <th className="p-3 text-right font-medium text-slate-700 border-b">Sold</th>
                        <th className="p-3 text-right font-medium text-slate-700 border-b">Purchase</th>
                        <th className="p-3 text-right font-medium text-slate-700 border-b">Net Need</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(stockByColor.entries()).map(([color, info]) => (
                        <tr key={color} className="hover:bg-slate-50 transition-colors">
                          <td className="p-3 border-b capitalize font-medium">{color}</td>
                          <td className="p-3 border-b text-right tabular-nums">{sum(info.stock)}</td>
                          <td className="p-3 border-b text-right tabular-nums text-red-600">{sum(info.soldSum) > 0 ? `-${sum(info.soldSum)}` : '0'}</td>
                          <td className="p-3 border-b text-right tabular-nums text-green-600">{sum(info.purchaseSum)}</td>
                          <td className={`p-3 border-b text-right tabular-nums font-semibold ${sum(info.available) < 0 ? 'text-red-700' : sum(info.available) > 0 ? 'text-green-700' : ''}`}>
                            {sum(info.available)}
                          </td>
                        </tr>
                      ))}
                      {stockByColor.size > 1 && (
                        <tr className="bg-slate-100 font-semibold">
                          <td className="p-3 border-b">Total</td>
                          <td className="p-3 border-b text-right tabular-nums">
                            {Array.from(stockByColor.values()).reduce((acc, info) => acc + sum(info.stock), 0)}
                          </td>
                          <td className="p-3 border-b text-right tabular-nums text-red-600">
                            {(() => {
                              const total = Array.from(stockByColor.values()).reduce((acc, info) => acc + sum(info.soldSum), 0);
                              return total > 0 ? `-${total}` : '0';
                            })()}
                          </td>
                          <td className="p-3 border-b text-right tabular-nums text-green-600">
                            {Array.from(stockByColor.values()).reduce((acc, info) => acc + sum(info.purchaseSum), 0)}
                          </td>
                          <td className={`p-3 border-b text-right tabular-nums ${
                            (() => {
                              const total = Array.from(stockByColor.values()).reduce((acc, info) => acc + sum(info.available), 0);
                              return total < 0 ? 'text-red-700' : total > 0 ? 'text-green-700' : '';
                            })()
                          }`}>
                            {Array.from(stockByColor.values()).reduce((acc, info) => acc + sum(info.available), 0)}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-sm text-slate-500 py-4 text-center">No stock data available. Click &quot;Scrape Stock&quot; to fetch data.</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Colors Tab */}
        <TabsContent value="colors" className="space-y-4">
          {(colors ?? []).length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <div className="text-slate-500">No colors found yet. Click &quot;Scrape Stock&quot; to discover colors.</div>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Expand/Collapse Controls */}
              <div className="flex items-center justify-between">
                <div className="text-sm text-slate-600">
                  {(colors ?? []).length} color{(colors ?? []).length !== 1 ? 's' : ''} found
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={expandAllColors}
                    className="text-xs px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-50 transition-colors"
                  >
                    Expand All
                  </button>
                  <button 
                    onClick={collapseAllColors}
                    className="text-xs px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-50 transition-colors"
                  >
                    Collapse All
                  </button>
                </div>
              </div>

              {/* Color Cards */}
              <div className="space-y-3">
                {(colors ?? []).map((c) => {
                  const stockInfo = stockByColor.get(c.color.trim().toLowerCase());
                  const colorEans = eansByColor.get(c.color.trim().toLowerCase()) ?? [];
                  const seasonIds = colorSeasons?.map.get(c.id) || [];
                  const seasonLabels = seasonIds.map((id) => colorSeasons?.seasons.get(id)).filter(Boolean) as Array<{ name: string; year: number | null }>;
                  const isExpanded = expandedColors.has(c.id);

                  return (
                    <Card key={c.id} className={`transition-all ${c.inactive ? 'opacity-60' : ''}`}>
                      {/* Color Header - Always Visible */}
                      <button
                        onClick={() => toggleColorExpanded(c.id)}
                        className="w-full p-4 flex items-center justify-between text-left hover:bg-slate-50 transition-colors rounded-t-md"
                      >
                        <div className="flex items-center gap-4">
                          {c.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img 
                              src={c.image_url} 
                              alt={c.color} 
                              className="h-12 w-12 object-cover rounded border border-slate-200" 
                            />
                          ) : (
                            <div className="h-12 w-12 rounded border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center">
                              <span className="text-slate-400 text-[10px]">No img</span>
                            </div>
                          )}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-slate-900">{c.color}</span>
                              {c.is_noos && (
                                <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">NOOS</Badge>
                              )}
                              {c.inactive && (
                                <Badge className="bg-red-100 text-red-700 border-red-200">Inactive</Badge>
                              )}
                              {c.maybe_inactive && !c.inactive && (
                                <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200">Maybe Inactive</Badge>
                              )}
                              {c.visible === false && (
                                <Badge className="bg-slate-100 text-slate-700 border-slate-200">Hidden</Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-4 text-xs text-slate-500 mt-1">
                              {stockInfo && (
                                <span>Stock: {sum(stockInfo.stock)} | Net: {sum(stockInfo.available)}</span>
                              )}
                              {colorEans.length > 0 && (
                                <span>{colorEans.length} EAN{colorEans.length !== 1 ? 's' : ''}</span>
                              )}
                              {seasonLabels.length > 0 && (
                                <span>{seasonLabels.length} season{seasonLabels.length !== 1 ? 's' : ''}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <svg 
                            className={`w-5 h-5 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} 
                            fill="none" 
                            viewBox="0 0 24 24" 
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>

                      {/* Expanded Content */}
                      {isExpanded && (
                        <div className="border-t px-4 py-4 space-y-6">
                          {/* Seasons */}
                          <div>
                            <h4 className="text-sm font-medium text-slate-700 mb-2">Seasons</h4>
                            <div className="flex flex-wrap gap-1">
                              {seasonLabels.length === 0 ? (
                                <span className="text-xs text-slate-500">No seasons assigned</span>
                              ) : (
                                seasonLabels.map((s, i) => (
                                  <Badge key={i} className="bg-slate-100 text-slate-700 border-slate-200">
                                    {s.name}{s.year ? ` ${s.year}` : ''}
                                  </Badge>
                                ))
                              )}
                            </div>
                          </div>

                          {/* Stock Table */}
                          <div>
                            <h4 className="text-sm font-medium text-slate-700 mb-2">Stock by Size</h4>
                            {stockInfo && stockInfo.sizes.length > 0 ? (
                              <div className="overflow-x-auto border rounded-lg">
                                <table className="w-full text-xs">
                                  <thead className="bg-slate-50">
                                    <tr>
                                      <th className="p-2 text-left font-medium text-slate-700 border-b">Section</th>
                                      {stockInfo.sizes.map((size, i) => (
                                        <th key={i} className="p-2 text-right font-medium text-slate-700 border-b min-w-[50px]">{size}</th>
                                      ))}
                                      <th className="p-2 text-right font-semibold text-slate-900 border-b bg-slate-100">Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <tr>
                                      <td className="p-2 border-b font-medium">Stock</td>
                                      {stockInfo.stock.map((v, i) => (
                                        <td key={i} className="p-2 border-b text-right tabular-nums">{v}</td>
                                      ))}
                                      <td className="p-2 border-b text-right font-semibold tabular-nums bg-slate-50">{sum(stockInfo.stock)}</td>
                                    </tr>
                                    <tr>
                                      <td className="p-2 border-b font-medium">Sold</td>
                                      {stockInfo.soldSum.map((v, i) => (
                                        <td key={i} className="p-2 border-b text-right tabular-nums text-red-600">{v > 0 ? `-${v}` : '0'}</td>
                                      ))}
                                      <td className="p-2 border-b text-right font-semibold tabular-nums text-red-700 bg-slate-50">
                                        {sum(stockInfo.soldSum) > 0 ? `-${sum(stockInfo.soldSum)}` : '0'}
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="p-2 border-b font-medium">Purchase</td>
                                      {stockInfo.purchaseSum.map((v, i) => (
                                        <td key={i} className="p-2 border-b text-right tabular-nums text-green-600">{v}</td>
                                      ))}
                                      <td className="p-2 border-b text-right font-semibold tabular-nums text-green-700 bg-slate-50">{sum(stockInfo.purchaseSum)}</td>
                                    </tr>
                                    <tr className="bg-blue-50">
                                      <td className="p-2 font-semibold">Net Need</td>
                                      {stockInfo.available.map((v, i) => (
                                        <td key={i} className={`p-2 text-right font-semibold tabular-nums ${v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : ''}`}>{v}</td>
                                      ))}
                                      <td className={`p-2 text-right font-bold tabular-nums bg-blue-100 ${sum(stockInfo.available) < 0 ? 'text-red-700' : sum(stockInfo.available) > 0 ? 'text-green-700' : ''}`}>
                                        {sum(stockInfo.available)}
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="text-xs text-slate-500 py-2">No stock data available for this color</div>
                            )}
                          </div>

                          {/* EAN Table */}
                          <div>
                            <h4 className="text-sm font-medium text-slate-700 mb-2">EAN Codes</h4>
                            {colorEans.length > 0 ? (
                              <div className="overflow-x-auto border rounded-lg">
                                <table className="w-full text-xs">
                                  <thead className="bg-slate-50">
                                    <tr>
                                      <th className="p-2 text-left font-medium text-slate-700 border-b">Size</th>
                                      <th className="p-2 text-left font-medium text-slate-700 border-b">EAN Code</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {colorEans.map((ean, i) => (
                                      <tr key={i} className="hover:bg-slate-50">
                                        <td className="p-2 border-b font-medium">{ean.size}</td>
                                        <td className="p-2 border-b font-mono text-slate-600">{ean.ean}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="text-xs text-slate-500 py-2">No EAN codes. Run &quot;Scrape EANs&quot; job to populate.</div>
                            )}
                          </div>

                          {/* Action Buttons */}
                          {!has('sales') && (
                            <div className="flex gap-3 pt-2 border-t">
                              <button
                                onClick={() => toggleNoos(c)}
                                disabled={updatingColorId === c.id}
                                className={`flex-1 text-sm px-4 py-2.5 rounded-lg border font-medium transition-all ${
                                  updatingColorId === c.id
                                    ? 'bg-gray-100 text-gray-400 border-gray-300 cursor-not-allowed'
                                    : c.is_noos 
                                      ? 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100' 
                                      : 'bg-slate-50 text-slate-600 border-slate-300 hover:bg-slate-100'
                                }`}
                              >
                                {updatingColorId === c.id ? 'Updating...' : c.is_noos ? '✓ NOOS Item' : 'Mark as NOOS'}
                              </button>
                              
                              <button
                                onClick={() => toggleInactive(c)}
                                disabled={updatingColorId === c.id}
                                className={`flex-1 text-sm px-4 py-2.5 rounded-lg border font-medium transition-all ${
                                  updatingColorId === c.id
                                    ? 'bg-gray-100 text-gray-400 border-gray-300 cursor-not-allowed'
                                    : c.inactive 
                                      ? 'bg-green-50 text-green-700 border-green-300 hover:bg-green-100' 
                                      : 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100'
                                }`}
                              >
                                {updatingColorId === c.id ? 'Updating...' : c.inactive ? 'Activate Color' : 'Set Inactive'}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

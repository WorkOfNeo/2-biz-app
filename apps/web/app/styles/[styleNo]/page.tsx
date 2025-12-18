'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRoles } from '../../../lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs';
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

export default function StyleDetailPage({ params }: { params: { styleNo: string } }) {
  const supabase = createClientComponentClient();
  const router = useRouter();
  const styleNo = decodeURIComponent(params.styleNo);
  const [updatingColorId, setUpdatingColorId] = React.useState<string | null>(null);
  const [scraping, setScraping] = React.useState<boolean>(false);
  const [scrapeMessage, setScrapeMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const { data: meta, mutate: mutateMeta } = useSWR(['style:meta', styleNo], async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url, link_href, updated_at')
      .eq('style_no', styleNo)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null; link_href: string | null; updated_at: string } | null;
  });

  const { data: colors, mutate: mutateColors } = useSWR(['style:colors', styleNo, meta?.id], async () => {
    if (!meta?.id) return [] as Array<{ id: string; color: string; maybe_inactive: boolean; inactive: boolean; is_noos: boolean; updated_at: string | null }>;
    const { data, error } = await supabase
      .from('style_colors')
      .select('id, color, maybe_inactive, inactive, is_noos, updated_at')
      .eq('style_id', meta.id)
      .order('color');
    if (error) throw error as any;
    return (data ?? []) as Array<{ id: string; color: string; maybe_inactive: boolean; inactive: boolean; is_noos: boolean; updated_at: string | null }>;
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

      // Enqueue scrape job for this style
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

      // Poll for job completion
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
              // Refresh stock data and colors (colors are created during stock scraping)
              await mutateStockData();
              await mutateColors();
              // Clear message after 3 seconds
              setTimeout(() => setScrapeMessage(null), 3000);
            } else {
              setScrapeMessage({ type: 'error', text: `Job ${jobData.status}. Check the Jobs page for details.` });
            }
          }
        } catch (err) {
          console.error('Error polling job status:', err);
        }
      }, 2000); // Poll every 2 seconds

      // Stop polling after 5 minutes
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
    
    // Deduplicate and aggregate per color
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

  const getTabColor = (color: { maybe_inactive: boolean; inactive: boolean }) => {
    if (color.inactive) return 'bg-red-100 text-red-900 data-[state=active]:bg-red-200';
    if (color.maybe_inactive) return 'bg-yellow-100 text-yellow-900 data-[state=active]:bg-yellow-200';
    return '';
  };

  return (
    <div className="space-y-4 w-full max-w-full overflow-hidden">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          {meta?.image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={meta.image_url} alt={meta.style_name ?? meta.style_no} className="h-24 w-24 object-cover rounded border" />
          )}
          <div>
            <div className="text-xs text-gray-500">Style</div>
            <h1 className="text-xl font-semibold">{styleNo}</h1>
            <div className="text-sm text-gray-700">{meta?.style_name ?? '—'}</div>
            {meta?.supplier && <div className="text-xs text-gray-500">Supplier: {meta.supplier}</div>}
            {meta?.link_href && (() => {
              const SPY_BASE_URL = 'https://2-biz.spysystem.dk';
              try {
                const url = new URL(meta.link_href, SPY_BASE_URL).toString();
                const statUrl = url.replace(/#.*$/, '') + '#tab=statandstock';
                return (
                  <div className="flex items-center gap-3 mt-1">
                    <a className="text-xs underline text-slate-700" href={url} target="_blank" rel="noopener noreferrer">Open in 2-Biz</a>
                    <a className="text-xs underline text-slate-700" href={statUrl} target="_blank" rel="noopener noreferrer">Stat & Stock</a>
                  </div>
                );
              } catch { return null; }
            })()}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            onClick={scrapeThisStyle}
            disabled={scraping}
            title="Scrape stock data for this style"
          >
            {scraping ? 'Scraping...' : 'Scrape Stock'}
          </button>
          {has('admin') && (
            <button
              className="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700"
              onClick={onDelete}
              title="Permanently delete this style"
            >
              Permanently Delete
            </button>
          )}
        </div>
      </div>

      {/* Scrape message */}
      {scrapeMessage && (
        <div className={`rounded border px-3 py-2 text-sm ${
          scrapeMessage.type === 'success' 
            ? 'bg-green-50 text-green-700 border-green-200' 
            : 'bg-red-50 text-red-700 border-red-200'
        }`}>
          {scrapeMessage.text}
        </div>
      )}

      <div className="rounded-md border bg-white p-4 w-full overflow-hidden">
        {(colors ?? []).length === 0 ? (
          <div className="text-sm text-gray-500">No colors found yet.</div>
        ) : (
          <Tabs defaultValue={(colors ?? [])[0]?.id} className="w-full">
            <div className="w-full overflow-x-auto -mx-4 px-4 mb-4 scrollbar-thin">
              <TabsList className="inline-flex">
                {(colors ?? []).map((c) => (
                  <TabsTrigger key={c.id} value={c.id} className={getTabColor(c)}>
                    {c.color}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            
            {(colors ?? []).map((c) => {
              const stockInfo = stockByColor.get(c.color.trim().toLowerCase());
              const seasonIds = colorSeasons?.map.get(c.id) || [];
              const seasonLabels = seasonIds.map((id) => colorSeasons?.seasons.get(id)).filter(Boolean) as Array<{ name: string; year: number | null }>;
              const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
              
              return (
                <TabsContent key={c.id} value={c.id} className="w-full">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
                    {/* Left Column: Stock Data */}
                    <div className="space-y-2 min-w-0">
                      <h3 className="text-sm font-semibold mb-3">Stock Information</h3>
                      {stockInfo ? (
                        <div className="overflow-x-auto border rounded">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="p-2 text-left border-b">Section</th>
                                {stockInfo.sizes.map((size, i) => (
                                  <th key={i} className="p-2 text-right border-b">{size}</th>
                                ))}
                                <th className="p-2 text-right border-b font-semibold">Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr>
                                <td className="p-2 border-b">Stock</td>
                                {stockInfo.stock.map((v, i) => (
                                  <td key={i} className="p-2 border-b text-right">{v}</td>
                                ))}
                                <td className="p-2 border-b text-right font-medium">{sum(stockInfo.stock)}</td>
                              </tr>
                              <tr>
                                <td className="p-2 border-b">Sold</td>
                                {stockInfo.soldSum.map((v, i) => (
                                  <td key={i} className="p-2 border-b text-right text-red-600">{v > 0 ? `-${v}` : v}</td>
                                ))}
                                <td className="p-2 border-b text-right font-medium text-red-700">{sum(stockInfo.soldSum) > 0 ? `-${sum(stockInfo.soldSum)}` : sum(stockInfo.soldSum)}</td>
                              </tr>
                              <tr>
                                <td className="p-2 border-b">Purchase Orders</td>
                                {stockInfo.purchaseSum.map((v, i) => (
                                  <td key={i} className="p-2 border-b text-right text-green-700">{v}</td>
                                ))}
                                <td className="p-2 border-b text-right font-medium text-green-800">{sum(stockInfo.purchaseSum)}</td>
                              </tr>
                              <tr className="bg-blue-50">
                                <td className="p-2 font-semibold">Net Need</td>
                                {stockInfo.available.map((v, i) => (
                                  <td key={i} className={`p-2 text-right font-semibold ${v < 0 ? 'text-red-700' : v > 0 ? 'text-green-800' : ''}`}>{v}</td>
                                ))}
                                <td className={`p-2 text-right font-semibold ${sum(stockInfo.available) < 0 ? 'text-red-700' : sum(stockInfo.available) > 0 ? 'text-green-800' : ''}`}>{sum(stockInfo.available)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="text-xs text-gray-500">No stock data available for this color.</div>
                      )}
                    </div>

                    {/* Right Column: Metadata */}
                    <div className="space-y-4 min-w-0">
                      <div>
                        <h3 className="text-sm font-semibold mb-2">Seasons</h3>
                        <div className="flex flex-wrap gap-1">
                          {seasonLabels.length === 0 ? (
                            <span className="text-[11px] text-gray-500">No seasons assigned yet.</span>
                          ) : (
                            seasonLabels.map((s, i) => (
                              <span key={i} className="inline-flex items-center rounded border px-2 py-1 text-[11px] bg-gray-50">
                                {s.name}{s.year ? ` ${s.year}` : ''}
                              </span>
                            ))
                          )}
                        </div>
                      </div>

                      <div>
                        <h3 className="text-sm font-semibold mb-2">EAN Codes</h3>
                        {eans && eans.length > 0 ? (
                          <div className="overflow-x-auto border rounded">
                            <table className="w-full text-xs">
                              <thead className="bg-gray-50">
                                <tr>
                                  <th className="p-2 text-left border-b">Color</th>
                                  <th className="p-2 text-left border-b">Size</th>
                                  <th className="p-2 text-left border-b font-mono">EAN</th>
                                </tr>
                              </thead>
                              <tbody>
                                {eans.map((ean, i) => (
                                  <tr key={i}>
                                    <td className="p-2 border-b">{ean.color}</td>
                                    <td className="p-2 border-b">{ean.size}</td>
                                    <td className="p-2 border-b font-mono">{ean.ean}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {eans.length > 0 && (
                              <div className="p-2 text-xs text-gray-500 border-t bg-gray-50">
                                {eans.length} EAN code{eans.length !== 1 ? 's' : ''} • Last scraped: {eans[0]?.scraped_at ? new Date(eans[0].scraped_at).toLocaleString() : '—'}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-xs text-gray-500">No EAN codes found. Run "Scrape EANs" job to populate.</div>
                        )}
                      </div>

                      {!has('sales') && (
                        <div className="space-y-2">
                          {/* NOOS Toggle */}
                          <button
                            onClick={async () => {
                              try {
                                setUpdatingColorId(c.id);
                                const newNoos = !c.is_noos;
                                
                                // Optimistic update
                                mutateColors((current) => {
                                  if (!current) return current;
                                  return current.map(color => 
                                    color.id === c.id 
                                      ? { ...color, is_noos: newNoos } 
                                      : color
                                  );
                                }, false);
                                
                                // Update database
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
                            }}
                            disabled={updatingColorId === c.id}
                            className={`w-full text-sm px-4 py-2 rounded border font-medium transition-colors ${
                              updatingColorId === c.id
                                ? 'bg-gray-100 text-gray-400 border-gray-300 cursor-not-allowed'
                                : c.is_noos 
                                  ? 'bg-[#8FA894]/20 text-[#8FA894] border-[#8FA894] hover:bg-[#8FA894]/30' 
                                  : 'bg-slate-50 text-slate-600 border-slate-300 hover:bg-slate-100'
                            }`}
                          >
                            {updatingColorId === c.id 
                              ? 'Updating...' 
                              : c.is_noos 
                                ? '✓ NOOS Item' 
                                : 'Mark as NOOS'
                            }
                          </button>
                          
                          {/* Inactive Toggle */}
                          <button
                            onClick={async () => {
                              try {
                                setUpdatingColorId(c.id);
                                const newInactive = !c.inactive;
                                
                                // Optimistic update
                                mutateColors((current) => {
                                  if (!current) return current;
                                  return current.map(color => 
                                    color.id === c.id 
                                      ? { ...color, inactive: newInactive } 
                                      : color
                                  );
                                }, false);
                                
                                // Update database
                                const { error } = await supabase
                                  .from('style_colors')
                                  .update({ inactive: newInactive })
                                  .eq('id', c.id);
                                
                                if (error) throw error;
                                
                                // Revalidate to ensure we have server truth
                                await mutateColors();
                                
                                // Show success feedback
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
                                // Revalidate on error to restore correct state
                                await mutateColors();
                              } finally {
                                setUpdatingColorId(null);
                              }
                            }}
                            disabled={updatingColorId === c.id}
                            className={`w-full text-sm px-4 py-2 rounded border font-medium transition-colors ${
                              updatingColorId === c.id
                                ? 'bg-gray-100 text-gray-400 border-gray-300 cursor-not-allowed'
                                : c.inactive 
                                  ? 'bg-green-50 text-green-700 border-green-300 hover:bg-green-100' 
                                  : 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100'
                            }`}
                          >
                            {updatingColorId === c.id 
                              ? 'Updating...' 
                              : c.inactive 
                                ? 'Activate Color' 
                                : 'Set Color as Inactive'
                            }
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>
              );
            })}
          </Tabs>
        )}
      </div>
    </div>
  );
}

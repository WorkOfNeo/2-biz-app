'use client';
import { useState, useMemo } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import useSWR from 'swr';
import { SearchSelect } from '../../components/SearchSelect';
import { Button } from '../../components/ui/button';

export default function StylesPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [q, setQ] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [supplierInvert, setSupplierInvert] = useState(false);
  const [stockAllZerosFilter, setStockAllZerosFilter] = useState<boolean | null>(null);
  const [seasonFilter, setSeasonFilter] = useState('');
  const [seasonInvert, setSeasonInvert] = useState(false);
  const [settingInactive, setSettingInactive] = useState(false);
  const [updatingStyleId, setUpdatingStyleId] = useState<string | null>(null);
  const supabase = createClientComponentClient();

  // Fetch seasons for dropdown
  const { data: seasons } = useSWR('seasons:list', async () => {
    const { data, error } = await supabase
      .from('seasons')
      .select('id, name, year')
      .order('year', { ascending: false })
      .order('name', { ascending: true });
    if (error) throw error;
    return data;
  });

  const { data: rows, mutate } = useSWR(['styles:list', q, supplierFilter, supplierInvert, stockAllZerosFilter, seasonFilter, seasonInvert], async () => {
    // Build base query
    let baseQuery = supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url, link_href, maybe_inactive, inactive, stock_all_zeros, missing_from_spy, needs_enrichment, dg')
      .order('updated_at', { ascending: false });
    
    // Search in both style_no and style_name
    if (q && q.trim().length > 0) {
      const searchTerm = `%${q.trim()}%`;
      baseQuery = baseQuery.or(`style_no.ilike.${searchTerm},style_name.ilike.${searchTerm}`);
    }
    
    // Filter by supplier
    if (supplierFilter && supplierFilter.trim().length > 0) {
      if (supplierInvert) {
        baseQuery = baseQuery.neq('supplier', supplierFilter);
      } else {
        baseQuery = baseQuery.eq('supplier', supplierFilter);
      }
    }
    
    // Filter by stock_all_zeros
    if (stockAllZerosFilter !== null) {
      baseQuery = baseQuery.eq('stock_all_zeros', stockAllZerosFilter);
    }
    
    // Paginate to get all rows (Supabase default limit is ~1000, so we'll paginate)
    const pageSize = 1000;
    const cap = 50000; // avoid runaway
    let from = 0;
    const allRows: any[] = [];
    
    while (from < cap) {
      const to = from + pageSize - 1;
      const { data, error } = await baseQuery.range(from, to);
      if (error) throw new Error(error.message);
      const batch = data ?? [];
      allRows.push(...batch);
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    
    // Filter by season on client-side (requires joining with style_colors and style_color_seasons)
    let filtered = allRows;
    if (seasonFilter && seasonFilter.trim().length > 0) {
      // Get style IDs that have colors in the selected season
      const { data: styleColorSeasons } = await supabase
        .from('style_color_seasons')
        .select('style_color_id')
        .eq('season_id', seasonFilter);
      
      if (styleColorSeasons && styleColorSeasons.length > 0) {
        const styleColorIds = styleColorSeasons.map(s => s.style_color_id);
        
        const { data: styleColors } = await supabase
          .from('style_colors')
          .select('style_id')
          .in('id', styleColorIds);
        
        if (styleColors && styleColors.length > 0) {
          const styleIds = new Set(styleColors.map(sc => sc.style_id));
          // Invert logic if seasonInvert is true
          if (seasonInvert) {
            filtered = allRows.filter(r => !styleIds.has(r.id));
          } else {
            filtered = allRows.filter(r => styleIds.has(r.id));
          }
        } else {
          // No styles found with this season
          filtered = seasonInvert ? allRows : [];
        }
      } else {
        // No color-season mappings found
        filtered = seasonInvert ? allRows : [];
      }
    }
    
    return filtered;
  });

  // Get unique suppliers for the dropdown
  const supplierOptions = useMemo(() => {
    const suppliers = new Set<string>();
    (rows ?? []).forEach((r) => {
      if (r.supplier && r.supplier.trim()) {
        suppliers.add(r.supplier.trim());
      }
    });
    return Array.from(suppliers)
      .sort((a, b) => a.localeCompare(b))
      .map((s) => ({ value: s, label: s }));
  }, [rows]);

  // Season options for dropdown with year
  const seasonOptions = useMemo(() => {
    return (seasons ?? []).map((s) => {
      // Use the year field directly
      const year = s.year ? String(s.year) : '';
      
      // Combine name with year if year exists and not already in name
      const label = year && !s.name.includes(year) ? `${s.name} ${year}` : s.name;
      return { value: s.id, label };
    });
  }, [seasons]);

  // "Set all visible to Inactive" function
  async function setAllVisibleInactive() {
    if (!rows || rows.length === 0) {
      alert('No styles to set inactive');
      return;
    }
    
    const activeRows = rows.filter(r => !r.inactive);
    if (activeRows.length === 0) {
      alert('All visible styles are already inactive');
      return;
    }
    
    if (!confirm(`⚠️ Are you sure you want to set ${activeRows.length} visible ACTIVE styles to INACTIVE?\n\nThis will prevent them from being scraped in future runs.\n\n${rows.length - activeRows.length} styles are already inactive and will not be affected.`)) return;
    
    setSettingInactive(true);
    try {
      console.log('[styles] Setting multiple styles to inactive:', activeRows.map(r => r.style_no));
      const styleIds = activeRows.map(r => r.id);
      
      const { data, error } = await supabase
        .from('styles')
        .update({ inactive: true })
        .in('id', styleIds)
        .select();
      
      if (error) {
        console.error('[styles] Bulk update error:', error);
        throw error;
      }
      
      console.log('[styles] Bulk update successful:', data);
      await mutate();
      alert(`✓ Successfully set ${styleIds.length} styles to INACTIVE\n\nThese styles will now be skipped in all future scraping runs.`);
    } catch (err: any) {
      console.error('[styles] Bulk update failed:', err);
      alert(`❌ Failed to set styles inactive:\n\n${err?.message || 'Unknown error'}\n\nDetails: ${JSON.stringify(err, null, 2)}`);
    } finally {
      setSettingInactive(false);
    }
  }

  async function enqueueUpdate() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ type: 'scrape_styles', payload: { requestedBy: session.user.email } })
      });
      const js = await res.json().catch(() => ({}));
      // eslint-disable-next-line no-console
      console.log('[styles] enqueue', res.status, js);
      try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('job-started', { detail: { label: 'Update styles — job started' } })); } catch {}
      setMenuOpen(false);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[styles] enqueue error', e);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Styles</div>
          <h1 className="text-xl font-semibold">STYLES</h1>
        </div>
        <div className="relative">
          <button className="p-1 rounded hover:bg-gray-100" onClick={() => setMenuOpen((v) => !v)}>
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-44 rounded-md border bg-white shadow">
              <button className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50" onClick={enqueueUpdate}>Update styles</button>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-white p-3 text-sm">
        <div className="mb-3 flex items-center gap-3 flex-wrap">
          <input 
            value={q} 
            onChange={(e) => setQ(e.target.value)} 
            placeholder="Search style no or name..." 
            className="border rounded p-2 text-sm w-64" 
          />
          <div className="flex items-center gap-1">
            <SearchSelect
              items={supplierOptions}
              value={supplierFilter}
              onChange={setSupplierFilter}
              placeholder="Filter by supplier..."
              clearable={true}
            />
            {supplierFilter && (
              <label className="flex items-center gap-1 text-xs whitespace-nowrap cursor-pointer">
                <input
                  type="checkbox"
                  checked={supplierInvert}
                  onChange={(e) => setSupplierInvert(e.target.checked)}
                  className="h-3 w-3 rounded"
                />
                <span>NOT</span>
              </label>
            )}
          </div>
          <div className="flex items-center gap-1">
            <SearchSelect
              items={seasonOptions}
              value={seasonFilter}
              onChange={setSeasonFilter}
              placeholder="Filter by season..."
              clearable={true}
            />
            {seasonFilter && (
              <label className="flex items-center gap-1 text-xs whitespace-nowrap cursor-pointer">
                <input
                  type="checkbox"
                  checked={seasonInvert}
                  onChange={(e) => setSeasonInvert(e.target.checked)}
                  className="h-3 w-3 rounded"
                />
                <span>NOT</span>
              </label>
            )}
          </div>
          <label className="flex items-center gap-2 border rounded px-3 py-2 cursor-pointer hover:bg-gray-50">
            <input
              type="checkbox"
              checked={stockAllZerosFilter === true}
              onChange={(e) => setStockAllZerosFilter(e.target.checked ? true : null)}
              className="h-4 w-4 rounded"
            />
            <span className="text-sm">Stock All Zeros</span>
          </label>
          <Button 
            onClick={setAllVisibleInactive}
            disabled={settingInactive || !rows || rows.length === 0}
            variant="destructive"
            size="sm"
          >
            {settingInactive ? 'Setting Inactive...' : 'Set All Visible to Inactive'}
          </Button>
          {(q || supplierFilter || seasonFilter || stockAllZerosFilter !== null) && (
            <div className="text-xs text-gray-500">
              Found {(rows ?? []).length} style{(rows ?? []).length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
        <div className="overflow-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2 border-b">Image</th>
                <th className="text-left p-2 border-b">Style No.</th>
                <th className="text-left p-2 border-b">Style Name</th>
                <th className="text-left p-2 border-b">Supplier</th>
                <th className="text-left p-2 border-b">DG</th>
                <th className="text-left p-2 border-b">Stock All Zeros</th>
                <th className="text-left p-2 border-b">Missing from SPY</th>
                <th className="text-left p-2 border-b">Status</th>
                <th className="text-left p-2 border-b">Link</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={9} className="p-4 text-center text-gray-500">
                    No styles found. {(q || supplierFilter || seasonFilter || stockAllZerosFilter !== null) ? 'Try adjusting your filters.' : ''}
                  </td>
                </tr>
              )}
              {(rows ?? []).map((r) => (
                <tr
                  key={r.style_no}
                  className={`transition-colors ${r.inactive ? 'bg-red-100 opacity-70' : 'hover:bg-gray-50'}`}
                >
                  <td className="p-2 border-b cursor-pointer" onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>
                    <div className={r.inactive ? 'opacity-50 grayscale' : ''}>
                      {r.image_url ? <img src={r.image_url} alt="thumb" className="h-8 w-8 object-cover rounded" /> : null}
                    </div>
                  </td>
                  <td className={`p-2 border-b underline cursor-pointer ${r.inactive ? 'text-red-700 line-through' : 'text-slate-700'}`} onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>{r.style_no}</td>
                  <td className={`p-2 border-b cursor-pointer ${r.inactive ? 'text-gray-500 line-through' : ''}`} onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>{r.style_name ?? '—'}</td>
                  <td className={`p-2 border-b cursor-pointer ${r.inactive ? 'text-gray-500' : ''}`} onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>{r.supplier ?? '—'}</td>
                  <td className={`p-2 border-b cursor-pointer ${r.inactive ? 'text-gray-500' : ''}`} onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>{r.dg ?? '—'}</td>
                  <td className="p-2 border-b cursor-pointer" onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>
                    {r.stock_all_zeros ? (
                      <span className="text-red-600 font-medium">Yes</span>
                    ) : (
                      <span className="text-gray-400">No</span>
                    )}
                  </td>
                  <td className="p-2 border-b cursor-pointer" onClick={() => { window.location.href = `/styles/${encodeURIComponent(r.style_no)}`; }}>
                    {r.missing_from_spy ? (
                      <span className="text-red-600 font-medium">Yes</span>
                    ) : (
                      <span className="text-gray-400">No</span>
                    )}
                  </td>
                  <td className="p-2 border-b">
                    <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                        {r.inactive ? (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              setUpdatingStyleId(r.id);
                              try {
                                console.log('[styles] Setting style to ACTIVE:', r.id, r.style_no);
                                const { data, error } = await supabase
                                  .from('styles')
                                  .update({ inactive: false })
                                  .eq('id', r.id)
                                  .select();
                                
                                if (error) {
                                  console.error('[styles] Supabase error:', error);
                                  alert(`Failed to activate style: ${error.message}\n\nDetails: ${JSON.stringify(error, null, 2)}`);
                                  return;
                                }
                                
                                console.log('[styles] Update successful:', data);
                                await mutate();
                                alert(`✓ Style ${r.style_no} is now ACTIVE and will be scraped`);
                              } catch (err: any) {
                                console.error('[styles] Failed to toggle inactive', err);
                                alert(`Error: ${err?.message || 'Unknown error occurred'}`);
                              } finally {
                                setUpdatingStyleId(null);
                              }
                            }}
                            disabled={updatingStyleId === r.id}
                            className="text-xs px-3 py-1.5 rounded border bg-green-50 text-green-700 border-green-300 hover:bg-green-100 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {updatingStyleId === r.id ? '⏳ Updating...' : '✓ Set Active'}
                          </button>
                        ) : (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                              if (!confirm(`Set style ${r.style_no} to INACTIVE?\n\nThis will prevent it from being scraped in future runs.`)) return;
                              setUpdatingStyleId(r.id);
                              try {
                                console.log('[styles] Setting style to INACTIVE:', r.id, r.style_no);
                                const { data, error } = await supabase
                                  .from('styles')
                                  .update({ inactive: true })
                                  .eq('id', r.id)
                                  .select();
                                
                                if (error) {
                                  console.error('[styles] Supabase error:', error);
                                  alert(`Failed to set inactive: ${error.message}\n\nDetails: ${JSON.stringify(error, null, 2)}`);
                                  return;
                                }
                                
                                console.log('[styles] Update successful:', data);
                            await mutate();
                                alert(`✓ Style ${r.style_no} is now INACTIVE and will be skipped in scraping`);
                              } catch (err: any) {
                                console.error('[styles] Failed to toggle inactive', err);
                                alert(`Error: ${err?.message || 'Unknown error occurred'}`);
                              } finally {
                                setUpdatingStyleId(null);
                              }
                            }}
                            disabled={updatingStyleId === r.id}
                            className="text-xs px-3 py-1.5 rounded border bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                            {updatingStyleId === r.id ? '⏳ Setting...' : 'Set Inactive'}
                      </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {r.maybe_inactive && !r.inactive && <span className="text-[10px] px-1.5 py-0.5 bg-yellow-100 text-yellow-800 rounded">Maybe Inactive</span>}
                        {r.needs_enrichment && <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded" title="Needs enrichment - will be processed by enrich_styles job">Needs Enrichment</span>}
                      </div>
                    </div>
                  </td>
                  <td className="p-2 border-b">{r.link_href ? <a className="underline" href={r.link_href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

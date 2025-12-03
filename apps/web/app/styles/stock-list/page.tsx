"use client";
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import React from 'react';
import { useRoles } from '../../../lib/supabaseClient';
import { MultiSelect } from '../../../components/MultiSelect';
import { ProgressBar } from '../../../components/ProgressBar';
import { Card, CardContent } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { Button } from '../../../components/ui/button';

type Row = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  po_link: string | null;
  scraped_at: string;
};

export default function StockListPage() {
  const supabase = createClientComponentClient();
  const { has } = useRoles();
  // Preselect previously active list if stored by Settings → Stock Lists tab
  const [activeListId, setActiveListId] = React.useState<string>('');
  React.useEffect(() => {
    try {
      const v = localStorage.getItem('activeStockListId') || '';
      if (v) setActiveListId(v);
    } catch {}
  }, []);
  const [searchQuery, setSearchQuery] = React.useState<string>('');
  const [scrapeBusy, setScrapeBusy] = React.useState<string | null>(null);
  const [selectedSeasons, setSelectedSeasons] = React.useState<string[]>([]);
  const [hideZeros, setHideZeros] = React.useState<boolean>(false);
  const [loadingProgress, setLoadingProgress] = React.useState<{ total: number; current: number } | null>(null);
  const { data } = useSWR('style_stock:list', async () => {
    // First, get the total count
    const { count, error: countError } = await supabase
      .from('style_stock')
      .select('*', { count: 'exact', head: true });
    if (countError) throw new Error(countError.message);
    const totalCount = count ?? 0;
    
    setLoadingProgress({ total: totalCount, current: 0 });
    
    const pageSize = 1000; // Match Supabase's default limit
    const cap = 50000; // avoid runaway
    let from = 0;
    const rows: any[] = [];
    
    while (from < cap) {
      const to = from + pageSize - 1;
      const { data, error } = await supabase
        .from('style_stock')
        .select('style_no, color, sizes, section, row_label, values, po_link, scraped_at')
        .order('scraped_at', { ascending: false })
        .range(from, to);
      if (error) throw new Error(error.message);
      const batch = data ?? [];
      rows.push(...batch);
      
      // Update progress
      setLoadingProgress({ total: totalCount, current: rows.length });
      
      // Break if we got fewer rows than requested (end of data)
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    
    setLoadingProgress(null); // Clear progress when done
    return rows as Row[];
  }, { refreshInterval: 30000 });

  // Collect distinct style numbers from current data
  const styleNos = React.useMemo(() => Array.from(new Set((data ?? []).map((r) => r.style_no))), [data]);
  // Lookup style names/images for those style numbers
  const { data: styleRows } = useSWR(styleNos.length ? ['styles:byNo', styleNos.join(',')] : null, async () => {
    const { data: rows, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url, dg, link_href')
      .in('style_no', styleNos);
    if (error) throw new Error(error.message);
    return rows as Array<{ id: string; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null; dg?: string | null; link_href?: string | null }>;
  }, { refreshInterval: 0 });
  const styleMetaByNo = React.useMemo(() => {
    const m: Record<string, { id: string | null; name: string | null; supplier: string | null; image: string | null; dg?: string | null; link_href?: string | null }> = {};
    for (const r of (styleRows ?? []) as any[]) {
      m[r.style_no] = { id: r.id || null, name: r.style_name || null, supplier: r.supplier || null, image: r.image_url || null, dg: (r as any).dg ?? null, link_href: (r as any).link_href ?? null };
    }
    return m;
  }, [styleRows]);
  const styleIds = React.useMemo(() => (styleRows ?? []).map((r: any) => r.id as string).filter(Boolean), [styleRows]);

  // Seasons list for chips and selector
  const { data: seasons } = useSWR('seasons:list', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year').order('year', { ascending: false }).order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string; year: number | null }>;
  }, { refreshInterval: 0 });

  // Colors → ids for seasons mapping (including inactive flags)
  const { data: styleColors, mutate: mutateStyleColors } = useSWR(styleIds.length ? ['style_colors:ids', styleIds.join(',')] : null, async () => {
    const { data, error } = await supabase.from('style_colors').select('id, style_id, color, maybe_inactive, inactive').in('style_id', styleIds);
    if (error) throw new Error(error.message);
    const map = new Map<string, Map<string, string>>(); // style_id -> (colorLower -> style_color_id)
    const statusMap = new Map<string, { maybe_inactive: boolean; inactive: boolean }>(); // style_color_id -> status
    for (const r of (data ?? []) as any[]) {
      const sid = String(r.style_id || '');
      const ckey = String(r.color || '').trim().toLowerCase();
      if (!map.has(sid)) map.set(sid, new Map());
      map.get(sid)!.set(ckey, r.id as string);
      statusMap.set(r.id as string, { maybe_inactive: r.maybe_inactive || false, inactive: r.inactive || false });
    }
    return { idMap: map, statusMap };
  }, { refreshInterval: 0 });

  // DB-backed stock lists (lists, styles, and per-list color exclusions)
  const { data: stockLists } = useSWR('stock-lists:all', async () => {
    const { data, error } = await supabase.from('stock_lists').select('id, name').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string }>;
  });
  const { data: listStyles } = useSWR(activeListId ? ['stock-list-styles:byList', activeListId] : null, async () => {
    const { data, error } = await supabase.from('stock_list_styles').select('style_id').eq('list_id', activeListId);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ style_id: string }>;
  });
  const styleIdsInList = React.useMemo(() => new Set((listStyles ?? []).map(r => r.style_id)), [listStyles]);
  const { data: listColorRules } = useSWR(activeListId ? ['stock_list_colors:byList', activeListId] : null, async () => {
    const { data, error } = await supabase.from('stock_list_colors').select('style_id, style_color_id, include').eq('list_id', activeListId);
    if (error) throw new Error(error.message);
    // Blacklist model: hiddenIdsMap holds color IDs where include === false
    const hiddenIdsMap = new Map<string, Set<string>>(); // style_id -> set(style_color_id)
    for (const r of (data ?? []) as any[]) {
      const sid = String(r.style_id || '');
      if (r.include === false) {
        const set = hiddenIdsMap.get(sid) || new Set<string>();
        set.add(String(r.style_color_id || ''));
        hiddenIdsMap.set(sid, set);
      }
    }
    // Build reverse map: style_id -> (style_color_id -> colorLower)
    const invertByStyle = new Map<string, Map<string, string>>();
    for (const sid of styleIds) {
      const cmap = styleColors?.idMap?.get(sid) || new Map<string, string>();
      const inv = new Map<string, string>();
      for (const [ck, id] of Array.from(cmap.entries())) inv.set(id, ck);
      invertByStyle.set(sid, inv);
    }
    return { hiddenIdsMap, invertByStyle } as { hiddenIdsMap: Map<string, Set<string>>; invertByStyle: Map<string, Map<string, string>> };
  }, { refreshInterval: 0 });

  // Removed per-user selection and view toggles

  type Group = {
    styleNo: string;
    color: string;
    sizes: string[];
    stock: number[];
    soldSum: number[];
    purchaseSum: number[];
    available: number[];
    soldRows: Row[];
    purchaseRows: Row[];
    scrapedAt: string;
  };
  const ensureNums = (arr: any[], len: number) => Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);
  const groups: Group[] = React.useMemo(() => {
    const res: Group[] = [];
    // Build map style->color->rows and pick latest per (section,row_label)
    const byStyle = new Map<string, Map<string, Row[]>>();
    for (const r of (data ?? [])) {
      if (!byStyle.has(r.style_no)) byStyle.set(r.style_no, new Map());
      const byColor = byStyle.get(r.style_no)!;
      if (!byColor.has(r.color)) byColor.set(r.color, []);
      byColor.get(r.color)!.push(r);
    }
    for (const [styleNo, byColor] of byStyle.entries()) {
      for (const [color, rows] of byColor.entries()) {
        if (rows.length === 0) continue;
        // latest per (section,row_label)
        const latestMap = new Map<string, Row>();
        let uniqueIdCounter = 0;
        
        for (const r of rows) {
          const normalizedLabel = String(r.row_label ?? '').trim();
          
          if (normalizedLabel) {
            // Has a PO number: deduplicate by keeping only latest scraped_at for this PO
            const key = `${r.section}|${normalizedLabel}`;
            const curr = latestMap.get(key);
            if (!curr || new Date(r.scraped_at).getTime() > new Date(curr.scraped_at).getTime()) {
              latestMap.set(key, r);
            }
          } else {
            // No PO number (NULL/empty): treat each row as a unique unnamed PO
            // Use a unique counter to ensure each gets summed
            latestMap.set(`${r.section}|__unnamed_${uniqueIdCounter++}`, r);
          }
        }
        const latestRows = Array.from(latestMap.values());
        const sizes = (latestRows.find(r => r.section === 'Stock') || latestRows[0] || rows[0])?.sizes || [];
        const num = sizes.length;
        const zero = Array.from({ length: num }, () => 0);
        const stockRow = latestRows.find(r => r.section === 'Stock');
        const stock = stockRow ? ensureNums(Array.isArray(stockRow.values) ? (stockRow.values as any[]) : JSON.parse(String(stockRow.values || '[]')), num) : zero.slice();
        const soldRows = latestRows.filter(r => r.section === 'Sold');
        const purchaseRows = latestRows.filter(r => r.section === 'Purchase (Running + Shipped)');
        const soldSum = soldRows.reduce((acc, r) => {
          const vals = ensureNums(Array.isArray(r.values) ? (r.values as any[]) : JSON.parse(String(r.values || '[]')), num);
          return acc.map((v, i) => v + (vals[i] ?? 0));
        }, zero.slice());
        const purchaseSum = purchaseRows.reduce((acc, r) => {
          const vals = ensureNums(Array.isArray(r.values) ? (r.values as any[]) : JSON.parse(String(r.values || '[]')), num);
          return acc.map((v, i) => v + (vals[i] ?? 0));
        }, zero.slice());
        const available = stock.map((v, i) => v - (soldSum[i] ?? 0) + (purchaseSum[i] ?? 0));
        const latestAt = latestRows.reduce((max, r) => (new Date(r.scraped_at).getTime() > new Date(max).getTime() ? r.scraped_at : max), latestRows[0]?.scraped_at || new Date(0).toISOString());
        res.push({ styleNo, color, sizes, stock, soldSum, purchaseSum, available, soldRows, purchaseRows, scrapedAt: latestAt });
      }
    }
    // Sort by style then color for deterministic order
    res.sort((a, b) => (a.styleNo.localeCompare(b.styleNo) || a.color.localeCompare(b.color)));
    return res;
  }, [data]);
  // Stable size column count across all rendered groups to avoid layout shifting
  const maxSizeCount = React.useMemo(() => {
    let n = 0;
    for (const g of groups) n = Math.max(n, g.sizes.length);
    return Math.max(8, n || 0);
  }, [groups]);

  // Compute style_color_ids we need seasons for
  const colorIds = React.useMemo(() => {
    const out: string[] = [];
    for (const r of (styleRows ?? []) as any[]) {
      const sid = r.id as string;
      const cmap = styleColors?.idMap?.get(sid) || new Map<string, string>();
      for (const g of groups.filter((gr) => styleMetaByNo[gr.styleNo]?.id === sid)) {
        const id = cmap.get((g.color || '').trim().toLowerCase());
        if (id) out.push(id);
      }
    }
    const uniqueIds = Array.from(new Set(out));
    console.log('[stock-list] colorIds computed:', uniqueIds.length, uniqueIds.slice(0, 5));
    return uniqueIds;
  }, [groups, styleRows, styleColors, styleMetaByNo]);
  
  // Fetch season mappings for the computed color IDs
  const { data: colorSeasons, mutate: mutateColorSeasons } = useSWR(colorIds.length ? ['style_color_seasons:byColorIds', colorIds.join(',')] : null, async () => {
    const { data, error } = await supabase
      .from('style_color_seasons')
      .select('style_color_id, season_id')
      .in('style_color_id', colorIds)
      .limit(100000);
    if (error) throw new Error(error.message);
    console.log('[stock-list] colorSeasons raw data:', data);
    const map = new Map<string, Set<string>>();
    for (const r of (data ?? []) as any[]) {
      const set = map.get(r.style_color_id) || new Set<string>();
      set.add(r.season_id);
      map.set(r.style_color_id, set);
    }
    console.log('[stock-list] colorSeasons map:', map);
    return map as Map<string, Set<string>>;
  }, { refreshInterval: 0 });

  // Per-list color includes (exclusions) for selected list will be loaded below after list selection setup

  // Group merged rows by style, then list colors within
  const groupedByStyle = React.useMemo(() => {
    const map = new Map<string, Group[]>();
    for (const g of groups) {
      if (!map.has(g.styleNo)) map.set(g.styleNo, []);
      map.get(g.styleNo)!.push(g);
    }
    const out = Array.from(map.entries()).map(([styleNo, list]) => ({ styleNo, colors: list.sort((a, b) => a.color.localeCompare(b.color)) }));
    // Sort by supplier first, then A-Z by style_no within each supplier
    out.sort((a, b) => {
      const supplierA = (styleMetaByNo[a.styleNo]?.supplier || '').toLowerCase();
      const supplierB = (styleMetaByNo[b.styleNo]?.supplier || '').toLowerCase();
      // First by supplier
      const bySupplier = supplierA.localeCompare(supplierB);
      if (bySupplier !== 0) return bySupplier;
      // Then by style_no within supplier
      return a.styleNo.localeCompare(b.styleNo);
    });
    // Apply per-list color exclusions when a list is selected
    if (!activeListId) {
      return out as Array<{ styleNo: string; colors: Group[] }>;
    }
    // Build a quick styleId -> styleNo map for list styles present in styles table
    const styleIdToNoLocal = new Map<string, string>();
    for (const r of (styleRows ?? []) as any[]) {
      if (r?.id && r?.style_no) styleIdToNoLocal.set(String(r.id), String(r.style_no));
    }
    const presentStyleNos = new Set(out.map((r) => r.styleNo));
    // Ensure rows exist for styles in the active list even if they have no scraped data yet
    for (const sid of Array.from(styleIdsInList)) {
      const styleNo = styleIdToNoLocal.get(sid) || '';
      if (!styleNo) continue;
      if (!presentStyleNos.has(styleNo)) {
        out.push({ styleNo, colors: [] });
        presentStyleNos.add(styleNo);
      }
    }
    // Blacklist rules: hide only the explicitly hidden colors; all others visible
    const filtered = out.map((row) => {
      const sid = styleMetaByNo[row.styleNo]?.id || null;
      if (!sid) return row;
      const hiddenIds = (listColorRules as any)?.hiddenIdsMap?.get(sid) as Set<string> | undefined;
      // Collect colorLower -> style_color_id map for this style
      const allColorKeysMap = styleColors?.idMap?.get(sid) || new Map<string, string>(); // colorLower -> style_color_id
      // Filter current colors to remove hidden
      const current = row.colors.filter((c) => {
        const key = String(c.color || '').trim().toLowerCase();
        const scId = allColorKeysMap.get(key) || '';
        return !(hiddenIds?.has(String(scId)));
      });
      // Add placeholders for non-hidden colors that have no scraped data yet
      const existingKeys = new Set(current.map((c) => `${row.styleNo}|${String(c.color || '').trim().toLowerCase()}`));
      const placeholders: Group[] = [];
      for (const [ckey, scId] of Array.from(allColorKeysMap.entries())) {
        if (hiddenIds?.has(String(scId))) continue; // skip hidden
        const key = `${row.styleNo}|${ckey}`;
        if (!existingKeys.has(key)) {
          placeholders.push({
            styleNo: row.styleNo,
            color: ckey,
            sizes: [],
            stock: [],
            soldSum: [],
            purchaseSum: [],
            available: [],
            soldRows: [],
            purchaseRows: [],
            scrapedAt: ''
          });
        }
      }
      const colors = [...current, ...placeholders].sort((a, b) => a.color.localeCompare(b.color));
      return { ...row, colors };
    });
    return filtered as Array<{ styleNo: string; colors: Group[] }>;
  }, [groups, styleMetaByNo, activeListId, listColorRules?.hiddenIdsMap, styleRows, styleColors, styleIdsInList]);

  // Log selection changes and high-level counts
  React.useEffect(() => {
    if (!activeListId) {
      // eslint-disable-next-line no-console
      console.log('[stock-list] activeListId cleared (All)');
    } else {
      // eslint-disable-next-line no-console
      console.log('[stock-list] activeListId set', {
        listId: activeListId,
        stylesInList: styleIdsInList.size,
        groupsCount: groups.length
      });
    }
  }, [activeListId, styleIdsInList.size, groups.length]);

  const [openSold, setOpenSold] = React.useState<Record<string, boolean>>({});
  const [openPurchase, setOpenPurchase] = React.useState<Record<string, boolean>>({});

  // (migrated to top of file to satisfy dependencies)

  // Filter rows based on active Stock List, search, seasons, and hide zeros
  const filteredForView = React.useMemo(() => {
    let base = groupedByStyle;
    console.log('[stock-list] Starting filter - base:', base.length, 'styles');
    
    // Filter by active list
    if (activeListId) {
      base = base.filter(({ styleNo }) => {
        const sid = styleMetaByNo[styleNo]?.id || null;
        return sid ? styleIdsInList.has(sid) : false;
      });
      console.log('[stock-list] After list filter:', base.length, 'styles');
    }
    
    // Filter by search query
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      base = base.filter(({ styleNo, colors }) => {
        const name = styleMetaByNo[styleNo]?.name || '';
        if (styleNo.toLowerCase().includes(q) || (name || '').toLowerCase().includes(q)) return true;
        return colors.some((c) => (c.color || '').toLowerCase().includes(q));
      });
      console.log('[stock-list] After search filter:', base.length, 'styles');
    }
    
    // Filter by seasons - only show colors that have at least one of the selected seasons
    if (selectedSeasons.length > 0 && styleColors && colorSeasons) {
      console.log('[stock-list] Filtering by seasons:', selectedSeasons);
      console.log('[stock-list] styleColors available:', !!styleColors, 'colorSeasons available:', !!colorSeasons);
      
      base = base.map(({ styleNo, colors }) => {
        const sid = styleMetaByNo[styleNo]?.id || null;
        if (!sid) return { styleNo, colors: [] };
        
        const cmap = styleColors.idMap?.get(sid);
        if (!cmap) return { styleNo, colors: [] };
        
        const filteredColors = colors.filter((c) => {
          const colorKey = (c.color || '').trim().toLowerCase();
          const scId = cmap.get(colorKey);
          if (!scId) {
            console.log('[stock-list] No scId for color:', c.color, 'in style:', styleNo);
            return false;
          }
          
          const thisColorSeasons = colorSeasons.get(scId);
          if (!thisColorSeasons) {
            console.log('[stock-list] No seasons for scId:', scId);
            return false;
          }
          
          // Color must have at least one of the selected seasons
          const hasMatch = selectedSeasons.some(seasonId => thisColorSeasons.has(seasonId));
          console.log('[stock-list] Color:', c.color, 'seasons:', Array.from(thisColorSeasons), 'matches:', hasMatch);
          return hasMatch;
        });
        
        return { styleNo, colors: filteredColors };
      }).filter(({ colors }) => colors.length > 0);
      console.log('[stock-list] After season filter:', base.length, 'styles');
    }
    
    // Filter out colors with all zeros
    if (hideZeros) {
      console.log('[stock-list] Filtering out zeros');
      base = base.map(({ styleNo, colors }) => {
        const filteredColors = colors.filter((c) => {
          const hasNonZero = c.stock.some(v => v !== 0) || 
                           c.soldSum.some(v => v !== 0) || 
                           c.purchaseSum.some(v => v !== 0) || 
                           c.available.some(v => v !== 0);
          return hasNonZero;
        });
        return { styleNo, colors: filteredColors };
      }).filter(({ colors }) => colors.length > 0);
      console.log('[stock-list] After zero filter:', base.length, 'styles');
    }
    
    console.log('[stock-list] Final filtered:', base.length, 'styles');
    return base;
  }, [groupedByStyle, activeListId, styleIdsInList.size, searchQuery, styleMetaByNo, selectedSeasons, hideZeros, styleColors, colorSeasons]);

  const emptyState: JSX.Element | null = React.useMemo(() => {
    if (activeListId && filteredForView.length === 0) {
      return <div className="text-sm text-gray-600">No stock data yet for styles in the selected list.</div>;
    }
    if (filteredForView.length === 0) {
      return <div className="text-sm text-gray-600">No scraped stock data available yet.</div>;
    }
    return null;
  }, [activeListId, filteredForView.length]);

  // Calculate totals from visible content
  const totals = React.useMemo(() => {
    let stock = 0;
    let sold = 0;
    let purchase = 0;
    let available = 0;
    
    for (const { colors } of filteredForView) {
      for (const color of colors) {
        stock += color.stock.reduce((sum, v) => sum + (Number(v) || 0), 0);
        sold += color.soldSum.reduce((sum, v) => sum + (Number(v) || 0), 0);
        purchase += color.purchaseSum.reduce((sum, v) => sum + (Number(v) || 0), 0);
        available += color.available.reduce((sum, v) => sum + (Number(v) || 0), 0);
      }
    }
    
    return { stock, sold, purchase, available };
  }, [filteredForView]);

  return (
    <div className="space-y-4 sl-root">
      <div>
        <div className="text-xs text-gray-500 sl-header-eyebrow">Styles</div>
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-2xl font-semibold sl-header-title">Stock List</h1>
          <span className="text-sm text-gray-600">
            ({filteredForView.length.toLocaleString()} {filteredForView.length === 1 ? 'style' : 'styles'})
          </span>
        </div>
        
        {/* Loading Progress Bar */}
        {loadingProgress && (
          <Card className="shadow-sm mb-4">
            <CardContent className="p-4">
              <div className="text-sm text-gray-600 mb-2">
                Loading {loadingProgress.current.toLocaleString()} of {loadingProgress.total.toLocaleString()} rows...
              </div>
              <ProgressBar value={loadingProgress.current} max={loadingProgress.total} showLabel={true} />
            </CardContent>
          </Card>
        )}
        
        {/* Summary Totals - Cards */}
        <div className="grid grid-cols-4 gap-3">
          <Card className="shadow-sm">
            <CardContent className="p-4">
              <div className="text-xs text-gray-600 mb-1">Stock</div>
              <div className="text-2xl font-bold text-black">{totals.stock.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardContent className="p-4">
              <div className="text-xs text-gray-600 mb-1">Sold</div>
              <div className="text-2xl font-bold text-red-700">
                {totals.sold > 0 ? `-${totals.sold.toLocaleString()}` : totals.sold}
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardContent className="p-4">
              <div className="text-xs text-gray-600 mb-1">Purchase</div>
              <div className="text-2xl font-bold text-green-700">{totals.purchase.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardContent className="p-4">
              <div className="text-xs text-gray-600 mb-1">Available</div>
              <div className={`text-2xl font-bold ${totals.available < 0 ? 'text-red-700' : totals.available > 0 ? 'text-green-800' : 'text-black'}`}>
                {totals.available.toLocaleString()}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Stock List Tabs and Filters in Single Row */}
      <Card className="shadow-sm">
        <CardContent className="p-3">
          <div className="space-y-3">
            {/* Stock List Tabs */}
            <Tabs value={activeListId || 'all'} onValueChange={(v) => setActiveListId(v === 'all' ? '' : v)}>
              <TabsList className="w-full justify-start">
                <TabsTrigger value="all">All</TabsTrigger>
                {(stockLists ?? []).map((row) => (
                  <TabsTrigger key={row.id} value={row.id}>{row.name}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            
            {/* All Filters in One Row */}
            <div className="flex items-center gap-3 flex-wrap">
              <Input
                placeholder="Search style no, name or color…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-64"
              />
              
              <MultiSelect
                items={(seasons || []).map(s => ({ 
                  value: s.id, 
                  label: `${s.name}${s.year ? ` ${s.year}` : ''}` 
                }))}
                values={selectedSeasons}
                onChange={setSelectedSeasons}
                placeholder="Filter by seasons..."
              />
              
              <label className="flex items-center gap-2 text-sm cursor-pointer border rounded px-3 py-2 bg-white hover:bg-gray-50">
                <input
                  type="checkbox"
                  checked={hideZeros}
                  onChange={(e) => setHideZeros(e.target.checked)}
                  className="h-4 w-4 rounded accent-slate-900"
                />
                <span>Hide all zeros</span>
              </label>
              
              {(selectedSeasons.length > 0 || hideZeros) && (
                <button
                  onClick={() => {
                    setSelectedSeasons([]);
                    setHideZeros(false);
                  }}
                  className="text-sm text-slate-600 hover:text-slate-900 underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      {/* Scrape active list */}
      {activeListId && (
        <div className="flex items-center justify-end">
          <ScrapeActiveListButton
            listId={activeListId}
            styleIdsInList={Array.from(styleIdsInList)}
          />
              </div>
        )}

      {/* Main content */}
      <div className="space-y-4 sl-main">
      {emptyState || filteredForView.map(({ styleNo, colors }) => {
        const meta = styleMetaByNo[styleNo] || { id: null, name: null, supplier: null, image: null, dg: null, link_href: null };
        return (
          <div key={styleNo} id={`style-${styleNo}`} className="bg-white p-3 space-y-3 sl-style">
            <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-4 sl-style-grid">
              {/* Left: style header */}
              <div className="sl-style-left">
                <div className="flex items-start gap-3 sl-style-header">
                  <div className="shrink-0 sl-style-image">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {meta.image ? <img src={meta.image} alt={meta.name ?? styleNo} className="h-20 w-20 object-cover rounded border" /> : <div className="h-20 w-20 rounded border bg-gray-50" />}
                  </div>
                  <div className="min-w-0 sl-style-meta">
                    {meta.link_href ? (
                      <a 
                        href={(() => {
                          const linkHref = meta.link_href || '';
                          const SPY_BASE_URL = 'https://2-biz.spysystem.dk';
                          try {
                            const url = new URL(linkHref, SPY_BASE_URL).toString();
                            return url.replace(/#.*$/, '') + '#tab=statandstock';
                          } catch {
                            // Fallback if URL construction fails
                            return linkHref;
                          }
                        })()} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:text-blue-800 underline sl-style-no"
                      >
                        {styleNo}
                      </a>
                    ) : (
                      <div className="text-xs text-gray-500 sl-style-no">{styleNo}</div>
                    )}
                    <div className="text-base font-semibold text-black truncate sl-style-name">{meta.name ?? '—'}</div>
                    {meta.supplier && <div className="text-xs text-gray-500 sl-style-supplier">{meta.supplier}</div>}
                    {styleMetaByNo[styleNo]?.dg && (
                      <div className="text-[11px] text-gray-600 sl-style-dg">DG: <span className="font-medium">{styleMetaByNo[styleNo]?.dg}</span></div>
                    )}
                  </div>
                </div>
              </div>
              {/* Right: per-color tables */}
              <div className="space-y-4 sl-color-sections">
                {colors.map((g) => {
                  const key = `${g.styleNo}:${g.color}`;
                  const sum = (arr: number[]) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
                  const stockTotal = sum(g.stock);
                  const soldTotal = sum(g.soldSum);
                  const purchaseTotal = sum(g.purchaseSum);
                  const availableTotal = sum(g.available);
                  return (
                  <div key={key} className="space-y-1 sl-color-block">
                      {/* Display seasons as simple text */}
                      {(() => {
                        const sid = styleMetaByNo[g.styleNo]?.id || null;
                        const cmap = sid ? (styleColors?.idMap?.get(sid) || new Map<string, string>()) : new Map<string, string>();
                        const scId = cmap.get((g.color || '').trim().toLowerCase()) || null;
                        const set = (scId && colorSeasons) ? (colorSeasons.get(scId) || new Set<string>()) : new Set<string>();
                        const labels = (seasons || []).filter(s => set.has(s.id));
                        
                        console.log('[stock-list] Season display for', g.styleNo, g.color, '- scId:', scId, 'seasonIds:', Array.from(set), 'labels:', labels);
                        
                        if (labels.length === 0) return null;
                        
                        const seasonText = labels.map(s => `${s.name}${s.year ? ` ${s.year}` : ''}`).join(', ');
                        return (
                          <div className="text-[12px] text-gray-500 mb-1">{seasonText}</div>
                        );
                      })()}
                    {/* Sizes table with image + color columns */}
                    <div className="overflow-auto sl-table-wrap">
                      <table className="min-w-full text-xs sl-table">
                          <thead className="bg-gray-50">
                            <tr>
                            <th className="p-2 text-left border-b sl-th sl-th-color" style={{ width: 140 }}>Color</th>
                            <th className="p-2 text-left border-b whitespace-nowrap sl-th sl-th-section" style={{ width: 160 }}>Section</th>
                            {Array.from({ length: maxSizeCount }, (_, i) => g.sizes[i] ?? '').map((s, i) => (
                              <th key={i} className="p-2 text-right border-b sl-th sl-th-size" style={{ width: 64 }}>{s}</th>
                            ))}
                            <th className="p-2 text-right border-b sl-th sl-th-total" style={{ width: 72 }}>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                          <tr className="sl-row sl-row-stock">
                            <td className="p-2 border-b align-top sl-cell sl-cell-color" rowSpan={4} style={{ width: 140 }}>{g.color}</td>
                            <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>Stock</td>
                            {Array.from({ length: maxSizeCount }, (_, i) => i < g.sizes.length ? (g.stock[i] ?? 0) : null).map((v, i) => (
                              <td key={i} className="p-2 border-b text-right text-black sl-cell sl-cell-size" style={{ width: 64 }}>{i < g.sizes.length ? v : ''}</td>
                            ))}
                            <td className="p-2 border-b text-right font-medium text-black sl-cell sl-cell-total" style={{ width: 72 }}>{stockTotal}</td>
                          </tr>
                          <tr className="cursor-pointer hover:bg-gray-50 sl-row sl-row-sold-sum" onClick={() => setOpenSold((m) => ({ ...m, [key]: !m[key] }))}>
                            <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>Sold (sum)</td>
                            {Array.from({ length: maxSizeCount }, (_, i) => i < g.sizes.length ? (g.soldSum[i] ?? 0) : null).map((v, i) => (
                              <td key={i} className="p-2 border-b text-right text-red-600 sl-cell sl-cell-size" style={{ width: 64 }}>{i < g.sizes.length ? (Number(v) > 0 ? `-${v}` : v) : ''}</td>
                            ))}
                            <td className="p-2 border-b text-right font-medium text-red-700 sl-cell sl-cell-total" style={{ width: 72 }}>{soldTotal > 0 ? `-${soldTotal}` : soldTotal}</td>
                        </tr>
                          {openSold[key] && g.soldRows.map((r, idx) => (
                            <tr key={`sold-${idx}`} className="bg-gray-50 sl-row sl-row-sold-detail">
                              <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>• {r.row_label ?? 'Row'}</td>
                              {Array.from({ length: maxSizeCount }, (_, i) => i < g.sizes.length ? ((r.values as any[])?.[i] ?? 0) : null).map((rv, i) => (
                                <td key={i} className="p-2 border-b text-right text-red-600 sl-cell sl-cell-size" style={{ width: 64 }}>{i < g.sizes.length ? (Number(rv) > 0 ? `-${rv}` : rv) : ''}</td>
                              ))}
                              <td className="p-2 border-b text-right text-red-700 sl-cell sl-cell-total" style={{ width: 72 }}>{(() => { const val = sum((r.values as any[]) || []); return val > 0 ? `-${val}` : val; })()}</td>
                            </tr>
                          ))}
                          <tr className="cursor-pointer hover:bg-gray-50 sl-row sl-row-purchase-sum" onClick={() => setOpenPurchase((m) => ({ ...m, [key]: !m[key] }))}>
                            <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>Purchase (sum)</td>
                            {Array.from({ length: maxSizeCount }, (_, i) => i < g.sizes.length ? (g.purchaseSum[i] ?? 0) : null).map((v, i) => (
                              <td key={i} className="p-2 border-b text-right text-green-700 sl-cell sl-cell-size" style={{ width: 64 }}>{i < g.sizes.length ? v : ''}</td>
                            ))}
                            <td className="p-2 border-b text-right font-medium text-green-800 sl-cell sl-cell-total" style={{ width: 72 }}>{purchaseTotal}</td>
                          </tr>
                          {openPurchase[key] && g.purchaseRows.map((r, idx) => (
                            <tr key={`purchase-${idx}`} className="bg-gray-50 sl-row sl-row-purchase-detail">
                              <td className="p-2 border-b whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>• {r.row_label ?? 'Row'}</td>
                              {Array.from({ length: maxSizeCount }, (_, i) => i < g.sizes.length ? ((r.values as any[])?.[i] ?? 0) : null).map((rv, i) => (
                                <td key={i} className="p-2 border-b text-right text-green-700 sl-cell sl-cell-size" style={{ width: 64 }}>{i < g.sizes.length ? rv : ''}</td>
                              ))}
                              <td className="p-2 border-b text-right text-green-800 sl-cell sl-cell-total" style={{ width: 72 }}>{sum((r.values as any[]) || [])}</td>
                            </tr>
                          ))}
                          <tr className="sl-row sl-row-available">
                            <td className="p-2 whitespace-nowrap sl-cell sl-cell-section" style={{ width: 160 }}>Available</td>
                            {Array.from({ length: maxSizeCount }, (_, i) => i < g.sizes.length ? (g.available[i] ?? 0) : null).map((v, i) => (
                              <td key={i} className={"p-2 text-right font-semibold sl-cell sl-cell-size " + ((Number(v) < 0) ? 'text-red-700' : ((Number(v) > 0) ? 'text-green-800' : '') )} style={{ width: 64 }}>{i < g.sizes.length ? v : ''}</td>
                            ))}
                            <td className={"p-2 text-right font-semibold sl-cell sl-cell-total " + (availableTotal < 0 ? 'text-red-700' : (availableTotal > 0 ? 'text-green-800' : '') )} style={{ width: 72 }}>{availableTotal}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
        })}
              </div>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

function ScrapeActiveListButton({ listId, styleIdsInList }: { listId: string; styleIdsInList: string[] }) {
  const supabase = createClientComponentClient();
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  return (
    <Button
      size="sm"
      variant={busy ? 'secondary' : 'default'}
      disabled={busy}
      onClick={async () => {
        try {
          setBusy(true);
          setDone(false);
          // Resolve style_nos for styles in this list
          const ids = Array.from(new Set(styleIdsInList || []));
          if (ids.length === 0) {
            alert('This list has no styles yet.');
            setBusy(false);
            return;
          }
          const { data: styles } = await supabase.from('styles').select('style_no').in('id', ids);
          const nos = Array.from(new Set((styles ?? []).map((r: any) => String(r.style_no || '')).filter(Boolean)));
          if (nos.length === 0) {
            alert('No style numbers found for this list.');
            setBusy(false);
            return;
          }
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) { alert('Not signed in'); setBusy(false); return; }
          const res = await fetch('/api/enqueue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ type: 'update_style_stock', payload: { requestedBy: session.user.email, styleNos: nos } })
          });
          if (!res.ok) {
            const t = await res.text().catch(()=>'');
            throw new Error(t || `Failed (${res.status})`);
          }
          // eslint-disable-next-line no-console
          console.log('[stock-list] scrape list enqueued', { listId, count: nos.length });
          setDone(true);
        } catch (e: any) {
          alert(e?.message || 'Failed to enqueue scrape');
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Scraping…' : (done ? 'Enqueued!' : 'Scrape this list')}
    </Button>
  );
}



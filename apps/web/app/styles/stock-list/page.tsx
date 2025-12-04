"use client";
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import React from 'react';
import { useRoles } from '../../../lib/supabaseClient';
import { MultiSelect } from '../../../components/MultiSelect';
import { ProgressBar } from '../../../components/ProgressBar';
import { Modal } from '../../../components/Modal';
import { Card, CardContent } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { Button } from '../../../components/ui/button';
import * as XLSX from 'xlsx';

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

// Helper function to format relative time
function formatRelativeTime(isoString: string): string {
  if (!isoString) return 'Never';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

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
  const [showCheckerModal, setShowCheckerModal] = React.useState<boolean>(false);
  const [checkerInput, setCheckerInput] = React.useState<string>('');
  const [checkerResults, setCheckerResults] = React.useState<any>(null);
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

  // Get total count of ALL styles in database
  const { data: allStylesData } = useSWR('styles:all', async () => {
    const { data, error } = await supabase.from('styles').select('id, style_no, style_name, supplier').eq('inactive', false);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; style_no: string; style_name: string | null; supplier: string | null }>;
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
  const [showHiddenModal, setShowHiddenModal] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [showStyleTotals, setShowStyleTotals] = React.useState(false);

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

  // Excel export function
  const exportToExcel = React.useCallback(() => {
    setExporting(true);
    try {
      const exportData: any[] = [];
      
      // Add header row
      const maxSizes = Math.max(...filteredForView.flatMap(s => s.colors.flatMap(c => c.sizes.length)), 0);
      const sizeHeaders = Array.from({ length: maxSizes }, (_, i) => `Size ${i + 1}`);
      
      for (const { styleNo, colors } of filteredForView) {
        const meta = styleMetaByNo[styleNo] || { id: null, name: null, supplier: null, image: null };
        
        for (const color of colors) {
          // Stock row
          const stockRow: any = {
            'Style No': styleNo,
            'Style Name': meta.name || '',
            'Supplier': meta.supplier || '',
            'Color': color.color,
            'Section': 'Stock',
            'Scraped At': color.scrapedAt ? new Date(color.scrapedAt).toLocaleString() : 'Not scraped'
          };
          color.sizes.forEach((size, idx) => {
            stockRow[size] = color.stock[idx] ?? 0;
          });
          stockRow['Total'] = color.stock.reduce((sum, v) => sum + (Number(v) || 0), 0);
          exportData.push(stockRow);
          
          // Sold row
          const soldRow: any = {
            'Style No': styleNo,
            'Style Name': meta.name || '',
            'Supplier': meta.supplier || '',
            'Color': color.color,
            'Section': 'Sold',
            'Scraped At': color.scrapedAt ? new Date(color.scrapedAt).toLocaleString() : 'Not scraped'
          };
          color.sizes.forEach((size, idx) => {
            soldRow[size] = color.soldSum[idx] ?? 0;
          });
          soldRow['Total'] = color.soldSum.reduce((sum, v) => sum + (Number(v) || 0), 0);
          exportData.push(soldRow);
          
          // Purchase row
          const purchaseRow: any = {
            'Style No': styleNo,
            'Style Name': meta.name || '',
            'Supplier': meta.supplier || '',
            'Color': color.color,
            'Section': 'Purchase',
            'Scraped At': color.scrapedAt ? new Date(color.scrapedAt).toLocaleString() : 'Not scraped'
          };
          color.sizes.forEach((size, idx) => {
            purchaseRow[size] = color.purchaseSum[idx] ?? 0;
          });
          purchaseRow['Total'] = color.purchaseSum.reduce((sum, v) => sum + (Number(v) || 0), 0);
          exportData.push(purchaseRow);
          
          // Available row
          const availableRow: any = {
            'Style No': styleNo,
            'Style Name': meta.name || '',
            'Supplier': meta.supplier || '',
            'Color': color.color,
            'Section': 'Available',
            'Scraped At': color.scrapedAt ? new Date(color.scrapedAt).toLocaleString() : 'Not scraped'
          };
          color.sizes.forEach((size, idx) => {
            availableRow[size] = color.available[idx] ?? 0;
          });
          availableRow['Total'] = color.available.reduce((sum, v) => sum + (Number(v) || 0), 0);
          exportData.push(availableRow);
        }
      }
      
      // Create worksheet
      const ws = XLSX.utils.json_to_sheet(exportData);
      
      // Create workbook
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Stock List');
      
      // Generate filename with timestamp
      const timestamp = new Date().toISOString().split('T')[0];
      const listName = activeListId ? (stockLists?.find(l => l.id === activeListId)?.name || 'List') : 'All';
      const filename = `stock-list-${listName}-${timestamp}.xlsx`;
      
      // Download
      XLSX.writeFile(wb, filename);
    } catch (error) {
      console.error('Export error:', error);
      alert('Failed to export Excel file');
    } finally {
      setExporting(false);
    }
  }, [filteredForView, styleMetaByNo, activeListId, stockLists]);

  // Compute total style universe and hidden styles
  const { totalStyles, hiddenStyles } = React.useMemo(() => {
    // Total is ALWAYS all styles in the database (excluding inactive)
    const allDbStyles = allStylesData ?? [];
    const totalStyles = allDbStyles.length;

    const visibleStyleNos = new Set(filteredForView.map(s => s.styleNo));
    const hidden: Array<{ styleNo: string; name: string | null; supplier: string | null; reason: string }> = [];

    // Check each style in the database
    for (const dbStyle of allDbStyles) {
      const styleNo = dbStyle.style_no;
      
      if (!visibleStyleNos.has(styleNo)) {
        // Determine why it's hidden
        let reason = 'Unknown';
        
        // Check if in active list (if a list is selected)
        if (activeListId) {
          const isInList = styleIdsInList.has(dbStyle.id);
          if (!isInList) {
            reason = 'Not in selected list';
          }
        }
        
        // Check if it has no scraped data
        if (reason === 'Unknown' || reason === 'Not in selected list') {
          const hasScrapedData = groups.some(g => g.styleNo === styleNo);
          if (!hasScrapedData) {
            reason = reason === 'Not in selected list' ? 'Not in selected list & no scraped data' : 'No scraped stock data';
          } else {
            // Has scraped data but filtered out
            if (searchQuery.trim()) {
              const q = searchQuery.trim().toLowerCase();
              const matchesSearch = styleNo.toLowerCase().includes(q) || 
                                    (dbStyle.style_name || '').toLowerCase().includes(q) ||
                                    groups.filter(g => g.styleNo === styleNo).some(g => g.color.toLowerCase().includes(q));
              if (!matchesSearch) {
                reason = 'Filtered out by search';
              }
            }
            
            if (selectedSeasons.length > 0 && (reason === 'Unknown' || reason === 'Not in selected list')) {
              reason = 'Filtered out by season';
            }
            
            if (hideZeros && (reason === 'Unknown' || reason === 'Not in selected list')) {
              reason = 'All zeros hidden';
            }
          }
        }
        
        hidden.push({
          styleNo,
          name: dbStyle.style_name || null,
          supplier: dbStyle.supplier || null,
          reason
        });
      }
    }

    return {
      totalStyles,
      hiddenStyles: hidden
    };
  }, [allStylesData, filteredForView, activeListId, styleIdsInList, groups, searchQuery, selectedSeasons, hideZeros]);

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

  // Checker function: parse pasted data and compare with current stock
  const runChecker = React.useCallback(() => {
    try {
      const lines = checkerInput.trim().split('\n');
      const pastedData = new Map<string, { name: string; total: number }>();
      
      // Parse pasted data (skip header if present)
      for (const line of lines) {
        const parts = line.trim().split('\t');
        if (parts.length < 3) continue;
        
        const styleNo = parts[0]?.trim() || '';
        const styleName = parts[1]?.trim() || '';
        const totalStr = parts[2]?.trim() || '';
        
        // Skip header row or empty data
        if (!styleNo || styleNo === 'Style No.' || styleNo === 'Style no') continue;
        
        const total = parseInt(totalStr.replace(/[^0-9-]/g, ''), 10);
        if (isNaN(total)) continue;
        
        pastedData.set(styleNo, { name: styleName, total });
      }
      
      // Calculate totals per style from ALL stock data (unfiltered, STOCK ONLY - not Available)
      // Use groupedByStyle instead of filteredForView to get ALL styles regardless of current filters
      const currentData = new Map<string, { name: string | null; total: number }>();
      for (const { styleNo, colors } of groupedByStyle) {
        const meta = styleMetaByNo[styleNo] || { name: null };
        let styleTotal = 0;
        // Sum STOCK (not available) across ALL colors for this style
        for (const color of colors) {
          styleTotal += color.stock.reduce((sum, v) => sum + (Number(v) || 0), 0);
        }
        currentData.set(styleNo, { name: meta.name, total: styleTotal });
      }
      
      // Compare and find differences
      const differences: Array<{
        styleNo: string;
        name: string | null;
        pastedTotal: number;
        currentTotal: number;
        diff: number;
        status: 'missing_in_pasted' | 'missing_in_current' | 'mismatch' | 'match';
      }> = [];
      
      // Check all pasted styles
      for (const [styleNo, pastedInfo] of pastedData.entries()) {
        const current = currentData.get(styleNo);
        if (!current) {
          differences.push({
            styleNo,
            name: pastedInfo.name,
            pastedTotal: pastedInfo.total,
            currentTotal: 0,
            diff: -pastedInfo.total,
            status: 'missing_in_current'
          });
        } else if (current.total !== pastedInfo.total) {
          differences.push({
            styleNo,
            name: current.name || pastedInfo.name,
            pastedTotal: pastedInfo.total,
            currentTotal: current.total,
            diff: current.total - pastedInfo.total,
            status: 'mismatch'
          });
        } else {
          differences.push({
            styleNo,
            name: current.name || pastedInfo.name,
            pastedTotal: pastedInfo.total,
            currentTotal: current.total,
            diff: 0,
            status: 'match'
          });
        }
      }
      
      // Check for styles in current but not in pasted
      for (const [styleNo, currentInfo] of currentData.entries()) {
        if (!pastedData.has(styleNo)) {
          differences.push({
            styleNo,
            name: currentInfo.name,
            pastedTotal: 0,
            currentTotal: currentInfo.total,
            diff: currentInfo.total,
            status: 'missing_in_pasted'
          });
        }
      }
      
      // Sort: mismatches first, then by absolute diff descending
      differences.sort((a, b) => {
        if (a.status === 'mismatch' && b.status !== 'mismatch') return -1;
        if (a.status !== 'mismatch' && b.status === 'mismatch') return 1;
        if (a.status === 'missing_in_current' && b.status !== 'missing_in_current') return -1;
        if (a.status !== 'missing_in_current' && b.status === 'missing_in_current') return 1;
        if (a.status === 'missing_in_pasted' && b.status !== 'missing_in_pasted') return -1;
        if (a.status !== 'missing_in_pasted' && b.status === 'missing_in_pasted') return 1;
        return Math.abs(b.diff) - Math.abs(a.diff);
      });
      
      setCheckerResults({
        pastedCount: pastedData.size,
        currentCount: currentData.size,
        differences,
        mismatches: differences.filter(d => d.status === 'mismatch').length,
        missingInCurrent: differences.filter(d => d.status === 'missing_in_current').length,
        missingInPasted: differences.filter(d => d.status === 'missing_in_pasted').length,
        matches: differences.filter(d => d.status === 'match').length
      });
    } catch (err: any) {
      alert(`Error parsing data: ${err.message}`);
    }
  }, [checkerInput, filteredForView, styleMetaByNo]);

  return (
    <div className="space-y-4 sl-root">
      <div>
        <div className="text-xs text-gray-500 sl-header-eyebrow">Styles</div>
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-2xl font-semibold sl-header-title">Stock List</h1>
          <span className="text-sm text-gray-600">
            (Showing {filteredForView.length.toLocaleString()} / {totalStyles.toLocaleString()} {totalStyles === 1 ? 'style' : 'styles'})
          </span>
            {hiddenStyles.length > 0 && (
            <button
              onClick={() => setShowHiddenModal(true)}
              className="text-sm text-blue-600 hover:text-blue-800 underline"
            >
              {hiddenStyles.length} hidden
            </button>
          )}
          <Button
            size="sm"
            variant="default"
            onClick={exportToExcel}
            disabled={exporting || filteredForView.length === 0}
          >
            {exporting ? 'Exporting...' : 'Export to Excel'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setShowCheckerModal(true);
              setCheckerResults(null);
              setCheckerInput('');
            }}
          >
            Checker
          </Button>
        </div>
        
        {/* Loading Progress Bar - Fixed Bottom Right */}
        {loadingProgress && (
          <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)]">
            <Card className="shadow-lg">
              <CardContent className="p-4">
                <div className="text-sm text-gray-600 mb-2">
                  Loading {loadingProgress.current.toLocaleString()} of {loadingProgress.total.toLocaleString()} rows...
                </div>
                <ProgressBar value={loadingProgress.current} max={loadingProgress.total} showLabel={true} />
              </CardContent>
            </Card>
          </div>
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
              
              <label className="flex items-center gap-2 text-sm cursor-pointer border rounded px-3 py-2 bg-white hover:bg-gray-50">
                <input
                  type="checkbox"
                  checked={showStyleTotals}
                  onChange={(e) => setShowStyleTotals(e.target.checked)}
                  className="h-4 w-4 rounded accent-slate-900"
                />
                <span>Display style totals</span>
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
                      {/* Display seasons and scraped timestamp */}
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div>
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
                              <span className="text-[12px] text-gray-500">{seasonText}</span>
                            );
                          })()}
                        </div>
                        <div className="text-[11px] text-gray-400">
                          {g.scrapedAt ? `Scraped: ${formatRelativeTime(g.scrapedAt)}` : 'Not scraped yet'}
                        </div>
                      </div>
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
                
                {/* Style Total Summary */}
                {showStyleTotals && colors.length > 0 && (() => {
                  // Calculate style-level totals across all colors
                  const sum = (arr: number[]) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
                  
                  // Get the first color with sizes to use as reference
                  const firstColorWithSizes = colors.find(c => c.sizes && c.sizes.length > 0);
                  const referenceSizes = firstColorWithSizes?.sizes || [];
                  const referenceSizeCount = referenceSizes.length;
                  
                  // Build totals by combining all colors
                  const styleTotals = {
                    stock: Array.from({ length: maxSizeCount }, (_, i) => 
                      colors.reduce((sum, c) => sum + (c.stock[i] ?? 0), 0)
                    ),
                    soldSum: Array.from({ length: maxSizeCount }, (_, i) => 
                      colors.reduce((sum, c) => sum + (c.soldSum[i] ?? 0), 0)
                    ),
                    purchaseSum: Array.from({ length: maxSizeCount }, (_, i) => 
                      colors.reduce((sum, c) => sum + (c.purchaseSum[i] ?? 0), 0)
                    ),
                    available: Array.from({ length: maxSizeCount }, (_, i) => 
                      colors.reduce((sum, c) => sum + (c.available[i] ?? 0), 0)
                    ),
                  };
                  
                  const totalStock = sum(styleTotals.stock);
                  const totalSold = sum(styleTotals.soldSum);
                  const totalPurchase = sum(styleTotals.purchaseSum);
                  const totalAvailable = sum(styleTotals.available);
                  
                  return (
                    <div className="mt-4 pt-4 border-t-2 border-gray-300">
                      <div className="text-sm font-semibold text-gray-700 mb-2">Style Total (All Colors Combined)</div>
                      <div className="overflow-auto sl-table-wrap">
                        <table className="min-w-full text-xs sl-table">
                          <thead className="bg-blue-50">
                            <tr>
                              <th className="p-2 text-left border-b font-semibold sl-th sl-th-section" style={{ width: 160 }}>Section</th>
                              {Array.from({ length: maxSizeCount }, (_, i) => referenceSizes[i] ?? '').map((s, i) => (
                                <th key={i} className="p-2 text-right border-b font-semibold sl-th sl-th-size" style={{ width: 64 }}>{s}</th>
                              ))}
                              <th className="p-2 text-right border-b font-semibold sl-th sl-th-total" style={{ width: 72 }}>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="bg-blue-50/50">
                              <td className="p-2 border-b font-semibold whitespace-nowrap" style={{ width: 160 }}>Stock</td>
                              {styleTotals.stock.map((v, i) => (
                                <td key={i} className="p-2 border-b text-right font-semibold text-black" style={{ width: 64 }}>
                                  {i < referenceSizeCount ? v : ''}
                                </td>
                              ))}
                              <td className="p-2 border-b text-right font-bold text-black" style={{ width: 72 }}>{totalStock}</td>
                            </tr>
                            <tr className="bg-blue-50/50">
                              <td className="p-2 border-b font-semibold whitespace-nowrap" style={{ width: 160 }}>Sold</td>
                              {styleTotals.soldSum.map((v, i) => (
                                <td key={i} className="p-2 border-b text-right font-semibold text-red-600" style={{ width: 64 }}>
                                  {i < referenceSizeCount ? (Number(v) > 0 ? `-${v}` : v) : ''}
                                </td>
                              ))}
                              <td className="p-2 border-b text-right font-bold text-red-700" style={{ width: 72 }}>
                                {totalSold > 0 ? `-${totalSold}` : totalSold}
                              </td>
                            </tr>
                            <tr className="bg-blue-50/50">
                              <td className="p-2 border-b font-semibold whitespace-nowrap" style={{ width: 160 }}>Purchase</td>
                              {styleTotals.purchaseSum.map((v, i) => (
                                <td key={i} className="p-2 border-b text-right font-semibold text-green-700" style={{ width: 64 }}>
                                  {i < referenceSizeCount ? v : ''}
                                </td>
                              ))}
                              <td className="p-2 border-b text-right font-bold text-green-800" style={{ width: 72 }}>{totalPurchase}</td>
                            </tr>
                            <tr className="bg-blue-50/50">
                              <td className="p-2 font-semibold whitespace-nowrap" style={{ width: 160 }}>Available</td>
                              {styleTotals.available.map((v, i) => (
                                <td key={i} className={`p-2 text-right font-semibold ${Number(v) < 0 ? 'text-red-700' : Number(v) > 0 ? 'text-green-800' : 'text-black'}`} style={{ width: 64 }}>
                                  {i < referenceSizeCount ? v : ''}
                                </td>
                              ))}
                              <td className={`p-2 text-right font-bold ${totalAvailable < 0 ? 'text-red-700' : totalAvailable > 0 ? 'text-green-800' : 'text-black'}`} style={{ width: 72 }}>
                                {totalAvailable}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        );
      })}
      </div>

      {/* Hidden Styles Modal */}
      <Modal
        open={showHiddenModal}
        onClose={() => setShowHiddenModal(false)}
        title={`Hidden Styles (${hiddenStyles.length})`}
        maxWidth="max-w-4xl"
        footer={
          <Button onClick={() => setShowHiddenModal(false)} variant="default">
            Close
          </Button>
        }
      >
        <div className="space-y-2">
          <p className="text-sm text-gray-600 mb-4">
            These styles are in {activeListId ? 'the selected list' : 'your database'} but not currently visible due to filters or missing data.
          </p>
          <div className="overflow-auto max-h-[50vh]">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="p-2 text-left border-b font-semibold">Style No</th>
                  <th className="p-2 text-left border-b font-semibold">Name</th>
                  <th className="p-2 text-left border-b font-semibold">Supplier</th>
                  <th className="p-2 text-left border-b font-semibold">Reason</th>
                </tr>
              </thead>
              <tbody>
                {hiddenStyles.map((style, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="p-2 border-b font-mono text-xs">{style.styleNo}</td>
                    <td className="p-2 border-b">{style.name || '—'}</td>
                    <td className="p-2 border-b text-gray-600">{style.supplier || '—'}</td>
                    <td className="p-2 border-b text-gray-500">{style.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>

      {/* Checker Modal */}
      <Modal
        open={showCheckerModal}
        onClose={() => {
          setShowCheckerModal(false);
          setCheckerResults(null);
          setCheckerInput('');
        }}
        title="Stock Checker"
        maxWidth="max-w-6xl"
      >
        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-600 mb-2">
              Paste your data in the format: <code className="bg-gray-100 px-1 rounded">Style No. [TAB] Style Name [TAB] Total</code>
            </p>
            <p className="text-xs text-gray-500 mb-3">
              The checker will compare the pasted totals with the current <strong>Stock</strong> quantities (all colors combined).
            </p>
            <textarea
              className="w-full h-64 p-3 border rounded font-mono text-xs"
              placeholder="1010191	RANY	1545
1011609	ILLIE	948
1011396	KARCEMONA	899"
              value={checkerInput}
              onChange={(e) => setCheckerInput(e.target.value)}
            />
          </div>
          
          <div className="flex gap-2">
            <Button onClick={runChecker} disabled={!checkerInput.trim()}>
              Check Differences
            </Button>
            <Button 
              variant="outline" 
              onClick={() => {
                setCheckerInput('');
                setCheckerResults(null);
              }}
            >
              Clear
            </Button>
          </div>
          
          {checkerResults && (
            <div className="mt-4 space-y-4">
              {/* Summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card className="shadow-sm">
                  <CardContent className="p-3">
                    <div className="text-xs text-gray-600">Pasted Styles</div>
                    <div className="text-xl font-bold">{checkerResults.pastedCount}</div>
                  </CardContent>
                </Card>
                <Card className="shadow-sm">
                  <CardContent className="p-3">
                    <div className="text-xs text-gray-600">Current Styles</div>
                    <div className="text-xl font-bold">{checkerResults.currentCount}</div>
                  </CardContent>
                </Card>
                <Card className="shadow-sm">
                  <CardContent className="p-3">
                    <div className="text-xs text-gray-600">Mismatches</div>
                    <div className="text-xl font-bold text-orange-600">{checkerResults.mismatches}</div>
                  </CardContent>
                </Card>
                <Card className="shadow-sm">
                  <CardContent className="p-3">
                    <div className="text-xs text-gray-600">Matches</div>
                    <div className="text-xl font-bold text-green-600">{checkerResults.matches}</div>
                  </CardContent>
                </Card>
              </div>
              
              {checkerResults.missingInCurrent > 0 && (
                <div className="p-3 bg-red-50 border border-red-200 rounded">
                  <div className="text-sm font-semibold text-red-800">
                    {checkerResults.missingInCurrent} style(s) in pasted data but NOT in current stock list
                  </div>
                </div>
              )}
              
              {checkerResults.missingInPasted > 0 && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded">
                  <div className="text-sm font-semibold text-blue-800">
                    {checkerResults.missingInPasted} style(s) in current stock list but NOT in pasted data
                  </div>
                </div>
              )}
              
              {/* Differences Table */}
              <div className="border rounded overflow-hidden">
                <div className="overflow-auto max-h-96">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-100 sticky top-0">
                      <tr>
                        <th className="p-2 text-left font-semibold">Style No</th>
                        <th className="p-2 text-left font-semibold">Name</th>
                        <th className="p-2 text-right font-semibold">Pasted</th>
                        <th className="p-2 text-right font-semibold">Current</th>
                        <th className="p-2 text-right font-semibold">Diff</th>
                        <th className="p-2 text-left font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checkerResults.differences.map((diff: any, idx: number) => (
                        <tr 
                          key={idx} 
                          className={
                            diff.status === 'mismatch' ? 'bg-orange-50' :
                            diff.status === 'missing_in_current' ? 'bg-red-50' :
                            diff.status === 'missing_in_pasted' ? 'bg-blue-50' :
                            'bg-white'
                          }
                        >
                          <td className="p-2 border-t font-mono text-xs">{diff.styleNo}</td>
                          <td className="p-2 border-t">{diff.name || '-'}</td>
                          <td className="p-2 border-t text-right font-mono">{diff.pastedTotal.toLocaleString()}</td>
                          <td className="p-2 border-t text-right font-mono">{diff.currentTotal.toLocaleString()}</td>
                          <td className={`p-2 border-t text-right font-mono font-semibold ${
                            diff.diff > 0 ? 'text-green-600' :
                            diff.diff < 0 ? 'text-red-600' :
                            'text-gray-600'
                          }`}>
                            {diff.diff > 0 ? `+${diff.diff.toLocaleString()}` : diff.diff.toLocaleString()}
                          </td>
                          <td className="p-2 border-t">
                            <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                              diff.status === 'match' ? 'bg-green-100 text-green-800' :
                              diff.status === 'mismatch' ? 'bg-orange-100 text-orange-800' :
                              diff.status === 'missing_in_current' ? 'bg-red-100 text-red-800' :
                              'bg-blue-100 text-blue-800'
                            }`}>
                              {diff.status === 'match' ? '✓ Match' :
                               diff.status === 'mismatch' ? 'Mismatch' :
                               diff.status === 'missing_in_current' ? 'Not in current' :
                               'Not in pasted'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </Modal>
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

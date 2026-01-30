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

// Helper function to format update timestamp (Danish)
function formatRelativeTime(isoString: string): string {
  if (!isoString) return 'Aldrig opdateret';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Aldrig opdateret';
  const hh = date.getHours().toString().padStart(2, '0');
  const mm = date.getMinutes().toString().padStart(2, '0');
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) return `Opdateret kl. ${hh}:${mm}`;
  // Show date for older updates
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  return `Opdateret ${day}/${month} kl. ${hh}:${mm}`;
}

function flash(message: string, type: 'success' | 'error' | 'info' = 'success') {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('toast', { detail: { message, type } }));
    }
  } catch {}
}

type StockListPageProps = {
  /** When true, renders a simplified, share-friendly UI (used by /public/stock-list/[id]) */
  publicMode?: boolean;
  /** Stock list ID to lock to in public mode */
  sharedListId?: string;
};

export default function StockListPage({ publicMode = false, sharedListId = '' }: StockListPageProps) {
  const supabase = createClientComponentClient();
  const { has } = useRoles();

  // This app is statically prerendered on Vercel; using next/navigation's useSearchParams() will fail
  // unless wrapped in a Suspense boundary. We avoid that by reading/updating the URL via window/history.
  const basePath = '/styles/stock-list';
  const [baseQueryString, setBaseQueryString] = React.useState<string>('');

  // Preselect previously active list by URL (?list=) or localStorage
  const [activeListId, setActiveListId] = React.useState<string>('');
  const didInitActiveList = React.useRef(false);
  React.useEffect(() => {
    if (publicMode) return;
    try {
      setBaseQueryString(window.location.search || '');
      const listParam = new URLSearchParams(window.location.search || '').get('list');
      if (listParam !== null) {
        setActiveListId(listParam === 'all' ? '' : listParam);
        didInitActiveList.current = true;
        return;
      }
    } catch {}
    try {
      const v = localStorage.getItem('activeStockListId') || '';
      if (v) setActiveListId(v);
    } catch {}
    didInitActiveList.current = true;
  }, [publicMode]);

  // Public mode: always pin active list id to the shared list
  React.useEffect(() => {
    if (!publicMode) return;
    if (sharedListId) setActiveListId(sharedListId);
  }, [publicMode, sharedListId]);

  // Persist active list selection to URL and localStorage (private view only)
  React.useEffect(() => {
    if (publicMode) return;
    if (!didInitActiveList.current) return;

    try {
      if (activeListId) localStorage.setItem('activeStockListId', activeListId);
      else localStorage.removeItem('activeStockListId');
    } catch {}

    try {
      const url = new URL(window.location.href);
      if (activeListId) url.searchParams.set('list', activeListId);
      else url.searchParams.delete('list');
      window.history.replaceState({}, '', url.toString());
      setBaseQueryString(url.search || '');
    } catch {}
  }, [activeListId, publicMode]);
  const [searchQuery, setSearchQuery] = React.useState<string>('');
  const [scrapeBusy, setScrapeBusy] = React.useState<string | null>(null);
  const [selectedSeasons, setSelectedSeasons] = React.useState<string[]>([]);
  const [loadingProgress, setLoadingProgress] = React.useState<{ total: number; current: number } | null>(null);
  const [showCheckerModal, setShowCheckerModal] = React.useState<boolean>(false);
  const [checkerInput, setCheckerInput] = React.useState<string>('');
  const [checkerResults, setCheckerResults] = React.useState<any>(null);
  const [checkerMode, setCheckerMode] = React.useState<'styles' | 'po'>('styles');
  const [scrapingMismatches, setScrapingMismatches] = React.useState<boolean>(false);
  const [runningStockFix, setRunningStockFix] = React.useState<boolean>(false);
  const [stockFixMessage, setStockFixMessage] = React.useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [stockFixProgress, setStockFixProgress] = React.useState<{ step: string; details?: string } | null>(null);
  const [scrapeProgress, setScrapeProgress] = React.useState<{ current: number; total: number } | null>(null);
  const [scrapeMessage, setScrapeMessage] = React.useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [autoScrapeEnabled, setAutoScrapeEnabled] = React.useState<boolean>(false);
  const { data, mutate: mutateStockData } = useSWR('style_stock:list', async () => {
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
  }, { refreshInterval: 90000 }); // Refresh every 1.5 minutes

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

  // Get total count of ALL styles in database (including inactive)
  const { data: allStylesData } = useSWR('styles:all', async () => {
    const { data, error } = await supabase.from('styles').select('id, style_no, style_name, supplier, inactive');
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; style_no: string; style_name: string | null; supplier: string | null; inactive: boolean }>;
  }, { refreshInterval: 0 });
  
  // Create a map of style_no -> inactive status for quick lookup
  const styleInactiveMap = React.useMemo(() => {
    const map = new Map<string, boolean>();
    for (const style of (allStylesData ?? [])) {
      map.set(style.style_no, style.inactive ?? false);
    }
    return map;
  }, [allStylesData]);

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
    const { data, error } = await supabase.from('stock_lists').select('id, name');
    if (error) throw new Error(error.message);
    
    // Custom sort order: Aktiv, Passiv, NOOS, Nye styles, Intet, then alphabetically
    const sortOrder: Record<string, number> = {
      'Aktiv': 1,
      'Passiv': 2,
      'NOOS': 3,
      'Nye styles': 4,
      'Intet': 5,
    };
    
    const sorted = (data ?? []).sort((a, b) => {
      const aOrder = sortOrder[a.name] ?? 999;
      const bOrder = sortOrder[b.name] ?? 999;
      
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      
      // For items not in sortOrder, sort alphabetically
      return a.name.localeCompare(b.name);
    });
    
    return sorted as Array<{ id: string; name: string }>;
  });
  const { data: listStyles, mutate: mutateListStyles } = useSWR(activeListId ? ['stock-list-styles:byList', activeListId] : null, async () => {
    const { data, error } = await supabase.from('stock_list_styles').select('style_id').eq('list_id', activeListId);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ style_id: string }>;
  });
  const styleIdsInList = React.useMemo(() => new Set((listStyles ?? []).map(r => r.style_id)), [listStyles]);
  const { data: listColorRules, mutate: mutateListColorRules } = useSWR(activeListId ? ['stock_list_colors:byList', activeListId] : null, async () => {
    const { data, error } = await supabase.from('stock_list_colors').select('style_id, style_color_id, include').eq('list_id', activeListId);
    if (error) throw new Error(error.message);
    // Prefer a whitelist model when possible: allowedIdsMap holds color IDs where include === true
    const allowedIdsMap = new Map<string, Set<string>>(); // style_id -> set(style_color_id)
    // Also keep a blacklist (include === false) for backwards-compat / clarity
    const hiddenIdsMap = new Map<string, Set<string>>(); // style_id -> set(style_color_id)
    for (const r of (data ?? []) as any[]) {
      const sid = String(r.style_id || '');
      const cid = String(r.style_color_id || '');
      if (!sid || !cid) continue;
      if (r.include === false) {
        const set = hiddenIdsMap.get(sid) || new Set<string>();
        set.add(cid);
        hiddenIdsMap.set(sid, set);
      } else {
        const set = allowedIdsMap.get(sid) || new Set<string>();
        set.add(cid);
        allowedIdsMap.set(sid, set);
      }
    }
    return { allowedIdsMap, hiddenIdsMap } as {
      allowedIdsMap: Map<string, Set<string>>;
      hiddenIdsMap: Map<string, Set<string>>;
    };
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
    const map = new Map<string, Set<string>>();
    for (const r of (data ?? []) as any[]) {
      const set = map.get(r.style_color_id) || new Set<string>();
      set.add(r.season_id);
      map.set(r.style_color_id, set);
    }
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
    // When a list is selected:
    // - Prefer whitelist (only colors that exist in stock_list_colors with include=true)
    // - Fall back to blacklist (hide include=false) but DO NOT auto-add placeholders (prevents "second load" reintroducing colors)
    const filtered = out.map((row) => {
      const sid = styleMetaByNo[row.styleNo]?.id || null;
      if (!sid) return row;
      const allowedIds = (listColorRules as any)?.allowedIdsMap?.get(sid) as Set<string> | undefined;
      const hiddenIds = (listColorRules as any)?.hiddenIdsMap?.get(sid) as Set<string> | undefined;
      // Collect colorLower -> style_color_id map for this style
      const allColorKeysMap = styleColors?.idMap?.get(sid) || new Map<string, string>(); // colorLower -> style_color_id
      const whitelistActive = !!allowedIds && allowedIds.size > 0;

      // Filter current colors
      const current = row.colors.filter((c) => {
        const key = String(c.color || '').trim().toLowerCase();
        const scId = allColorKeysMap.get(key) || '';
        if (!scId) return !whitelistActive; // if we can't map, only keep it in fallback mode
        if (whitelistActive) return allowedIds!.has(String(scId));
        return !(hiddenIds?.has(String(scId)));
      });

      // Only add placeholders when whitelist is active (so we only add colors that are actually in the list)
      if (!whitelistActive) {
        const colors = current.sort((a, b) => a.color.localeCompare(b.color));
        return { ...row, colors };
      }

      const existingKeys = new Set(current.map((c) => `${row.styleNo}|${String(c.color || '').trim().toLowerCase()}`));
      const placeholders: Group[] = [];

      // Build reverse map style_color_id -> colorLower
      const idToKey = new Map<string, string>();
      for (const [ckey, scId] of Array.from(allColorKeysMap.entries())) idToKey.set(String(scId), String(ckey));

      for (const scId of Array.from(allowedIds!)) {
        const ckey = idToKey.get(String(scId));
        if (!ckey) continue;
        const key = `${row.styleNo}|${ckey}`;
        if (existingKeys.has(key)) continue;
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

      const colors = [...current, ...placeholders].sort((a, b) => a.color.localeCompare(b.color));
      return { ...row, colors };
    });
    return filtered as Array<{ styleNo: string; colors: Group[] }>;
  }, [groups, styleMetaByNo, activeListId, (listColorRules as any)?.allowedIdsMap, (listColorRules as any)?.hiddenIdsMap, styleRows, styleColors, styleIdsInList]);

  // Log selection changes and high-level counts
  React.useEffect(() => {
    if (!activeListId) {
      // eslint-disable-next-line no-console
      console.log('[stock-list] activeListId cleared (Alle)');
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

  // Public view should never be affected by private-view filters/toggles
  React.useEffect(() => {
    if (!publicMode) return;
    setSelectedSeasons([]);
    setShowStyleTotals(false);
  }, [publicMode]);

  const groupHasAnyNonZero = React.useCallback((c: Group) => {
    const anyNonZero = (arr: any[] | null | undefined) => Array.isArray(arr) && arr.some((v) => (Number(v) || 0) !== 0);
    const anyRowNonZero = (rows: Row[] | null | undefined) =>
      Array.isArray(rows) && rows.some((r) => anyNonZero(Array.isArray((r as any)?.values) ? ((r as any).values as any[]) : []));

    // If there are no size columns at all, treat as empty.
    if (!Array.isArray(c.sizes) || c.sizes.length === 0) return false;

    return (
      anyNonZero(c.stock) ||
      anyNonZero(c.soldSum) ||
      anyNonZero(c.purchaseSum) ||
      anyNonZero(c.available) ||
      anyRowNonZero(c.soldRows) ||
      anyRowNonZero(c.purchaseRows)
    );
  }, []);

  // Filter rows based on active Stock List, search, seasons, and remove empty/zero-only colors
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
      base = base.map(({ styleNo, colors }) => {
        const sid = styleMetaByNo[styleNo]?.id || null;
        if (!sid) return { styleNo, colors: [] };
        
        const cmap = styleColors.idMap?.get(sid);
        if (!cmap) return { styleNo, colors: [] };
        
        const filteredColors = colors.filter((c) => {
          const colorKey = (c.color || '').trim().toLowerCase();
          const scId = cmap.get(colorKey);
          if (!scId) return false;
          
          const thisColorSeasons = colorSeasons.get(scId);
          if (!thisColorSeasons) return false;
          
          // Color must have at least one of the selected seasons
          return selectedSeasons.some(seasonId => thisColorSeasons.has(seasonId));
        });
        
        return { styleNo, colors: filteredColors };
      }).filter(({ colors }) => colors.length > 0);
    }
    
    // Always remove colors that are empty or all-zero across all rows
    base = base
      .map(({ styleNo, colors }) => {
        const filteredColors = (colors ?? []).filter(groupHasAnyNonZero);
        return { styleNo, colors: filteredColors };
      })
      .filter(({ colors }) => (colors ?? []).length > 0);
    
    return base;
  }, [groupedByStyle, activeListId, styleIdsInList.size, searchQuery, styleMetaByNo, selectedSeasons, styleColors, colorSeasons, groupHasAnyNonZero]);

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
            'Opdateret': color.scrapedAt ? formatRelativeTime(color.scrapedAt) : 'Ikke opdateret'
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
            'Opdateret': color.scrapedAt ? formatRelativeTime(color.scrapedAt) : 'Ikke opdateret'
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
            'Opdateret': color.scrapedAt ? formatRelativeTime(color.scrapedAt) : 'Ikke opdateret'
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
            'Opdateret': color.scrapedAt ? formatRelativeTime(color.scrapedAt) : 'Ikke opdateret'
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
      const listName = activeListId ? (stockLists?.find(l => l.id === activeListId)?.name || 'List') : 'Alle';
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
  }, [allStylesData, filteredForView, activeListId, styleIdsInList, groups, searchQuery, selectedSeasons]);

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

  // Scrape mismatches function
  const scrapeMismatches = React.useCallback(async () => {
    if (!checkerResults) return;
    
    // Get style numbers that have mismatches
    let mismatchStyleNos: string[] = [];
    
    if (checkerResults.mode === 'po') {
      // For PO mode, extract unique style numbers from mismatch details
      const styleNosSet = new Set<string>();
      for (const diff of checkerResults.differences) {
        if (diff.status === 'mismatch' && diff.details) {
          for (const row of diff.details) {
            if (row.style_no) {
              styleNosSet.add(row.style_no);
            }
          }
        }
      }
      mismatchStyleNos = Array.from(styleNosSet);
    } else {
      // For styles mode, use styleNo directly
      mismatchStyleNos = checkerResults.differences
      .filter((d: any) => d.status === 'mismatch')
      .map((d: any) => d.styleNo);
    }
    
    if (mismatchStyleNos.length === 0) {
      setScrapeMessage({ type: 'info', text: 'No mismatches to scrape' });
      return;
    }
    
    try {
      setScrapingMismatches(true);
      setScrapeProgress({ current: 0, total: mismatchStyleNos.length });
      setScrapeMessage(null);
      
      // Enqueue the scrape job
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'update_style_stock',
          payload: { styleNos: mismatchStyleNos, requestedBy: 'checker' }
        })
      });
      
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `Failed (${res.status})`);
      }
      
      const { jobId } = await res.json();
      console.log(`[Scrape Started] Job ${jobId} enqueued for ${mismatchStyleNos.length} styles:`, mismatchStyleNos);
      
      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          // Check job status from Supabase
          const { data: jobData, error: jobError } = await supabase
            .from('jobs')
            .select('status')
            .eq('id', jobId)
            .single();
          
          if (jobError) {
            console.error('Error fetching job status:', jobError);
            clearInterval(pollInterval);
            return;
          }
          
          // Check logs for progress - count delete_all_success which happens for each style
          const { data: logsData, error: logsError } = await supabase
            .from('job_logs')
            .select('msg, data')
            .eq('job_id', jobId)
            .eq('msg', 'STEP:style_stock_delete_all_success')
            .order('ts', { ascending: true });
          
          if (logsError) {
            console.error('Error fetching job logs:', logsError);
          }
          
          const completedCount = logsData?.length || 0;
          console.log(`[Scrape Progress] Job ${jobId}: ${completedCount}/${mismatchStyleNos.length} styles completed (status: ${jobData.status})`);
          setScrapeProgress({ current: completedCount, total: mismatchStyleNos.length });
          
          // Check if job is finished
          if (jobData.status === 'succeeded' || jobData.status === 'failed' || jobData.status === 'cancelled') {
            clearInterval(pollInterval);
            setScrapingMismatches(false);
            
            if (jobData.status === 'succeeded') {
              setScrapeMessage({ 
                type: 'success', 
                text: `Scraping complete! ${completedCount} styles scraped. Refreshing data...` 
              });
              // Refresh the stock data without reloading the page
              setTimeout(() => mutateStockData(), 2000);
            } else {
              setScrapeMessage({ 
                type: 'error', 
                text: `Scraping ${jobData.status}. Check the Jobs page for details.` 
              });
            }
          }
        } catch (err: any) {
          console.error('Poll error:', err);
        }
      }, 3000); // Poll every 3 seconds
      
      // Stop polling after 10 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        if (scrapingMismatches) {
          setScrapingMismatches(false);
          setScrapeMessage({ 
            type: 'info', 
            text: 'Scraping is taking longer than expected. Check the Jobs page for status.' 
          });
        }
      }, 600000);
      
    } catch (err: any) {
      setScrapingMismatches(false);
      setScrapeProgress(null);
      setScrapeMessage({ 
        type: 'error', 
        text: `Failed to start scraping: ${err.message}` 
      });
    }
  }, [checkerResults, supabase, scrapingMismatches, mutateStockData]);

  // Run stock fix check function
  const runStockFixCheck = React.useCallback(async () => {
    try {
      setRunningStockFix(true);
      setStockFixMessage({ type: 'info', text: 'Starting SPY stock verification...' });
      setStockFixProgress({ step: 'Enqueuing verification job...' });
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setStockFixMessage({ type: 'error', text: 'Not signed in' });
        setStockFixProgress(null);
        setRunningStockFix(false);
        return;
      }
      
      // Enqueue the check_stock_fix job (runs on worker with Playwright)
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          Authorization: `Bearer ${session.access_token}` 
        },
        body: JSON.stringify({
          type: 'check_stock_fix',
          payload: { 
            requestedBy: session.user.email,
            manual: true
          }
        })
      });
      
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `Failed (${res.status})`);
      }
      
      const { jobId } = await res.json();
      setStockFixProgress({ step: 'Job enqueued, monitoring progress...' });
      
      // Poll for job completion
      const pollInterval = setInterval(async () => {
        try {
          const { data: jobData } = await supabase
            .from('jobs')
            .select('status')
            .eq('id', jobId)
            .single();
          
          if (!jobData) return;
          
          // Update progress based on job status
          setStockFixProgress({ step: 'Scraping SPY stock data...' });
          
            if (jobData.status === 'succeeded' || jobData.status === 'failed' || jobData.status === 'cancelled') {
            clearInterval(pollInterval);
            
            if (jobData.status === 'succeeded') {
              // Fetch the job results
              const { data: resultsData, error: resultsError } = await supabase
                .from('job_results')
                .select('data, summary')
                .eq('job_id', jobId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
              
              console.log('SPY Verification - Job Results:', {
                hasResultsData: !!resultsData,
                resultsError,
                summary: resultsData?.summary,
                dataKeys: resultsData?.data ? Object.keys(resultsData.data) : []
              });
              
              if (resultsError) {
                console.error('Error fetching job results:', resultsError);
                setRunningStockFix(false);
                setStockFixProgress(null);
                setStockFixMessage({ type: 'error', text: `Failed to fetch results: ${resultsError.message}` });
                return;
              }
              
              if (resultsData?.data) {
                const resultData = resultsData.data as any;
                const spyStyles = resultData.details || [];
                
                console.log('SPY Verification - Parsed Data:', {
                  hasDetails: !!resultData.details,
                  detailsLength: spyStyles.length,
                  detailsType: Array.isArray(spyStyles),
                  sampleDetail: spyStyles[0],
                  resultDataKeys: Object.keys(resultData)
                });
                
                if (!Array.isArray(spyStyles) || spyStyles.length === 0) {
                  console.error('SPY Verification - Invalid or empty details:', {
                    details: resultData.details,
                    resultData
                  });
                  setRunningStockFix(false);
                  setStockFixProgress(null);
                  setStockFixMessage({ 
                    type: 'error', 
                    text: `No SPY data found in results. Check job logs for details.` 
                  });
                  return;
                }
                
                setStockFixProgress({ step: 'Comparing with local stock...', details: `${spyStyles.length} styles from SPY` });
                
                // Build SPY data map
                const spyDataMap = new Map<string, { stock: number }>();
                for (const item of spyStyles) {
                  if (item.style_no) {
                    spyDataMap.set(item.style_no, { stock: item.spy_stock ?? 0 });
                  }
                }
                
                console.log('SPY Verification - SPY Data Map:', {
                  spyDataMapSize: spyDataMap.size,
                  sampleSpyData: Array.from(spyDataMap.entries()).slice(0, 5)
                });
                
                // Calculate totals per style from local stock data
                // Use ALL data (not filtered) to get complete comparison
                const currentData = new Map<string, { name: string | null; total: number }>();
                
                // Build a map of all styles from raw data (unfiltered)
                const allStylesMap = new Map<string, Map<string, Row[]>>();
                for (const r of (data ?? [])) {
                  if (!allStylesMap.has(r.style_no)) allStylesMap.set(r.style_no, new Map());
                  const byColor = allStylesMap.get(r.style_no)!;
                  if (!byColor.has(r.color)) byColor.set(r.color, []);
                  byColor.get(r.color)!.push(r);
                }
                
                // Calculate totals for each style
                for (const [styleNo, byColor] of allStylesMap.entries()) {
                  const meta = styleMetaByNo[styleNo] || { name: null };
                  let styleTotal = 0;
                  
                  for (const [color, rows] of byColor.entries()) {
                    // Get latest Stock row for this color (deduplicate by section + row_label)
                    const stockRows = rows.filter(r => r.section === 'Stock');
                    if (stockRows.length > 0) {
                      // Group by section + row_label and get latest
                      const latestByKey = new Map<string, Row>();
                      for (const r of stockRows) {
                        const key = `${r.section}|${r.row_label || ''}`;
                        const existing = latestByKey.get(key);
                        if (!existing || new Date(r.scraped_at).getTime() > new Date(existing.scraped_at).getTime()) {
                          latestByKey.set(key, r);
                        }
                      }
                      
                      // Sum all Stock rows for this color
                      for (const stockRow of latestByKey.values()) {
                        const values = Array.isArray(stockRow.values) 
                          ? stockRow.values 
                          : JSON.parse(String(stockRow.values || '[]'));
                        const colorTotal = Array.isArray(values) 
                          ? values.reduce((sum: number, v: any) => sum + (Number(v) || 0), 0) 
                          : Number(values) || 0;
                        styleTotal += colorTotal;
                      }
                    }
                  }
                  
                  currentData.set(styleNo, { name: meta.name, total: styleTotal });
                }
                
                console.log('SPY Verification - Current Data:', {
                  currentDataSize: currentData.size,
                  sampleCurrentData: Array.from(currentData.entries()).slice(0, 5)
                });
                
                // Compare and find differences
                const differences: Array<{
                  styleNo: string;
                  name: string | null;
                  pastedTotal: number;
                  currentTotal: number;
                  diff: number;
                  status: 'missing_in_pasted' | 'missing_in_current' | 'mismatch' | 'match';
                  inactive?: boolean;
                }> = [];
                
                for (const [styleNo, spyInfo] of spyDataMap.entries()) {
                  const current = currentData.get(styleNo);
                  if (!current) {
                    // Check if style is inactive in DB
                    const isInactive = styleInactiveMap.get(styleNo) ?? false;
                    differences.push({
                      styleNo,
                      name: null,
                      pastedTotal: spyInfo.stock,
                      currentTotal: 0,
                      diff: -spyInfo.stock,
                      status: 'missing_in_current',
                      inactive: isInactive
                    });
                  } else if (current.total !== spyInfo.stock) {
                    differences.push({
                      styleNo,
                      name: current.name,
                      pastedTotal: spyInfo.stock,
                      currentTotal: current.total,
                      diff: current.total - spyInfo.stock,
                      status: 'mismatch'
                    });
                  } else {
                    differences.push({
                      styleNo,
                      name: current.name,
                      pastedTotal: spyInfo.stock,
                      currentTotal: current.total,
                      diff: 0,
                      status: 'match'
                    });
                  }
                }
                
                for (const [styleNo, currentInfo] of currentData.entries()) {
                  if (!spyDataMap.has(styleNo)) {
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
                
                // Sort: mismatches first, then matches, then missing_in_current at the bottom
                differences.sort((a, b) => {
                  // Mismatches first
                  if (a.status === 'mismatch' && b.status !== 'mismatch') return -1;
                  if (a.status !== 'mismatch' && b.status === 'mismatch') return 1;
                  // Matches second
                  if (a.status === 'match' && b.status !== 'match') return -1;
                  if (a.status !== 'match' && b.status === 'match') return 1;
                  // Missing in pasted third
                  if (a.status === 'missing_in_pasted' && b.status !== 'missing_in_pasted') return -1;
                  if (a.status !== 'missing_in_pasted' && b.status === 'missing_in_pasted') return 1;
                  // Missing in current last (at the bottom)
                  if (a.status === 'missing_in_current' && b.status !== 'missing_in_current') return 1;
                  if (a.status !== 'missing_in_current' && b.status === 'missing_in_current') return -1;
                  // Within same status, sort by absolute diff descending
                  return Math.abs(b.diff) - Math.abs(a.diff);
                });
                
                const mismatchCount = differences.filter(d => d.status === 'mismatch').length;
                const missingInCurrent = differences.filter(d => d.status === 'missing_in_current').length;
                const missingInPasted = differences.filter(d => d.status === 'missing_in_pasted').length;
                const matches = differences.filter(d => d.status === 'match').length;
                
                console.log('SPY Verification Results:', {
                  spyDataMapSize: spyDataMap.size,
                  currentDataSize: currentData.size,
                  differencesLength: differences.length,
                  mismatchCount,
                  missingInCurrent,
                  missingInPasted,
                  matches,
                  sampleDifferences: differences.slice(0, 5),
                  sampleSpyStyles: Array.from(spyDataMap.entries()).slice(0, 5),
                  sampleCurrentData: Array.from(currentData.entries()).slice(0, 5)
                });
                
                // Ensure we have results to display
                if (differences.length === 0 && spyDataMap.size === 0) {
                  console.warn('SPY Verification - No data to display');
                  setRunningStockFix(false);
                  setStockFixProgress(null);
                  setStockFixMessage({ 
                    type: 'error', 
                    text: 'No data found in SPY verification results. Please check job logs.' 
                  });
                  return;
                }
                
                setCheckerResults({
                  mode: 'spy',
                  pastedCount: spyDataMap.size,
                  currentCount: currentData.size,
                  differences,
                  mismatches: mismatchCount,
                  missingInCurrent,
                  missingInPasted,
                  matches
                });
                
                console.log('SPY Verification - Results set:', {
                  mode: 'spy',
                  pastedCount: spyDataMap.size,
                  currentCount: currentData.size,
                  differencesCount: differences.length,
                  mismatches: mismatchCount
                });
                
                // If mismatches found, automatically enqueue scrape mismatches (only if auto-scrape is enabled)
                if (mismatchCount > 0 && autoScrapeEnabled) {
                  setStockFixProgress({ step: 'Mismatches found, enqueuing scrape...', details: `${mismatchCount} mismatches` });
                  
                  // Get style numbers for mismatches
                  const mismatchStyleNos = differences
                    .filter(d => d.status === 'mismatch')
                    .map(d => d.styleNo)
                    .filter(Boolean);
                  
                  try {
                    // Get fresh session token for nested async operations
                    const { data: { session: freshSession } } = await supabase.auth.getSession();
                    if (!freshSession) {
                      throw new Error('Session expired');
                    }
                    
                    // Enqueue scrape mismatches
                    const scrapeRes = await fetch('/api/enqueue', {
                      method: 'POST',
                      headers: { 
                        'Content-Type': 'application/json', 
                        Authorization: `Bearer ${freshSession.access_token}` 
                      },
                      body: JSON.stringify({
                        type: 'update_style_stock',
                        payload: { 
                          styleNos: mismatchStyleNos, 
                          requestedBy: 'check_stock_fix_auto'
                        }
                      })
                    });
                    
                    if (!scrapeRes.ok) {
                      throw new Error('Failed to enqueue scrape mismatches');
                    }
                    
                    const { jobId: scrapeJobId } = await scrapeRes.json();
                    setStockFixProgress({ step: 'Scraping mismatches...', details: `Job ${scrapeJobId}` });
                    
                    // Wait for scrape job to complete
                    const scrapePollInterval = setInterval(async () => {
                      try {
                        const { data: scrapeJobData } = await supabase
                          .from('jobs')
                          .select('status')
                          .eq('id', scrapeJobId)
                          .single();
                        
                        if (scrapeJobData?.status === 'succeeded' || scrapeJobData?.status === 'failed' || scrapeJobData?.status === 'cancelled') {
                          clearInterval(scrapePollInterval);
                          
                          if (scrapeJobData.status === 'succeeded') {
                            // After scraping, export stock lists
                            setStockFixProgress({ step: 'Exporting stock lists...' });
                            
                            // Get fresh session token again
                            const { data: { session: exportSession } } = await supabase.auth.getSession();
                            if (exportSession) {
                              const exportRes = await fetch('/api/enqueue', {
                                method: 'POST',
                                headers: { 
                                  'Content-Type': 'application/json', 
                                  Authorization: `Bearer ${exportSession.access_token}` 
                                },
                                body: JSON.stringify({
                                  type: 'export_stock_list',
                                  payload: { requestedBy: 'check_stock_fix_auto' }
                                })
                              });
                              
                              if (exportRes.ok) {
                                setStockFixProgress({ step: 'Stock list export enqueued' });
                              }
                            }
                            
                            // Refresh stock data
                            await mutateStockData();
                            
                            setRunningStockFix(false);
                            setStockFixProgress(null);
                            setStockFixMessage({ 
                              type: 'success', 
                              text: `SPY verification complete! Scraped ${mismatchCount} mismatch${mismatchCount !== 1 ? 'es' : ''} and exported stock lists.` 
                            });
                          } else {
                            setRunningStockFix(false);
                            setStockFixProgress(null);
                            setStockFixMessage({ 
                              type: 'error', 
                              text: `Scrape job ${scrapeJobData.status}. Check the Jobs page for details.` 
                            });
                          }
                        }
                      } catch (err: any) {
                        console.error('Scrape poll error:', err);
                      }
                    }, 3000);
                    
                    // Stop polling after 10 minutes
                    setTimeout(() => {
                      clearInterval(scrapePollInterval);
                    }, 600000);
                    
                  } catch (err: any) {
                    setRunningStockFix(false);
                    setStockFixProgress(null);
                    setStockFixMessage({ 
                      type: 'error', 
                      text: `Failed to enqueue scrape: ${err.message}` 
                    });
                  }
                } else {
                  // No mismatches or auto-scrape disabled, just show results
                  setRunningStockFix(false);
                  setStockFixProgress(null);
                  
                  if (mismatchCount === 0 && missingInCurrent === 0 && missingInPasted === 0) {
                    setStockFixMessage({ type: 'success', text: `SPY verification complete! All ${spyDataMap.size} styles match.` });
                  } else {
                    const autoScrapeNote = !autoScrapeEnabled && mismatchCount > 0 
                      ? ' Auto-scrape is disabled. Use the "Scrape Mismatches" button to manually scrape.' 
                      : '';
                    setStockFixMessage({ 
                      type: 'info', 
                      text: `SPY verification complete! Found ${mismatchCount} mismatch${mismatchCount !== 1 ? 'es' : ''}, ${missingInCurrent} missing in DB, ${missingInPasted} missing in SPY.${autoScrapeNote}` 
                    });
                  }
                }
              } else {
                setRunningStockFix(false);
                setStockFixProgress(null);
                setStockFixMessage({ type: 'success', text: 'SPY verification complete!' });
              }
            } else {
              setRunningStockFix(false);
              setStockFixProgress(null);
              setStockFixMessage({ type: 'error', text: `Stock check ${jobData.status}. Check the Jobs page for details.` });
            }
          }
        } catch (err: any) {
          console.error('Stock fix poll error:', err);
        }
      }, 3000);
      
      // Stop polling after 5 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        if (runningStockFix) {
          setRunningStockFix(false);
          setStockFixProgress(null);
          setStockFixMessage({ type: 'info', text: 'Stock check is taking longer than expected. Check the Jobs page for status.' });
        }
      }, 300000);
      
    } catch (err: any) {
      setRunningStockFix(false);
      setStockFixProgress(null);
      setStockFixMessage({ type: 'error', text: `Failed to verify SPY stock: ${err.message}` });
    }
  }, [supabase, groupedByStyle, styleMetaByNo, runningStockFix, styleInactiveMap, data]);


  // Export Checker results to Excel
  const exportCheckerToExcel = React.useCallback(() => {
    if (!checkerResults) return;
    
    try {
      const workbook = XLSX.utils.book_new();
      const isPO = checkerResults.mode === 'po';
      
      // Create summary data
      const summaryData = [
        [isPO ? 'Purchase Order Checker Results' : 'Stock Checker Results', '', '', '', '', '', ''],
        ['Generated', new Date().toLocaleString()],
        [''],
        ['Summary'],
        [`Pasted ${isPO ? 'POs' : 'Styles'}`, checkerResults.pastedCount],
        [`Current ${isPO ? 'POs' : 'Styles'}`, checkerResults.currentCount],
        ['Matches', checkerResults.matches],
        ['Mismatches', checkerResults.mismatches],
        ['Missing in Current', checkerResults.missingInCurrent],
        ['Missing in Pasted', checkerResults.missingInPasted],
        [''],
        ['Details'],
      ];
      
      // Add headers based on mode
      if (isPO) {
        summaryData.push(['PO Label', 'Pasted Count', 'Pasted Total', 'DB Count', 'DB Total', 'Difference', 'Status']);
      } else {
        summaryData.push(['Style No', 'Name', 'Pasted Total', 'Current Total', 'Difference', 'Status', 'Inactive']);
      }
      
      // Add all differences
      for (const diff of checkerResults.differences) {
        if (isPO) {
          summaryData.push([
            diff.poLabel,
            diff.pastedCount,
            diff.pastedTotal,
            diff.currentCount,
            diff.currentTotal,
            diff.diff,
            diff.status === 'match' ? 'Match' :
            diff.status === 'mismatch' ? 'Mismatch' :
            diff.status === 'missing_in_current' ? 'Not in current' :
            'Not in pasted'
          ]);
        } else {
        summaryData.push([
          diff.styleNo,
          diff.name || '',
          diff.pastedTotal,
          diff.currentTotal,
          diff.diff,
          diff.status === 'match' ? 'Match' :
          diff.status === 'mismatch' ? 'Mismatch' :
          diff.status === 'missing_in_current' ? 'Not in current' :
          'Not in pasted',
          diff.status === 'missing_in_current' && diff.inactive ? 'Yes' : ''
        ]);
        }
      }
      
      const worksheet = XLSX.utils.aoa_to_sheet(summaryData);
      
      // Set column widths based on mode
      if (isPO) {
        worksheet['!cols'] = [
          { wch: 20 }, // PO Label
          { wch: 15 }, // Pasted Count
          { wch: 15 }, // Pasted Total
          { wch: 15 }, // DB Count
          { wch: 15 }, // DB Total
          { wch: 15 }, // Difference
          { wch: 20 }  // Status
        ];
      } else {
        worksheet['!cols'] = [
          { wch: 15 }, // Style No
          { wch: 25 }, // Name
          { wch: 15 }, // Pasted Total
          { wch: 15 }, // Current Total
          { wch: 15 }, // Difference
          { wch: 20 }, // Status
          { wch: 12 }  // Inactive
        ];
      }
      
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Checker Results');
      
      const filename = `stock-checker-${new Date().toISOString().split('T')[0]}.xlsx`;
      XLSX.writeFile(workbook, filename);
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    }
  }, [checkerResults]);

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
        mode: 'styles',
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

  // Purchase Order Checker
  const runPOChecker = React.useCallback(() => {
    try {
      const lines = checkerInput.trim().split('\n');
      const pastedPOs = new Map<string, { count: number; total: number; lines: string[] }>();
      
      // Helper function to extract base PO number from label (e.g., "PO7376 ETA 2025-11-06" -> "PO7376")
      const extractPONumber = (label: string): string | null => {
        const trimmed = label.trim();
        if (!trimmed) return null;
        // Match PO pattern at the start (e.g., PO7376, BR7317, etc.)
        const match = trimmed.match(/^([A-Z]{1,3}\d+(?:-\d+)?)/i);
        return match && match[1] ? match[1].toUpperCase() : null;
      };
      
      // Parse pasted PO data - format: PO7376, 480 or PO7376<TAB>480
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Handle comma or tab separated
        const parts = trimmed.includes('\t') ? trimmed.split('\t') : trimmed.split(',');
        if (parts.length < 2) continue;
        
        const poLabelRaw = parts[0]?.trim() || '';
        const qtyStr = parts[1]?.trim().replace(/[^0-9-]/g, '') || '';
        
        if (!poLabelRaw || !qtyStr) continue;
        
        // Extract base PO number from pasted label (handles cases like "PO7376 ETA 2025-11-06")
        const basePONumber = extractPONumber(poLabelRaw);
        if (!basePONumber) continue;
        
        const qty = parseInt(qtyStr, 10);
        if (isNaN(qty)) continue;
        
        // Aggregate by base PO number
        const existing = pastedPOs.get(basePONumber) || { count: 0, total: 0, lines: [] };
        existing.count += 1;
        existing.total += qty;
        existing.lines.push(trimmed);
        pastedPOs.set(basePONumber, existing);
      }
      
      // Get current PO data from database - aggregate purchase rows
      const currentPOs = new Map<string, { count: number; total: number; rows: Array<{ style_no: string; color: string; row_label: string; qty: number }> }>();
      
      // Aggregate from purchaseRows in groups
      for (const { styleNo, colors } of groupedByStyle) {
        for (const color of colors) {
          for (const purchaseRow of color.purchaseRows) {
            const fullLabel = String(purchaseRow.row_label || '').trim();
            if (!fullLabel) continue;
            
            // Extract base PO number (e.g., "PO7376" from "PO7376 ETA 2025-11-06")
            const basePONumber = extractPONumber(fullLabel);
            if (!basePONumber) continue;
            
            // Calculate total qty for this PO row
            const values = Array.isArray(purchaseRow.values) 
              ? purchaseRow.values 
              : JSON.parse(String(purchaseRow.values || '[]'));
            const qty = Array.isArray(values) 
              ? values.reduce((sum, v) => sum + (Number(v) || 0), 0)
              : Number(values) || 0;
            
            // Group by base PO number (not full label)
            const existing = currentPOs.get(basePONumber) || { count: 0, total: 0, rows: [] };
            existing.count += 1;
            existing.total += qty;
            existing.rows.push({
              style_no: styleNo,
              color: color.color,
              row_label: fullLabel, // Keep full label for reference
              qty
            });
            currentPOs.set(basePONumber, existing);
          }
        }
      }
      
      // Compare and find differences
      const differences: Array<{
        poLabel: string;
        pastedCount: number;
        pastedTotal: number;
        currentCount: number;
        currentTotal: number;
        diff: number;
        status: 'missing_in_current' | 'missing_in_pasted' | 'mismatch' | 'match';
        details?: Array<{ style_no: string; color: string; qty: number }>;
      }> = [];
      
      // Check all pasted POs
      for (const [poLabel, pastedInfo] of pastedPOs.entries()) {
        const current = currentPOs.get(poLabel);
        if (!current) {
          differences.push({
            poLabel,
            pastedCount: pastedInfo.count,
            pastedTotal: pastedInfo.total,
            currentCount: 0,
            currentTotal: 0,
            diff: -pastedInfo.total,
            status: 'missing_in_current'
          });
        } else if (current.total !== pastedInfo.total) {
          differences.push({
            poLabel,
            pastedCount: pastedInfo.count,
            pastedTotal: pastedInfo.total,
            currentCount: current.count,
            currentTotal: current.total,
            diff: current.total - pastedInfo.total,
            status: 'mismatch',
            details: current.rows
          });
        } else {
          differences.push({
            poLabel,
            pastedCount: pastedInfo.count,
            pastedTotal: pastedInfo.total,
            currentCount: current.count,
            currentTotal: current.total,
            diff: 0,
            status: 'match',
            details: current.rows
          });
        }
      }
      
      // Check for POs in current but not in pasted
      for (const [poLabel, currentInfo] of currentPOs.entries()) {
        if (!pastedPOs.has(poLabel)) {
          differences.push({
            poLabel,
            pastedCount: 0,
            pastedTotal: 0,
            currentCount: currentInfo.count,
            currentTotal: currentInfo.total,
            diff: currentInfo.total,
            status: 'missing_in_pasted',
            details: currentInfo.rows
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
        mode: 'po',
        pastedCount: pastedPOs.size,
        currentCount: currentPOs.size,
        differences,
        mismatches: differences.filter(d => d.status === 'mismatch').length,
        missingInCurrent: differences.filter(d => d.status === 'missing_in_current').length,
        missingInPasted: differences.filter(d => d.status === 'missing_in_pasted').length,
        matches: differences.filter(d => d.status === 'match').length
      });
    } catch (err: any) {
      alert(`Error parsing PO data: ${err.message}`);
    }
  }, [checkerInput, groupedByStyle]);

  return (
    <div className="space-y-4 sl-root">
      <div>
        <div className="text-xs text-gray-500 sl-header-eyebrow">Styles</div>
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-2xl font-semibold sl-header-title">
            {publicMode ? (stockLists?.find((l) => l.id === activeListId)?.name || 'Stock List') : 'Stock List'}
          </h1>
          {!publicMode && (
            <>
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
            </>
          )}
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
        {!publicMode && (
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
        )}
      </div>

      {/* Scraping Progress Banner - Outside Modal */}
      {!publicMode && scrapingMismatches && scrapeProgress && (
        <Card className="shadow-sm border-blue-300 bg-blue-50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-semibold text-blue-900">
                  🔄 Scraping mismatches in progress...
                </div>
                <div className="text-xs text-blue-700 mt-1">
                  Progress: {scrapeProgress.current} / {scrapeProgress.total} styles 
                  ({Math.round((scrapeProgress.current / scrapeProgress.total) * 100)}%)
                </div>
              </div>
            </div>
            <ProgressBar 
              value={scrapeProgress.current} 
              max={scrapeProgress.total} 
              showLabel={true}
            />
          </CardContent>
        </Card>
      )}

      {/* Scraping Complete/Error Message Banner */}
      {!publicMode && !scrapingMismatches && scrapeMessage && (
        <Card className={`shadow-sm ${
          scrapeMessage.type === 'success' ? 'border-green-300 bg-green-50' :
          scrapeMessage.type === 'error' ? 'border-red-300 bg-red-50' :
          'border-blue-300 bg-blue-50'
        }`}>
          <CardContent className="p-4">
            <div className={`text-sm font-semibold ${
              scrapeMessage.type === 'success' ? 'text-green-900' :
              scrapeMessage.type === 'error' ? 'text-red-900' :
              'text-blue-900'
            }`}>
              {scrapeMessage.type === 'success' ? '✓ ' : 
               scrapeMessage.type === 'error' ? '✗ ' : 
               'ℹ️ '}
              {scrapeMessage.text}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stock List Tabs and Filters in Single Row */}
      <Card className="shadow-sm">
        <CardContent className="p-3">
          <div className="space-y-3">
            {/* Stock List Tabs */}
            {!publicMode && (
              <Tabs value={activeListId || 'all'} onValueChange={(v) => setActiveListId(v === 'all' ? '' : v)}>
                <TabsList className="w-full justify-start">
                  {(stockLists ?? []).map((row) => {
                    const next = new URLSearchParams(baseQueryString || '');
                    next.set('list', row.id);
                    const qs = next.toString();
                    const href = qs ? `${basePath}?${qs}` : basePath;
                    return (
                      <TabsTrigger key={row.id} value={row.id} asChild>
                        <a href={href}>{row.name}</a>
                      </TabsTrigger>
                    );
                  })}
                  {(() => {
                    const next = new URLSearchParams(baseQueryString || '');
                    next.delete('list');
                    const qs = next.toString();
                    const href = qs ? `${basePath}?${qs}` : basePath;
                    return (
                      <TabsTrigger value="all" asChild>
                        <a href={href}>Alle</a>
                      </TabsTrigger>
                    );
                  })()}
                </TabsList>
              </Tabs>
            )}
            
            {/* All Filters in One Row */}
            <div className="flex items-center gap-3 flex-wrap">
              <Input
                placeholder="Search style no, name or color…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-64"
              />
              
              {!publicMode && (
                <>
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
                      checked={showStyleTotals}
                      onChange={(e) => setShowStyleTotals(e.target.checked)}
                      className="h-4 w-4 rounded accent-slate-900"
                    />
                    <span>Display style totals</span>
                  </label>
                  
                  {selectedSeasons.length > 0 && (
                    <button
                      onClick={() => {
                        setSelectedSeasons([]);
                      }}
                      className="text-sm text-slate-600 hover:text-slate-900 underline"
                    >
                      Clear filters
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      {/* Scrape active list */}
      {!publicMode && activeListId && (
        <div className="flex items-center justify-end">
          <ScrapeActiveListButton
            listId={activeListId}
            styleIdsInList={Array.from(styleIdsInList)}
            listName={stockLists?.find(l => l.id === activeListId)?.name}
            onDataRefresh={mutateStockData}
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
                <div className="flex items-start gap-5 sl-style-header">
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
                  const sid = styleMetaByNo[g.styleNo]?.id || null;
                  const cmap = sid ? (styleColors?.idMap?.get(sid) || new Map<string, string>()) : new Map<string, string>();
                  const scId = cmap.get((g.color || '').trim().toLowerCase()) || null;
                  return (
                  <div key={key} className="space-y-1 sl-color-block">
                      {/* Display seasons and scraped timestamp */}
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <div className="text-[12px] text-gray-500">
                      {(() => {
                        const set = (scId && colorSeasons) ? (colorSeasons.get(scId) || new Set<string>()) : new Set<string>();
                        const labels = (seasons || []).filter(s => set.has(s.id));
                        
                        if (labels.length === 0) return null;
                        
                            return labels.map(s => `${s.name}${s.year ? ` ${s.year}` : ''}`).join(', ');
                      })()}
                        </div>
                        <div className="ml-auto text-[10px] text-gray-400 italic">
                          {g.scrapedAt ? formatRelativeTime(g.scrapedAt) : 'Ikke opdateret endnu'}
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
                            <td className="p-2 border-b align-top sl-cell sl-cell-color" rowSpan={4} style={{ width: 140 }}>
                              <div className="space-y-2">
                                <div className="font-medium text-slate-900">{g.color}</div>
                                {!publicMode && activeListId && (stockLists?.length ?? 0) > 0 && (
                                  <div className="space-y-1">
                                    <div className="text-[10px] text-gray-500">List</div>
                                    <select
                                      className="w-full rounded border px-2 py-1 text-[11px] bg-white"
                                      value={activeListId}
                                      disabled={!sid || !scId}
                                      onChange={async (e) => {
                                        const destinationListId = e.target.value;
                                        if (!destinationListId || destinationListId === activeListId) return;
                                        if (!sid || !scId) return;
                                        try {
                                          const destName = stockLists?.find((l) => l.id === destinationListId)?.name || 'destination list';

                                          // Ensure style exists in destination list
                                          const { error: styleErr } = await supabase
                                            .from('stock_list_styles')
                                            .upsert({ list_id: destinationListId, style_id: sid } as any, { onConflict: 'list_id,style_id', ignoreDuplicates: true } as any);
                                          if (styleErr) throw styleErr;

                                          // Add (or reactivate) color in destination list
                                          const { error: colorErr } = await supabase
                                            .from('stock_list_colors')
                                            .upsert({ list_id: destinationListId, style_id: sid, style_color_id: scId, include: true } as any, { onConflict: 'list_id,style_color_id' } as any);
                                          if (colorErr) throw colorErr;

                                          // Remove from current list by excluding it
                                          const { error: excludeErr } = await supabase
                                            .from('stock_list_colors')
                                            .update({ include: false })
                                            .eq('list_id', activeListId)
                                            .eq('style_color_id', scId);
                                          if (excludeErr) throw excludeErr;

                                          // If that was the last included color for this style in the current list, remove the style from the list
                                          const { count: remainingCount, error: remainingErr } = await supabase
                                            .from('stock_list_colors')
                                            .select('*', { count: 'exact', head: true })
                                            .eq('list_id', activeListId)
                                            .eq('style_id', sid)
                                            .eq('include', true);
                                          if (remainingErr) throw remainingErr;
                                          if ((remainingCount ?? 0) === 0) {
                                            await supabase.from('stock_list_styles').delete().eq('list_id', activeListId).eq('style_id', sid);
                                          }

                                          await mutateListColorRules?.();
                                          await mutateListStyles?.();
                                          flash(`Moved ${g.color} to "${destName}"`, 'success');
                                        } catch (err: any) {
                                          flash(err?.message || 'Failed to move color', 'error');
                                        }
                                      }}
                                    >
                                      {(stockLists ?? []).map((l) => (
                                        <option key={l.id} value={l.id}>
                                          {l.name}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                              </div>
                            </td>
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
      {!publicMode && (
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
      )}

      {/* Checker Modal */}
      {!publicMode && (
        <Modal
          open={showCheckerModal}
          onClose={() => {
            setShowCheckerModal(false);
            setCheckerResults(null);
            setCheckerInput('');
            setCheckerMode('styles');
          }}
          title="Stock Checker"
          maxWidth="max-w-6xl"
        >
          <div className="space-y-4">
          {/* Tabs */}
          <div className="flex gap-2 border-b">
            <button
              onClick={() => {
                setCheckerMode('styles');
                setCheckerResults(null);
                setCheckerInput('');
              }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                checkerMode === 'styles'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Style Checker
            </button>
            <button
              onClick={() => {
                setCheckerMode('po');
                setCheckerResults(null);
                setCheckerInput('');
              }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                checkerMode === 'po'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Purchase Order Checker
            </button>
          </div>

          <div>
            {checkerMode === 'styles' ? (
              <>
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
              </>
            ) : (
              <>
                <p className="text-sm text-gray-600 mb-2">
                  Paste your PO data in the format: <code className="bg-gray-100 px-1 rounded">PO7376, 480</code> or <code className="bg-gray-100 px-1 rounded">PO7376 [TAB] 480</code>
                </p>
                <p className="text-xs text-gray-500 mb-3">
                  The checker will aggregate duplicate PO numbers (count occurrences, sum totals) and compare with Purchase Order rows in the database.
                </p>
                <textarea
                  className="w-full h-64 p-3 border rounded font-mono text-xs"
                  placeholder="PO7376, 480
PO7375, 460
PO7374, 260
PO7332, 2100"
                  value={checkerInput}
                  onChange={(e) => setCheckerInput(e.target.value)}
                />
              </>
            )}
          </div>
          
          <div className="flex gap-2 flex-wrap">
            <Button 
              onClick={checkerMode === 'styles' ? runChecker : runPOChecker} 
              disabled={!checkerInput.trim() || scrapingMismatches || runningStockFix}
            >
              Check Differences
            </Button>
            {checkerResults && checkerResults.mismatches > 0 && (() => {
              let scrapeText = 'Scraping...';
              if (!scrapingMismatches) {
                if (checkerResults.mode === 'po') {
                  // Calculate unique style count from mismatch details
                  const styleNosSet = new Set<string>();
                  for (const diff of checkerResults.differences) {
                    if (diff.status === 'mismatch' && diff.details) {
                      for (const row of diff.details) {
                        if (row.style_no) {
                          styleNosSet.add(row.style_no);
                        }
                      }
                    }
                  }
                  const styleCount = styleNosSet.size;
                  scrapeText = `Scrape ${styleCount} Style${styleCount !== 1 ? 's' : ''} (PO Mismatches)`;
                } else {
                  scrapeText = `Scrape ${checkerResults.mismatches} Mismatches`;
                }
              }
              return (
              <Button 
                onClick={scrapeMismatches} 
                variant="default"
                disabled={scrapingMismatches}
                className="bg-orange-600 hover:bg-orange-700"
              >
                  {scrapeText}
              </Button>
              );
            })()}
            {checkerResults && (
              <Button onClick={exportCheckerToExcel} variant="outline" disabled={scrapingMismatches || runningStockFix}>
                Export to Excel
              </Button>
            )}
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoScrapeEnabled}
                  onChange={(e) => setAutoScrapeEnabled(e.target.checked)}
                  disabled={runningStockFix || scrapingMismatches}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-gray-700">Auto-scrape mismatches</span>
              </label>
              <Button 
                onClick={runStockFixCheck}
                variant="default"
                disabled={runningStockFix || scrapingMismatches}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {runningStockFix ? 'Running...' : 'Run SPY Stock Verification'}
              </Button>
            </div>
            <Button 
              variant="outline" 
              onClick={() => {
                setCheckerInput('');
                setCheckerResults(null);
                setScrapeProgress(null);
                setStockFixMessage(null);
                setStockFixProgress(null);
              }}
              disabled={scrapingMismatches || runningStockFix}
            >
              Clear
            </Button>
          </div>
          
          {scrapingMismatches && scrapeProgress && (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded">
              <p className="text-sm font-semibold text-blue-900 mb-2">
                ⚠️ Scraping in progress - This might take a few minutes, please don't close this popup
              </p>
              <div className="mb-2">
                <div className="text-sm text-blue-700">
                  Progress: {scrapeProgress.current} / {scrapeProgress.total} styles scraped
                </div>
              </div>
              <ProgressBar 
                value={scrapeProgress.current} 
                max={scrapeProgress.total} 
                showLabel={true}
              />
            </div>
          )}
          
          {scrapeMessage && (
            <div className={`mt-4 p-4 border rounded ${
              scrapeMessage.type === 'success' ? 'bg-green-50 border-green-200' :
              scrapeMessage.type === 'error' ? 'bg-red-50 border-red-200' :
              'bg-blue-50 border-blue-200'
            }`}>
              <p className={`text-sm font-semibold ${
                scrapeMessage.type === 'success' ? 'text-green-900' :
                scrapeMessage.type === 'error' ? 'text-red-900' :
                'text-blue-900'
              }`}>
                {scrapeMessage.type === 'success' ? '✓ ' : 
                 scrapeMessage.type === 'error' ? '✗ ' : 
                 'ℹ️ '}
                {scrapeMessage.text}
              </p>
            </div>
          )}
          
          {runningStockFix && stockFixProgress && (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded">
              <p className="text-sm font-semibold text-blue-900 mb-2">
                🔍 SPY Stock Verification in Progress
              </p>
              <div className="space-y-1">
                <div className="text-sm text-blue-700">
                  Status: <span className="font-medium">{stockFixProgress.step}</span>
                </div>
                {stockFixProgress.details && (
                  <div className="text-xs text-blue-600">
                    {stockFixProgress.details}
                  </div>
                )}
              </div>
              <div className="mt-3">
                <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-600 animate-pulse" style={{ width: '100%' }} />
                </div>
              </div>
            </div>
          )}
          
          {stockFixMessage && (
            <div className={`mt-4 p-4 border rounded ${
              stockFixMessage.type === 'success' ? 'bg-green-50 border-green-200' :
              stockFixMessage.type === 'error' ? 'bg-red-50 border-red-200' :
              'bg-blue-50 border-blue-200'
            }`}>
              <p className={`text-sm font-semibold ${
                stockFixMessage.type === 'success' ? 'text-green-900' :
                stockFixMessage.type === 'error' ? 'text-red-900' :
                'text-blue-900'
              }`}>
                {stockFixMessage.type === 'success' ? '✓ ' : 
                 stockFixMessage.type === 'error' ? '✗ ' : 
                 'ℹ️ '}
                {stockFixMessage.text}
              </p>
            </div>
          )}
          
          {checkerResults && (
            <div className="mt-4 space-y-4">
              {/* Summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card className="shadow-sm">
                  <CardContent className="p-3">
                    <div className="text-xs text-gray-600">
                      {checkerResults.mode === 'po' ? 'Pasted POs' : 
                       checkerResults.mode === 'spy' ? 'SPY Styles' : 
                       'Pasted Styles'}
                    </div>
                    <div className="text-xl font-bold">{checkerResults.pastedCount}</div>
                  </CardContent>
                </Card>
                <Card className="shadow-sm">
                  <CardContent className="p-3">
                    <div className="text-xs text-gray-600">
                      {checkerResults.mode === 'po' ? 'Current POs' : 
                       checkerResults.mode === 'spy' ? 'DB Styles' : 
                       'Current Styles'}
                    </div>
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
                    {checkerResults.missingInCurrent} {checkerResults.mode === 'po' ? 'PO(s)' : 'style(s)'} in {checkerResults.mode === 'spy' ? 'SPY' : 'pasted data'} but NOT in current database
                  </div>
                </div>
              )}
              
              {checkerResults.missingInPasted > 0 && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded">
                  <div className="text-sm font-semibold text-blue-800">
                    {checkerResults.missingInPasted} {checkerResults.mode === 'po' ? 'PO(s)' : 'style(s)'} in current database but NOT in {checkerResults.mode === 'spy' ? 'SPY' : 'pasted data'}
                  </div>
                </div>
              )}
              
              {/* Differences Table */}
              <div className="border rounded overflow-hidden">
                <div className="overflow-auto max-h-96">
                  {checkerResults.mode === 'po' ? (
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-100 sticky top-0">
                        <tr>
                          <th className="p-2 text-left font-semibold">PO Label</th>
                          <th className="p-2 text-right font-semibold">Pasted Count</th>
                          <th className="p-2 text-right font-semibold">Pasted Total</th>
                          <th className="p-2 text-right font-semibold">DB Count</th>
                          <th className="p-2 text-right font-semibold">DB Total</th>
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
                            <td className="p-2 border-t font-mono text-xs">{diff.poLabel}</td>
                            <td className="p-2 border-t text-right font-mono">{diff.pastedCount}</td>
                            <td className="p-2 border-t text-right font-mono">{diff.pastedTotal.toLocaleString()}</td>
                            <td className="p-2 border-t text-right font-mono">{diff.currentCount}</td>
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
                  ) : (
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-100 sticky top-0">
                      <tr>
                        <th className="p-2 text-left font-semibold">Style No</th>
                        <th className="p-2 text-left font-semibold">Name</th>
                        <th className="p-2 text-right font-semibold">{checkerResults.mode === 'spy' ? 'SPY' : 'Pasted'}</th>
                        <th className="p-2 text-right font-semibold">{checkerResults.mode === 'spy' ? 'DB' : 'Current'}</th>
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
                          <td className="p-2 border-t">
                            {diff.name || '-'}
                            {diff.status === 'missing_in_current' && diff.inactive && (
                              <span className="ml-2 text-xs text-gray-500">(Inactive)</span>
                            )}
                          </td>
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
                            {diff.status === 'missing_in_current' && diff.inactive && (
                              <span className="ml-2 text-xs text-gray-600 italic">(Inactive in DB)</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  )}
                </div>
              </div>
            </div>
          )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ScrapeActiveListButton({ listId, styleIdsInList, listName, onDataRefresh }: { listId: string; styleIdsInList: string[]; listName?: string; onDataRefresh?: () => void }) {
  const supabase = createClientComponentClient();
  const [busy, setBusy] = React.useState(false);
  const [scraping, setScraping] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [scrapeProgress, setScrapeProgress] = React.useState<{ current: number; total: number } | null>(null);
  const [exportProgress, setExportProgress] = React.useState<{ current: number; total: number } | null>(null);
  const [message, setMessage] = React.useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [latestExport, setLatestExport] = React.useState<{ id: string; title: string; public_url: string | null; created_at: string } | null>(null);

  // Fetch latest export for this list
  const { data: exportsData, mutate: mutateExports } = useSWR(
    listName ? ['stock-list-exports', listId, listName] : null,
    async () => {
      if (!listName) return null;
      // Query all stock list exports and filter by list name in metadata
      const { data, error } = await supabase
        .from('exports')
        .select('id, title, public_url, created_at, meta')
        .eq('kind', 'stock_list_pdf')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      // Filter by list name in metadata
      const filtered = (data ?? []).filter((exp: any) => {
        const meta = exp.meta || {};
        return meta.list === listName || exp.title?.includes(listName);
      });
      const latest = filtered[0];
      return latest ? {
        id: latest.id,
        title: latest.title || '',
        public_url: latest.public_url || null,
        created_at: latest.created_at || new Date().toISOString()
      } as { id: string; title: string; public_url: string | null; created_at: string } : null;
    },
    { refreshInterval: 90000 } // Refresh every 1.5 minutes
  );

  React.useEffect(() => {
    if (exportsData) {
      setLatestExport(exportsData);
    }
  }, [exportsData]);

  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Dannet lige nu';
    if (diffMins < 60) return `Dannet for ${diffMins} min siden`;
    if (diffHours < 24) return `Dannet for ${diffHours} time${diffHours !== 1 ? 'r' : ''} siden`;
    if (diffDays < 7) return `Dannet for ${diffDays} dag${diffDays !== 1 ? 'e' : ''} siden`;
    return `Dannet ${date.toLocaleDateString('da-DK')}`;
  };

  return (
    <div className="space-y-2 w-full">
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-2">
          {latestExport && latestExport.public_url && (
            <>
              <a
                href={latestExport.public_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                PDF
              </a>
              <span className="text-xs text-gray-500">{formatRelativeTime(latestExport.created_at)}</span>
            </>
          )}
        </div>
        
    <Button
      size="sm"
          variant={busy || scraping || exporting ? 'secondary' : 'default'}
          disabled={busy || scraping || exporting}
      onClick={async () => {
        try {
          setBusy(true);
              setScraping(false);
              setExporting(false);
              setScrapeProgress(null);
              setExportProgress(null);
              setMessage(null);
              
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
              
              // Enqueue scrape job
          const res = await fetch('/api/enqueue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ type: 'update_style_stock', payload: { requestedBy: session.user.email, styleNos: nos } })
          });
          if (!res.ok) {
            const t = await res.text().catch(()=>'');
            throw new Error(t || `Failed (${res.status})`);
          }
              
              const { jobId } = await res.json();
              setBusy(false);
              setScraping(true);
              setScrapeProgress({ current: 0, total: nos.length });
              
              // Poll for scrape progress
              const scrapePollInterval = setInterval(async () => {
                try {
                  const { data: jobData } = await supabase
                    .from('jobs')
                    .select('status')
                    .eq('id', jobId)
                    .single();
                  
                  if (!jobData) return;
                  
                  // Check logs for progress
                  const { data: logsData } = await supabase
                    .from('job_logs')
                    .select('msg, data')
                    .eq('job_id', jobId)
                    .eq('msg', 'STEP:style_stock_delete_all_success')
                    .order('ts', { ascending: true });
                  
                  const completedCount = logsData?.length || 0;
                  setScrapeProgress({ current: completedCount, total: nos.length });
                  
                  if (jobData.status === 'succeeded' || jobData.status === 'failed' || jobData.status === 'cancelled') {
                    clearInterval(scrapePollInterval);
                    setScraping(false);
                    
                    if (jobData.status === 'succeeded') {
                      setMessage({ type: 'success', text: 'Scraping complete! Starting export...' });
                      
                      // Trigger export job
                      setExporting(true);
                      setExportProgress({ current: 0, total: 1 });
                      
                      const exportRes = await fetch('/api/enqueue', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                        body: JSON.stringify({ type: 'export_stock_list', payload: {} })
                      });
                      
                      if (!exportRes.ok) {
                        const t = await exportRes.text().catch(()=>'');
                        throw new Error(t || `Export failed (${exportRes.status})`);
                      }
                      
                      const { jobId: exportJobId } = await exportRes.json();
                      
                      // Poll for export completion
                      const exportPollInterval = setInterval(async () => {
                        try {
                          const { data: exportJobData } = await supabase
                            .from('jobs')
                            .select('status')
                            .eq('id', exportJobId)
                            .single();
                          
                          if (!exportJobData) return;
                          
                          setExportProgress({ current: 1, total: 1 });
                          
                          if (exportJobData.status === 'succeeded' || exportJobData.status === 'failed' || exportJobData.status === 'cancelled') {
                            clearInterval(exportPollInterval);
                            setExporting(false);
                            setExportProgress(null);
                            
                            if (exportJobData.status === 'succeeded') {
                              setMessage({ type: 'success', text: 'Export complete!' });
                              // Refresh exports list
                              await mutateExports();
                              // Refresh stock data without reloading the page
                              if (onDataRefresh) {
                                setTimeout(() => onDataRefresh(), 2000);
                              }
                            } else {
                              setMessage({ type: 'error', text: `Export ${exportJobData.status}. Check the Jobs page for details.` });
                            }
                          }
                        } catch (err: any) {
                          console.error('Export poll error:', err);
                        }
                      }, 2000);
                      
                      // Stop polling after 5 minutes
                      setTimeout(() => {
                        clearInterval(exportPollInterval);
                        if (exporting) {
                          setExporting(false);
                          setMessage({ type: 'info', text: 'Export is taking longer than expected. Check the Jobs page for status.' });
                        }
                      }, 300000);
                    } else {
                      setMessage({ type: 'error', text: `Scraping ${jobData.status}. Check the Jobs page for details.` });
                    }
                  }
                } catch (err: any) {
                  console.error('Scrape poll error:', err);
                }
              }, 2000);
              
              // Stop polling after 10 minutes
              setTimeout(() => {
                clearInterval(scrapePollInterval);
                if (scraping) {
                  setScraping(false);
                  setMessage({ type: 'info', text: 'Scraping is taking longer than expected. Check the Jobs page for status.' });
                }
              }, 600000);
              
        } catch (e: any) {
          setBusy(false);
              setScraping(false);
              setExporting(false);
              alert(e?.message || 'Failed to enqueue scrape');
        }
      }}
    >
          {busy ? 'Starting...' : scraping ? 'Scraping...' : exporting ? 'Exporting...' : 'Scrape List'}
    </Button>
      </div>
      
      {(scraping || exporting) && (
        <div className="space-y-2">
          {scraping && scrapeProgress && (
            <div className="space-y-1">
              <div className="text-xs text-gray-600">Scraping progress: {scrapeProgress.current} / {scrapeProgress.total} styles</div>
              <ProgressBar value={scrapeProgress.current} max={scrapeProgress.total} showLabel={true} />
            </div>
          )}
          {exporting && exportProgress && (
            <div className="space-y-1">
              <div className="text-xs text-gray-600">Exporting stock list PDF...</div>
              <ProgressBar value={exportProgress.current} max={exportProgress.total} showLabel={true} />
            </div>
          )}
        </div>
      )}
      
      {message && (
        <div className={`text-xs p-2 rounded ${
          message.type === 'success' ? 'bg-green-50 text-green-800' :
          message.type === 'error' ? 'bg-red-50 text-red-800' :
          'bg-blue-50 text-blue-800'
        }`}>
          {message.text}
        </div>
      )}
    </div>
  );
}


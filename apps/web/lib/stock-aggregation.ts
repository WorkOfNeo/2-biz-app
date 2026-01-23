/**
 * Stock Data Aggregation Utility
 * 
 * Shared logic for aggregating style_stock data, used by both:
 * - /styles/stock-list (display)
 * - /purchase/call-off/Quick PO (analysis)
 * 
 * This ensures consistent stock calculations across the app.
 */

export type StockRow = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  po_link: string | null;
  scraped_at: string;
};

export type AggregatedStockData = {
  sizes: string[];
  stock: number[];
  soldSum: number[];
  purchaseSum: number[];
  netNeed: number[]; // stock - sold + purchase
  stockTotal: number;
  soldTotal: number;
  purchaseTotal: number;
  netNeedTotal: number;
  soldRows: Array<{
    section: string;
    row_label: string | null;
    sizes: string[];
    values: number[];
    total: number;
  }>;
  purchaseRows: Array<{
    section: string;
    row_label: string | null;
    sizes: string[];
    values: number[];
    total: number;
  }>;
  scrapedAt: string; // Latest scraped_at timestamp
};

/**
 * Ensure array has correct length and all values are numbers
 */
function ensureNums(arr: any[], len: number): number[] {
  return Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);
}

/**
 * Aggregate stock data for a specific style_no and color combination.
 * 
 * This matches the logic from /styles/stock-list/page.tsx:
 * - Deduplicates by keeping latest scraped_at per (section, row_label)
 * - Handles unnamed POs (NULL row_label) as separate entries
 * - Aggregates Stock, Sold, and Purchase sections
 */
/**
 * Fuzzy match color - handles cases like "WHITE" matching "807 WHITE" or "BLACK" matching "807 BLACK"
 * 
 * IMPORTANT: Prevents false matches like "WHITE" matching "WHITE WEFT"
 */
function fuzzyMatchColor(rowColor: string, targetColor: string): boolean {
  const rowLower = (rowColor || '').toLowerCase().trim();
  const targetLower = (targetColor || '').toLowerCase().trim();
  
  // Exact match
  if (rowLower === targetLower) return true;
  
  // Match if row color ends with our color (e.g., "807 BLACK" matches "BLACK")
  // But ensure it's a word boundary - not part of a longer word
  if (rowLower.endsWith(` ${targetLower}`)) {
    // Check that the character before the space is not part of the target
    // This prevents "WHITE" from matching "WHITE WEFT"
    const beforeMatch = rowLower.slice(0, rowLower.length - targetLower.length - 1);
    // If there's more text after our match, it's a false match
    // e.g., "white weft" - "weft" = "white " - we want to reject this
    // But "807 black" - "black" = "807 " - we want to accept this
    // So we check: if the remaining part (beforeMatch) ends with a space or is just numbers, it's OK
    if (beforeMatch.endsWith(' ') || /^\d+\s*$/.test(beforeMatch)) {
      return true;
    }
  }
  
  // Match if row color without number prefix equals target
  const rowColorWithoutNumber = rowLower.replace(/^\d+\s*/, '');
  if (rowColorWithoutNumber === targetLower) return true;
  
  return false;
}

export function aggregateStockData(
  rows: StockRow[],
  styleNo: string,
  color: string
): AggregatedStockData | null {
  if (!rows || rows.length === 0) return null;

  // Filter to this style/color with fuzzy matching
  const filteredRows = rows.filter(
    r => r.style_no === styleNo && fuzzyMatchColor(r.color || '', color)
  );

  if (filteredRows.length === 0) return null;

  // Deduplicate: keep latest scraped_at per (section, row_label)
  const latestMap = new Map<string, StockRow>();
  let uniqueIdCounter = 0;

  for (const r of filteredRows) {
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
      latestMap.set(`${r.section}|__unnamed_${uniqueIdCounter++}`, r);
    }
  }

  const latestRows = Array.from(latestMap.values());

  // Determine sizes from Stock row, or first row
  const sizes = (latestRows.find(r => r.section === 'Stock') || latestRows[0])?.sizes || [];
  const num = sizes.length;
  const zero = Array.from({ length: num }, () => 0);

  // Stock: single row with section='Stock'
  const stockRow = latestRows.find(r => r.section === 'Stock');
  const stock = stockRow
    ? ensureNums(
        Array.isArray(stockRow.values) ? stockRow.values : JSON.parse(String(stockRow.values || '[]')),
        num
      )
    : zero.slice();

  // Sold: sum all rows with section='Sold'
  const soldRows = latestRows.filter(r => r.section === 'Sold');
  const soldSum = soldRows.reduce(
    (acc, r) => {
      const vals = ensureNums(
        Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
        num
      );
      return acc.map((v, i) => v + (vals[i] ?? 0));
    },
    zero.slice()
  );

  // Purchase: sum all rows with section='Purchase (Running + Shipped)' or section includes 'Purchase'
  const purchaseRows = latestRows.filter(
    r => r.section === 'Purchase (Running + Shipped)' || r.section?.includes('Purchase')
  );
  const purchaseSum = purchaseRows.reduce(
    (acc, r) => {
      const vals = ensureNums(
        Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
        num
      );
      return acc.map((v, i) => v + (vals[i] ?? 0));
    },
    zero.slice()
  );

  // Net Need: stock - sold + purchase
  const netNeed = stock.map((v, i) => v - (soldSum[i] ?? 0) + (purchaseSum[i] ?? 0));

  // Latest scraped_at timestamp
  const latestAt = latestRows.reduce(
    (max, r) =>
      new Date(r.scraped_at).getTime() > new Date(max).getTime() ? r.scraped_at : max,
    latestRows[0]?.scraped_at || new Date(0).toISOString()
  );

  // Helper to sum array
  const sum = (arr: number[]) => arr.reduce((a, b) => a + (b || 0), 0);

  return {
    sizes,
    stock,
    soldSum,
    purchaseSum,
    netNeed,
    stockTotal: sum(stock),
    soldTotal: sum(soldSum),
    purchaseTotal: sum(purchaseSum),
    netNeedTotal: sum(netNeed),
    soldRows: soldRows.map(r => ({
      section: r.section,
      row_label: r.row_label,
      sizes: r.sizes || [],
      values: ensureNums(
        Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
        num
      ),
      total: sum(
        ensureNums(Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')), num)
      )
    })),
    purchaseRows: purchaseRows.map(r => ({
      section: r.section,
      row_label: r.row_label,
      sizes: r.sizes || [],
      values: ensureNums(
        Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
        num
      ),
      total: sum(
        ensureNums(Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')), num)
      )
    })),
    scrapedAt: latestAt
  };
}

/**
 * Fetch all stock data for a style (all colors) from Supabase
 */
export async function fetchStyleStockData(
  supabase: any,
  styleNo: string
): Promise<StockRow[]> {
  const pageSize = 1000;
  const cap = 50000;
  let from = 0;
  const rows: StockRow[] = [];

  while (from < cap) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('style_stock')
      .select('style_no, color, section, row_label, sizes, values, po_link, scraped_at')
      .eq('style_no', styleNo)
      .order('scraped_at', { ascending: false })
      .range(from, to);

    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);

    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return rows as StockRow[];
}

/**
 * Check if a color is WHITE WEFT (exact match, case-insensitive)
 */
export function isWhiteWeft(color: string): boolean {
  const normalized = (color || '').toLowerCase().trim();
  return normalized === 'white weft' || normalized === 'whiteweft';
}

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type StockRow = {
  style_no: string;
  color: string;
  sizes: string[];
  section: string;
  row_label: string | null;
  values: number[];
  scraped_at: string;
};

type SelectionInput = {
  style_no: string;
  color: string;
};

type StyleColorSummary = {
  style_no: string;
  color: string;
  style_name: string | null;
  supplier: string | null;
  image_url: string | null;
  sizes: string[];
  stock: number[];
  sold: number[];
  purchase: number[];
  incoming: number[];
  netNeed: number[];
  totalStock: number;
  totalSold: number;
  totalPurchase: number;
  totalIncoming: number;
  totalNetNeed: number;
};

/**
 * POST /api/purchase/smart-draft/summary
 * 
 * Returns summary data for selected style/color combinations including:
 * - Style metadata (name, supplier, image)
 * - Latest stock data by section (Stock, Sold, Purchase, Incoming)
 * - Derived metrics (net need per size)
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { selections } = body as { selections: SelectionInput[] };

    if (!Array.isArray(selections) || selections.length === 0) {
      return NextResponse.json({ error: 'selections array is required' }, { status: 400 });
    }

    // Get unique style numbers
    const styleNos = Array.from(new Set(selections.map(s => s.style_no)));

    // Fetch style metadata
    const { data: stylesData, error: stylesError } = await supabase
      .from('styles')
      .select('style_no, style_name, supplier, image_url')
      .in('style_no', styleNos);

    if (stylesError) {
      return NextResponse.json({ error: stylesError.message }, { status: 500 });
    }

    const styleMetaMap = new Map<string, { style_name: string | null; supplier: string | null; image_url: string | null }>();
    for (const s of stylesData || []) {
      styleMetaMap.set(s.style_no, {
        style_name: s.style_name,
        supplier: s.supplier,
        image_url: s.image_url,
      });
    }

    // Fetch all stock data for these styles
    const { data: stockData, error: stockError } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .in('style_no', styleNos)
      .order('scraped_at', { ascending: false });

    if (stockError) {
      return NextResponse.json({ error: stockError.message }, { status: 500 });
    }

    // Helper to ensure numeric arrays
    const ensureNums = (arr: any[], len: number): number[] =>
      Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);

    // Build summaries for each selection
    const summaries: StyleColorSummary[] = [];

    for (const sel of selections) {
      const { style_no, color } = sel;
      const meta = styleMetaMap.get(style_no) || { style_name: null, supplier: null, image_url: null };

      // Filter stock rows for this style/color
      const rows = (stockData || []).filter(
        (r: StockRow) => r.style_no === style_no && r.color.toLowerCase() === color.toLowerCase()
      );

      if (rows.length === 0) {
        // No stock data - return empty summary
        summaries.push({
          style_no,
          color,
          style_name: meta.style_name,
          supplier: meta.supplier,
          image_url: meta.image_url,
          sizes: [],
          stock: [],
          sold: [],
          purchase: [],
          incoming: [],
          netNeed: [],
          totalStock: 0,
          totalSold: 0,
          totalPurchase: 0,
          totalIncoming: 0,
          totalNetNeed: 0,
        });
        continue;
      }

      // Get latest row per section
      const latestBySection = new Map<string, StockRow>();
      for (const r of rows) {
        const key = `${r.section}|${r.row_label ?? ''}`;
        const current = latestBySection.get(key);
        if (!current || new Date(r.scraped_at) > new Date(current.scraped_at)) {
          latestBySection.set(key, r);
        }
      }

      const latestRows = Array.from(latestBySection.values());
      const stockRow = latestRows.find(r => r.section === 'Stock');
      const sizes = stockRow?.sizes || latestRows[0]?.sizes || [];
      const num = sizes.length;

      // Parse values for each section
      const parseRow = (row: StockRow | undefined): number[] => {
        if (!row) return Array(num).fill(0);
        const vals = Array.isArray(row.values) ? row.values : JSON.parse(String(row.values || '[]'));
        return ensureNums(vals, num);
      };

      const stock = parseRow(stockRow);

      // Aggregate sold rows (there can be multiple)
      const soldRows = latestRows.filter(r => r.section === 'Sold');
      const sold = soldRows.reduce((acc, r) => {
        const vals = parseRow(r);
        return acc.map((v, i) => v + (vals[i] || 0));
      }, Array(num).fill(0) as number[]);

      // Aggregate purchase rows
      const purchaseRows = latestRows.filter(r => r.section === 'Purchase');
      const purchase = purchaseRows.reduce((acc, r) => {
        const vals = parseRow(r);
        return acc.map((v, i) => v + (vals[i] || 0));
      }, Array(num).fill(0) as number[]);

      // Incoming (if separate from purchase)
      const incomingRows = latestRows.filter(r => r.section === 'Incoming');
      const incoming = incomingRows.reduce((acc, r) => {
        const vals = parseRow(r);
        return acc.map((v, i) => v + (vals[i] || 0));
      }, Array(num).fill(0) as number[]);

      // Net Need = Stock - Sold + Purchase + Incoming
      // Positive = surplus, Negative = deficit
      const netNeed = sizes.map((_, i) => 
        (stock[i] || 0) - (sold[i] || 0) + (purchase[i] || 0) + (incoming[i] || 0)
      );

      const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

      summaries.push({
        style_no,
        color,
        style_name: meta.style_name,
        supplier: meta.supplier,
        image_url: meta.image_url,
        sizes,
        stock,
        sold,
        purchase,
        incoming,
        netNeed,
        totalStock: sum(stock),
        totalSold: sum(sold),
        totalPurchase: sum(purchase),
        totalIncoming: sum(incoming),
        totalNetNeed: sum(netNeed),
      });
    }

    return NextResponse.json({
      success: true,
      summaries,
    });
  } catch (error: any) {
    console.error('[smart-draft/summary] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}


'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';

export default function PurchaseMakeOrderPage() {
  const STORAGE_KEYS = React.useMemo(() => ({
    started: 'makeOrder.process1.started',
    step: 'makeOrder.process1.step',
    returnPath: 'makeOrder.process1.returnPath',
    selectedStyles: 'makeOrder.process1.selectedStyles',
    selections: 'makeOrder.process1.selections',
    inputs: 'makeOrder.process1.inputs'
  }), []);

  const [started, setStarted] = React.useState<boolean>(false);
  const [step, setStep] = React.useState<number>(1);
  const [returnPath, setReturnPath] = React.useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  // Step 1: Selected style numbers only
  const [selectedStyles, setSelectedStyles] = React.useState<string[]>([]);
  
  // Step 2: Selected style_no + color pairs
  type Selection = { style_no: string; color: string };
  const [selections, setSelections] = React.useState<Selection[]>([]);

  // Step 3: Inputs per style/color/size
  type InputRecord = Record<string, number[]>; // key: "style_no|color"
  const [inputsByKey, setInputsByKey] = React.useState<InputRecord>({});

  // Load persisted state
  React.useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEYS.started);
      const r = localStorage.getItem(STORAGE_KEYS.returnPath);
      const st = localStorage.getItem(STORAGE_KEYS.step);
      const styles = localStorage.getItem(STORAGE_KEYS.selectedStyles);
      const sel = localStorage.getItem(STORAGE_KEYS.selections);
      const inp = localStorage.getItem(STORAGE_KEYS.inputs);
      
      if (s === '1') setStarted(true);
      if (typeof r === 'string') setReturnPath(r);
      if (st) {
        const num = Number(st) || 1;
        setStep(num >= 1 && num <= 4 ? num : 1);
      }
      if (styles) {
        try { setSelectedStyles(JSON.parse(styles) as string[]); } catch {}
      }
      if (sel) {
        try { setSelections(JSON.parse(sel) as Selection[]); } catch {}
      }
      if (inp) {
        try { setInputsByKey(JSON.parse(inp) as InputRecord); } catch {}
      }
    } catch {}
  }, [STORAGE_KEYS]);

  // Persist state
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.step, String(step)); } catch {}
  }, [step, STORAGE_KEYS.step]);
  
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.selectedStyles, JSON.stringify(selectedStyles)); } catch {}
  }, [selectedStyles, STORAGE_KEYS.selectedStyles]);
  
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.selections, JSON.stringify(selections)); } catch {}
  }, [selections, STORAGE_KEYS.selections]);
  
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.inputs, JSON.stringify(inputsByKey)); } catch {}
  }, [inputsByKey, STORAGE_KEYS.inputs]);

  function startProcess() {
    try {
      let from: string | null = null;
      try {
        const ref = document.referrer || '';
        if (ref) {
          const u = new URL(ref);
          const cur = new URL(window.location.href);
          if (u.origin === cur.origin) from = u.pathname + u.search + u.hash;
        }
      } catch {}
      if (!from) from = '/';
      localStorage.setItem(STORAGE_KEYS.returnPath, from);
      localStorage.setItem(STORAGE_KEYS.started, '1');
      setReturnPath(from);
      setStarted(true);
      setStep(1);
    } catch {}
  }

  function resetProcess() {
    try {
      Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
      setStarted(false);
      setStep(1);
      setSelectedStyles([]);
      setSelections([]);
      setInputsByKey({});
      setReturnPath(null);
    } catch {}
  }

  // Sync step with URL slug
  React.useEffect(() => {
    try {
      const m = pathname?.match(/\/purchase\/make-order\/step\/(\d+)/i);
      if (m && m[1]) {
        const n = Math.max(1, Math.min(4, Number(m[1]) || 1));
        setStep(n);
      }
    } catch {}
  }, [pathname]);

  React.useEffect(() => {
    if (!started) return;
    const target = `/purchase/make-order/step/${step}`;
    if (pathname !== target) {
      try { router.push(target as any); } catch {}
    }
  }, [step, started, pathname, router]);

  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">Purchase</div>
          <h1 className="text-2xl font-semibold">Make Order</h1>
        </div>
        {returnPath && (
          <a href={returnPath} className="text-sm underline text-blue-700 hover:text-blue-800">
            Back to previous page
          </a>
        )}
      </div>

      {/* Progress indicator */}
      {started && (
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${
                  s === step
                    ? 'bg-slate-900 text-white'
                    : s < step
                    ? 'bg-green-500 text-white'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {s}
              </div>
              {s < 4 && (
                <div className={`w-16 h-0.5 ${s < step ? 'bg-green-500' : 'bg-slate-200'}`} />
              )}
            </div>
          ))}
          <div className="ml-4 text-sm text-slate-600">
            {step === 1 && 'Choose Styles'}
            {step === 2 && 'Choose Colors'}
            {step === 3 && 'Enter Order Quantities'}
            {step === 4 && 'Review & Confirm'}
          </div>
          <Button variant="ghost" size="sm" onClick={resetProcess} className="ml-auto">
            Reset Process
          </Button>
        </div>
      )}

      {!started && (
        <Card>
          <CardHeader>
            <CardTitle>Purchase Order Process</CardTitle>
            <CardDescription>
              Start the guided 4-step order flow to create your purchase order.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={startProcess}>Start Purchase Order</Button>
          </CardContent>
        </Card>
      )}

      {started && step === 1 && <Step1ChooseStyles selectedStyles={selectedStyles} setSelectedStyles={setSelectedStyles} onContinue={() => setStep(2)} />}
      {started && step === 2 && <Step2ChooseColors selectedStyles={selectedStyles} selections={selections} setSelections={setSelections} onBack={() => setStep(1)} onContinue={() => setStep(3)} />}
      {started && step === 3 && <Step3EnterQuantities selections={selections} inputsByKey={inputsByKey} setInputsByKey={setInputsByKey} onBack={() => setStep(2)} onContinue={() => setStep(4)} />}
      {started && step === 4 && <Step4Review selections={selections} inputsByKey={inputsByKey} onBack={() => setStep(3)} onReset={resetProcess} />}
    </div>
  );
}

// ==================== STEP 1: Choose Styles ====================
function Step1ChooseStyles({
  selectedStyles,
  setSelectedStyles,
  onContinue
}: {
  selectedStyles: string[];
  setSelectedStyles: React.Dispatch<React.SetStateAction<string[]>>;
  onContinue: () => void;
}) {
  const [q, setQ] = React.useState('');
  const { data: styleList } = useSWR(
    ['makeOrder:styles', q],
    async () => {
      let query = supabase
        .from('styles')
        .select('id, style_no, style_name, supplier, image_url')
        .order('style_no', { ascending: true })
        .limit(200);
    const qq = q.trim();
    if (qq) {
      query = query.or(`style_no.ilike.%${qq}%,style_name.ilike.%${qq}%`);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
      return (data ?? []) as Array<{
        id: string;
        style_no: string;
        style_name: string | null;
        supplier: string | null;
        image_url: string | null;
      }>;
    }
  );

  function toggleStyle(styleNo: string) {
    setSelectedStyles(
      selectedStyles.includes(styleNo)
        ? selectedStyles.filter((s) => s !== styleNo)
        : [...selectedStyles, styleNo]
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Step 1: Choose Styles</CardTitle>
          <CardDescription>
            Select the styles you want to create a purchase order for.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            placeholder="Search by style number or name..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-md"
          />

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {(styleList ?? []).map((style) => {
              const isSelected = selectedStyles.includes(style.style_no);
              return (
                <div
                  key={style.id}
                  onClick={() => toggleStyle(style.style_no)}
                  className={`border rounded-lg p-3 cursor-pointer transition-all ${
                    isSelected
                      ? 'border-slate-900 bg-slate-50 ring-2 ring-slate-900'
                      : 'border-slate-200 hover:border-slate-400'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {style.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={style.image_url}
                        alt={style.style_name || style.style_no}
                        className="h-16 w-16 object-cover rounded border"
                      />
                    ) : (
                      <div className="h-16 w-16 rounded border bg-gray-100 flex items-center justify-center text-xs text-gray-400">
                        No image
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-semibold">{style.style_no}</div>
                        {isSelected && (
                          <svg className="w-4 h-4 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                              clipRule="evenodd"
                            />
                          </svg>
                        )}
                      </div>
                      <div className="text-xs text-slate-600 truncate">
                        {style.style_name || '—'}
                      </div>
                      {style.supplier && (
                        <Badge className="mt-1 text-[10px]">{style.supplier}</Badge>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {selectedStyles.length > 0 && (
            <div className="flex items-center justify-between pt-4 border-t">
              <div className="text-sm text-slate-600">
                Selected: <strong>{selectedStyles.length}</strong> style{selectedStyles.length !== 1 ? 's' : ''}
              </div>
              <Button onClick={onContinue}>Continue to Step 2</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== STEP 2: Choose Colors ====================
function Step2ChooseColors({
  selectedStyles,
  selections,
  setSelections,
  onBack,
  onContinue
}: {
  selectedStyles: string[];
  selections: Array<{ style_no: string; color: string }>;
  setSelections: React.Dispatch<React.SetStateAction<Array<{ style_no: string; color: string }>>>;
  onBack: () => void;
  onContinue: () => void;
}) {
  // Fetch style details
  const { data: styleDetails } = useSWR(
    selectedStyles.length ? ['makeOrder:styleDetails', selectedStyles.join(',')] : null,
    async () => {
      const { data, error } = await supabase
        .from('styles')
        .select('style_no, style_name, supplier, image_url')
        .in('style_no', selectedStyles);
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{
        style_no: string;
        style_name: string | null;
        supplier: string | null;
        image_url: string | null;
      }>;
    }
  );

  // Fetch colors for selected styles
  const { data: colorData } = useSWR(
    selectedStyles.length ? ['makeOrder:colors', selectedStyles.join(',')] : null,
    async () => {
      const { data: styleIds } = await supabase
        .from('styles')
        .select('id, style_no')
        .in('style_no', selectedStyles);
      
      if (!styleIds || styleIds.length === 0) return [];

      const { data, error } = await supabase
        .from('style_colors')
        .select('style_id, color')
        .in('style_id', styleIds.map((s: any) => s.id))
        .order('color', { ascending: true });
      
    if (error) throw new Error(error.message);

      // Map style_id back to style_no
      const idToNo = new Map(styleIds.map((s: any) => [s.id, s.style_no]));
      return (data ?? []).map((row: any) => ({
        style_no: idToNo.get(row.style_id),
        color: row.color
      }));
    }
  );

  function toggleColor(style_no: string, color: string) {
    const key = `${style_no}|${color}`.toLowerCase();
    const exists = selections.some(
      (s) => `${s.style_no}|${s.color}`.toLowerCase() === key
    );
    if (exists) {
      setSelections(selections.filter((s) => `${s.style_no}|${s.color}`.toLowerCase() !== key));
    } else {
      setSelections([...selections, { style_no, color }]);
    }
  }

  // Group colors by style
  const colorsByStyle = React.useMemo(() => {
    const map = new Map<string, string[]>();
    (colorData ?? []).forEach((item) => {
      if (!item.style_no) return;
      if (!map.has(item.style_no)) map.set(item.style_no, []);
      map.get(item.style_no)!.push(item.color);
    });
    return map;
  }, [colorData]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Step 2: Choose Colors</CardTitle>
          <CardDescription>
            Select the colors from your chosen styles.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {(styleDetails ?? []).map((style) => {
            const colors = colorsByStyle.get(style.style_no) || [];
            return (
              <div key={style.style_no} className="space-y-3 pb-6 border-b last:border-b-0 last:pb-0">
                <div className="flex items-start gap-3">
                  {style.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={style.image_url}
                      alt={style.style_name || style.style_no}
                      className="h-16 w-16 object-cover rounded border"
                    />
                  ) : (
                    <div className="h-16 w-16 rounded border bg-gray-100" />
                  )}
                  <div>
                    <div className="text-sm font-semibold">{style.style_no}</div>
                    <div className="text-xs text-slate-600">{style.style_name || '—'}</div>
                    {style.supplier && <Badge className="mt-1 text-[10px]">{style.supplier}</Badge>}
                  </div>
                </div>

                {colors.length === 0 ? (
                  <div className="text-sm text-slate-500">No colors available for this style.</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {colors.map((color) => {
                      const isSelected = selections.some(
                        (s) => s.style_no === style.style_no && s.color === color
                      );
                      return (
                        <button
                          key={color}
                          onClick={() => toggleColor(style.style_no, color)}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                            isSelected
                              ? 'bg-slate-900 text-white ring-2 ring-slate-900 ring-offset-2'
                              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                          }`}
                        >
                          {color}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex items-center justify-between pt-4 border-t">
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
            <div className="flex items-center gap-3">
              <div className="text-sm text-slate-600">
                Selected: <strong>{selections.length}</strong> color{selections.length !== 1 ? 's' : ''}
              </div>
              <Button onClick={onContinue} disabled={selections.length === 0}>
                Continue to Step 3
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Helper function to distribute total by sold pressure
function distributeBySoldPressure(total: number, soldArray: number[]): number[] {
  const soldTotal = soldArray.reduce((a, b) => a + b, 0);
  
  if (soldTotal === 0) {
    // If no sold data, distribute evenly
    const perSize = Math.floor(total / soldArray.length);
    const remainder = total % soldArray.length;
    return soldArray.map((_, i) => perSize + (i < remainder ? 1 : 0));
  }

  // Calculate pressure percentages
  const pressures = soldArray.map((s) => s / soldTotal);
  
  // Distribute with largest remainder method
  const exact = pressures.map((p) => p * total);
  const floored = exact.map((v) => Math.floor(v));
  let remaining = total - floored.reduce((a, b) => a + b, 0);
  
  // Sort indices by fractional part (descending)
  const fractional = exact.map((v, i) => ({ i, frac: v - Math.floor(v) }));
  fractional.sort((a, b) => b.frac - a.frac);
  
  // Add 1 to the sizes with largest fractional parts
  for (let k = 0; k < remaining && k < fractional.length; k++) {
    const item = fractional[k];
    if (item && item.i < floored.length) {
      floored[item.i]++;
    }
  }
  
  return floored;
}

// ==================== STEP 3: Enter Quantities (Grouped by Supplier) ====================
function Step3EnterQuantities({
  selections,
  inputsByKey,
  setInputsByKey,
  onBack,
  onContinue
}: {
  selections: Array<{ style_no: string; color: string }>;
  inputsByKey: Record<string, number[]>;
  setInputsByKey: React.Dispatch<React.SetStateAction<Record<string, number[]>>>;
  onBack: () => void;
  onContinue: () => void;
}) {
  const selectedStyleNos = React.useMemo(
    () => Array.from(new Set(selections.map((s) => s.style_no))),
    [selections]
  );

  // Fetch style metadata (including supplier)
  const { data: styleMetadata } = useSWR(
    selectedStyleNos.length ? ['makeOrder:styleMeta', selectedStyleNos.join(',')] : null,
    async () => {
      const { data, error } = await supabase
        .from('styles')
        .select('style_no, style_name, supplier, image_url')
        .in('style_no', selectedStyleNos);
      if (error) throw new Error(error.message);
      const map = new Map<string, { name: string | null; supplier: string | null; image: string | null }>();
      (data ?? []).forEach((r: any) => {
        map.set(r.style_no, { name: r.style_name, supplier: r.supplier, image: r.image_url });
      });
      return map;
    }
  );

  // Fetch stock data
  type StockRow = {
    style_no: string;
    color: string;
    sizes: string[];
    section: string;
    row_label: string | null;
    values: number[];
    scraped_at: string;
  };

  const { data: stockData } = useSWR(
    selectedStyleNos.length ? ['makeOrder:stock', selectedStyleNos.join(',')] : null,
    async () => {
      const selectedColors = Array.from(new Set(selections.map((s) => s.color)));
    const { data, error } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .in('style_no', selectedStyleNos)
      .in('color', selectedColors);
    if (error) throw new Error(error.message);
    return (data ?? []) as StockRow[];
    }
  );

  // Group data by supplier, then by style/color
  const groupedBySupplier = React.useMemo(() => {
    if (!styleMetadata || !stockData) return [];

    const selectionKeys = new Set(selections.map((s) => `${s.style_no}|${s.color}`.toLowerCase()));

    type ColorGroup = {
      style_no: string;
      color: string;
      sizes: string[];
      stock: number[];
      sold: number[];
      purchase: number[];
      available: number[];
    };

    type SupplierGroup = {
      supplier: string;
      colors: ColorGroup[];
    };

    const bySupplier = new Map<string, ColorGroup[]>();

    // Process each selection
    selections.forEach(({ style_no, color }) => {
      const meta = styleMetadata.get(style_no);
      if (!meta) return;

      const supplier = meta.supplier || 'Unknown Supplier';
      const key = `${style_no}|${color}`.toLowerCase();

      // Find relevant stock rows
      const rows = stockData.filter(
        (r) => r.style_no === style_no && r.color === color
      );

      if (rows.length === 0) return;

      // Get latest row per section
      const latestBySection = new Map<string, StockRow>();
      rows.forEach((r) => {
        const sectionKey = `${r.section}|${r.row_label ?? ''}`;
        const current = latestBySection.get(sectionKey);
        if (!current || new Date(r.scraped_at) > new Date(current.scraped_at)) {
          latestBySection.set(sectionKey, r);
      }
      });

      const latestRows = Array.from(latestBySection.values());
      const sizes = (latestRows.find((r) => r.section === 'Stock') || latestRows[0])?.sizes || [];
      const num = sizes.length;
      const zero = Array(num).fill(0);

      const ensureNums = (arr: any[], len: number) =>
        Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);

      const stockRow = latestRows.find((r) => r.section === 'Stock');
      const stock = stockRow
        ? ensureNums(
            Array.isArray(stockRow.values) ? stockRow.values : JSON.parse(String(stockRow.values || '[]')),
            num
          )
        : zero.slice();

      const soldRows = latestRows.filter((r) => r.section === 'Sold');
      const sold = soldRows.reduce((acc, r) => {
        const vals = ensureNums(
          Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
          num
        );
        return acc.map((v, i) => v + vals[i]);
      }, zero.slice());

      const purchaseRows = latestRows.filter((r) => r.section === 'Purchase (Running + Shipped)');
      const purchase = purchaseRows.reduce((acc, r) => {
        const vals = ensureNums(
          Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
          num
        );
        return acc.map((v, i) => v + vals[i]);
      }, zero.slice());

      const available = stock.map((v, i) => v - sold[i] + purchase[i]);

      const colorGroup: ColorGroup = {
        style_no,
        color,
        sizes,
        stock,
        sold,
        purchase,
        available
      };

      if (!bySupplier.has(supplier)) bySupplier.set(supplier, []);
      bySupplier.get(supplier)!.push(colorGroup);
    });

    // Convert to array
    const result: SupplierGroup[] = [];
    bySupplier.forEach((colors, supplier) => {
      result.push({ supplier, colors });
    });

    return result;
  }, [selections, styleMetadata, stockData]);

  function setInput(key: string, sizeIndex: number, value: number, sizesLength: number) {
    setInputsByKey((prev) => {
      const base = prev[key]?.length === sizesLength ? [...prev[key]] : Array(sizesLength).fill(0);
      base[sizeIndex] = Math.max(0, value);
      return { ...prev, [key]: base };
    });
  }

  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  // State for bulk order amounts per color
  const [bulkOrderAmounts, setBulkOrderAmounts] = React.useState<Record<string, string>>({});

  const applyBulkOrder = (key: string, colorGroup: any) => {
    const total = Number(bulkOrderAmounts[key] || 0);
    if (total <= 0) return;

    // Distribute based on sold pressure
    const distributed = distributeBySoldPressure(total, colorGroup.sold);
    
    setInputsByKey((prev) => ({
      ...prev,
      [key]: distributed
    }));
    
    // Clear the input
    setBulkOrderAmounts((prev) => ({ ...prev, [key]: '' }));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Step 3: Enter Order Quantities</CardTitle>
          <CardDescription>
            Review stock data and enter order quantities, grouped by supplier.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          {groupedBySupplier.map((supplierGroup) => (
            <div key={supplierGroup.supplier} className="space-y-4">
              <div className="flex items-center gap-2 pb-2 border-b-2 border-slate-900">
                <h3 className="text-lg font-semibold">{supplierGroup.supplier}</h3>
                <Badge>{supplierGroup.colors.length} item{supplierGroup.colors.length !== 1 ? 's' : ''}</Badge>
              </div>

              {supplierGroup.colors.map((colorGroup) => {
                const key = `${colorGroup.style_no}|${colorGroup.color}`.toLowerCase();
                const meta = styleMetadata?.get(colorGroup.style_no);
                const inputs =
                  inputsByKey[key]?.length === colorGroup.sizes.length
                    ? inputsByKey[key]
                    : Array(colorGroup.sizes.length).fill(0);

                // Calculate Net Need = Sold - Available
                const netNeed = colorGroup.sold.map((s, i) => s - colorGroup.available[i]);
                const netNeedTotal = sum(netNeed);
                
                // Calculate pressure % for Net Need (based on sold)
                const soldTotal = sum(colorGroup.sold);
                const soldPressure = colorGroup.sold.map((s) => 
                  soldTotal > 0 ? ((s / soldTotal) * 100).toFixed(1) : '0.0'
                );

                // Calculate New Net Need = Net Need - Order
                const newNetNeed = netNeed.map((n, i) => n - inputs[i]);

                return (
                  <div key={key} className="space-y-3 pb-4 border-b last:border-b-0">
                    <div className="flex items-start gap-3">
                      {meta?.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={meta.image}
                          alt={colorGroup.style_no}
                          className="h-16 w-16 object-cover rounded border"
                        />
                      ) : (
                        <div className="h-16 w-16 rounded border bg-gray-100" />
                      )}
                      <div>
                        <div className="text-sm font-semibold">{colorGroup.style_no}</div>
                        <div className="text-xs text-slate-600">{meta?.name || '—'}</div>
                        <div className="text-xs text-slate-600">Color: {colorGroup.color}</div>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="min-w-full text-xs border">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="p-2 text-left font-semibold border-r">Size</th>
                            {colorGroup.sizes.map((size, i) => (
                              <th key={i} className="p-2 text-right font-semibold border-r">
                                {size}
                              </th>
                            ))}
                            <th className="p-2 text-right font-semibold">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-t">
                            <td className="p-2 font-medium border-r bg-slate-50">Stock</td>
                            {colorGroup.stock.map((v, i) => (
                              <td key={i} className="p-2 text-right font-mono tabular-nums border-r">
                                {v}
                              </td>
                            ))}
                            <td className="p-2 text-right font-mono tabular-nums font-semibold">
                              {sum(colorGroup.stock)}
                            </td>
                          </tr>
                          <tr className="border-t">
                            <td className="p-2 font-medium border-r bg-slate-50">Sold</td>
                            {colorGroup.sold.map((v, i) => (
                              <td key={i} className="p-2 text-right font-mono tabular-nums border-r">
                                {v}
                              </td>
                            ))}
                            <td className="p-2 text-right font-mono tabular-nums font-semibold">
                              {sum(colorGroup.sold)}
                            </td>
                          </tr>
                          <tr className="border-t">
                            <td className="p-2 font-medium border-r bg-slate-50">Purchase</td>
                            {colorGroup.purchase.map((v, i) => (
                              <td key={i} className="p-2 text-right font-mono tabular-nums border-r">
                                {v}
                              </td>
                            ))}
                            <td className="p-2 text-right font-mono tabular-nums font-semibold">
                              {sum(colorGroup.purchase)}
                            </td>
                          </tr>
                          <tr className="border-t">
                            <td className="p-2 font-medium border-r bg-slate-50">Available</td>
                            {colorGroup.available.map((v, i) => (
                              <td key={i} className="p-2 text-right font-mono tabular-nums border-r">
                                {v}
                              </td>
                            ))}
                            <td className="p-2 text-right font-mono tabular-nums font-semibold">
                              {sum(colorGroup.available)}
                            </td>
                          </tr>
                          <tr className="border-t bg-amber-50">
                            <td className="p-2 font-medium border-r">Net Need</td>
                            {netNeed.map((v, i) => (
                              <td key={i} className="p-2 text-right border-r">
                                <div className="font-mono tabular-nums font-semibold">
                                  {v}
                                </div>
                                <div className="text-[10px] text-slate-500 mt-0.5">
                                  {soldPressure[i]}%
                                </div>
                              </td>
                            ))}
                            <td className="p-2 text-right font-mono tabular-nums font-bold">
                              {netNeedTotal}
                            </td>
                          </tr>
                          <tr className="border-t bg-blue-50">
                            <td className="p-2 font-medium border-r">Order</td>
                            {colorGroup.sizes.map((_, i) => (
                              <td key={i} className="p-2 border-r">
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  className="w-20 h-8 text-right font-mono tabular-nums"
                                  value={inputs[i]}
                                  onChange={(e) =>
                                    setInput(key, i, Number(e.target.value || 0), colorGroup.sizes.length)
                                  }
                                  min={0}
                                />
                              </td>
                            ))}
                            <td className="p-2 text-right font-mono tabular-nums font-bold text-blue-900">
                              {sum(inputs)}
                            </td>
                          </tr>
                          <tr className="border-t bg-green-50">
                            <td className="p-2 font-medium border-r">New Net Need</td>
                            {newNetNeed.map((v, i) => (
                              <td key={i} className="p-2 text-right font-mono tabular-nums border-r font-semibold">
                                {v}
                              </td>
                            ))}
                            <td className="p-2 text-right font-mono tabular-nums font-bold">
                              {sum(newNetNeed)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {/* Bulk Order Distribution Tool */}
                    <div className="flex items-center gap-2 pt-2">
                      <label className="text-xs text-slate-600 font-medium">Total Order Amount:</label>
                      <Input
                        type="number"
                        inputMode="numeric"
                        className="w-24 h-8 text-sm"
                        placeholder="0"
                        value={bulkOrderAmounts[key] || ''}
                        onChange={(e) => setBulkOrderAmounts((prev) => ({ ...prev, [key]: e.target.value }))}
                        min={0}
                      />
                      <Button
                        size="sm"
                        onClick={() => applyBulkOrder(key, colorGroup)}
                        disabled={!bulkOrderAmounts[key] || Number(bulkOrderAmounts[key]) <= 0}
                      >
                        ADD
                      </Button>
                      <span className="text-xs text-slate-500 ml-2">
                        (Distributes by sold pressure across sizes)
                      </span>
                    </div>
                  </div>
                );
              })}
                  </div>
          ))}

          <div className="flex items-center justify-between pt-4 border-t">
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
            <Button onClick={onContinue}>Continue to Review</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== STEP 4: Review & Confirm ====================
function Step4Review({
  selections,
  inputsByKey,
  onBack,
  onReset
}: {
  selections: Array<{ style_no: string; color: string }>;
  inputsByKey: Record<string, number[]>;
  onBack: () => void;
  onReset: () => void;
}) {
  // Calculate order summary
  const orderItems = React.useMemo(() => {
    const items: Array<{
      style_no: string;
      color: string;
      quantities: number[];
      total: number;
    }> = [];

    selections.forEach(({ style_no, color }) => {
      const key = `${style_no}|${color}`.toLowerCase();
      const quantities = inputsByKey[key] || [];
      const total = quantities.reduce((a, b) => a + b, 0);
      if (total > 0) {
        items.push({ style_no, color, quantities, total });
    }
    });

    return items;
  }, [selections, inputsByKey]);

  const grandTotal = orderItems.reduce((sum, item) => sum + item.total, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Step 4: Review Order</CardTitle>
          <CardDescription>
            Review your order before finalizing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {orderItems.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              <p className="mb-2">No items with quantities entered.</p>
              <Button variant="outline" onClick={onBack}>
                Go back to add quantities
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {orderItems.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <div className="font-semibold text-sm">
                        {item.style_no} - {item.color}
                      </div>
                      <div className="text-xs text-slate-600">
                        Quantities: {item.quantities.join(', ')}
                      </div>
                    </div>
                    <div className="text-lg font-bold">{item.total}</div>
                  </div>
                ))}
              </div>

              <div className="pt-4 border-t">
                <div className="flex items-center justify-between text-lg font-bold">
                  <span>Grand Total:</span>
                  <span>{grandTotal}</span>
        </div>
      </div>

              <div className="flex items-center justify-between pt-4 border-t">
                <Button variant="outline" onClick={onBack}>
                  Back
                </Button>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={onReset}>
                    Start New Order
                  </Button>
                  <Button>Finalize Order</Button>
      </div>
            </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

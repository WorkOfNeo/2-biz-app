'use client';
import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Input } from '../../../../components/ui/input';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';

type AppPo = {
  id: number;
  po_no: string;
  status: string;
  supplier: string | null;
  styles: number | null;
  ordered: number | null;
  shipped: number | null;
  etd: string | null;
  eta: string | null;
  meta: any;
  created_at: string;
  updated_at: string;
};

type OrderItem = {
  style_no: string;
  color: string;
  quantities: number[];
  total: number;
};

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
  style_no: string;
  style_name: string | null;
  supplier: string | null;
  image_url: string | null;
};

type OtherPoItem = {
  po_no: string;
  quantities: number[];
};

export default function AppPoDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const { data: po, error, isLoading } = useSWR(
    id ? ['app-po', id] : null,
    async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*')
        .eq('id', id)
        .eq('category', 'app')
        .single();
      
      if (error) throw error;
      return data as AppPo;
    }
  );

  // Extract order items from meta
  const orderItems: OrderItem[] = React.useMemo(() => {
    if (!po?.meta?.items) return [];
    return po.meta.items as OrderItem[];
  }, [po]);

  // Get unique style numbers
  const styleNos = React.useMemo(() => {
    return Array.from(new Set(orderItems.map(item => item.style_no)));
  }, [orderItems]);

  // Fetch style metadata (images, names, supplier)
  const { data: styleMetas } = useSWR(
    styleNos.length > 0 ? ['styles-meta', styleNos.join(',')] : null,
    async () => {
      const { data, error } = await supabase
        .from('styles')
        .select('style_no, style_name, supplier, image_url')
        .in('style_no', styleNos);
      
      if (error) throw error;
      
      const map = new Map<string, StyleMeta>();
      (data || []).forEach((row: any) => {
        map.set(row.style_no, row as StyleMeta);
      });
      return map;
    }
  );

  // Fetch stock data for sold information
  const { data: stockData } = useSWR(
    styleNos.length > 0 ? ['stock-data', styleNos.join(',')] : null,
    async () => {
      const colors = Array.from(new Set(orderItems.map(item => item.color)));
      const { data, error } = await supabase
        .from('style_stock')
        .select('style_no, color, sizes, section, row_label, values, scraped_at')
        .in('style_no', styleNos)
        .in('color', colors);
      
      if (error) throw error;
      return (data || []) as StockRow[];
    }
  );

  // Fetch other APP PO's for the same style/color combinations
  const { data: otherPos } = useSWR(
    orderItems.length > 0 && po ? ['other-app-pos', orderItems.map(i => `${i.style_no}|${i.color}`).join(',')] : null,
    async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('id, po_no, meta')
        .eq('category', 'app')
        .neq('id', po!.id);
      
      if (error) throw error;
      
      // Build a map of style_no|color -> array of {po_no, quantities}
      const map = new Map<string, OtherPoItem[]>();
      
      (data || []).forEach((otherPo: any) => {
        if (!otherPo.meta?.items) return;
        
        (otherPo.meta.items as OrderItem[]).forEach(item => {
          const key = `${item.style_no}|${item.color}`.toLowerCase();
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({
            po_no: otherPo.po_no,
            quantities: item.quantities
          });
        });
      });
      
      return map;
    }
  );

  // Helper to get sold data for a style/color
  const getSoldData = (style_no: string, color: string) => {
    if (!stockData) return { sizes: [], sold: [] };
    
    const rows = stockData.filter(
      r => r.style_no === style_no && r.color === color
    );
    
    if (rows.length === 0) return { sizes: [], sold: [] };
    
    // Get latest row per section
    const latestBySection = new Map<string, StockRow>();
    rows.forEach(r => {
      const key = `${r.section}|${r.row_label ?? ''}`;
      const current = latestBySection.get(key);
      if (!current || new Date(r.scraped_at) > new Date(current.scraped_at)) {
        latestBySection.set(key, r);
      }
    });
    
    const latestRows = Array.from(latestBySection.values());
    const sizes = (latestRows.find(r => r.section === 'Stock') || latestRows[0])?.sizes || [];
    const num = sizes.length;
    const zero = Array(num).fill(0);
    
    const ensureNums = (arr: any[], len: number) =>
      Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);
    
    const soldRows = latestRows.filter(r => r.section === 'Sold');
    const sold = soldRows.reduce((acc, r) => {
      const vals = ensureNums(
        Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
        num
      );
      return acc.map((v, i) => v + vals[i]);
    }, zero.slice());
    
    return { sizes, sold };
  };

  // Group items by supplier
  const groupedBySupplier = React.useMemo(() => {
    if (!styleMetas) return [];
    
    const groups = new Map<string, OrderItem[]>();
    
    orderItems.forEach(item => {
      const meta = styleMetas.get(item.style_no);
      const supplier = meta?.supplier || 'Unknown Supplier';
      
      if (!groups.has(supplier)) groups.set(supplier, []);
      groups.get(supplier)!.push(item);
    });
    
    return Array.from(groups.entries()).map(([supplier, items]) => ({
      supplier,
      items
    }));
  }, [orderItems, styleMetas]);

  if (isLoading) {
    return (
      <div className="p-4 max-w-7xl mx-auto">
        <div className="text-center py-8 text-slate-500">Loading...</div>
      </div>
    );
  }

  if (error || !po) {
    return (
      <div className="p-4 max-w-7xl mx-auto">
        <div className="text-center py-8 text-red-600">
          Purchase order not found
        </div>
        <div className="text-center">
          <Button variant="outline" onClick={() => router.push('/purchase/app-pos')}>
            Back to list
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      {/* Back Button */}
      <div>
        <Button 
          variant="ghost" 
          size="sm"
          onClick={() => router.push('/purchase/app-pos')}
          className="hover:bg-slate-100"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Button>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">Purchase / App PO's</div>
          <h1 className="text-2xl font-semibold">{po.po_no}</h1>
        </div>
        <Button onClick={() => {
          // TODO: Implement push order logic
          alert('Push Order functionality coming soon!');
        }}>
          Push Order
        </Button>
      </div>

      {/* PO Number & SPY PO No. */}
      <Card>
        <CardHeader>
          <CardTitle>Purchase Order Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">
                PO Number
              </label>
              <Input value={po.po_no} disabled className="bg-slate-50" />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">
                SPY PO No.
              </label>
              <Input placeholder="Enter SPY PO Number..." className="bg-white" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Order Content */}
      <Card>
        <CardHeader>
          <CardTitle>Order Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          {groupedBySupplier.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              No items in this order
            </div>
          ) : (
            groupedBySupplier.map(({ supplier, items }) => (
              <div key={supplier} className="space-y-6">
                {/* Supplier Header */}
                <div className="pb-3 border-b-2 border-slate-900">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold">{supplier}</h3>
                    <Badge>{items.length} item{items.length !== 1 ? 's' : ''}</Badge>
                  </div>
                </div>

                {/* Items grouped by style */}
                {items.map((item) => {
                  const meta = styleMetas?.get(item.style_no);
                  const { sizes, sold } = getSoldData(item.style_no, item.color);
                  const key = `${item.style_no}|${item.color}`.toLowerCase();
                  const otherPoItems = otherPos?.get(key) || [];
                  
                  // Calculate other PO's totals per size
                  const otherPoTotals = otherPoItems.reduce((acc, opi) => {
                    return acc.map((v, i) => v + (opi.quantities[i] || 0));
                  }, Array(item.quantities.length).fill(0));
                  
                  // Calculate Net Need: -Sold + This PO + Other PO's
                  const netNeed = item.quantities.map((qty, i) => {
                    const soldVal = sold[i] || 0;
                    const otherVal = otherPoTotals[i] || 0;
                    return -soldVal + qty + otherVal;
                  });
                  
                  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

                  return (
                    <div key={key} className="space-y-3 pb-6 border-b last:border-b-0">
                      {/* Style Header */}
                      <div className="flex gap-4">
                        {/* Image */}
                        <div className="flex-shrink-0" style={{ maxWidth: '160px' }}>
                          {meta?.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={meta.image_url}
                              alt={meta.style_name || item.style_no}
                              className="w-full h-auto object-cover rounded border"
                            />
                          ) : (
                            <div className="w-40 h-40 rounded border bg-gray-100 flex items-center justify-center text-xs text-gray-400">
                              No image
                            </div>
                          )}
                        </div>

                        {/* Style Info */}
                        <div className="flex-1 min-w-0">
                          <div className="text-base font-semibold mb-1">
                            {item.style_no}
                          </div>
                          <div className="text-sm text-slate-600 mb-2">
                            {meta?.style_name || '—'}
                          </div>
                          <div className="text-sm text-slate-700">
                            Color: <span className="font-medium">{item.color}</span>
                          </div>
                        </div>
                      </div>

                      {/* Data Table */}
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border border-slate-300">
                          <thead className="bg-slate-100">
                            <tr>
                              <th className="p-2 text-left font-semibold border-r border-slate-300 w-32">
                                Metric
                              </th>
                              {(sizes.length > 0 ? sizes : item.quantities.map((_, i) => `Size ${i + 1}`)).map((size, i) => (
                                <th key={i} className="p-2 text-center font-semibold border-r border-slate-300 min-w-[70px]">
                                  {size}
                                </th>
                              ))}
                              <th className="p-2 text-center font-semibold min-w-[80px]">
                                Total
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {/* Sold Row */}
                            <tr className="border-t border-slate-300 bg-red-50">
                              <td className="p-2 font-medium border-r border-slate-300 bg-red-100">
                                Sold
                              </td>
                              {item.quantities.map((_, i) => (
                                <td key={i} className="p-2 text-center border-r border-slate-300 text-red-700 font-semibold">
                                  {sold[i] || 0}
                                </td>
                              ))}
                              <td className="p-2 text-center font-bold text-red-700">
                                {sum(sold)}
                              </td>
                            </tr>

                            {/* APP PO Row (this order) */}
                            <tr className="border-t border-slate-300 bg-green-50">
                              <td className="p-2 font-medium border-r border-slate-300 bg-green-100">
                                APP PO
                              </td>
                              {item.quantities.map((qty, i) => (
                                <td key={i} className="p-2 text-center border-r border-slate-300 text-green-700 font-semibold">
                                  {qty}
                                </td>
                              ))}
                              <td className="p-2 text-center font-bold text-green-700">
                                {sum(item.quantities)}
                              </td>
                            </tr>

                            {/* Other APP PO's Row */}
                            {otherPoItems.length > 0 && (
                              <tr className="border-t border-slate-300 bg-slate-50">
                                <td className="p-2 font-medium border-r border-slate-300 bg-slate-100">
                                  Other APP PO's
                                </td>
                                {otherPoTotals.map((total, i) => (
                                  <td key={i} className="p-2 text-center border-r border-slate-300 text-slate-600 font-semibold">
                                    {total}
                                  </td>
                                ))}
                                <td className="p-2 text-center font-bold text-slate-600">
                                  {sum(otherPoTotals)}
                                </td>
                              </tr>
                            )}

                            {/* Net Need Row */}
                            <tr className="border-t border-slate-300 bg-blue-50">
                              <td className="p-2 font-medium border-r border-slate-300 bg-blue-100">
                                Net Need
                              </td>
                              {netNeed.map((need, i) => (
                                <td 
                                  key={i} 
                                  className={`p-2 text-center border-r border-slate-300 font-semibold ${
                                    need > 0 ? 'text-green-700' : need < 0 ? 'text-red-700' : 'text-slate-600'
                                  }`}
                                >
                                  {need}
                                </td>
                              ))}
                              <td className={`p-2 text-center font-bold ${
                                sum(netNeed) > 0 ? 'text-green-700' : sum(netNeed) < 0 ? 'text-red-700' : 'text-slate-600'
                              }`}>
                                {sum(netNeed)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>

                      {/* Show other PO details if any */}
                      {otherPoItems.length > 0 && (
                        <div className="text-xs text-slate-500 pl-2">
                          Other PO's: {otherPoItems.map(opi => opi.po_no).join(', ')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}


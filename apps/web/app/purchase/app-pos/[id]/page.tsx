'use client';
import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Input } from '../../../../components/ui/input';
import { Button } from '../../../../components/ui/button';

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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">Purchase / App PO's</div>
          <h1 className="text-2xl font-semibold">{po.po_no}</h1>
        </div>
        <Button variant="outline" onClick={() => router.push('/purchase/app-pos')}>
          Back to list
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

      {/* Main Section - Gray Placeholder */}
      <Card>
        <CardContent className="p-8">
          <div className="bg-slate-100 rounded-lg border-2 border-dashed border-slate-300 min-h-[400px] flex items-center justify-center">
            <div className="text-center text-slate-500">
              <p className="text-lg font-medium mb-2">Content Coming Soon</p>
              <p className="text-sm">This section will contain order details, items, and more.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


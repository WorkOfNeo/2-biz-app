'use client';
import React from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { ChevronDown, ChevronRight } from 'lucide-react';

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
  created_at: string;
  updated_at: string;
  confirmed: boolean;
};

export default function AppPosPage() {
  const router = useRouter();
  const [showConfirmed, setShowConfirmed] = React.useState(false);
  
  const { data: pos, error, isLoading } = useSWR(
    'app-pos',
    async () => {
      const { data, error } = await supabase
        .from('app_pos')
        .select('id, po_no, status, supplier, styles, ordered, shipped, etd, eta, created_at, updated_at, confirmed')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return (data ?? []) as AppPo[];
    }
  );
  
  const unconfirmedPos = pos?.filter(po => !po.confirmed) || [];
  const confirmedPos = pos?.filter(po => po.confirmed) || [];

  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">Purchase</div>
          <h1 className="text-2xl font-semibold">App PO's</h1>
        </div>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="py-8">
            <div className="text-center text-slate-500">Loading...</div>
          </CardContent>
        </Card>
      )}
      
      {error && (
        <Card>
          <CardContent className="py-8">
            <div className="text-center text-red-600">
              Error loading purchase orders
            </div>
          </CardContent>
        </Card>
      )}
      
      {!isLoading && !error && (!pos || pos.length === 0) && (
        <Card>
          <CardContent className="py-8">
            <div className="text-center text-slate-500">
              No purchase orders yet. Create one from the Make Order page.
            </div>
          </CardContent>
        </Card>
      )}
      
      {!isLoading && !error && pos && pos.length > 0 && (
        <div className="space-y-4">
          {/* Active Orders */}
          <Card>
            <CardHeader>
              <CardTitle>Active Orders</CardTitle>
              <CardDescription>
                Purchase orders awaiting confirmation
              </CardDescription>
            </CardHeader>
            <CardContent>
              {unconfirmedPos.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  No active orders
                </div>
              ) : (
                <div className="space-y-3">
                  {unconfirmedPos.map((po) => (
                    <div
                      key={po.id}
                      onClick={() => router.push(`/purchase/app-pos/${po.id}`)}
                      className="border rounded-lg p-4 hover:border-slate-400 hover:bg-slate-50 cursor-pointer transition-all"
                    >
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <div className="font-semibold text-lg">{po.po_no}</div>
                            <Badge className={
                              po.status === 'Shipped' 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-blue-100 text-blue-800'
                            }>
                              {po.status}
                            </Badge>
                          </div>
                          {po.supplier && (
                            <div className="text-sm text-slate-600">
                              Supplier: {po.supplier}
                            </div>
                          )}
                          <div className="flex items-center gap-4 text-xs text-slate-500">
                            {po.styles !== null && (
                              <span>{po.styles} style{po.styles !== 1 ? 's' : ''}</span>
                            )}
                            {po.ordered !== null && (
                              <span>{po.ordered} ordered</span>
                            )}
                            {po.shipped !== null && po.shipped > 0 && (
                              <span>{po.shipped} shipped</span>
                            )}
                          </div>
                        </div>
                        <div className="text-xs text-slate-400">
                          {new Date(po.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          
          {/* Confirmed Orders (Collapsible) */}
          {confirmedPos.length > 0 && (
            <Card className="border-green-200 bg-green-50/30">
              <CardHeader 
                className="cursor-pointer hover:bg-green-50/50 transition-colors"
                onClick={() => setShowConfirmed(!showConfirmed)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-green-900 flex items-center gap-2">
                      Confirmed Orders
                      <Badge className="bg-green-100 text-green-800">
                        {confirmedPos.length}
                      </Badge>
                    </CardTitle>
                    <CardDescription className="text-green-700">
                      Confirmed purchase orders
                    </CardDescription>
                  </div>
                  {showConfirmed ? (
                    <ChevronDown className="w-5 h-5 text-green-700" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-green-700" />
                  )}
                </div>
              </CardHeader>
              {showConfirmed && (
                <CardContent>
                  <div className="space-y-3">
                    {confirmedPos.map((po) => (
                      <div
                        key={po.id}
                        onClick={() => router.push(`/purchase/app-pos/${po.id}`)}
                        className="border border-green-200 bg-white rounded-lg p-4 hover:border-green-400 hover:bg-green-50 cursor-pointer transition-all"
                      >
                        <div className="flex items-start justify-between">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold text-lg">{po.po_no}</div>
                              <Badge className="bg-green-100 text-green-800 border-green-300">
                                Confirmed
                              </Badge>
                              <Badge className={
                                po.status === 'Shipped' 
                                  ? 'bg-green-100 text-green-800' 
                                  : 'bg-blue-100 text-blue-800'
                              }>
                                {po.status}
                              </Badge>
                            </div>
                            {po.supplier && (
                              <div className="text-sm text-slate-600">
                                Supplier: {po.supplier}
                              </div>
                            )}
                            <div className="flex items-center gap-4 text-xs text-slate-500">
                              {po.styles !== null && (
                                <span>{po.styles} style{po.styles !== 1 ? 's' : ''}</span>
                              )}
                              {po.ordered !== null && (
                                <span>{po.ordered} ordered</span>
                              )}
                              {po.shipped !== null && po.shipped > 0 && (
                                <span>{po.shipped} shipped</span>
                              )}
                            </div>
                          </div>
                          <div className="text-xs text-slate-400">
                            {new Date(po.created_at).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}


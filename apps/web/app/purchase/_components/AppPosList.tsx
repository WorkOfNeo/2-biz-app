'use client';
import React from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { ChevronDown, ChevronRight, Trash2, CheckSquare } from 'lucide-react';

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

export function AppPosList({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const [showConfirmed, setShowConfirmed] = React.useState(false);
  const [deleting, setDeleting] = React.useState<number | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = React.useState(false);

  const { data: pos, error, isLoading, mutate } = useSWR('app-pos', async () => {
    const { data, error } = await supabase
      .from('app_pos')
      .select('id, po_no, status, supplier, styles, ordered, shipped, etd, eta, created_at, updated_at, confirmed')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data ?? []) as AppPo[];
  });

  const unconfirmedPos = pos?.filter((po) => !po.confirmed) || [];
  const confirmedPos = pos?.filter((po) => po.confirmed) || [];

  async function handleDelete(po: AppPo, e: React.MouseEvent) {
    e.stopPropagation(); // Prevent navigation

    const confirmed = window.confirm(
      `Are you sure you want to delete APP PO "${po.po_no}"?\n\nThis action cannot be undone.`
    );

    if (!confirmed) return;

    setDeleting(po.id);

    try {
      const { error, data } = await supabase
        .from('app_pos')
        .delete()
        .eq('id', po.id)
        .select();

      if (error) {
        console.error('Delete error:', error);
        throw new Error(error.message || 'Database error');
      }

      // Check if anything was actually deleted
      if (!data || data.length === 0) {
        throw new Error('No rows deleted - you may not have permission to delete this PO');
      }

      // Remove from selected if it was selected
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(po.id);
        return next;
      });

      await mutate();
    } catch (err: any) {
      console.error('Delete error:', err);
      alert(`Failed to delete APP PO: ${err.message || 'Unknown error'}\n\nIf this persists, check the browser console for details.`);
    } finally {
      setDeleting(null);
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedIds.size} APP PO${selectedIds.size > 1 ? 's' : ''}?\n\nThis action cannot be undone.`
    );

    if (!confirmed) return;

    setBulkDeleting(true);

    try {
      const idsToDelete = Array.from(selectedIds);
      
      const { error, data } = await supabase
        .from('app_pos')
        .delete()
        .in('id', idsToDelete)
        .select();

      if (error) {
        console.error('Bulk delete error:', error);
        throw new Error(error.message || 'Database error');
      }

      const deletedCount = data?.length || 0;
      
      if (deletedCount === 0) {
        throw new Error('No rows deleted - you may not have permission to delete these POs');
      }

      if (deletedCount < selectedIds.size) {
        alert(`Warning: Only ${deletedCount} of ${selectedIds.size} POs were deleted. Some may have been protected.`);
      }

      setSelectedIds(new Set());
      await mutate();
    } catch (err: any) {
      console.error('Bulk delete error:', err);
      alert(`Failed to delete APP POs: ${err.message || 'Unknown error'}\n\nIf this persists, check the browser console for details.`);
    } finally {
      setBulkDeleting(false);
    }
  }

  function toggleSelect(poId: number, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(poId)) {
        next.delete(poId);
      } else {
        next.add(poId);
      }
      return next;
    });
  }

  function toggleSelectAll(pos: AppPo[]) {
    if (selectedIds.size === pos.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pos.map(po => po.id)));
    }
  }

  return (
    <div className={embedded ? 'space-y-4' : 'p-4 space-y-4 max-w-7xl mx-auto'}>
      {!embedded && (
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-500">Purchase</div>
            <h1 className="text-2xl font-semibold">App PO&apos;s</h1>
          </div>
        </div>
      )}

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
            <div className="text-center text-red-600">Error loading purchase orders</div>
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && (!pos || pos.length === 0) && (
        <Card>
          <CardContent className="py-8">
            <div className="text-center text-slate-500">No purchase orders yet. Create one from the Make Order page.</div>
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && pos && pos.length > 0 && (
        <div className="space-y-4">
          {/* Bulk Actions Bar */}
          {selectedIds.size > 0 && (
            <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CheckSquare className="w-5 h-5 text-indigo-600" />
                <span className="font-medium text-indigo-900">
                  {selectedIds.size} PO{selectedIds.size > 1 ? 's' : ''} selected
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear Selection
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleBulkDelete}
                  disabled={bulkDeleting}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  {bulkDeleting ? 'Deleting...' : `Delete ${selectedIds.size}`}
                </Button>
              </div>
            </div>
          )}

          {/* Active Orders */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Active Orders</CardTitle>
                  <CardDescription>Purchase orders awaiting confirmation</CardDescription>
                </div>
                {unconfirmedPos.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleSelectAll(unconfirmedPos)}
                  >
                    {selectedIds.size === unconfirmedPos.length && unconfirmedPos.every(po => selectedIds.has(po.id))
                      ? 'Deselect All'
                      : 'Select All'}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {unconfirmedPos.length === 0 ? (
                <div className="text-center py-8 text-slate-500">No active orders</div>
              ) : (
                <div className="space-y-3">
                  {unconfirmedPos.map((po) => (
                    <div
                      key={po.id}
                      className={`border rounded-lg p-4 hover:border-slate-400 hover:bg-slate-50 transition-all ${
                        selectedIds.has(po.id) ? 'border-indigo-400 bg-indigo-50' : ''
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {/* Checkbox */}
                        <div className="pt-1">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(po.id)}
                            onChange={(e) => toggleSelect(po.id, e as any)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-4 h-4 text-indigo-600 bg-white border-slate-300 rounded focus:ring-indigo-500 focus:ring-2 cursor-pointer"
                          />
                        </div>

                        {/* PO Content - Clickable */}
                        <div
                          className="flex-1 cursor-pointer"
                          onClick={() => router.push(`/purchase/app-pos/${po.id}`)}
                        >
                          <div className="flex items-start justify-between">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <div className="font-semibold text-lg">{po.po_no}</div>
                                <Badge
                                  className={
                                    po.status === 'Shipped' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                                  }
                                >
                                  {po.status}
                                </Badge>
                              </div>
                              {po.supplier && <div className="text-sm text-slate-600">Supplier: {po.supplier}</div>}
                              <div className="flex items-center gap-4 text-xs text-slate-500">
                                {po.styles !== null && <span>{po.styles} style{po.styles !== 1 ? 's' : ''}</span>}
                                {po.ordered !== null && <span>{po.ordered} ordered</span>}
                                {po.shipped !== null && po.shipped > 0 && <span>{po.shipped} shipped</span>}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="text-xs text-slate-400">{new Date(po.created_at).toLocaleDateString()}</div>
                              <button
                                onClick={(e) => handleDelete(po, e)}
                                disabled={deleting === po.id}
                                className="p-2 rounded hover:bg-red-50 text-red-600 hover:text-red-700 disabled:opacity-50 transition-colors"
                                title="Delete APP PO"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
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
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div
                    className="flex-1 cursor-pointer hover:bg-green-50/50 transition-colors -m-6 p-6"
                    onClick={() => setShowConfirmed(!showConfirmed)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-green-900 flex items-center gap-2">
                          Confirmed Orders
                          <Badge className="bg-green-100 text-green-800">{confirmedPos.length}</Badge>
                        </CardTitle>
                        <CardDescription className="text-green-700">Confirmed purchase orders</CardDescription>
                      </div>
                      {showConfirmed ? (
                        <ChevronDown className="w-5 h-5 text-green-700" />
                      ) : (
                        <ChevronRight className="w-5 h-5 text-green-700" />
                      )}
                    </div>
                  </div>
                  {showConfirmed && confirmedPos.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleSelectAll(confirmedPos)}
                      className="ml-2"
                    >
                      {selectedIds.size > 0 && confirmedPos.every(po => selectedIds.has(po.id))
                        ? 'Deselect All'
                        : 'Select All'}
                    </Button>
                  )}
                </div>
              </CardHeader>
              {showConfirmed && (
                <CardContent>
                  <div className="space-y-3">
                    {confirmedPos.map((po) => (
                      <div
                        key={po.id}
                        className={`border border-green-200 bg-white rounded-lg p-4 hover:border-green-400 hover:bg-green-50 transition-all ${
                          selectedIds.has(po.id) ? 'border-indigo-400 bg-indigo-50' : ''
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          {/* Checkbox */}
                          <div className="pt-1">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(po.id)}
                              onChange={(e) => toggleSelect(po.id, e as any)}
                              onClick={(e) => e.stopPropagation()}
                              className="w-4 h-4 text-indigo-600 bg-white border-slate-300 rounded focus:ring-indigo-500 focus:ring-2 cursor-pointer"
                            />
                          </div>

                          {/* PO Content - Clickable */}
                          <div
                            className="flex-1 cursor-pointer"
                            onClick={() => router.push(`/purchase/app-pos/${po.id}`)}
                          >
                            <div className="flex items-start justify-between">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <div className="font-semibold text-lg">{po.po_no}</div>
                                  <Badge className="bg-green-100 text-green-800 border-green-300">Confirmed</Badge>
                                  <Badge
                                    className={
                                      po.status === 'Shipped'
                                        ? 'bg-green-100 text-green-800'
                                        : 'bg-blue-100 text-blue-800'
                                    }
                                  >
                                    {po.status}
                                  </Badge>
                                </div>
                                {po.supplier && <div className="text-sm text-slate-600">Supplier: {po.supplier}</div>}
                                <div className="flex items-center gap-4 text-xs text-slate-500">
                                  {po.styles !== null && <span>{po.styles} style{po.styles !== 1 ? 's' : ''}</span>}
                                  {po.ordered !== null && <span>{po.ordered} ordered</span>}
                                  {po.shipped !== null && po.shipped > 0 && <span>{po.shipped} shipped</span>}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="text-xs text-slate-400">{new Date(po.created_at).toLocaleDateString()}</div>
                                <button
                                  onClick={(e) => handleDelete(po, e)}
                                  disabled={deleting === po.id}
                                  className="p-2 rounded hover:bg-red-50 text-red-600 hover:text-red-700 disabled:opacity-50 transition-colors"
                                  title="Delete APP PO"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
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



'use client';
import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useSWRConfig } from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import { Card, CardHeader, CardTitle, CardContent } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Modal } from '../../../../components/Modal';
import type { CustomerDiff, CustomerScrapePreviewRow, CustomerFieldChange } from '@shared/types';

function CustomerPreviewContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const previewId = searchParams.get('id');
  
  const [preview, setPreview] = useState<CustomerScrapePreviewRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyStatus, setApplyStatus] = useState<string>('');
  const [expandedUpdated, setExpandedUpdated] = useState<Set<string>>(new Set());
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; company: string } | null>(null);
  const [deleteAllModalOpen, setDeleteAllModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  
  useEffect(() => {
    if (!previewId) return;
    
    async function fetchPreview() {
      try {
        const res = await fetch(`/api/customers/preview?id=${previewId}`);
        if (!res.ok) throw new Error('Failed to fetch preview');
        const data = await res.json();
        setPreview(data.preview);
      } catch (e: any) {
        alert(e?.message || 'Failed to load preview');
      } finally {
        setLoading(false);
      }
    }
    
    fetchPreview();
  }, [previewId]);
  
  const diff: CustomerDiff | null = preview?.diff_data as CustomerDiff || null;
  
  const toggleExpanded = (customerId: string) => {
    const newSet = new Set(expandedUpdated);
    if (newSet.has(customerId)) {
      newSet.delete(customerId);
    } else {
      newSet.add(customerId);
    }
    setExpandedUpdated(newSet);
  };
  
  const handleApply = async () => {
    if (!previewId || !diff) return;
    
    try {
      setApplying(true);
      
      const totalChanges = diff.new.length + diff.updated.length;
      console.log('[APPLY] Starting to apply changes:', {
        new: diff.new.length,
        updated: diff.updated.length,
        total: totalChanges
      });
      
      setApplyStatus(`Applying ${totalChanges} changes...`);
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      
      const startTime = Date.now();
      
      const res = await fetch('/api/customers/preview/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ previewId })
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to apply');
      }
      
      const result = await res.json();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      
      console.log('[APPLY] ✅ Changes applied successfully:', {
        ...result,
        elapsedSeconds: elapsed
      });
      
      // Show detailed changes
      if (result.updates && result.updates.length > 0) {
        console.log('[APPLY] Customer changes:', result.updates.map((u: any) => 
          `${u.type === 'new' ? '➕ NEW' : '✏️ UPDATED'}: ${u.company}`
        ).join('\n'));
      }
      
      setApplyStatus(`✅ Applied ${totalChanges} changes in ${elapsed}s`);
      
      // Invalidate all customer-related SWR caches
      console.log('[APPLY] Invalidating customer caches...');
      await mutate(
        (key) => {
          if (typeof key === 'string') {
            return key.includes('customer') || key.includes('overview') || key.includes('general');
          }
          if (Array.isArray(key)) {
            return key.some(k => typeof k === 'string' && (k.includes('customer') || k.includes('overview') || k.includes('general')));
          }
          return false;
        },
        undefined,
        { revalidate: true }
      );
      console.log('[APPLY] ✅ Customer caches invalidated - pages will refresh automatically');
      
      // Wait a moment to show success message
      await new Promise(r => setTimeout(r, 1500));
      
      router.push('/settings/customers?applied=true');
    } catch (e: any) {
      console.error('[APPLY] ❌ Error:', e);
      alert(e?.message || 'Failed to apply preview');
      setApplying(false);
      setApplyStatus('');
    }
  };
  
  const handleDeleteCustomer = async (customerId: string) => {
    if (!previewId) return;
    
    try {
      setDeleting(true);
      const res = await fetch(`/api/customers/orphaned?id=${customerId}&previewId=${previewId}`, {
        method: 'DELETE'
      });
      
      if (!res.ok) throw new Error('Failed to delete customer');
      
      // Refresh preview
      const refreshRes = await fetch(`/api/customers/preview?id=${previewId}`);
      const refreshData = await refreshRes.json();
      setPreview(refreshData.preview);
      
      setDeleteModalOpen(false);
      setDeleteTarget(null);
    } catch (e: any) {
      alert(e?.message || 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };
  
  const handleDeleteAllOrphaned = async () => {
    if (!previewId) return;
    
    try {
      setDeleting(true);
      const res = await fetch(`/api/customers/orphaned?all=true&previewId=${previewId}`, {
        method: 'DELETE'
      });
      
      if (!res.ok) throw new Error('Failed to delete customers');
      
      // Refresh preview
      const refreshRes = await fetch(`/api/customers/preview?id=${previewId}`);
      const refreshData = await refreshRes.json();
      setPreview(refreshData.preview);
      
      setDeleteAllModalOpen(false);
    } catch (e: any) {
      alert(e?.message || 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };
  
  if (loading) {
    return (
      <div className="p-6">
        <div className="text-sm text-gray-600">Loading preview...</div>
      </div>
    );
  }
  
  if (!preview || !diff) {
    return (
      <div className="p-6">
        <div className="text-sm text-red-600">Preview not found</div>
      </div>
    );
  }
  
  if (preview.applied_at) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-gray-600">
              This preview has already been applied.
            </div>
            <Button
              className="mt-4"
              onClick={() => router.push('/settings/customers')}
            >
              Back to Customers
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  
  const hasChanges = diff.new.length > 0 || diff.updated.length > 0;
  
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Customer Scrape</div>
          <h1 className="text-xl font-semibold">Review Changes</h1>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => router.push('/settings/customers')}
          >
            Cancel
          </Button>
          {hasChanges && (
            <div className="flex items-center gap-3">
              {applying && applyStatus && (
                <div className="text-sm text-gray-600 flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-slate-900" />
                  {applyStatus}
                </div>
              )}
              <Button
                disabled={applying}
                onClick={handleApply}
              >
                {applying ? 'Applying...' : 'Apply Changes'}
              </Button>
            </div>
          )}
        </div>
      </div>
      
      {!hasChanges && (
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-gray-600">
              No changes detected. All customers are up to date.
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Summary Stats */}
      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div className="p-3 bg-green-50 border border-green-200 rounded">
              <div className="text-xs text-green-700 font-medium">New</div>
              <div className="text-2xl font-bold text-green-900">{diff.new.length}</div>
            </div>
            <div className="p-3 bg-blue-50 border border-blue-200 rounded">
              <div className="text-xs text-blue-700 font-medium">Updated</div>
              <div className="text-2xl font-bold text-blue-900">{diff.updated.length}</div>
            </div>
            <div className="p-3 bg-gray-50 border border-gray-200 rounded">
              <div className="text-xs text-gray-700 font-medium">Unchanged</div>
              <div className="text-2xl font-bold text-gray-900">{diff.unchanged?.length || 0}</div>
            </div>
            <div className="p-3 bg-red-50 border border-red-200 rounded">
              <div className="text-xs text-red-700 font-medium">Orphaned</div>
              <div className="text-2xl font-bold text-red-900">{diff.orphaned.length}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* New Customers */}
      {diff.new.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>New Customers</CardTitle>
              <Badge className="bg-green-100 text-green-800 border-green-300">
                {diff.new.length} new
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-2 border-b">Account</th>
                    <th className="text-left p-2 border-b">Company</th>
                    <th className="text-left p-2 border-b">City</th>
                    <th className="text-left p-2 border-b">Country</th>
                    <th className="text-left p-2 border-b">Salesperson</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.new.map((customer, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="p-2 border-b font-mono text-xs">{customer.account}</td>
                      <td className="p-2 border-b">{customer.company || '-'}</td>
                      <td className="p-2 border-b">{customer.city || '-'}</td>
                      <td className="p-2 border-b">{customer.country || '-'}</td>
                      <td className="p-2 border-b">{customer.sales_person || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Updated Customers */}
      {diff.updated.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Updated Customers</CardTitle>
              <Badge className="bg-blue-100 text-blue-800 border-blue-300">
                {diff.updated.length} modified
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {diff.updated.map((customer) => {
                const isExpanded = expandedUpdated.has(customer.id);
                return (
                  <div key={customer.id} className="border rounded-md">
                    <button
                      className="w-full text-left p-3 hover:bg-gray-50 flex items-center justify-between"
                      onClick={() => toggleExpanded(customer.id)}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium">{customer.company}</span>
                        <span className="text-xs text-gray-500 font-mono">{customer.customer_id}</span>
                        <Badge className="bg-amber-100 text-amber-800 border-amber-300">
                          {customer.changes.length} field{customer.changes.length !== 1 ? 's' : ''}
                        </Badge>
                      </div>
                      <span className="text-gray-400">{isExpanded ? '▼' : '▶'}</span>
                    </button>
                    {isExpanded && (
                      <div className="border-t p-3">
                        <table className="min-w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="text-left p-2">Field</th>
                              <th className="text-left p-2">Current</th>
                              <th className="text-left p-2">New</th>
                            </tr>
                          </thead>
                          <tbody>
                            {customer.changes.map((change, idx) => (
                              <tr key={idx} className="border-t">
                                <td className="p-2 font-medium">{change.field}</td>
                                <td className="p-2 text-gray-600">
                                  {String(change.oldValue || '-')}
                                </td>
                                <td className="p-2 bg-amber-50">
                                  {String(change.newValue || '-')}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Unchanged Customers */}
      {diff.unchanged && diff.unchanged.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Unchanged Customers</CardTitle>
              <Badge className="bg-gray-100 text-gray-800 border-gray-300">
                {diff.unchanged.length} unchanged
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-xs text-gray-600 mb-3">
              These customers are already up to date.
            </div>
            <div className="overflow-auto max-h-96">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left p-2 border-b">Account</th>
                    <th className="text-left p-2 border-b">Company</th>
                    <th className="text-left p-2 border-b">City</th>
                    <th className="text-left p-2 border-b">Country</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.unchanged.map((customer) => (
                    <tr key={customer.id} className="hover:bg-gray-50">
                      <td className="p-2 border-b font-mono text-xs">{customer.customer_id}</td>
                      <td className="p-2 border-b">{customer.company || '-'}</td>
                      <td className="p-2 border-b">{customer.city || '-'}</td>
                      <td className="p-2 border-b">{customer.country || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Orphaned Customers */}
      {diff.orphaned.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CardTitle>Orphaned Customers</CardTitle>
                <Badge className="bg-red-100 text-red-800 border-red-300">
                  {diff.orphaned.length} orphaned
                </Badge>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setDeleteAllModalOpen(true)}
              >
                Delete All
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-xs text-gray-600 mb-3">
              These customers exist in your database but were not found in SPY.
            </div>
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-2 border-b">Account</th>
                    <th className="text-left p-2 border-b">Company</th>
                    <th className="text-left p-2 border-b">City</th>
                    <th className="text-left p-2 border-b">Country</th>
                    <th className="text-left p-2 border-b">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.orphaned.map((customer) => (
                    <tr key={customer.id} className="hover:bg-gray-50">
                      <td className="p-2 border-b font-mono text-xs">{customer.customer_id}</td>
                      <td className="p-2 border-b">{customer.company || '-'}</td>
                      <td className="p-2 border-b">{customer.city || '-'}</td>
                      <td className="p-2 border-b">{customer.country || '-'}</td>
                      <td className="p-2 border-b">
                        <button
                          className="text-red-600 hover:underline text-xs"
                          onClick={() => {
                            setDeleteTarget({ id: customer.id, company: customer.company || customer.customer_id });
                            setDeleteModalOpen(true);
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Delete Single Customer Modal */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Customer"
        footer={(
          <>
            <button
              className="px-3 py-1.5 text-sm"
              onClick={() => setDeleteModalOpen(false)}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              onClick={() => deleteTarget && handleDeleteCustomer(deleteTarget.id)}
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </>
        )}
      >
        <div className="text-sm">
          Are you sure you want to delete <strong>{deleteTarget?.company}</strong>?
          This action cannot be undone.
        </div>
      </Modal>
      
      {/* Delete All Orphaned Modal */}
      <Modal
        open={deleteAllModalOpen}
        onClose={() => setDeleteAllModalOpen(false)}
        title="Delete All Orphaned Customers"
        footer={(
          <>
            <button
              className="px-3 py-1.5 text-sm"
              onClick={() => setDeleteAllModalOpen(false)}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              onClick={handleDeleteAllOrphaned}
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : `Delete All ${diff.orphaned.length}`}
            </button>
          </>
        )}
      >
        <div className="text-sm">
          Are you sure you want to delete all <strong>{diff.orphaned.length}</strong> orphaned customers?
          This action cannot be undone.
        </div>
      </Modal>
    </div>
  );
}

export default function CustomerPreviewPage() {
  return (
    <Suspense fallback={
      <div className="p-6">
        <div className="text-sm text-gray-600">Loading preview...</div>
      </div>
    }>
      <CustomerPreviewContent />
    </Suspense>
  );
}


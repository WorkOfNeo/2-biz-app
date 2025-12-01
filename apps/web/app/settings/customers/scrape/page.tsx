'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../../../lib/supabaseClient';
import { Card, CardHeader, CardTitle, CardContent } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Modal } from '../../../../components/Modal';
import type { CustomerDiff, CustomerScrapePreviewRow } from '@shared/types';

export default function CustomerScrapePage() {
  const router = useRouter();
  const [scraping, setScraping] = useState(false);
  const [preview, setPreview] = useState<CustomerScrapePreviewRow | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [expandedUpdated, setExpandedUpdated] = useState<Set<string>>(new Set());
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; company: string } | null>(null);
  const [deleteAllModalOpen, setDeleteAllModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const diff: CustomerDiff | null = preview?.diff_data as CustomerDiff || null;

  const handleScrape = async () => {
    try {
      setScraping(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const token = session.access_token;
      
      console.log('[SCRAPE] Starting customer scrape...');
      
      // Enqueue scrape job
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'scrape_customers', payload: { requestedBy: session.user.email } })
      });
      if (!res.ok) {
        const errorText = await res.text();
        console.error('[SCRAPE] Enqueue failed:', errorText);
        throw new Error(errorText);
      }
      
      const { jobId } = await res.json();
      console.log('[SCRAPE] Job enqueued:', jobId);
      
      try { 
        if (typeof window !== 'undefined') 
          window.dispatchEvent(new CustomEvent('job-started', { detail: { label: 'Scrape customers — generating preview...' } })); 
      } catch {}
      
      // Poll for job completion
      let newPreviewId: string | null = null;
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const { data: job, error: jobError } = await supabase.from('jobs').select('status, id').eq('id', jobId).single();
        
        if (jobError) {
          console.error('[SCRAPE] Error fetching job status:', jobError);
          throw new Error(`Job status error: ${jobError.message}`);
        }
        
        console.log(`[SCRAPE] Poll ${i + 1}/120 - Job status:`, job?.status);
        
        if (job?.status === 'succeeded') {
          console.log('[SCRAPE] Job succeeded! Fetching results...');
          
          // Get the result
          const { data: results, error: resultsError } = await supabase
            .from('job_results')
            .select('data')
            .eq('job_id', jobId)
            .order('created_at', { ascending: false })
            .limit(1);
          
          if (resultsError) {
            console.error('[SCRAPE] Error fetching job results:', resultsError);
            throw new Error(`Results error: ${resultsError.message}`);
          }
          
          console.log('[SCRAPE] Job results:', results);
          console.log('[SCRAPE] Results length:', results?.length);
          
          const result = results?.[0];
          console.log('[SCRAPE] First result:', result);
          console.log('[SCRAPE] Result data:', result?.data);
          
          newPreviewId = result?.data?.preview_id;
          console.log('[SCRAPE] Preview ID:', newPreviewId);
          break;
        }
        
        if (job?.status === 'failed' || job?.status === 'cancelled') {
          console.error('[SCRAPE] Job failed or cancelled');
          throw new Error('Scrape job failed');
        }
      }
      
      if (!newPreviewId) {
        console.error('[SCRAPE] No preview ID found after polling');
        throw new Error('No preview generated');
      }

      console.log('[SCRAPE] Fetching preview data for ID:', newPreviewId);
      
      // Fetch the preview data
      setPreviewId(newPreviewId);
      const previewRes = await fetch(`/api/customers/preview?id=${newPreviewId}`);
      if (!previewRes.ok) {
        const errorText = await previewRes.text();
        console.error('[SCRAPE] Failed to fetch preview:', errorText);
        throw new Error('Failed to fetch preview');
      }
      const previewData = await previewRes.json();
      console.log('[SCRAPE] Preview data received:', previewData);
      setPreview(previewData.preview);
      console.log('[SCRAPE] Success! Preview set.');
    } catch (e: any) {
      console.error('[SCRAPE] Error:', e);
      alert(e?.message || 'Failed to scrape customers');
    } finally {
      setScraping(false);
    }
  };

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
    if (!previewId) return;
    
    try {
      setApplying(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      
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
      
      const { jobId } = await res.json();
      
      // Poll for job completion
      await pollJobCompletion(jobId);
      
      router.push('/settings/customers?applied=true');
    } catch (e: any) {
      alert(e?.message || 'Failed to apply preview');
      setApplying(false);
    }
  };

  const pollJobCompletion = async (jobId: string) => {
    for (let i = 0; i < 60; i++) {
      const { data } = await supabase.from('jobs').select('status').eq('id', jobId).single();
      if (data?.status === 'succeeded') return;
      if (data?.status === 'failed') throw new Error('Job failed');
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Job timeout');
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

  const hasChanges = diff && (diff.new.length > 0 || diff.updated.length > 0);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Customer Management</div>
          <h1 className="text-xl font-semibold">Scrape Customers</h1>
        </div>
        <Button
          variant="secondary"
          onClick={() => router.push('/settings/customers')}
        >
          Back to Customers
        </Button>
      </div>

      {/* Scrape Section */}
      {!preview && (
        <Card>
          <CardHeader>
            <CardTitle>Start Customer Scrape</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                This will scrape customer data from SPY and generate a preview of changes that need to be applied.
                You'll be able to review all changes before applying them.
              </p>
              <Button
                disabled={scraping}
                onClick={handleScrape}
              >
                {scraping ? 'Scraping...' : 'Start Scraping'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Preview Section */}
      {preview && diff && (
        <>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Review Changes</h2>
              <p className="text-sm text-gray-500">
                {preview.applied_at 
                  ? 'This preview has already been applied'
                  : 'Review the changes below and apply them when ready'
                }
              </p>
            </div>
            {!preview.applied_at && hasChanges && (
              <Button
                disabled={applying}
                onClick={handleApply}
              >
                {applying ? 'Applying...' : 'Apply Changes'}
              </Button>
            )}
          </div>

          {preview.applied_at && (
            <Card>
              <CardContent className="p-6">
                <div className="text-sm text-gray-600">
                  This preview has already been applied.
                </div>
              </CardContent>
            </Card>
          )}

          {!preview.applied_at && !hasChanges && (
            <Card>
              <CardContent className="p-6">
                <div className="text-sm text-gray-600">
                  No changes detected. All customers are up to date.
                </div>
              </CardContent>
            </Card>
          )}

          {/* New Customers */}
          {!preview.applied_at && diff.new.length > 0 && (
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
          {!preview.applied_at && diff.updated.length > 0 && (
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

          {/* Orphaned Customers */}
          {!preview.applied_at && diff.orphaned.length > 0 && (
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
        </>
      )}
    </div>
  );
}


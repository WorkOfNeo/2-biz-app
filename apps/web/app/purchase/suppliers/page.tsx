'use client';
import React, { useState, useCallback } from 'react';
import useSWR, { mutate } from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';

type Supplier = {
  id: string;
  name: string;
  external_name?: string;
  spy_id?: string;
  lead_time_days: number;
  travel_time_days: number;
  moq: number;
  tags: string[];
  notes?: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type SupplierFormData = {
  name: string;
  external_name: string;
  spy_id: string;
  lead_time_days: number;
  travel_time_days: number;
  moq: number;
  tags: string[];
  notes: string;
  active: boolean;
};

const emptyForm: SupplierFormData = {
  name: '',
  external_name: '',
  spy_id: '',
  lead_time_days: 0,
  travel_time_days: 0,
  moq: 0,
  tags: [],
  notes: '',
  active: true,
};

function SupplierForm({
  initial,
  onSave,
  onCancel,
  isNew,
}: {
  initial: SupplierFormData;
  onSave: (data: SupplierFormData) => Promise<void>;
  onCancel: () => void;
  isNew: boolean;
}) {
  const [form, setForm] = useState<SupplierFormData>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tagInput, setTagInput] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(form);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const addTag = () => {
    const tag = tagInput.trim().toUpperCase();
    if (tag && !form.tags.includes(tag)) {
      setForm(prev => ({ ...prev, tags: [...prev.tags, tag] }));
      setTagInput('');
    }
  };

  const removeTag = (tag: string) => {
    setForm(prev => ({ ...prev, tags: prev.tags.filter(t => t !== tag) }));
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Name <span className="text-red-500">*</span>
          </label>
          <Input
            value={form.name}
            onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
            placeholder="Supplier name"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            External Name
          </label>
          <Input
            value={form.external_name}
            onChange={e => setForm(prev => ({ ...prev, external_name: e.target.value }))}
            placeholder="Name in external systems"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            SPY ID
          </label>
          <Input
            value={form.spy_id}
            onChange={e => setForm(prev => ({ ...prev, spy_id: e.target.value }))}
            placeholder="ID in SPY system"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            MOQ (Minimum Order Qty)
          </label>
          <Input
            type="number"
            min={0}
            value={form.moq}
            onChange={e => setForm(prev => ({ ...prev, moq: parseInt(e.target.value) || 0 }))}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Lead Time (days)
          </label>
          <Input
            type="number"
            min={0}
            value={form.lead_time_days}
            onChange={e => setForm(prev => ({ ...prev, lead_time_days: parseInt(e.target.value) || 0 }))}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Travel Time (days)
          </label>
          <Input
            type="number"
            min={0}
            value={form.travel_time_days}
            onChange={e => setForm(prev => ({ ...prev, travel_time_days: parseInt(e.target.value) || 0 }))}
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Tags
        </label>
        <div className="flex gap-2 mb-2 flex-wrap">
          {form.tags.map(tag => (
            <Badge
              key={tag}
              className="bg-[#B8A8D8]/20 text-[#B8A8D8] cursor-pointer hover:bg-[#B8A8D8]/30"
              onClick={() => removeTag(tag)}
            >
              {tag} ×
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            placeholder="Add tag (e.g., BELL_RAIN)"
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTag())}
            className="flex-1"
          />
          <Button type="button" variant="outline" onClick={addTag} size="sm">
            Add
          </Button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Notes
        </label>
        <textarea
          value={form.notes}
          onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
          className="w-full border rounded-md p-2 text-sm min-h-[80px]"
          placeholder="Additional notes..."
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="active"
          checked={form.active}
          onChange={e => setForm(prev => ({ ...prev, active: e.target.checked }))}
          className="rounded"
        />
        <label htmlFor="active" className="text-sm text-slate-700">Active</label>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-3 text-sm">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving} className="bg-[#8FA894] hover:bg-[#8FA894]/90">
          {saving ? 'Saving...' : isNew ? 'Create Supplier' : 'Save Changes'}
        </Button>
      </div>
    </form>
  );
}

export default function SuppliersPage() {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Fetch suppliers
  const { data: suppliersData, error: suppliersError, isLoading } = useSWR('suppliers', async () => {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .order('name');
    if (error) throw error;
    return data as Supplier[];
  });
  const suppliers = suppliersData || [];

  const handleCreate = useCallback(async (data: SupplierFormData) => {
    const res = await fetch('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    mutate('suppliers');
    setShowForm(false);
  }, []);

  const handleUpdate = useCallback(async (id: string, data: SupplierFormData) => {
    const res = await fetch('/api/suppliers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...data }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    mutate('suppliers');
    setEditingId(null);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const res = await fetch(`/api/suppliers?id=${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const result = await res.json();
      throw new Error(result.error);
    }
    mutate('suppliers');
    setDeleteConfirm(null);
  }, []);

  const editingSupplier = editingId ? suppliers.find(s => s.id === editingId) : null;

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Suppliers</h1>
          <p className="text-slate-500 text-sm mt-1">
            Manage supplier master data for AI purchasing suggestions
          </p>
        </div>
        {!showForm && !editingId && (
          <Button onClick={() => setShowForm(true)} className="bg-[#8FA894] hover:bg-[#8FA894]/90">
            Add Supplier
          </Button>
        )}
      </div>

      {/* Create Form */}
      {showForm && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>New Supplier</CardTitle>
          </CardHeader>
          <CardContent>
            <SupplierForm
              initial={emptyForm}
              onSave={handleCreate}
              onCancel={() => setShowForm(false)}
              isNew={true}
            />
          </CardContent>
        </Card>
      )}

      {/* Edit Form */}
      {editingId && editingSupplier && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Edit Supplier: {editingSupplier.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <SupplierForm
              initial={{
                name: editingSupplier.name,
                external_name: editingSupplier.external_name || '',
                spy_id: editingSupplier.spy_id || '',
                lead_time_days: editingSupplier.lead_time_days,
                travel_time_days: editingSupplier.travel_time_days,
                moq: editingSupplier.moq,
                tags: editingSupplier.tags || [],
                notes: editingSupplier.notes || '',
                active: editingSupplier.active,
              }}
              onSave={(data) => handleUpdate(editingId, data)}
              onCancel={() => setEditingId(null)}
              isNew={false}
            />
          </CardContent>
        </Card>
      )}

      {/* Suppliers List */}
      {isLoading && (
        <div className="text-center py-12 text-slate-500">Loading suppliers...</div>
      )}

      {suppliersError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-4 text-sm">
          Failed to load suppliers: {suppliersError.message}
        </div>
      )}

      {!isLoading && suppliers.length === 0 && !showForm && (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="text-slate-500 mb-4">No suppliers configured yet</div>
            <Button onClick={() => setShowForm(true)} variant="outline">
              Add your first supplier
            </Button>
          </CardContent>
        </Card>
      )}

      {suppliers.length > 0 && !editingId && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left p-3 font-medium">Name</th>
                  <th className="text-left p-3 font-medium">MOQ</th>
                  <th className="text-left p-3 font-medium">Lead Time</th>
                  <th className="text-left p-3 font-medium">Tags</th>
                  <th className="text-center p-3 font-medium">Status</th>
                  <th className="text-right p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map(supplier => (
                  <tr key={supplier.id} className="border-t hover:bg-slate-50">
                    <td className="p-3">
                      <div className="font-medium">{supplier.name}</div>
                      {supplier.external_name && (
                        <div className="text-xs text-slate-500">{supplier.external_name}</div>
                      )}
                    </td>
                    <td className="p-3">{supplier.moq > 0 ? supplier.moq.toLocaleString() : '-'}</td>
                    <td className="p-3">
                      {supplier.lead_time_days > 0 ? `${supplier.lead_time_days}d` : '-'}
                      {supplier.travel_time_days > 0 && (
                        <span className="text-slate-400 ml-1">(+{supplier.travel_time_days}d travel)</span>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex gap-1 flex-wrap">
                        {(supplier.tags || []).map(tag => (
                          <Badge key={tag} className="bg-[#B8A8D8]/20 text-[#B8A8D8] text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="p-3 text-center">
                      <Badge className={supplier.active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}>
                        {supplier.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(supplier.id)}
                        >
                          Edit
                        </Button>
                        {deleteConfirm === supplier.id ? (
                          <>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleDelete(supplier.id)}
                            >
                              Confirm
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setDeleteConfirm(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => setDeleteConfirm(supplier.id)}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}


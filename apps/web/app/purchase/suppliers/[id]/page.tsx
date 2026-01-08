'use client';

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import Link from 'next/link';
import { supabase } from '../../../../lib/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import { ArrowLeft, Trash2, Plus, Star } from 'lucide-react';

type SupplierContact = {
  name: string;
  email: string;
  role?: string;
  primary?: boolean;
};

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
  contacts?: SupplierContact[];
  active: boolean;
  created_at: string;
  updated_at: string;
};

export default function SupplierDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  const isNew = id === 'new';

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Form state
  const [form, setForm] = useState({
    name: '',
    external_name: '',
    spy_id: '',
    lead_time_days: 0,
    travel_time_days: 0,
    moq: 0,
    tags: [] as string[],
    notes: '',
    contacts: [] as SupplierContact[],
    active: true,
  });

  // Fetch supplier data
  const { data: supplier, error: fetchError, mutate } = useSWR(
    !isNew && id ? ['supplier', id] : null,
    async () => {
      const { data, error } = await supabase
        .from('suppliers')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data as Supplier;
    }
  );

  // Populate form when supplier loads
  useEffect(() => {
    if (supplier) {
      setForm({
        name: supplier.name || '',
        external_name: supplier.external_name || '',
        spy_id: supplier.spy_id || '',
        lead_time_days: supplier.lead_time_days || 0,
        travel_time_days: supplier.travel_time_days || 0,
        moq: supplier.moq || 0,
        tags: supplier.tags || [],
        notes: supplier.notes || '',
        contacts: supplier.contacts || [],
        active: supplier.active ?? true,
      });
    }
  }, [supplier]);

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        external_name: form.external_name.trim() || null,
        spy_id: form.spy_id.trim() || null,
        notes: form.notes.trim() || null,
      };

      let res;
      if (isNew) {
        res = await fetch('/api/suppliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch('/api/suppliers', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, ...payload }),
        });
      }

      const result = await res.json();
      if (!res.ok) throw new Error(result.error);

      if (isNew && result.data?.id) {
        router.push(`/purchase/suppliers/${result.data.id}`);
      } else {
        mutate();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/suppliers?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const result = await res.json();
        throw new Error(result.error);
      }
      router.push('/purchase/suppliers');
    } catch (err: any) {
      setError(err.message);
      setDeleting(false);
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

  const addContact = () => {
    setForm(prev => ({
      ...prev,
      contacts: [
        ...prev.contacts,
        { name: '', email: '', role: '', primary: prev.contacts.length === 0 },
      ],
    }));
  };

  const updateContact = (idx: number, updates: Partial<SupplierContact>) => {
    const newContacts = [...form.contacts];
    newContacts[idx] = { ...newContacts[idx], ...updates };
    setForm(prev => ({ ...prev, contacts: newContacts }));
  };

  const removeContact = (idx: number) => {
    const newContacts = form.contacts.filter((_, i) => i !== idx);
    // If removed contact was primary, make first one primary
    if (form.contacts[idx]?.primary && newContacts.length > 0) {
      newContacts[0] = { ...newContacts[0], primary: true };
    }
    setForm(prev => ({ ...prev, contacts: newContacts }));
  };

  const setPrimaryContact = (idx: number) => {
    const newContacts = form.contacts.map((c, i) => ({
      ...c,
      primary: i === idx,
    }));
    setForm(prev => ({ ...prev, contacts: newContacts }));
  };

  if (!isNew && fetchError) {
    return (
      <div className="max-w-4xl mx-auto py-8 px-4">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
          Failed to load supplier: {fetchError.message}
        </div>
      </div>
    );
  }

  if (!isNew && !supplier) {
    return (
      <div className="max-w-4xl mx-auto py-8 px-4">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 rounded w-1/3"></div>
          <div className="h-64 bg-slate-100 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link href="/purchase/suppliers">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold text-slate-900">
            {isNew ? 'New Supplier' : supplier?.name}
          </h1>
          {!isNew && (
            <p className="text-slate-500 text-sm">
              Last updated: {new Date(supplier?.updated_at || '').toLocaleDateString()}
            </p>
          )}
        </div>
        {!isNew && (
          <Button
            variant="outline"
            onClick={() => setShowDeleteConfirm(true)}
            className="text-red-600 border-red-200 hover:bg-red-50"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </Button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Form */}
        <div className="lg:col-span-2 space-y-6">
          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle>Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
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
                    placeholder="Add tag"
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
                  className="w-full border rounded-md p-3 text-sm min-h-[100px] focus:ring-2 focus:ring-[#8FA894]/20 focus:border-[#8FA894]"
                  placeholder="Additional notes about this supplier..."
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
            </CardContent>
          </Card>

          {/* Contact Persons */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Contact Persons</CardTitle>
                <Button variant="outline" size="sm" onClick={addContact}>
                  <Plus className="w-4 h-4 mr-1" />
                  Add Contact
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {form.contacts.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <p className="mb-2">No contacts added yet</p>
                  <Button variant="outline" size="sm" onClick={addContact}>
                    Add your first contact
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {form.contacts.map((contact, idx) => (
                    <div
                      key={idx}
                      className={`p-4 rounded-lg border ${
                        contact.primary
                          ? 'bg-[#C5D5CA]/10 border-[#8FA894]'
                          : 'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <div className="flex items-start gap-4">
                        <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-slate-500 mb-1">
                              Name
                            </label>
                            <Input
                              value={contact.name}
                              onChange={e => updateContact(idx, { name: e.target.value })}
                              placeholder="Contact name"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-500 mb-1">
                              Email
                            </label>
                            <Input
                              type="email"
                              value={contact.email}
                              onChange={e => updateContact(idx, { email: e.target.value })}
                              placeholder="email@supplier.com"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-500 mb-1">
                              Role
                            </label>
                            <Input
                              value={contact.role || ''}
                              onChange={e => updateContact(idx, { role: e.target.value })}
                              placeholder="e.g., Sales Manager"
                            />
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 pt-5">
                          <button
                            type="button"
                            onClick={() => setPrimaryContact(idx)}
                            className={`p-1.5 rounded transition-colors ${
                              contact.primary
                                ? 'text-amber-500'
                                : 'text-slate-300 hover:text-amber-400'
                            }`}
                            title={contact.primary ? 'Primary contact' : 'Set as primary'}
                          >
                            <Star className={`w-4 h-4 ${contact.primary ? 'fill-current' : ''}`} />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeContact(idx)}
                            className="p-1.5 rounded text-slate-400 hover:text-red-500 transition-colors"
                            title="Remove contact"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      {contact.primary && (
                        <div className="mt-2 text-xs text-[#8FA894] font-medium">
                          ★ Primary contact - auto-selected when sending emails
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Save Button */}
          <Card>
            <CardContent className="p-4">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="w-full bg-[#8FA894] hover:bg-[#8FA894]/90"
              >
                {saving ? 'Saving...' : isNew ? 'Create Supplier' : 'Save Changes'}
              </Button>
            </CardContent>
          </Card>

          {/* Status */}
          {!isNew && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-slate-600">Status</span>
                  <Badge className={form.active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}>
                    {form.active ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-slate-600">Contacts</span>
                  <span className="text-sm font-medium">{form.contacts.length}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-slate-600">Lead Time</span>
                  <span className="text-sm font-medium">
                    {form.lead_time_days}d + {form.travel_time_days}d travel
                  </span>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                <Trash2 className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-lg">Delete Supplier</h3>
                <p className="text-sm text-slate-600">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-slate-700 mb-6">
              Are you sure you want to delete <strong>{supplier?.name}</strong>? This will permanently remove the supplier and all associated data.
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                onClick={handleDelete}
                disabled={deleting}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {deleting ? 'Deleting...' : 'Delete Supplier'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


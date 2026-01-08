'use client';

import React from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Plus, Users, ChevronRight } from 'lucide-react';

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

export default function SuppliersPage() {
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

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Suppliers</h1>
          <p className="text-slate-500 text-sm mt-1">
            Manage supplier master data and contacts
          </p>
        </div>
        <Link href="/purchase/suppliers/new">
          <Button className="bg-[#8FA894] hover:bg-[#8FA894]/90">
            <Plus className="w-4 h-4 mr-2" />
            Add Supplier
          </Button>
        </Link>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="text-center py-12 text-slate-500">Loading suppliers...</div>
      )}

      {/* Error */}
      {suppliersError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-4 text-sm">
          Failed to load suppliers: {suppliersError.message}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && suppliers.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="text-slate-500 mb-4">No suppliers configured yet</div>
            <Link href="/purchase/suppliers/new">
              <Button variant="outline">
                Add your first supplier
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Suppliers List */}
      {suppliers.length > 0 && (
        <div className="space-y-3">
          {suppliers.map(supplier => (
            <Link key={supplier.id} href={`/purchase/suppliers/${supplier.id}`}>
              <Card className="hover:border-[#C5D5CA] transition-colors cursor-pointer">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    {/* Name & External Name */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-900">{supplier.name}</span>
                        <Badge className={supplier.active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}>
                          {supplier.active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      {supplier.external_name && (
                        <div className="text-sm text-slate-500">{supplier.external_name}</div>
                      )}
                    </div>

                    {/* Contacts */}
                    <div className="flex items-center gap-1 text-sm text-slate-600">
                      <Users className="w-4 h-4" />
                      <span>{supplier.contacts?.length || 0}</span>
                    </div>

                    {/* Lead Time */}
                    <div className="text-sm text-slate-600 min-w-[100px] text-right">
                      {supplier.lead_time_days > 0 ? (
                        <>
                          {supplier.lead_time_days}d
                          {supplier.travel_time_days > 0 && (
                            <span className="text-slate-400"> +{supplier.travel_time_days}d</span>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </div>

                    {/* Tags */}
                    <div className="flex gap-1 flex-wrap max-w-[200px]">
                      {(supplier.tags || []).slice(0, 3).map(tag => (
                        <Badge key={tag} className="bg-[#B8A8D8]/20 text-[#B8A8D8] text-xs">
                          {tag}
                        </Badge>
                      ))}
                      {(supplier.tags || []).length > 3 && (
                        <Badge className="bg-slate-100 text-slate-500 text-xs">
                          +{supplier.tags.length - 3}
                        </Badge>
                      )}
                    </div>

                    {/* Arrow */}
                    <ChevronRight className="w-5 h-5 text-slate-400" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

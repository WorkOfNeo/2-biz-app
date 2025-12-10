'use client';
import * as React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import Link from 'next/link';
import { ChevronRight, List } from 'lucide-react';

type StockList = {
  id: string;
  name: string;
  fixed: boolean;
  created_at: string;
  updated_at: string;
};

export default function StockListsPage() {
  const supabase = createClientComponentClient();
  
  const { data: lists, mutate } = useSWR('stock-lists:all', async () => {
    const { data, error } = await supabase
      .from('stock_lists')
      .select('*')
      .order('fixed', { ascending: false })
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []) as StockList[];
  });

  const fixedLists = lists?.filter(l => l.fixed) ?? [];
  const userLists = lists?.filter(l => !l.fixed) ?? [];

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Settings</div>
        <h1 className="text-xl font-semibold">Stock Lists</h1>
        <p className="text-sm text-gray-600 mt-1">
          Manage your stock lists for exports and organization
        </p>
      </div>

      {/* Fixed Lists */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">System Lists</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {fixedLists.map((list) => (
              <Link
                key={list.id}
                href={`/settings/stock-lists/${list.id}`}
                className="flex items-center justify-between p-3 rounded-lg border hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <List className="h-5 w-5 text-gray-400" />
                  <div>
                    <div className="font-medium">{list.name}</div>
                    <div className="text-xs text-gray-500">System list</div>
                  </div>
                </div>
                <ChevronRight className="h-5 w-5 text-gray-400" />
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* User Lists */}
      {userLists.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Custom Lists</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {userLists.map((list) => (
                <Link
                  key={list.id}
                  href={`/settings/stock-lists/${list.id}`}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <List className="h-5 w-5 text-gray-400" />
                    <div>
                      <div className="font-medium">{list.name}</div>
                      <div className="text-xs text-gray-500">Custom list</div>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-gray-400" />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

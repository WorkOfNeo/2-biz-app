'use client';
import * as React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import Link from 'next/link';
import { ChevronRight, List, Wrench } from 'lucide-react';

type StockList = {
  id: string;
  name: string;
  fixed: boolean;
  created_at: string;
  updated_at: string;
};

export default function StockListsPage() {
  const supabase = createClientComponentClient();
  const [fixingLists, setFixingLists] = React.useState(false);
  const [fixMessage, setFixMessage] = React.useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  
  const { data: lists, mutate } = useSWR('stock-lists:all', async () => {
    const { data, error } = await supabase
      .from('stock_lists')
      .select('*');
    if (error) throw error;
    
    // Custom sort order: Aktiv, Passiv, NOOS, Nye styles, Intet, then alphabetically
    const sortOrder: Record<string, number> = {
      'Aktiv': 1,
      'Passiv': 2,
      'NOOS': 3,
      'Nye styles': 4,
      'Intet': 5,
    };
    
    const sorted = (data ?? []).sort((a, b) => {
      const aOrder = sortOrder[a.name] ?? 999;
      const bOrder = sortOrder[b.name] ?? 999;
      
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      
      // For items not in sortOrder, sort alphabetically
      return a.name.localeCompare(b.name);
    });
    
    return sorted as StockList[];
  });

  const fixedLists = lists?.filter(l => l.fixed) ?? [];
  const userLists = lists?.filter(l => !l.fixed) ?? [];

  // FIX LISTS: Remove colors from PASSIV that are included in AKTIV
  async function fixLists() {
    setFixMessage(null);
    setFixingLists(true);
    try {
      // Find Aktiv and Passiv list IDs
      const aktivList = lists?.find(l => l.name === 'Aktiv');
      const passivList = lists?.find(l => l.name === 'Passiv');
      
      if (!aktivList || !passivList) {
        setFixMessage({ type: 'error', text: 'Could not find Aktiv or Passiv list.' });
        return;
      }

      // Fetch all included colors from AKTIV
      const { data: aktivColors, error: aktivError } = await supabase
        .from('stock_list_colors')
        .select('style_color_id')
        .eq('list_id', aktivList.id)
        .eq('include', true);
      
      if (aktivError) throw aktivError;
      
      const aktivColorIds = new Set((aktivColors ?? []).map(c => c.style_color_id));
      
      if (aktivColorIds.size === 0) {
        setFixMessage({ type: 'info', text: 'AKTIV has no included colors. Nothing to fix.' });
        return;
      }

      // Fetch included colors from PASSIV that overlap with AKTIV
      const aktivColorIdArray = Array.from(aktivColorIds);
      const { data: passivOverlap, error: passivError } = await supabase
        .from('stock_list_colors')
        .select('style_color_id')
        .eq('list_id', passivList.id)
        .eq('include', true)
        .in('style_color_id', aktivColorIdArray);
      
      if (passivError) throw passivError;
      
      const overlapIds = (passivOverlap ?? []).map(c => c.style_color_id);
      
      if (overlapIds.length === 0) {
        setFixMessage({ type: 'info', text: 'No overlapping colors between AKTIV and PASSIV. Nothing to fix.' });
        return;
      }

      // Update overlapping PASSIV colors to include=false (chunk to avoid PostgREST limits)
      const chunkSize = 500;
      let updated = 0;
      for (let i = 0; i < overlapIds.length; i += chunkSize) {
        const chunk = overlapIds.slice(i, i + chunkSize);
        const { error: updateError } = await supabase
          .from('stock_list_colors')
          .update({ include: false })
          .eq('list_id', passivList.id)
          .in('style_color_id', chunk);
        
        if (updateError) throw updateError;
        updated += chunk.length;
      }

      // Refresh caches
      await mutate();

      setFixMessage({ type: 'success', text: `Excluded ${updated} color(s) from PASSIV (because they're included in AKTIV).` });
    } catch (e: any) {
      setFixMessage({ type: 'error', text: e.message || 'Failed to fix lists' });
    } finally {
      setFixingLists(false);
    }
  }

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
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">System Lists</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={fixLists}
            disabled={fixingLists}
          >
            <Wrench className="h-4 w-4 mr-2" />
            {fixingLists ? 'Fixing...' : 'FIX LISTS'}
          </Button>
        </CardHeader>
        {fixMessage && (
          <div className={`mx-6 mb-4 p-3 rounded text-sm ${
            fixMessage.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' :
            fixMessage.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' :
            'bg-blue-50 text-blue-700 border border-blue-200'
          }`}>
            {fixMessage.text}
          </div>
        )}
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

'use client';

import React from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { ChevronRight, List, Plus, Settings } from 'lucide-react';

type StockList = {
  id: string;
  name: string;
  fixed: boolean;
  created_at: string;
  updated_at: string;
};

type ListStyleCount = {
  list_id: string;
  count: number;
};

type ListColorCount = {
  list_id: string;
  count: number;
};

export default function CallOffSetsPage() {
  const supabase = createClientComponentClient();
  const [newSetName, setNewSetName] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  // Fetch all stock lists
  const { data: lists, mutate } = useSWR('calloff-sets:lists', async () => {
    const { data, error } = await supabase
      .from('stock_lists')
      .select('*')
      .order('name');
    if (error) throw error;
    return data as StockList[];
  });

  // Fetch style counts per list
  const { data: styleCounts } = useSWR('calloff-sets:style-counts', async () => {
    const { data, error } = await supabase
      .from('stock_list_styles')
      .select('list_id');
    if (error) throw error;
    
    const counts = new Map<string, number>();
    (data ?? []).forEach((row: any) => {
      const current = counts.get(row.list_id) || 0;
      counts.set(row.list_id, current + 1);
    });
    return counts;
  });

  // Fetch included color counts per list
  const { data: colorCounts } = useSWR('calloff-sets:color-counts', async () => {
    const { data, error } = await supabase
      .from('stock_list_colors')
      .select('list_id, include')
      .eq('include', true);
    if (error) throw error;
    
    const counts = new Map<string, number>();
    (data ?? []).forEach((row: any) => {
      const current = counts.get(row.list_id) || 0;
      counts.set(row.list_id, current + 1);
    });
    return counts;
  });

  async function createSet() {
    const trimmedName = newSetName.trim();
    if (!trimmedName) return;
    
    setCreating(true);
    try {
      const { error } = await supabase
        .from('stock_lists')
        .insert({ name: trimmedName, fixed: false });
      
      if (error) {
        if (error.code === '23505') {
          alert('A set with this name already exists');
        } else {
          throw error;
        }
        return;
      }
      
      setNewSetName('');
      await mutate();
    } catch (err: any) {
      console.error('Failed to create set:', err);
      alert('Failed to create set: ' + (err.message || 'Unknown error'));
    } finally {
      setCreating(false);
    }
  }

  // Separate system lists (fixed) from user-created sets
  const systemLists = (lists ?? []).filter(l => l.fixed);
  const userSets = (lists ?? []).filter(l => !l.fixed);

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      <div>
        <div className="text-xs text-slate-500">Purchase</div>
        <h1 className="text-2xl font-semibold text-slate-900">Call-Off Sets</h1>
        <p className="text-slate-600 text-sm mt-1">
          Sets are reusable groups of styles and colors for NOOS Call-Off. They use the Stock Lists system
          with per-color include/exclude rules.
        </p>
      </div>

      {/* Quick Actions */}
      <Card className="border-[#C5D5CA]">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Create New Set
          </CardTitle>
          <CardDescription>
            Create a new set, then add styles and colors to it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Set name (e.g. 'Winter NOOS')"
              value={newSetName}
              onChange={(e) => setNewSetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createSet()}
              className="flex-1 px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#8FA894] focus:border-transparent"
            />
            <Button
              onClick={createSet}
              disabled={creating || !newSetName.trim()}
              className="bg-[#8FA894] hover:bg-[#8FA894]/90"
            >
              {creating ? 'Creating...' : 'Create Set'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* User Sets */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Sets</CardTitle>
          <CardDescription>
            Custom sets you've created for call-off grouping.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {userSets.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              <p className="mb-2">No custom sets yet.</p>
              <p className="text-sm">Create one above to get started!</p>
            </div>
          ) : (
            <div className="space-y-2">
              {userSets.map((list) => {
                const styleCount = styleCounts?.get(list.id) || 0;
                const colorCount = colorCounts?.get(list.id) || 0;
                
                return (
                  <Link
                    key={list.id}
                    href={`/settings/stock-lists/${list.id}`}
                    className="flex items-center justify-between p-4 rounded-lg border hover:bg-slate-50 hover:border-[#C5D5CA] transition-colors group"
                  >
                    <div className="flex items-center gap-3">
                      <List className="h-5 w-5 text-[#8FA894]" />
                      <div>
                        <div className="font-medium text-slate-900">{list.name}</div>
                        <div className="text-xs text-slate-500">
                          {styleCount} style{styleCount !== 1 ? 's' : ''} · {colorCount} color{colorCount !== 1 ? 's' : ''} included
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        Custom
                      </Badge>
                      <ChevronRight className="h-5 w-5 text-slate-400 group-hover:text-[#8FA894] transition-colors" />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* System Lists */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">System Lists</CardTitle>
          <CardDescription>
            Built-in lists. You can use these as sets too, or just as reference.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {systemLists.map((list) => {
              const styleCount = styleCounts?.get(list.id) || 0;
              const colorCount = colorCounts?.get(list.id) || 0;
              
              return (
                <Link
                  key={list.id}
                  href={`/settings/stock-lists/${list.id}`}
                  className="flex items-center justify-between p-4 rounded-lg border hover:bg-slate-50 hover:border-[#C5D5CA] transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <List className="h-5 w-5 text-slate-400" />
                    <div>
                      <div className="font-medium text-slate-900">{list.name}</div>
                      <div className="text-xs text-slate-500">
                        {styleCount} style{styleCount !== 1 ? 's' : ''} · {colorCount} color{colorCount !== 1 ? 's' : ''} included
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs bg-slate-100">
                      System
                    </Badge>
                    <ChevronRight className="h-5 w-5 text-slate-400 group-hover:text-[#8FA894] transition-colors" />
                  </div>
                </Link>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Help Text */}
      <div className="bg-[#F5F3F0] rounded-lg p-4 text-sm text-slate-600 border border-[#C5D5CA]/50">
        <div className="flex items-start gap-3">
          <Settings className="h-5 w-5 text-[#8FA894] mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium text-slate-700 mb-1">How Sets Work</p>
            <p className="mb-2">
              Sets are Stock Lists with per-color include rules. When you select a Set in the NOOS Call-Off flow,
              it automatically loads all the styles and colors you've configured.
            </p>
            <p>
              Click on any set above to edit which styles and colors are included. You can add/remove styles
              and toggle individual colors on or off.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

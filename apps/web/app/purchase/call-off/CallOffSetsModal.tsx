'use client';

import React from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { ChevronRight, List, Plus, Settings, X } from 'lucide-react';

type StockList = {
  id: string;
  name: string;
  fixed: boolean;
  created_at: string;
  updated_at: string;
};

type CallOffSetsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelectSet?: (setId: string, setName: string) => void;
};

export default function CallOffSetsModal({ isOpen, onClose, onSelectSet }: CallOffSetsModalProps) {
  const supabase = createClientComponentClient();
  const [newSetName, setNewSetName] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  // Fetch all stock lists
  const { data: lists, mutate } = useSWR(isOpen ? 'calloff-sets:lists' : null, async () => {
    const { data, error } = await supabase
      .from('stock_lists')
      .select('*')
      .order('name');
    if (error) throw error;
    return data as StockList[];
  });

  // Fetch style counts per list
  const { data: styleCounts } = useSWR(isOpen ? 'calloff-sets:style-counts' : null, async () => {
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
  const { data: colorCounts } = useSWR(isOpen ? 'calloff-sets:color-counts' : null, async () => {
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

  if (!isOpen) return null;

  // Separate system lists (fixed) from user-created sets
  const systemLists = (lists ?? []).filter(l => l.fixed);
  const userSets = (lists ?? []).filter(l => !l.fixed);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50" 
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Manage Call-Off Sets</h2>
            <p className="text-sm text-slate-500">
              Sets are reusable groups of styles and colors for NOOS Call-Off
            </p>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-slate-100 rounded-md transition-colors"
          >
            <X className="h-5 w-5 text-slate-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Create New Set */}
          <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
            <div className="flex items-center gap-2 mb-3">
              <Plus className="h-4 w-4 text-[#8FA894]" />
              <span className="text-sm font-medium text-slate-700">Create New Set</span>
            </div>
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
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>

          {/* User Sets */}
          <div>
            <h3 className="text-sm font-medium text-slate-700 mb-2">Your Sets</h3>
            {userSets.length === 0 ? (
              <div className="text-center py-6 text-slate-500 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                <p className="text-sm">No custom sets yet. Create one above!</p>
              </div>
            ) : (
              <div className="space-y-2">
                {userSets.map((list) => {
                  const styleCount = styleCounts?.get(list.id) || 0;
                  const colorCount = colorCounts?.get(list.id) || 0;
                  
                  return (
                    <div
                      key={list.id}
                      className="flex items-center justify-between p-3 rounded-lg border hover:bg-slate-50 hover:border-[#C5D5CA] transition-colors group"
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
                        <Badge className="text-xs border-slate-300">Custom</Badge>
                        <Link
                          href={`/settings/stock-lists/${list.id}`}
                          className="px-2 py-1 text-xs text-[#8FA894] hover:bg-[#8FA894]/10 rounded transition-colors"
                        >
                          Edit
                        </Link>
                        {onSelectSet && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onSelectSet(list.id, list.name)}
                            className="text-xs"
                          >
                            Use
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* System Lists */}
          <div>
            <h3 className="text-sm font-medium text-slate-700 mb-2">System Lists</h3>
            <div className="space-y-2">
              {systemLists.map((list) => {
                const styleCount = styleCounts?.get(list.id) || 0;
                const colorCount = colorCounts?.get(list.id) || 0;
                
                return (
                  <div
                    key={list.id}
                    className="flex items-center justify-between p-3 rounded-lg border hover:bg-slate-50 transition-colors group"
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
                      <Badge className="text-xs bg-slate-100">System</Badge>
                      <Link
                        href={`/settings/stock-lists/${list.id}`}
                        className="px-2 py-1 text-xs text-[#8FA894] hover:bg-[#8FA894]/10 rounded transition-colors"
                      >
                        View
                      </Link>
                      {onSelectSet && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onSelectSet(list.id, list.name)}
                          className="text-xs"
                        >
                          Use
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Help Text */}
          <div className="bg-[#F5F3F0] rounded-lg p-4 text-sm text-slate-600 border border-[#C5D5CA]/50">
            <div className="flex items-start gap-3">
              <Settings className="h-5 w-5 text-[#8FA894] mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium text-slate-700 mb-1">How Sets Work</p>
                <p>
                  Sets are Stock Lists with per-color include rules. Click "Edit" to configure which styles 
                  and colors are included. Click "Use" to select a set for this call-off.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t bg-slate-50">
          <Button variant="outline" onClick={onClose} className="w-full">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

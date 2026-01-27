'use client';
import * as React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import Link from 'next/link';
import { ChevronRight, List, Wrench, Loader2 } from 'lucide-react';

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
  
  // Auto-sync state
  const [syncProgress, setSyncProgress] = React.useState<{ current: number; total: number; step: string } | null>(null);
  const [syncMessage, setSyncMessage] = React.useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const syncRanRef = React.useRef(false);
  
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

  // AUTO-SYNC: Find styles/colors not in any list and add them to "Nye styles"
  async function syncNewStylesToList() {
    setSyncMessage(null);
    setSyncProgress({ current: 0, total: 100, step: 'Checking for unlisted styles...' });
    
    try {
      // Find "Nye styles" list
      const nyeList = lists?.find(l => l.name === 'Nye styles');
      if (!nyeList) {
        setSyncProgress(null);
        setSyncMessage({ type: 'error', text: 'Could not find "Nye styles" list.' });
        return;
      }

      // Step 1: Get all style IDs
      setSyncProgress({ current: 5, total: 100, step: 'Fetching all styles...' });
      const { data: allStyles, error: stylesError } = await supabase
        .from('styles')
        .select('id');
      if (stylesError) throw stylesError;
      
      const allStyleIds = new Set((allStyles ?? []).map(s => s.id));
      
      // Step 2: Get all style IDs that are already in any list
      setSyncProgress({ current: 15, total: 100, step: 'Checking existing list memberships...' });
      const { data: listedStyles, error: listedError } = await supabase
        .from('stock_list_styles')
        .select('style_id');
      if (listedError) throw listedError;
      
      const listedStyleIds = new Set((listedStyles ?? []).map(s => s.style_id));
      
      // Step 3: Find styles not in any list
      const unlistedStyleIds = Array.from(allStyleIds).filter(id => !listedStyleIds.has(id));
      
      if (unlistedStyleIds.length === 0) {
        setSyncProgress(null);
        setSyncMessage({ type: 'info', text: 'All styles are already in a list.' });
        return;
      }

      setSyncProgress({ current: 20, total: 100, step: `Found ${unlistedStyleIds.length} unlisted style(s). Adding to Nye styles...` });

      // Step 4: Add unlisted styles to "Nye styles" in chunks
      const chunkSize = 200;
      let stylesAdded = 0;
      for (let i = 0; i < unlistedStyleIds.length; i += chunkSize) {
        const chunk = unlistedStyleIds.slice(i, i + chunkSize);
        const styleInserts = chunk.map(styleId => ({ list_id: nyeList.id, style_id: styleId }));
        
        const { error: insertError } = await supabase
          .from('stock_list_styles')
          .upsert(styleInserts, { onConflict: 'list_id,style_id', ignoreDuplicates: true });
        if (insertError) throw insertError;
        
        stylesAdded += chunk.length;
        const progress = 20 + Math.round((stylesAdded / unlistedStyleIds.length) * 30);
        setSyncProgress({ current: progress, total: 100, step: `Added ${stylesAdded}/${unlistedStyleIds.length} styles...` });
      }

      // Step 5: Get all colors for unlisted styles
      setSyncProgress({ current: 55, total: 100, step: 'Fetching colors for new styles...' });
      const { data: colors, error: colorsError } = await supabase
        .from('style_colors')
        .select('id, style_id')
        .in('style_id', unlistedStyleIds);
      if (colorsError) throw colorsError;
      
      if (!colors || colors.length === 0) {
        setSyncProgress(null);
        setSyncMessage({ type: 'success', text: `Added ${unlistedStyleIds.length} style(s) to Nye styles (no colors to add).` });
        return;
      }

      // Step 6: Add colors to "Nye styles" in chunks
      setSyncProgress({ current: 60, total: 100, step: `Adding ${colors.length} color(s)...` });
      let colorsAdded = 0;
      for (let i = 0; i < colors.length; i += chunkSize) {
        const chunk = colors.slice(i, i + chunkSize);
        const colorInserts = chunk.map(c => ({
          list_id: nyeList.id,
          style_id: c.style_id,
          style_color_id: c.id,
          include: true
        }));
        
        const { error: colorInsertError } = await supabase
          .from('stock_list_colors')
          .upsert(colorInserts, { onConflict: 'list_id,style_color_id', ignoreDuplicates: true });
        if (colorInsertError) throw colorInsertError;
        
        colorsAdded += chunk.length;
        const progress = 60 + Math.round((colorsAdded / colors.length) * 35);
        setSyncProgress({ current: progress, total: 100, step: `Added ${colorsAdded}/${colors.length} colors...` });
      }

      setSyncProgress({ current: 100, total: 100, step: 'Done!' });
      
      // Clear progress after a short delay
      setTimeout(() => {
        setSyncProgress(null);
        setSyncMessage({ type: 'success', text: `Added ${unlistedStyleIds.length} style(s) and ${colors.length} color(s) to Nye styles.` });
      }, 500);
      
    } catch (e: any) {
      setSyncProgress(null);
      setSyncMessage({ type: 'error', text: e.message || 'Failed to sync new styles' });
    }
  }

  // Run auto-sync once when lists are loaded
  React.useEffect(() => {
    if (!lists || lists.length === 0) return;
    if (syncRanRef.current) return;
    syncRanRef.current = true;
    syncNewStylesToList();
  }, [lists]);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Settings</div>
        <h1 className="text-xl font-semibold">Stock Lists</h1>
        <p className="text-sm text-gray-600 mt-1">
          Manage your stock lists for exports and organization
        </p>
      </div>

      {/* Auto-sync progress bar */}
      {syncProgress && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
              <div className="flex-1">
                <div className="text-sm font-medium text-gray-700 mb-1">{syncProgress.step}</div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                    style={{ width: `${Math.round((syncProgress.current / syncProgress.total) * 100)}%` }}
                  />
                </div>
              </div>
              <span className="text-sm text-gray-500">{Math.round((syncProgress.current / syncProgress.total) * 100)}%</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Auto-sync message */}
      {syncMessage && !syncProgress && (
        <div className={`p-3 rounded text-sm ${
          syncMessage.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' :
          syncMessage.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' :
          'bg-blue-50 text-blue-700 border border-blue-200'
        }`}>
          {syncMessage.text}
        </div>
      )}

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

'use client';
import * as React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { SearchSelect } from '../../../../components/SearchSelect';
import { Modal } from '../../../../components/Modal';
import { Badge } from '../../../../components/ui/badge';
import Link from 'next/link';
import { ArrowLeft, Plus, Download, Upload, Trash2, X } from 'lucide-react';

type StockList = {
  id: string;
  name: string;
  fixed: boolean;
  created_at: string;
  updated_at: string;
};

type StyleRow = { 
  id: string; 
  style_no: string; 
  style_name: string | null; 
  supplier: string | null; 
  image_url: string | null 
};

type ColorRow = {
  id: string;
  color_name: string | null;
  color_code: string | null;
  style_id: string;
};

type ListStyle = {
  style_id: string;
  style: StyleRow;
};

type ListColor = {
  style_color_id: string;
  style_id: string;
  include: boolean;
  color: ColorRow;
};

export default function StockListDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClientComponentClient();
  const [query, setQuery] = React.useState('');
  const [seasonId, setSeasonId] = React.useState('');
  const [addModalOpen, setAddModalOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [notice, setNotice] = React.useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  function flash(text: string, kind: 'success' | 'error' = 'success') {
    setNotice({ text, kind });
    setTimeout(() => setNotice(null), 3000);
  }

  // Load the list
  const { data: list, mutate: mutateList } = useSWR(`stock-list:${params.id}`, async () => {
    const { data, error } = await supabase
      .from('stock_lists')
      .select('*')
      .eq('id', params.id)
      .single();
    if (error) throw error;
    return data as StockList;
  });

  // Load styles in this list
  const { data: listStyles, mutate: mutateListStyles } = useSWR(`stock-list:${params.id}:styles`, async () => {
    const { data, error } = await supabase
      .from('stock_list_styles')
      .select('style_id, styles!inner(id, style_no, style_name, supplier, image_url)')
      .eq('list_id', params.id);
    if (error) throw error;
    // Transform the data to match ListStyle type
    return ((data ?? []) as any[]).map((item: any) => ({
      style_id: item.style_id,
      style: item.styles
    })) as ListStyle[];
  });

  // Load colors for this list
  const { data: listColors, mutate: mutateListColors } = useSWR(`stock-list:${params.id}:colors`, async () => {
    const { data, error } = await supabase
      .from('stock_list_colors')
      .select('style_color_id, style_id, include, style_colors!inner(id, color_name, color_code, style_id)')
      .eq('list_id', params.id);
    if (error) throw error;
    // Transform the data to match ListColor type
    return ((data ?? []) as any[]).map((item: any) => ({
      style_color_id: item.style_color_id,
      style_id: item.style_id,
      include: item.include,
      color: item.style_colors
    })) as ListColor[];
  });

  // Load all styles for adding
  const { data: allStyles } = useSWR('styles:all:stocklist-detail', async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url')
      .order('style_no', { ascending: true })
      .limit(4000);
    if (error) throw error;
    return (data ?? []) as StyleRow[];
  });

  // Load seasons for filtering
  const { data: seasons } = useSWR('seasons:list:stocklist-detail', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year').order('year', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; name: string | null; year: number | null }>;
  });

  const seasonCodeById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (seasons ?? [])) {
      const parts = String(s.name || '').trim().split(/\s+/).filter(Boolean);
      const letters = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
      const yy = s.year != null ? String(s.year).slice(-2) : '';
      m.set(String(s.id), `${letters}${yy}`);
    }
    return m;
  }, [seasons]);

  const { data: styleSeasons } = useSWR('style_seasons:byStyle:stocklist-detail', async () => {
    const { data, error } = await supabase.from('style_seasons').select('style_no, seasons').limit(8000);
    if (error) throw error;
    const byStyle = new Map<string, string[]>();
    for (const r of (data ?? []) as any[]) {
      const arr = Array.isArray(r.seasons) ? (r.seasons as string[]) : [];
      byStyle.set(r.style_no, arr);
    }
    return byStyle as Map<string, string[]>;
  });

  const seasonSelectItems = React.useMemo(() => {
    return (seasons ?? [])
      .map((s) => ({ value: String(s.id), label: seasonCodeById.get(String(s.id)) || String(s.id) }));
  }, [seasons, seasonCodeById]);

  // Filter styles not in list for adding
  const styleIdsInList = new Set(listStyles?.map(ls => ls.style_id) ?? []);
  const availableStyles = React.useMemo(() => {
    let filtered = (allStyles ?? []).filter(s => !styleIdsInList.has(s.id));
    
    const qq = query.toLowerCase().trim();
    if (qq) {
      filtered = filtered.filter(s => 
        (s.style_name || '').toLowerCase().includes(qq) || 
        (s.style_no || '').toLowerCase().includes(qq)
      );
    }

    if (seasonId) {
      filtered = filtered.filter(s => {
        const sids = styleSeasons?.get(s.style_no) ?? [];
        return sids.includes(seasonId);
      });
    }

    return filtered;
  }, [allStyles, styleIdsInList, query, seasonId, styleSeasons]);

  // Add style to list
  async function addStyle(styleId: string) {
    try {
      const { error: styleError } = await supabase
        .from('stock_list_styles')
        .insert({ list_id: params.id, style_id: styleId });
      if (styleError) throw styleError;

      // Also add all colors for this style
      const { data: colors } = await supabase
        .from('style_colors')
        .select('id, style_id')
        .eq('style_id', styleId);
      
      if (colors && colors.length > 0) {
        const colorInserts = colors.map(c => ({
          list_id: params.id,
          style_id: c.style_id,
          style_color_id: c.id,
          include: true
        }));
        const { error: colorError } = await supabase
          .from('stock_list_colors')
          .insert(colorInserts);
        if (colorError) throw colorError;
      }

      await mutateListStyles();
      await mutateListColors();
      flash('Style added');
    } catch (e: any) {
      flash(e.message || 'Failed to add style', 'error');
    }
  }

  // Remove style from list
  async function removeStyle(styleId: string) {
    try {
      const { error } = await supabase
        .from('stock_list_styles')
        .delete()
        .eq('list_id', params.id)
        .eq('style_id', styleId);
      if (error) throw error;
      await mutateListStyles();
      await mutateListColors();
      flash('Style removed');
    } catch (e: any) {
      flash(e.message || 'Failed to remove style', 'error');
    }
  }

  // Remove color from list
  async function removeColor(styleColorId: string) {
    try {
      const { error } = await supabase
        .from('stock_list_colors')
        .delete()
        .eq('list_id', params.id)
        .eq('style_color_id', styleColorId);
      if (error) throw error;
      await mutateListColors();
      flash('Color removed');
    } catch (e: any) {
      flash(e.message || 'Failed to remove color', 'error');
    }
  }

  // Add new unlisted styles (for "Nye styles" list)
  async function addNewStyles() {
    setLoading(true);
    try {
      // Get all styles
      const { data: allStylesData } = await supabase
        .from('styles')
        .select('id, style_no');
      
      // Get all style IDs that are in any list
      const { data: stylesInLists } = await supabase
        .from('stock_list_styles')
        .select('style_id');
      
      const stylesInListsSet = new Set((stylesInLists ?? []).map(s => s.style_id));
      const newStyles = (allStylesData ?? []).filter(s => !stylesInListsSet.has(s.id));

      if (newStyles.length === 0) {
        flash('No new styles to add', 'error');
        return;
      }

      // Add to "Nye styles" list
      const styleInserts = newStyles.map(s => ({ list_id: params.id, style_id: s.id }));
      const { error: styleError } = await supabase
        .from('stock_list_styles')
        .insert(styleInserts);
      if (styleError) throw styleError;

      // Add all colors for these styles
      const { data: colors } = await supabase
        .from('style_colors')
        .select('id, style_id')
        .in('style_id', newStyles.map(s => s.id));
      
      if (colors && colors.length > 0) {
        const colorInserts = colors.map(c => ({
          list_id: params.id,
          style_id: c.style_id,
          style_color_id: c.id,
          include: true
        }));
        const { error: colorError } = await supabase
          .from('stock_list_colors')
          .insert(colorInserts);
        if (colorError) throw colorError;
      }

      await mutateListStyles();
      await mutateListColors();
      flash(`Added ${newStyles.length} new styles`);
    } catch (e: any) {
      flash(e.message || 'Failed to add new styles', 'error');
    } finally {
      setLoading(false);
    }
  }

  // Move all from Aktiv to Passiv
  async function moveToPassiv() {
    if (!confirm('Move all styles from Aktiv to Passiv? This will clear the Aktiv list.')) return;
    
    setLoading(true);
    try {
      // Get Passiv list ID
      const { data: passivList } = await supabase
        .from('stock_lists')
        .select('id')
        .eq('name', 'Passiv')
        .single();
      
      if (!passivList) throw new Error('Passiv list not found');

      // Copy styles to Passiv
      const { data: stylesToMove } = await supabase
        .from('stock_list_styles')
        .select('style_id')
        .eq('list_id', params.id);
      
      if (stylesToMove && stylesToMove.length > 0) {
        const styleInserts = stylesToMove.map(s => ({ 
          list_id: passivList.id, 
          style_id: s.style_id 
        }));
        await supabase
          .from('stock_list_styles')
          .upsert(styleInserts, { onConflict: 'list_id,style_id', ignoreDuplicates: true });
      }

      // Copy colors to Passiv
      const { data: colorsToMove } = await supabase
        .from('stock_list_colors')
        .select('style_id, style_color_id, include')
        .eq('list_id', params.id);
      
      if (colorsToMove && colorsToMove.length > 0) {
        const colorInserts = colorsToMove.map(c => ({
          list_id: passivList.id,
          style_id: c.style_id,
          style_color_id: c.style_color_id,
          include: c.include
        }));
        await supabase
          .from('stock_list_colors')
          .upsert(colorInserts, { onConflict: 'list_id,style_color_id', ignoreDuplicates: true });
      }

      // Clear Aktiv list
      await supabase.from('stock_list_styles').delete().eq('list_id', params.id);
      await supabase.from('stock_list_colors').delete().eq('list_id', params.id);

      await mutateListStyles();
      await mutateListColors();
      flash(`Moved ${stylesToMove?.length ?? 0} styles to Passiv`);
    } catch (e: any) {
      flash(e.message || 'Failed to move to Passiv', 'error');
    } finally {
      setLoading(false);
    }
  }

  // Import from Nye styles to Aktiv
  async function importFromNye() {
    if (!confirm('Import all styles from "Nye styles" to Aktiv?')) return;
    
    setLoading(true);
    try {
      // Get Nye styles list ID
      const { data: nyeList } = await supabase
        .from('stock_lists')
        .select('id')
        .eq('name', 'Nye styles')
        .single();
      
      if (!nyeList) throw new Error('Nye styles list not found');

      // Copy styles to Aktiv
      const { data: stylesToImport } = await supabase
        .from('stock_list_styles')
        .select('style_id')
        .eq('list_id', nyeList.id);
      
      if (stylesToImport && stylesToImport.length > 0) {
        const styleInserts = stylesToImport.map(s => ({ 
          list_id: params.id, 
          style_id: s.style_id 
        }));
        await supabase
          .from('stock_list_styles')
          .upsert(styleInserts, { onConflict: 'list_id,style_id', ignoreDuplicates: true });
      }

      // Copy colors to Aktiv
      const { data: colorsToImport } = await supabase
        .from('stock_list_colors')
        .select('style_id, style_color_id, include')
        .eq('list_id', nyeList.id);
      
      if (colorsToImport && colorsToImport.length > 0) {
        const colorInserts = colorsToImport.map(c => ({
          list_id: params.id,
          style_id: c.style_id,
          style_color_id: c.style_color_id,
          include: c.include
        }));
        await supabase
          .from('stock_list_colors')
          .upsert(colorInserts, { onConflict: 'list_id,style_color_id', ignoreDuplicates: true });
      }

      await mutateListStyles();
      await mutateListColors();
      flash(`Imported ${stylesToImport?.length ?? 0} styles from Nye styles`);
    } catch (e: any) {
      flash(e.message || 'Failed to import from Nye styles', 'error');
    } finally {
      setLoading(false);
    }
  }

  // Group colors by style
  const colorsByStyle = React.useMemo(() => {
    const map = new Map<string, ListColor[]>();
    for (const lc of (listColors ?? [])) {
      if (!map.has(lc.style_id)) {
        map.set(lc.style_id, []);
      }
      map.get(lc.style_id)!.push(lc);
    }
    return map;
  }, [listColors]);

  if (!list) return <div className="p-4">Loading...</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <Link href="/settings/stock-lists" className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mb-2">
          <ArrowLeft className="h-4 w-4" />
          Back to Stock Lists
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">{list.name}</h1>
            <p className="text-sm text-gray-600 mt-1">
              {listStyles?.length ?? 0} styles · {listColors?.length ?? 0} colors
            </p>
          </div>
          <div className="flex items-center gap-2">
            {list.name === 'Nye styles' && (
              <Button onClick={addNewStyles} disabled={loading}>
                <Plus className="h-4 w-4 mr-2" />
                Tilføj nye styles
              </Button>
            )}
            {list.name === 'Aktiv' && (
              <>
                <Button variant="outline" onClick={moveToPassiv} disabled={loading}>
                  <Download className="h-4 w-4 mr-2" />
                  Flyt til Passiv
                </Button>
                <Button onClick={importFromNye} disabled={loading}>
                  <Upload className="h-4 w-4 mr-2" />
                  Indfør nye styles
                </Button>
              </>
            )}
            <Button onClick={() => setAddModalOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Style
            </Button>
          </div>
        </div>
      </div>

      {/* Notice */}
      {notice && (
        <div className={(notice.kind === 'success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200') + ' rounded border px-3 py-2 text-sm'}>
          {notice.text}
        </div>
      )}

      {/* Styles in list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Styles in {list.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {(listStyles ?? []).map((ls) => {
              const style = ls.style;
              const colors = colorsByStyle.get(ls.style_id) ?? [];
              
              return (
                <div key={ls.style_id} className="border rounded-lg p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-start gap-3">
                      {style.image_url && (
                        <img 
                          src={style.image_url} 
                          alt={style.style_no} 
                          className="w-16 h-16 object-cover rounded"
                        />
                      )}
                      <div>
                        <div className="font-medium">{style.style_no}</div>
                        <div className="text-sm text-gray-600">{style.style_name}</div>
                        {style.supplier && (
                          <div className="text-xs text-gray-500">{style.supplier}</div>
                        )}
                      </div>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="sm"
                      onClick={() => removeStyle(ls.style_id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  
                  {colors.length > 0 && (
                    <div className="mt-2 pt-2 border-t">
                      <div className="text-xs text-gray-500 mb-2">Colors ({colors.length})</div>
                      <div className="flex flex-wrap gap-2">
                        {colors.map((lc) => (
                          <div 
                            key={lc.style_color_id}
                            className="flex items-center gap-1 px-2 py-1 bg-gray-50 rounded text-xs border"
                          >
                            {lc.color.color_code && (
                              <div 
                                className="w-3 h-3 rounded border"
                                style={{ backgroundColor: lc.color.color_code }}
                              />
                            )}
                            <span>{lc.color.color_name || 'Unknown'}</span>
                            <button
                              onClick={() => removeColor(lc.style_color_id)}
                              className="ml-1 hover:text-red-600"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            
            {(listStyles ?? []).length === 0 && (
              <div className="text-center py-8 text-gray-500">
                No styles in this list yet
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Add Style Modal */}
      <Modal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        title="Add Styles"
        maxWidth="max-w-4xl"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input 
              className="flex-1" 
              placeholder="Search style no / name" 
              value={query} 
              onChange={(e) => setQuery(e.target.value)} 
            />
            <SearchSelect 
              items={seasonSelectItems} 
              value={seasonId} 
              onChange={setSeasonId} 
              placeholder="All seasons" 
              clearable 
            />
          </div>
          
          <div className="max-h-96 overflow-auto divide-y border rounded">
            {availableStyles.map((s) => (
              <div key={s.id} className="flex items-start justify-between gap-2 px-3 py-2">
                <div className="flex items-start gap-2">
                  {s.image_url && (
                    <img 
                      src={s.image_url} 
                      alt={s.style_no} 
                      className="w-12 h-12 object-cover rounded"
                    />
                  )}
                  <div>
                    <div className="font-medium">{s.style_no}</div>
                    <div className="text-sm text-gray-600">{s.style_name}</div>
                  </div>
                </div>
                <Button size="sm" onClick={() => addStyle(s.id)}>
                  Add
                </Button>
              </div>
            ))}
            
            {availableStyles.length === 0 && (
              <div className="text-center py-8 text-gray-500">
                No styles available to add
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

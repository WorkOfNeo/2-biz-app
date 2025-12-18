'use client';
import React from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../../components/ui/tabs';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../../components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Sheet, SheetHeader, SheetTitle, SheetContent, SheetClose } from '../../../../components/ui/sheet';

type Currency = 'DKK' | 'EUR' | 'USD';

type VendorStyle = {
  id: string;
  style_no: string;
  price_per_sample: number;
  out_of_collection: boolean;
};

type VendorRow = {
  id: string;
  leverandør: string; // Supplier
  antal_prøver: number; // Number of samples
  styles_i_koll: number; // Styles in collection
  gns_pris_pr_prøve: number; // Average price per sample (DKK)
  total: number; // Total (calculated: antal_prøver * gns_pris_pr_prøve)
  total_ubrugte: number; // Total unused
  diff: number; // Difference (calculated: total - total_ubrugte)
  prøvefaktor: number; // Sample factor (calculated: antal_prøver / styles_i_koll)
  styles: VendorStyle[]; // Styles for this vendor
};

type Collection = {
  id: string;
  name: string;
  rows: VendorRow[];
};

const STORAGE_KEY = 'top10_vendors_collections';
const CURRENCY_KEY = 'top10_vendors_currency';
const CURRENCY_RATES: Record<Currency, number> = {
  DKK: 1,
  EUR: 7.45, // Approximate rate, can be updated
  USD: 6.85, // Approximate rate, can be updated
};

export default function Top10VendorsPage() {
  const [collections, setCollections] = React.useState<Collection[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Ensure all rows have styles array
        return parsed.map((c: Collection) => ({
          ...c,
          rows: c.rows.map((r: VendorRow) => ({
            ...r,
            styles: r.styles || [],
          })),
        }));
      }
    } catch {}
    // Default: one empty collection
    return [{ id: 'default', name: 'Collection 1', rows: [] }];
  });

  const [currency, setCurrency] = React.useState<Currency>(() => {
    try {
      const stored = localStorage.getItem(CURRENCY_KEY);
      if (stored && (stored === 'DKK' || stored === 'EUR' || stored === 'USD')) {
        return stored as Currency;
      }
    } catch {}
    return 'DKK';
  });

  const [activeTab, setActiveTab] = React.useState<string>(collections[0]?.id || 'default');
  const [editingName, setEditingName] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState('');
  const [openVendorSheet, setOpenVendorSheet] = React.useState<string | null>(null);
  const [bulkImportText, setBulkImportText] = React.useState('');

  // Persist to localStorage
  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collections));
    } catch (e) {
      console.error('Failed to save collections:', e);
    }
  }, [collections]);

  React.useEffect(() => {
    try {
      localStorage.setItem(CURRENCY_KEY, currency);
    } catch (e) {
      console.error('Failed to save currency:', e);
    }
  }, [currency]);

  // Convert price to DKK based on currency
  const convertToDKK = (price: number): number => {
    return price * CURRENCY_RATES[currency];
  };

  // Calculate derived fields for a row based on styles
  const calculateRow = (row: VendorRow): VendorRow => {
    const styles = row.styles || [];
    
    // Calculate from styles if available
    if (styles.length > 0) {
      const totalSamples = styles.reduce((sum, s) => {
        // Count samples based on prøvefaktor (if we have it from previous calculation)
        const factor = row.prøvefaktor > 0 ? row.prøvefaktor : 1;
        return sum + factor;
      }, 0);
      
      const inCollection = styles.filter(s => !s.out_of_collection);
      const outOfCollection = styles.filter(s => s.out_of_collection);
      
      const totalPrice = styles.reduce((sum, s) => {
        const priceInDKK = convertToDKK(s.price_per_sample);
        const factor = row.prøvefaktor > 0 ? row.prøvefaktor : 1;
        return sum + (priceInDKK * factor);
      }, 0);
      
      const unusedPrice = outOfCollection.reduce((sum, s) => {
        const priceInDKK = convertToDKK(s.price_per_sample);
        const factor = row.prøvefaktor > 0 ? row.prøvefaktor : 1;
        return sum + (priceInDKK * factor);
      }, 0);
      
      const avgPrice = styles.length > 0 
        ? totalPrice / (styles.length * (row.prøvefaktor > 0 ? row.prøvefaktor : 1))
        : 0;
      
      const prøvefaktor = inCollection.length > 0 
        ? totalSamples / inCollection.length 
        : (row.prøvefaktor || 0);
      
      return {
        ...row,
        antal_prøver: totalSamples,
        styles_i_koll: inCollection.length,
        gns_pris_pr_prøve: avgPrice,
        total: totalPrice,
        total_ubrugte: unusedPrice,
        diff: totalPrice - unusedPrice,
        prøvefaktor,
      };
    }
    
    // Fallback to manual calculation if no styles
    const total = (row.antal_prøver || 0) * (row.gns_pris_pr_prøve || 0);
    const diff = total - (row.total_ubrugte || 0);
    const prøvefaktor = (row.styles_i_koll || 0) > 0 
      ? (row.antal_prøver || 0) / (row.styles_i_koll || 1) 
      : 0;
    
    return {
      ...row,
      total,
      diff,
      prøvefaktor
    };
  };

  // Add new collection
  const addCollection = () => {
    const newId = `collection-${Date.now()}`;
    const newCollection: Collection = {
      id: newId,
      name: `Collection ${collections.length + 1}`,
      rows: []
    };
    setCollections([...collections, newCollection]);
    setActiveTab(newId);
    setEditingName(newId);
    setNewName(newCollection.name);
  };

  // Update collection name
  const updateCollectionName = (id: string, name: string) => {
    setCollections(collections.map(c => 
      c.id === id ? { ...c, name: name.trim() || c.name } : c
    ));
    setEditingName(null);
  };

  // Delete collection
  const deleteCollection = (id: string) => {
    if (collections.length <= 1) {
      alert('Cannot delete the last collection');
      return;
    }
    if (window.confirm('Are you sure you want to delete this collection?')) {
      const newCollections = collections.filter(c => c.id !== id);
      setCollections(newCollections);
      if (activeTab === id) {
        setActiveTab(newCollections[0]?.id || 'default');
      }
    }
  };

  // Get current collection
  const currentCollection = collections.find(c => c.id === activeTab);
  if (!currentCollection) return null;

  // Add new row
  const addRow = () => {
    const newRow: VendorRow = {
      id: `row-${Date.now()}`,
      leverandør: '',
      antal_prøver: 0,
      styles_i_koll: 0,
      gns_pris_pr_prøve: 0,
      total: 0,
      total_ubrugte: 0,
      diff: 0,
      prøvefaktor: 0,
      styles: []
    };
    setCollections(collections.map(c => 
      c.id === activeTab 
        ? { ...c, rows: [...c.rows, newRow] }
        : c
    ));
  };

  // Update row field
  const updateRow = (rowId: string, field: keyof VendorRow, value: string | number) => {
    setCollections(collections.map(c => 
      c.id === activeTab 
        ? {
            ...c,
            rows: c.rows.map(r => {
              if (r.id === rowId) {
                const updated = { ...r, [field]: value };
                return calculateRow(updated);
              }
              return r;
            })
          }
        : c
    ));
  };

  // Delete row
  const deleteRow = (rowId: string) => {
    setCollections(collections.map(c => 
      c.id === activeTab 
        ? { ...c, rows: c.rows.filter(r => r.id !== rowId) }
        : c
    ));
  };

  // Get current vendor row
  const currentVendorRow = React.useMemo(() => {
    if (!openVendorSheet) return null;
    const collection = collections.find(c => c.id === activeTab);
    return collection?.rows.find(r => r.id === openVendorSheet) || null;
  }, [openVendorSheet, collections, activeTab]);

  // Add style to vendor
  const addStyle = (vendorId: string) => {
    const newStyle: VendorStyle = {
      id: `style-${Date.now()}`,
      style_no: '',
      price_per_sample: 0,
      out_of_collection: false,
    };
    setCollections(collections.map(c => 
      c.id === activeTab 
        ? {
            ...c,
            rows: c.rows.map(r => {
              if (r.id === vendorId) {
                const updated = { ...r, styles: [...(r.styles || []), newStyle] };
                return calculateRow(updated);
              }
              return r;
            })
          }
        : c
    ));
  };

  // Update style
  const updateStyle = (vendorId: string, styleId: string, field: keyof VendorStyle, value: string | number | boolean) => {
    setCollections(collections.map(c => 
      c.id === activeTab 
        ? {
            ...c,
            rows: c.rows.map(r => {
              if (r.id === vendorId) {
                const updated = {
                  ...r,
                  styles: (r.styles || []).map(s => 
                    s.id === styleId ? { ...s, [field]: value } : s
                  )
                };
                return calculateRow(updated);
              }
              return r;
            })
          }
        : c
    ));
  };

  // Delete style
  const deleteStyle = (vendorId: string, styleId: string) => {
    setCollections(collections.map(c => 
      c.id === activeTab 
        ? {
            ...c,
            rows: c.rows.map(r => {
              if (r.id === vendorId) {
                const updated = {
                  ...r,
                  styles: (r.styles || []).filter(s => s.id !== styleId)
                };
                return calculateRow(updated);
              }
              return r;
            })
          }
        : c
    ));
  };

  // Import styles from textarea (one per line)
  const importStylesFromText = (vendorId: string, text: string) => {
    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    if (lines.length === 0) return;

    const newStyles: VendorStyle[] = lines.map(line => ({
      id: `style-${Date.now()}-${Math.random()}`,
      style_no: line,
      price_per_sample: 0,
      out_of_collection: false,
    }));

    setCollections(collections.map(c => 
      c.id === activeTab 
        ? {
            ...c,
            rows: c.rows.map(r => {
              if (r.id === vendorId) {
                const updated = {
                  ...r,
                  styles: [...(r.styles || []), ...newStyles]
                };
                return calculateRow(updated);
              }
              return r;
            })
          }
        : c
    ));

    // Clear the textarea
    setBulkImportText('');
  };

  // Format number for display
  const formatNumber = (num: number): string => {
    if (num === 0) return '0';
    if (Number.isInteger(num)) return num.toLocaleString('da-DK');
    return num.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Format currency
  const formatCurrency = (num: number): string => {
    return formatNumber(num) + ' DKK';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
      <div className="text-xs text-gray-500">Statistics</div>
      <h1 className="text-xl font-semibold">Top 10 Vendors</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600">Currency:</label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
              className="text-xs border rounded px-2 py-1"
            >
              <option value="DKK">DKK</option>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <Button 
            onClick={addCollection}
            className="bg-[#8FA894] hover:bg-[#C5D5CA]"
          >
            + Add New Collection
          </Button>
        </div>
      </div>

      <Card className="border-[#C5D5CA]">
        <CardContent className="p-0">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <div className="border-b border-[#C5D5CA] px-4 pt-4">
              <TabsList className="w-full justify-start overflow-x-auto">
                {collections.map((collection) => (
                  <div key={collection.id} className="flex items-center gap-1 mr-2">
                    {editingName === collection.id ? (
                      <div className="flex items-center gap-1">
                        <Input
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          onBlur={() => updateCollectionName(collection.id, newName)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              updateCollectionName(collection.id, newName);
                            } else if (e.key === 'Escape') {
                              setEditingName(null);
                            }
                          }}
                          className="h-8 w-32 text-xs"
                          autoFocus
                        />
                      </div>
                    ) : (
                      <>
                        <TabsTrigger 
                          value={collection.id}
                          className="text-xs"
                          onDoubleClick={() => {
                            setEditingName(collection.id);
                            setNewName(collection.name);
                          }}
                        >
                          {collection.name}
                        </TabsTrigger>
                        {collections.length > 1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteCollection(collection.id);
                            }}
                            className="ml-1 text-red-500 hover:text-red-700 text-xs"
                            title="Delete collection"
                          >
                            ×
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </TabsList>
            </div>

            {collections.map((collection) => (
              <TabsContent key={collection.id} value={collection.id} className="p-4">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-gray-600">
                      {collection.rows.length} vendor{collection.rows.length !== 1 ? 's' : ''}
                    </div>
                    <Button 
                      onClick={addRow}
                      variant="outline"
                      size="sm"
                      className="border-[#8FA894] text-[#8FA894] hover:bg-[#8FA894]/10"
                    >
                      + Add Vendor
                    </Button>
                  </div>

                  {collection.rows.length === 0 ? (
                    <div className="text-center py-12 text-gray-500 border border-dashed rounded-lg">
                      <p className="mb-2">No vendors added yet</p>
                      <Button 
                        onClick={addRow}
                        variant="outline"
                        size="sm"
                      >
                        Add your first vendor
                      </Button>
                    </div>
                  ) : (
                    <div className="overflow-x-auto border rounded-lg">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-[#F5F3F0]">
                            <TableHead className="w-[200px]">Leverandør</TableHead>
                            <TableHead className="text-right w-[120px]">Antal prøver</TableHead>
                            <TableHead className="text-right w-[120px]">Styles i koll.</TableHead>
                            <TableHead className="text-right w-[150px]">Gns. pris pr prøve (DKK)</TableHead>
                            <TableHead className="text-right w-[120px]">Total</TableHead>
                            <TableHead className="text-right w-[120px]">Total ubrugte</TableHead>
                            <TableHead className="text-right w-[120px]">Diff</TableHead>
                            <TableHead className="text-right w-[120px]">Prøvefaktor</TableHead>
                            <TableHead className="w-[80px]"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {collection.rows.map((row) => {
                            const calculated = calculateRow(row);
                            return (
                              <TableRow 
                                key={row.id} 
                                className="hover:bg-gray-50 cursor-pointer"
                                onClick={() => setOpenVendorSheet(row.id)}
                              >
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <Input
                                      value={row.leverandør}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        updateRow(row.id, 'leverandør', e.target.value);
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      placeholder="Supplier name"
                                      className="w-full text-xs"
                                    />
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenVendorSheet(row.id);
                                      }}
                                      className="text-[#8FA894] hover:text-[#C5D5CA] text-xs"
                                      title="Open vendor details"
                                    >
                                      📋
                                    </button>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    value={row.antal_prøver || ''}
                                    onChange={(e) => updateRow(row.id, 'antal_prøver', parseFloat(e.target.value) || 0)}
                                    className="w-full text-xs text-right"
                                    min="0"
                                    step="1"
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    value={row.styles_i_koll || ''}
                                    onChange={(e) => updateRow(row.id, 'styles_i_koll', parseFloat(e.target.value) || 0)}
                                    className="w-full text-xs text-right"
                                    min="0"
                                    step="1"
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    value={row.gns_pris_pr_prøve || ''}
                                    onChange={(e) => updateRow(row.id, 'gns_pris_pr_prøve', parseFloat(e.target.value) || 0)}
                                    className="w-full text-xs text-right"
                                    min="0"
                                    step="0.01"
                                  />
                                </TableCell>
                                <TableCell className="text-right font-medium text-[#8FA894]">
                                  {formatCurrency(calculated.total)}
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    value={row.total_ubrugte || ''}
                                    onChange={(e) => updateRow(row.id, 'total_ubrugte', parseFloat(e.target.value) || 0)}
                                    className="w-full text-xs text-right"
                                    min="0"
                                    step="0.01"
                                  />
                                </TableCell>
                                <TableCell className={`text-right font-medium ${
                                  calculated.diff >= 0 ? 'text-green-600' : 'text-red-600'
                                }`}>
                                  {formatCurrency(calculated.diff)}
                                </TableCell>
                                <TableCell className="text-right text-gray-600">
                                  {calculated.prøvefaktor > 0 ? formatNumber(calculated.prøvefaktor) : '—'}
                                </TableCell>
                                <TableCell>
                                  <button
                                    onClick={() => deleteRow(row.id)}
                                    className="text-red-500 hover:text-red-700 text-xs"
                                    title="Delete row"
                                  >
                                    ×
                                  </button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      {/* Vendor Details Sheet */}
      <Sheet open={!!openVendorSheet} onOpenChange={(open) => {
        if (!open) {
          setOpenVendorSheet(null);
          setBulkImportText(''); // Clear textarea when closing
        }
      }}>
        <SheetHeader>
          <SheetTitle>
            {currentVendorRow ? `Vendor: ${currentVendorRow.leverandør || 'Unnamed'}` : 'Vendor Details'}
          </SheetTitle>
          <SheetClose onClick={() => setOpenVendorSheet(null)} />
        </SheetHeader>
        <SheetContent>
          {currentVendorRow && (
            <div className="space-y-4">
              <div className="text-sm text-gray-600">
                Add styles for this vendor. Prices will be calculated based on the selected currency ({currency}) and prøvefaktor.
              </div>

              {/* Bulk Import Textarea */}
              <Card className="border-[#C5D5CA] bg-[#F5F3F0]">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Bulk Import Styles</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <textarea
                    value={bulkImportText}
                    onChange={(e) => setBulkImportText(e.target.value)}
                    placeholder="Paste style numbers here, one per line (e.g., from Excel)&#10;STYLE-001&#10;STYLE-002&#10;STYLE-003"
                    className="w-full min-h-[100px] p-2 text-xs border rounded-md resize-y font-mono"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">
                      {bulkImportText.split('\n').filter(l => l.trim()).length} style{bulkImportText.split('\n').filter(l => l.trim()).length !== 1 ? 's' : ''} detected
                    </span>
                    <Button
                      onClick={() => importStylesFromText(currentVendorRow.id, bulkImportText)}
                      disabled={!bulkImportText.trim()}
                      variant="outline"
                      size="sm"
                      className="border-[#8FA894] text-[#8FA894] hover:bg-[#8FA894]/10"
                    >
                      Import Styles
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">
                  {currentVendorRow.styles?.length || 0} style{(currentVendorRow.styles?.length || 0) !== 1 ? 's' : ''}
                </div>
                <Button
                  onClick={() => addStyle(currentVendorRow.id)}
                  variant="outline"
                  size="sm"
                  className="border-[#8FA894] text-[#8FA894] hover:bg-[#8FA894]/10"
                >
                  + Add Style
                </Button>
              </div>

              {currentVendorRow.styles && currentVendorRow.styles.length > 0 ? (
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-[#F5F3F0]">
                        <TableHead className="w-[200px]">Style No</TableHead>
                        <TableHead className="text-right w-[150px]">Price per Sample ({currency})</TableHead>
                        <TableHead className="text-center w-[150px]">Out of Collection</TableHead>
                        <TableHead className="text-right w-[120px]">Price in DKK</TableHead>
                        <TableHead className="w-[80px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {currentVendorRow.styles.map((style) => {
                        const priceInDKK = convertToDKK(style.price_per_sample);
                        const vendorCalculated = calculateRow(currentVendorRow);
                        const factor = vendorCalculated.prøvefaktor > 0 ? vendorCalculated.prøvefaktor : 1;
                        const totalPrice = priceInDKK * factor;
                        
                        return (
                          <TableRow key={style.id} className="hover:bg-gray-50">
                            <TableCell>
                              <Input
                                value={style.style_no}
                                onChange={(e) => updateStyle(currentVendorRow.id, style.id, 'style_no', e.target.value)}
                                placeholder="Style number"
                                className="w-full text-xs"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                value={style.price_per_sample || ''}
                                onChange={(e) => updateStyle(currentVendorRow.id, style.id, 'price_per_sample', parseFloat(e.target.value) || 0)}
                                className="w-full text-xs text-right"
                                min="0"
                                step="0.01"
                              />
                            </TableCell>
                            <TableCell className="text-center">
                              <input
                                type="checkbox"
                                checked={style.out_of_collection}
                                onChange={(e) => updateStyle(currentVendorRow.id, style.id, 'out_of_collection', e.target.checked)}
                                className="w-4 h-4"
                              />
                            </TableCell>
                            <TableCell className="text-right text-gray-600">
                              {formatCurrency(totalPrice)}
                            </TableCell>
                            <TableCell>
                              <button
                                onClick={() => deleteStyle(currentVendorRow.id, style.id)}
                                className="text-red-500 hover:text-red-700 text-xs"
                                title="Delete style"
                              >
                                ×
                              </button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="text-center py-12 text-gray-500 border border-dashed rounded-lg">
                  <p className="mb-2">No styles added yet</p>
                  <Button
                    onClick={() => addStyle(currentVendorRow.id)}
                    variant="outline"
                    size="sm"
                  >
                    Add your first style
                  </Button>
                </div>
              )}

              {/* Summary */}
              {currentVendorRow.styles && currentVendorRow.styles.length > 0 && (() => {
                const calculated = calculateRow(currentVendorRow);
                return (
                  <Card className="border-[#C5D5CA] bg-[#F5F3F0]">
                    <CardHeader>
                      <CardTitle className="text-sm">Summary</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-600">Styles in Collection:</span>
                        <span className="font-medium">{calculated.styles_i_koll}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Total Unused:</span>
                        <span className="font-medium text-red-600">{formatCurrency(calculated.total_ubrugte)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Prøvefaktor:</span>
                        <span className="font-medium">{calculated.prøvefaktor > 0 ? formatNumber(calculated.prøvefaktor) : '—'}</span>
                      </div>
                      <div className="flex justify-between pt-2 border-t">
                        <span className="font-semibold">Total:</span>
                        <span className="font-bold text-[#8FA894]">{formatCurrency(calculated.total)}</span>
                      </div>
                    </CardContent>
                  </Card>
                );
              })()}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

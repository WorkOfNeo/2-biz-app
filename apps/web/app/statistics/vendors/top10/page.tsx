'use client';
import React from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../../components/ui/tabs';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../../components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';

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
};

type Collection = {
  id: string;
  name: string;
  rows: VendorRow[];
};

const STORAGE_KEY = 'top10_vendors_collections';

export default function Top10VendorsPage() {
  const [collections, setCollections] = React.useState<Collection[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch {}
    // Default: one empty collection
    return [{ id: 'default', name: 'Collection 1', rows: [] }];
  });

  const [activeTab, setActiveTab] = React.useState<string>(collections[0]?.id || 'default');
  const [editingName, setEditingName] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState('');

  // Persist to localStorage
  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collections));
    } catch (e) {
      console.error('Failed to save collections:', e);
    }
  }, [collections]);

  // Calculate derived fields for a row
  const calculateRow = (row: VendorRow): VendorRow => {
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
      prøvefaktor: 0
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
        <Button 
          onClick={addCollection}
          className="bg-[#8FA894] hover:bg-[#C5D5CA]"
        >
          + Add New Collection
        </Button>
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
                              <TableRow key={row.id} className="hover:bg-gray-50">
                                <TableCell>
                                  <Input
                                    value={row.leverandør}
                                    onChange={(e) => updateRow(row.id, 'leverandør', e.target.value)}
                                    placeholder="Supplier name"
                                    className="w-full text-xs"
                                  />
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
    </div>
  );
}

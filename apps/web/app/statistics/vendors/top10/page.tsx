'use client';
import React from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../../components/ui/tabs';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../../components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Sheet, SheetHeader, SheetTitle, SheetContent, SheetClose } from '../../../../components/ui/sheet';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import useSWR from 'swr';

type Currency = 'DKK' | 'EUR' | 'USD';

type VendorStyle = {
  id: string;
  style_no: string; // Matched style_no from database
  original_input?: string; // Original input (style name or number)
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
  prøvefaktor: number; // Sample factor (calculated: antal_prøver / styles_i_koll, or manually set)
  currency: Currency; // Currency for this vendor
  exchange_rate: number; // Exchange rate for currency conversion to DKK
  styles: VendorStyle[]; // Styles for this vendor
};

type Collection = {
  id: string;
  name: string;
  season_id: string | null; // Connected season from DB
  antal_prøver: number; // Sample size for the entire collection (default 9)
  rows: VendorRow[];
};

const STORAGE_KEY = 'top10_vendors_collections';
const CURRENCY_KEY = 'top10_vendors_currency';
const DEFAULT_CURRENCY_RATES: Record<Currency, number> = {
  DKK: 1,
  EUR: 7.45, // Default rate, can be updated per vendor
  USD: 6.85, // Default rate, can be updated per vendor
};

export default function Top10VendorsPage() {
  const supabase = createClientComponentClient();
  
  const [collections, setCollections] = React.useState<Collection[]>([]);
  const [loading, setLoading] = React.useState(true);

  // Load seasons from database
  const { data: seasons } = useSWR('seasons:list:top10', async () => {
    const { data, error } = await supabase
      .from('seasons')
      .select('id, name, year')
      .order('year', { ascending: false })
      .order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string; year: number | null }>;
  }, { refreshInterval: 0 });

  const [currency, setCurrency] = React.useState<Currency>('DKK');

  const [activeTab, setActiveTab] = React.useState<string>(collections[0]?.id || 'default');
  const [editingName, setEditingName] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState('');
  const [openVendorSheet, setOpenVendorSheet] = React.useState<string | null>(null);
  const [bulkImportText, setBulkImportText] = React.useState('');
  const [scrapingJobId, setScrapingJobId] = React.useState<string | null>(null);
  const [scrapingProgress, setScrapingProgress] = React.useState<{ current: number; total: number; currentStyle?: string } | null>(null);
  const [scrapingStatus, setScrapingStatus] = React.useState<string>('');
  
  // Batch scraping state (for all vendors)
  const [batchScrapingJobs, setBatchScrapingJobs] = React.useState<Array<{ vendorId: string; jobId: string; status: 'pending' | 'running' | 'completed' | 'failed' }>>([]);
  const [isBatchScraping, setIsBatchScraping] = React.useState(false);
  
  // Local state for input values to avoid saving on every keystroke
  const [localRowValues, setLocalRowValues] = React.useState<Record<string, Partial<VendorRow>>>({});
  const [localStyleValues, setLocalStyleValues] = React.useState<Record<string, Partial<VendorStyle>>>({});

  // Load collections from Supabase
  React.useEffect(() => {
    async function loadCollections() {
      try {
        setLoading(true);
        // Load collections
        const { data: collectionsData, error: collectionsError } = await supabase
          .from('vendor_collections')
          .select('*')
          .order('sort_order', { ascending: true });
        
        if (collectionsError) throw collectionsError;
        
        if (!collectionsData || collectionsData.length === 0) {
          // Create default collection if none exist
          const { data: newCollection, error: createError } = await supabase
            .from('vendor_collections')
            .insert({
              name: 'Collection 1',
              season_id: null,
              sort_order: 0,
            })
            .select()
            .single();
          
          if (createError) throw createError;
          
          setCollections([{
            id: newCollection.id,
            name: newCollection.name,
            season_id: newCollection.season_id,
            antal_prøver: newCollection.antal_prøver ?? 9,
            rows: [],
          }]);
          setActiveTab(newCollection.id);
          setLoading(false);
          return;
        }
        
        // Load vendor rows for all collections
        const collectionIds = collectionsData.map(c => c.id);
        const { data: rowsData, error: rowsError } = await supabase
          .from('vendor_rows')
          .select('*')
          .in('collection_id', collectionIds)
          .order('sort_order', { ascending: true });
        
        if (rowsError) throw rowsError;
        
        // Load styles for all vendor rows
        const rowIds = (rowsData || []).map(r => r.id);
        const { data: stylesData, error: stylesError } = await supabase
          .from('vendor_styles')
          .select('*')
          .in('vendor_row_id', rowIds.length > 0 ? rowIds : ['00000000-0000-0000-0000-000000000000'])
          .order('sort_order', { ascending: true });
        
        if (stylesError) throw stylesError;
        
        // Build collections structure
        const collectionsMap = new Map<string, Collection>();
        for (const c of collectionsData) {
          collectionsMap.set(c.id, {
            id: c.id,
            name: c.name,
            season_id: c.season_id,
            antal_prøver: c.antal_prøver ?? 9,
            rows: [],
          });
        }
        
        // Add rows to collections
        const stylesMap = new Map<string, VendorStyle[]>();
        for (const s of (stylesData || [])) {
          const arr = stylesMap.get(s.vendor_row_id) || [];
          arr.push({
            id: s.id,
            style_no: s.style_no,
            original_input: s.original_input || undefined,
            price_per_sample: s.price_per_sample,
            out_of_collection: s.out_of_collection,
          });
          stylesMap.set(s.vendor_row_id, arr);
        }
        
        for (const r of (rowsData || [])) {
          const collection = collectionsMap.get(r.collection_id);
          if (collection) {
            collection.rows.push({
              id: r.id,
              leverandør: r.leverandør,
              antal_prøver: r.antal_prøver,
              styles_i_koll: r.styles_i_koll,
              gns_pris_pr_prøve: r.gns_pris_pr_prøve,
              total: r.total,
              total_ubrugte: r.total_ubrugte,
              diff: r.diff,
              prøvefaktor: r.prøvefaktor,
              currency: (r.currency as Currency) || 'DKK',
              exchange_rate: r.exchange_rate || DEFAULT_CURRENCY_RATES[(r.currency as Currency) || 'DKK'],
              styles: stylesMap.get(r.id) || [],
            });
          }
        }
        
        const loadedCollections = Array.from(collectionsMap.values());
        setCollections(loadedCollections);
        if (loadedCollections.length > 0 && !activeTab && loadedCollections[0]) {
          setActiveTab(loadedCollections[0].id);
        }
      } catch (error) {
        console.error('Failed to load collections:', error);
        // Fallback to default
        setCollections([{ id: 'default', name: 'Collection 1', season_id: null, antal_prøver: 9, rows: [] }]);
      } finally {
        setLoading(false);
      }
    }
    
    loadCollections();
  }, []); // Only run on mount

  // Poll scraping job progress
  React.useEffect(() => {
    if (!scrapingJobId) return;

    const interval = setInterval(async () => {
      try {
        // Check job status
        const { data: job, error: jobError } = await supabase
          .from('jobs')
          .select('status, error')
          .eq('id', scrapingJobId)
          .maybeSingle();

        if (jobError) {
          console.error('Error fetching job status:', jobError);
          return;
        }

        if (!job) return;

        // Fetch latest logs for progress
        const { data: logs } = await supabase
          .from('job_logs')
          .select('msg, data, ts')
          .eq('job_id', scrapingJobId)
          .order('ts', { ascending: false })
          .limit(20);

        // Parse progress from logs
        if (logs && logs.length > 0) {
          for (const log of logs) {
            // Check for initial log with total count
            if (log.msg.includes('Found') && log.msg.includes('styles to scrape') && log.data?.total) {
              const total = log.data.total || 0;
              if (!scrapingProgress || scrapingProgress.total !== total) {
                setScrapingProgress({ current: 0, total });
                setScrapingStatus(`Starting to scrape ${total} styles...`);
              }
            }
            // Check for style scraping progress
            if (log.msg.includes('Scraping style:') && log.data) {
              const current = log.data.current || 0;
              const total = log.data.total || scrapingProgress?.total || 1;
              const styleNo = log.data.style_no || '';
              setScrapingProgress({ 
                current, 
                total,
                currentStyle: styleNo 
              });
              setScrapingStatus(`Scraping: ${styleNo} (${current}/${total})`);
            }
            // Check for updated style
            if (log.msg.includes('Updated') && log.msg.includes('with raw cost') && log.data) {
              const current = log.data.current || (scrapingProgress?.current || 0) + 1;
              const total = log.data.total || scrapingProgress?.total || 1;
              const styleNo = log.data.style_no || '';
              setScrapingProgress({ 
                current, 
                total,
                currentStyle: styleNo 
              });
              setScrapingStatus(`Updated ${styleNo} (${current}/${total})`);
            }
            // Check for completion
            if (log.msg === 'STEP:scrape_raw_costs_complete') {
              setScrapingStatus('Scraping completed!');
            }
          }
        }

        // Check if job is done
        if (job.status === 'succeeded') {
          setScrapingStatus('Scraping completed successfully!');
          setScrapingProgress(null);
          // Reload collections to show updated prices
          setTimeout(() => {
            window.location.reload();
          }, 2000);
          setScrapingJobId(null);
        } else if (job.status === 'failed') {
          setScrapingStatus(`Scraping failed: ${job.error || 'Unknown error'}`);
          setScrapingProgress(null);
          setScrapingJobId(null);
        } else if (job.status === 'cancelled') {
          setScrapingStatus('Scraping cancelled');
          setScrapingProgress(null);
          setScrapingJobId(null);
        }
      } catch (error) {
        console.error('Error polling job progress:', error);
      }
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(interval);
  }, [scrapingJobId, scrapingProgress, supabase]);

  // Start batch scraping for all vendors in a collection
  const startBatchScraping = async (collectionId: string) => {
    const collection = collections.find(c => c.id === collectionId);
    if (!collection) return;
    
    const vendorsWithStyles = collection.rows.filter(r => r.styles && r.styles.length > 0);
    if (vendorsWithStyles.length === 0) {
      alert('No vendors with styles to scrape.');
      return;
    }
    
    const totalStyles = vendorsWithStyles.reduce((sum, v) => sum + (v.styles?.length || 0), 0);
    if (!window.confirm(`Scrape Raw Costs for ${vendorsWithStyles.length} vendor(s) with ${totalStyles} total style(s)?`)) {
      return;
    }
    
    setIsBatchScraping(true);
    const jobs: Array<{ vendorId: string; jobId: string; status: 'pending' | 'running' | 'completed' | 'failed' }> = [];
    
    // Start jobs sequentially to avoid overwhelming the worker
    for (const vendor of vendorsWithStyles) {
      try {
        const res = await fetch('/api/enqueue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'scrape_style_raw_costs',
            payload: { vendor_row_id: vendor.id }
          })
        });
        if (!res.ok) throw new Error('Failed to start job');
        const { jobId } = await res.json();
        jobs.push({ vendorId: vendor.id, jobId, status: 'pending' });
      } catch (error: any) {
        console.error(`Failed to start job for vendor ${vendor.leverandør}:`, error);
        jobs.push({ vendorId: vendor.id, jobId: '', status: 'failed' });
      }
    }
    
    setBatchScrapingJobs(jobs);
  };

  // Poll batch scraping progress
  React.useEffect(() => {
    if (!isBatchScraping || batchScrapingJobs.length === 0) return;
    
    const interval = setInterval(async () => {
      const jobIds = batchScrapingJobs.filter(j => j.jobId && j.status !== 'completed' && j.status !== 'failed').map(j => j.jobId);
      if (jobIds.length === 0) {
        setIsBatchScraping(false);
        return;
      }
      
      try {
        const { data: jobsData } = await supabase
          .from('jobs')
          .select('id, status')
          .in('id', jobIds);
        
        if (jobsData) {
          setBatchScrapingJobs(prev => prev.map(job => {
            const dbJob = jobsData.find(j => j.id === job.jobId);
            if (dbJob) {
              if (dbJob.status === 'completed') return { ...job, status: 'completed' };
              if (dbJob.status === 'failed') return { ...job, status: 'failed' };
              if (dbJob.status === 'running') return { ...job, status: 'running' };
            }
            return job;
          }));
        }
        
        // Check if all done
        const allDone = batchScrapingJobs.every(j => j.status === 'completed' || j.status === 'failed');
        if (allDone) {
          setIsBatchScraping(false);
        }
      } catch (error) {
        console.error('Error polling batch jobs:', error);
      }
    }, 3000);
    
    return () => clearInterval(interval);
  }, [isBatchScraping, batchScrapingJobs, supabase]);

  // Save collections to Supabase (debounced for field updates only)
  const saveTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = React.useRef(false);
  
  const saveCollectionData = React.useCallback(async (collectionsToSave: Collection[]) => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    
    try {
      // Get current user
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        isSavingRef.current = false;
        return;
      }
      
      // Save collections (only updates, not creates - creates are handled in addCollection)
      for (const collection of collectionsToSave) {
        if (collection.id.startsWith('collection-') || collection.id === 'default') {
          continue; // Skip temporary IDs, they'll be created by addCollection
        }
        
        // Update existing collection
        await supabase
          .from('vendor_collections')
          .update({
            name: collection.name,
            season_id: collection.season_id,
            sort_order: collectionsToSave.indexOf(collection),
          })
          .eq('id', collection.id);
        
        // Save vendor rows
        for (const row of collection.rows) {
          if (row.id.startsWith('row-')) {
            continue; // Skip temporary IDs, they'll be created by addRow
          }
          
          // Update existing row
          await supabase
            .from('vendor_rows')
            .update({
              leverandør: row.leverandør,
              antal_prøver: row.antal_prøver,
              styles_i_koll: row.styles_i_koll,
              gns_pris_pr_prøve: row.gns_pris_pr_prøve,
              total: row.total,
              total_ubrugte: row.total_ubrugte,
              diff: row.diff,
              prøvefaktor: row.prøvefaktor,
              currency: row.currency,
              exchange_rate: row.exchange_rate,
              sort_order: collection.rows.indexOf(row),
            })
            .eq('id', row.id);
          
          // Save styles
          // First, delete styles that are no longer in the row
          const { data: existingStyles } = await supabase
            .from('vendor_styles')
            .select('id')
            .eq('vendor_row_id', row.id);
          
          const existingStyleIds = new Set((existingStyles || []).map(s => s.id));
          const currentStyleIds = new Set((row.styles || []).map(s => s.id).filter(id => !id.startsWith('style-')));
          const stylesToDelete = Array.from(existingStyleIds).filter(id => !currentStyleIds.has(id));
          
          if (stylesToDelete.length > 0) {
            await supabase
              .from('vendor_styles')
              .delete()
              .in('id', stylesToDelete);
          }
          
          // Update existing styles
          for (const style of (row.styles || [])) {
            if (style.id.startsWith('style-')) {
              continue; // Skip temporary IDs, they'll be created by addStyle
            }
            
            // Update existing style
            await supabase
              .from('vendor_styles')
              .update({
                style_no: style.style_no,
                original_input: style.original_input,
                price_per_sample: style.price_per_sample,
                out_of_collection: style.out_of_collection,
                sort_order: (row.styles || []).indexOf(style),
              })
              .eq('id', style.id);
          }
        }
      }
    } catch (error) {
      console.error('Failed to save collections:', error);
    } finally {
      isSavingRef.current = false;
    }
  }, [supabase]);
  
  // Debounce saves for field updates
  React.useEffect(() => {
    if (loading || collections.length === 0) return;
    
    // Clear previous timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    // Debounce saves to avoid too many API calls
    saveTimeoutRef.current = setTimeout(() => {
      saveCollectionData(collections);
    }, 2000); // 2 second debounce
    
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [collections, loading, saveCollectionData]);

  // Convert price to DKK based on vendor's currency and exchange rate
  const convertToDKK = (price: number, vendorCurrency: Currency, vendorExchangeRate: number): number => {
    if (vendorCurrency === 'DKK') return price;
    return price * vendorExchangeRate;
  };

  // Calculate derived fields for a row based on styles
  // collectionAntalPrøver: the sample size multiplier from the collection (default 9)
  const calculateRow = (row: VendorRow, collectionAntalPrøver: number = 9): VendorRow => {
    const styles = row.styles || [];
    const multiplier = collectionAntalPrøver > 0 ? collectionAntalPrøver : 9;
    
    // Calculate from styles if available
    if (styles.length > 0) {
      // Style count (number of style rows)
      const styleCount = styles.length;
      
      const inCollection = styles.filter(s => !s.out_of_collection);
      const outOfCollection = styles.filter(s => s.out_of_collection);
      
      // Sum up price_per_sample for each style, converted to DKK and multiplied by antal_prøver
      const totalPrice = styles.reduce((sum, s) => {
        const priceInDKK = convertToDKK(s.price_per_sample || 0, row.currency || 'DKK', row.exchange_rate || DEFAULT_CURRENCY_RATES[row.currency || 'DKK']);
        return sum + (priceInDKK * multiplier);
      }, 0);
      
      // Sum up price for styles IN collection (usable)
      const usablePrice = inCollection.reduce((sum, s) => {
        const priceInDKK = convertToDKK(s.price_per_sample || 0, row.currency || 'DKK', row.exchange_rate || DEFAULT_CURRENCY_RATES[row.currency || 'DKK']);
        return sum + (priceInDKK * multiplier);
      }, 0);
      
      // Average price per sample (in DKK, multiplied by antal_prøver)
      const avgPrice = styles.length > 0 
        ? totalPrice / styles.length
        : 0;
      
      // Prøvefaktor: ratio of styles to in-collection styles
      const prøvefaktor = inCollection.length > 0 
        ? styleCount / inCollection.length 
        : 0;
      
      return {
        ...row,
        antal_prøver: styleCount, // Count of style rows for this vendor
        styles_i_koll: inCollection.length,
        gns_pris_pr_prøve: avgPrice,
        total: totalPrice,
        total_ubrugte: outOfCollection.length, // COUNT of out-of-collection styles
        diff: usablePrice, // Total price of usable (in-collection) styles
        prøvefaktor,
      };
    }
    
    // Fallback to manual calculation if no styles
    const total = (row.antal_prøver || 0) * (row.gns_pris_pr_prøve || 0) * multiplier;
    const diff = total - (row.total_ubrugte || 0);
    
    return {
      ...row,
      total,
      diff,
    };
  };


  // Add new collection
  const addCollection = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: newCollection, error } = await supabase
        .from('vendor_collections')
        .insert({
          name: `Collection ${collections.length + 1}`,
          season_id: null,
          sort_order: collections.length,
          created_by: user?.id || null,
        })
        .select()
        .single();
      
      if (error) throw error;
      
      const collection: Collection = {
        id: newCollection.id,
        name: newCollection.name,
        season_id: newCollection.season_id,
        antal_prøver: newCollection.antal_prøver ?? 9,
        rows: [],
      };
      
      setCollections([...collections, collection]);
      setActiveTab(collection.id);
      setEditingName(collection.id);
      setNewName(collection.name);
    } catch (error) {
      console.error('Failed to create collection:', error);
      alert('Failed to create collection');
    }
  };

  // Update collection season
  const updateCollectionSeason = async (collectionId: string, seasonId: string | null) => {
    try {
      const { error } = await supabase
        .from('vendor_collections')
        .update({ season_id: seasonId })
        .eq('id', collectionId);
      
      if (error) throw error;
      
      setCollections(collections.map(c => 
        c.id === collectionId ? { ...c, season_id: seasonId } : c
      ));
    } catch (error) {
      console.error('Failed to update collection season:', error);
    }
  };

  // Update collection antal_prøver (sample size multiplier)
  const updateCollectionAntalPrøver = async (collectionId: string, antalPrøver: number) => {
    try {
      const value = antalPrøver > 0 ? antalPrøver : 9;
      const { error } = await supabase
        .from('vendor_collections')
        .update({ antal_prøver: value })
        .eq('id', collectionId);
      
      if (error) throw error;
      
      setCollections(collections.map(c => 
        c.id === collectionId ? { ...c, antal_prøver: value } : c
      ));
    } catch (error) {
      console.error('Failed to update collection antal_prøver:', error);
    }
  };

  // Update collection name
  const updateCollectionName = async (id: string, name: string) => {
    const trimmedName = name.trim() || 'Unnamed';
    try {
      const { error } = await supabase
        .from('vendor_collections')
        .update({ name: trimmedName })
        .eq('id', id);
      
      if (error) throw error;
      
      setCollections(collections.map(c => 
        c.id === id ? { ...c, name: trimmedName } : c
      ));
      setEditingName(null);
    } catch (error) {
      console.error('Failed to update collection name:', error);
    }
  };

  // Delete collection
  const deleteCollection = async (id: string) => {
    if (collections.length <= 1) {
      alert('Cannot delete the last collection');
      return;
    }
    if (window.confirm('Are you sure you want to delete this collection?')) {
      try {
        const { error } = await supabase
          .from('vendor_collections')
          .delete()
          .eq('id', id);
        
        if (error) throw error;
        
        const newCollections = collections.filter(c => c.id !== id);
        setCollections(newCollections);
        if (activeTab === id) {
          setActiveTab(newCollections[0]?.id || 'default');
        }
      } catch (error) {
        console.error('Failed to delete collection:', error);
        alert('Failed to delete collection');
      }
    }
  };

  // Get current collection
  const currentCollection = React.useMemo(() => {
    return collections.find(c => c.id === activeTab) || collections[0] || null;
  }, [collections, activeTab]);

  // Get current vendor row (must be before conditional returns)
  const currentVendorRow = React.useMemo(() => {
    if (!openVendorSheet) return null;
    return currentCollection?.rows.find(r => r.id === openVendorSheet) || null;
  }, [openVendorSheet, currentCollection]);

  // Update activeTab if current collection doesn't exist
  React.useEffect(() => {
    if (!loading && collections.length > 0 && !collections.find(c => c.id === activeTab)) {
      const firstCollection = collections[0];
      if (firstCollection) {
        setActiveTab(firstCollection.id);
      }
    }
  }, [loading, collections, activeTab]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-4 border-[#8FA894] border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-gray-600">Loading vendor statistics...</p>
        </div>
      </div>
    );
  }

  if (collections.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <p className="text-gray-600 mb-4">No collections found. Creating default collection...</p>
        </div>
      </div>
    );
  }

  if (!currentCollection) {
    // Fallback: use first collection - handle in useEffect to avoid hook order issues
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <p className="text-gray-600">Loading collection...</p>
        </div>
      </div>
    );
  }

  // Add new row
  const addRow = async () => {
    const currentCollection = collections.find(c => c.id === activeTab);
    if (!currentCollection) return;
    
    try {
      const { data: newRow, error } = await supabase
        .from('vendor_rows')
        .insert({
          collection_id: currentCollection.id,
          leverandør: '',
          antal_prøver: 0,
          styles_i_koll: 0,
          gns_pris_pr_prøve: 0,
          total: 0,
          total_ubrugte: 0,
          diff: 0,
          prøvefaktor: 0,
          currency: 'DKK',
          exchange_rate: 1,
          sort_order: currentCollection.rows.length,
        })
        .select()
        .single();
      
      if (error) throw error;
      
      const vendorRow: VendorRow = {
        id: newRow.id,
        leverandør: newRow.leverandør,
        antal_prøver: newRow.antal_prøver,
        styles_i_koll: newRow.styles_i_koll,
        gns_pris_pr_prøve: newRow.gns_pris_pr_prøve,
        total: newRow.total,
        total_ubrugte: newRow.total_ubrugte,
        diff: newRow.diff,
        prøvefaktor: newRow.prøvefaktor,
        currency: (newRow.currency as Currency) || 'DKK',
        exchange_rate: newRow.exchange_rate || 1,
        styles: [],
      };
      
      setCollections(collections.map(c => 
        c.id === activeTab 
          ? { ...c, rows: [...c.rows, vendorRow] }
          : c
      ));
    } catch (error) {
      console.error('Failed to create vendor row:', error);
      alert('Failed to create vendor');
    }
  };

  // Update row field (saves immediately)
  const updateRow = async (rowId: string, field: keyof VendorRow, value: string | number) => {
    // Update in database
    if (!rowId.startsWith('row-')) {
      try {
        const updateData: any = { [field]: value };
        await supabase
          .from('vendor_rows')
          .update(updateData)
          .eq('id', rowId);
      } catch (error) {
        console.error('Failed to update vendor row:', error);
      }
    }
    
    // Update local state
    const currentCollection = collections.find(c => c.id === activeTab);
    const collectionMultiplier = currentCollection?.antal_prøver ?? 9;
    setCollections(collections.map(c => 
      c.id === activeTab 
        ? {
            ...c,
            rows: c.rows.map(r => {
              if (r.id === rowId) {
                const updated = { ...r, [field]: value };
                return calculateRow(updated, collectionMultiplier);
              }
              return r;
            })
          }
        : c
    ));
  };

  // Update local row value (for input fields, saves on blur)
  const updateLocalRowValue = (rowId: string, field: keyof VendorRow, value: string | number) => {
    setLocalRowValues(prev => ({
      ...prev,
      [rowId]: {
        ...prev[rowId],
        [field]: value,
      },
    }));
  };

  // Save local row value on blur
  const saveLocalRowValue = (rowId: string, field: keyof VendorRow) => {
    const localValue = localRowValues[rowId]?.[field];
    if (localValue !== undefined && (typeof localValue === 'string' || typeof localValue === 'number')) {
      updateRow(rowId, field, localValue);
      // Clear local value after saving
      setLocalRowValues(prev => {
        const next = { ...prev };
        if (next[rowId]) {
          delete next[rowId][field];
          if (Object.keys(next[rowId]).length === 0) {
            delete next[rowId];
          }
        }
        return next;
      });
    }
  };

  // Delete row
  const deleteRow = async (rowId: string) => {
    try {
      const { error } = await supabase
        .from('vendor_rows')
        .delete()
        .eq('id', rowId);
      
      if (error) throw error;
      
      setCollections(collections.map(c => 
        c.id === activeTab 
          ? { ...c, rows: c.rows.filter(r => r.id !== rowId) }
          : c
      ));
    } catch (error) {
      console.error('Failed to delete vendor row:', error);
      alert('Failed to delete vendor');
    }
  };

  // Add style to vendor
  const addStyle = async (vendorId: string) => {
    try {
      const { data: newStyle, error } = await supabase
        .from('vendor_styles')
        .insert({
          vendor_row_id: vendorId,
          style_no: '',
          original_input: null,
          price_per_sample: 0,
          out_of_collection: false,
          sort_order: 0,
        })
        .select()
        .single();
      
      if (error) throw error;
      
      const vendorStyle: VendorStyle = {
        id: newStyle.id,
        style_no: newStyle.style_no,
        original_input: newStyle.original_input || undefined,
        price_per_sample: newStyle.price_per_sample,
        out_of_collection: newStyle.out_of_collection,
      };
      
      const currentCollection = collections.find(c => c.id === activeTab);
      const collectionMultiplier = currentCollection?.antal_prøver ?? 9;
      setCollections(collections.map(c => 
        c.id === activeTab 
          ? {
              ...c,
              rows: c.rows.map(r => {
                if (r.id === vendorId) {
                  const updated = { ...r, styles: [...(r.styles || []), vendorStyle] };
                  return calculateRow(updated, collectionMultiplier);
                }
                return r;
              })
            }
          : c
      ));
    } catch (error) {
      console.error('Failed to create style:', error);
      alert('Failed to add style');
    }
  };

  // Update style (saves immediately for checkboxes, on blur for inputs)
  const updateStyle = async (vendorId: string, styleId: string, field: keyof VendorStyle, value: string | number | boolean) => {
    // Update in database
    if (!styleId.startsWith('style-')) {
      try {
        const updateData: any = { [field]: value };
        await supabase
          .from('vendor_styles')
          .update(updateData)
          .eq('id', styleId);
      } catch (error) {
        console.error('Failed to update style:', error);
      }
    }
    
    // Update local state
    const currentCollection = collections.find(c => c.id === activeTab);
    const collectionMultiplier = currentCollection?.antal_prøver ?? 9;
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
                return calculateRow(updated, collectionMultiplier);
              }
              return r;
            })
          }
        : c
    ));
  };

  // Update local style value (for input fields, saves on blur)
  const updateLocalStyleValue = (vendorId: string, styleId: string, field: keyof VendorStyle, value: string | number) => {
    const key = `${vendorId}-${styleId}`;
    setLocalStyleValues(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        [field]: value,
      },
    }));
  };

  // Save local style value on blur
  const saveLocalStyleValue = (vendorId: string, styleId: string, field: keyof VendorStyle) => {
    const key = `${vendorId}-${styleId}`;
    const localValue = localStyleValues[key]?.[field];
    if (localValue !== undefined) {
      updateStyle(vendorId, styleId, field, localValue);
      // Clear local value after saving
      setLocalStyleValues(prev => {
        const next = { ...prev };
        if (next[key]) {
          delete next[key][field];
          if (Object.keys(next[key]).length === 0) {
            delete next[key];
          }
        }
        return next;
      });
    }
  };

  // Delete style
  const deleteStyle = async (vendorId: string, styleId: string) => {
    try {
      if (!styleId.startsWith('style-')) {
        await supabase
          .from('vendor_styles')
          .delete()
          .eq('id', styleId);
      }
      
      const currentCollection = collections.find(c => c.id === activeTab);
      const collectionMultiplier = currentCollection?.antal_prøver ?? 9;
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
                  return calculateRow(updated, collectionMultiplier);
                }
                return r;
              })
            }
          : c
      ));
    } catch (error) {
      console.error('Failed to delete style:', error);
      alert('Failed to delete style');
    }
  };

  // Import styles from textarea (one per line) with season matching
  const importStylesFromText = async (vendorId: string, text: string) => {
    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    if (lines.length === 0) return;

    const currentCollection = collections.find(c => c.id === activeTab);
    const seasonId = currentCollection?.season_id;

    let styleMap: Map<string, string> = new Map(); // style_name -> style_no

    // If season is selected, fetch styles from database and match by name
    if (seasonId && seasons) {
      try {
        // Query top_styles for this season to get style_name -> style_no mapping
        const { data: topStyles, error: topStylesError } = await supabase
          .from('top_styles')
          .select('style_no, style_name')
          .eq('season_id', seasonId);
        
        if (!topStylesError && topStyles) {
          // Create map of style_name -> style_no (case-insensitive)
          for (const ts of topStyles) {
            if (ts.style_name) {
              const key = ts.style_name.toLowerCase().trim();
              if (!styleMap.has(key)) {
                styleMap.set(key, ts.style_no || '');
              }
            }
            // Also map style_no to itself
            if (ts.style_no) {
              const key = ts.style_no.toLowerCase().trim();
              styleMap.set(key, ts.style_no);
            }
          }
        }

        // Also query styles table for additional matches
        const { data: allStyles, error: stylesError } = await supabase
          .from('styles')
          .select('style_no, style_name')
          .limit(10000);
        
        if (!stylesError && allStyles) {
          for (const s of allStyles) {
            if (s.style_name) {
              const key = s.style_name.toLowerCase().trim();
              if (!styleMap.has(key)) {
                styleMap.set(key, s.style_no || '');
              }
            }
            if (s.style_no) {
              const key = s.style_no.toLowerCase().trim();
              styleMap.set(key, s.style_no);
            }
          }
        }
      } catch (error) {
        console.error('Error fetching styles for matching:', error);
      }
    }

    // Match lines to style_no and create styles in database
    const createdStyles: VendorStyle[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      const key = trimmed.toLowerCase();
      const matchedStyleNo = styleMap.get(key) || trimmed; // Use matched style_no or original if no match
      
      try {
        const { data: newStyle, error } = await supabase
          .from('vendor_styles')
          .insert({
            vendor_row_id: vendorId,
            style_no: matchedStyleNo,
            original_input: trimmed !== matchedStyleNo ? trimmed : null,
            price_per_sample: 0,
            out_of_collection: false,
            sort_order: 0,
          })
          .select()
          .single();
        
        if (error) throw error;
        
        createdStyles.push({
          id: newStyle.id,
          style_no: newStyle.style_no,
          original_input: newStyle.original_input || undefined,
          price_per_sample: newStyle.price_per_sample,
          out_of_collection: newStyle.out_of_collection,
        });
      } catch (error) {
        console.error('Failed to create style:', error);
      }
    }

    if (createdStyles.length > 0) {
      const currentCollection = collections.find(c => c.id === activeTab);
      const collectionMultiplier = currentCollection?.antal_prøver ?? 9;
      setCollections(collections.map(c => 
        c.id === activeTab 
          ? {
              ...c,
              rows: c.rows.map(r => {
                if (r.id === vendorId) {
                  const updated = {
                    ...r,
                    styles: [...(r.styles || []), ...createdStyles]
                  };
                  return calculateRow(updated, collectionMultiplier);
                }
                return r;
              })
            }
          : c
      ));
    }

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
  const formatCurrency = (num: number, currency: Currency = 'DKK'): string => {
    return formatNumber(num) + ' ' + currency;
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
                    <div className="flex items-center gap-4">
                      <div className="text-sm text-gray-600">
                        {collection.rows.length} vendor{collection.rows.length !== 1 ? 's' : ''}
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-600">Season:</label>
                        <select
                          value={collection.season_id || ''}
                          onChange={(e) => updateCollectionSeason(collection.id, e.target.value || null)}
                          className="text-xs border rounded px-2 py-1 min-w-[200px]"
                        >
                          <option value="">No season selected</option>
                          {seasons?.map((season) => (
                            <option key={season.id} value={season.id}>
                              {season.name} {season.year ? `(${season.year})` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-600">Antal prøver:</label>
                        <Input
                          type="number"
                          value={collection.antal_prøver || 9}
                          onChange={(e) => updateCollectionAntalPrøver(collection.id, parseFloat(e.target.value) || 9)}
                          className="w-20 text-xs text-center"
                          min="1"
                          step="1"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isBatchScraping ? (
                        <div className="flex items-center gap-2 text-xs text-[#8FA894]">
                          <span className="animate-spin">⏳</span>
                          <span>
                            Scraping: {batchScrapingJobs.filter(j => j.status === 'completed').length}/{batchScrapingJobs.length} done
                          </span>
                        </div>
                      ) : (
                        <Button 
                          onClick={() => startBatchScraping(collection.id)}
                          variant="outline"
                          size="sm"
                          className="border-orange-400 text-orange-600 hover:bg-orange-50"
                          disabled={collection.rows.filter(r => r.styles && r.styles.length > 0).length === 0}
                        >
                          🔍 Scrape All
                        </Button>
                      )}
                      <Button 
                        onClick={addRow}
                        variant="outline"
                        size="sm"
                        className="border-[#8FA894] text-[#8FA894] hover:bg-[#8FA894]/10"
                      >
                        + Add Vendor
                      </Button>
                    </div>
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
                            <TableHead className="text-right w-[120px]">Total (DKK)</TableHead>
                            <TableHead className="text-right w-[100px]">Ubrugte</TableHead>
                            <TableHead className="text-right w-[120px]">Brugbar (DKK)</TableHead>
                            <TableHead className="text-right w-[120px]">Prøvefaktor</TableHead>
                            <TableHead className="w-[80px]"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {collection.rows.map((row) => {
                            const calculated = calculateRow(row, collection.antal_prøver);
                            return (
                              <TableRow 
                                key={row.id} 
                                className="hover:bg-gray-50 cursor-pointer"
                                onClick={() => setOpenVendorSheet(row.id)}
                              >
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <Input
                                      value={localRowValues[row.id]?.leverandør !== undefined ? (localRowValues[row.id]?.leverandør as string) : row.leverandør}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        updateLocalRowValue(row.id, 'leverandør', e.target.value);
                                      }}
                                      onBlur={(e) => {
                                        e.stopPropagation();
                                        saveLocalRowValue(row.id, 'leverandør');
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
                                <TableCell className="text-right">
                                  {calculated.antal_prøver}
                                </TableCell>
                                <TableCell className="text-right">
                                  {calculated.styles_i_koll}
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatCurrency(calculated.gns_pris_pr_prøve)}
                                </TableCell>
                                <TableCell className="text-right font-medium text-[#8FA894]">
                                  {formatCurrency(calculated.total)}
                                </TableCell>
                                <TableCell className={`text-right font-medium ${
                                  calculated.total_ubrugte > 0 ? 'text-red-600' : 'text-gray-500'
                                }`}>
                                  {calculated.total_ubrugte}
                                </TableCell>
                                <TableCell className="text-right font-medium text-green-600">
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
              {/* Currency and Prøvefaktor Settings */}
              <Card className="border-[#C5D5CA] bg-[#F5F3F0]">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Vendor Settings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Currency</label>
                      <select
                        value={currentVendorRow.currency || 'DKK'}
                        onChange={(e) => {
                          const newCurrency = e.target.value as Currency;
                          updateRow(currentVendorRow.id, 'currency', newCurrency);
                          // Update exchange rate to default if not set
                          if (!currentVendorRow.exchange_rate || currentVendorRow.exchange_rate === 1) {
                            updateRow(currentVendorRow.id, 'exchange_rate', DEFAULT_CURRENCY_RATES[newCurrency]);
                          }
                        }}
                        className="w-full text-xs border rounded px-2 py-1"
                      >
                        <option value="DKK">DKK</option>
                        <option value="EUR">EUR</option>
                        <option value="USD">USD</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Exchange Rate (to DKK)
                      </label>
                      <Input
                        type="number"
                        value={localRowValues[currentVendorRow.id]?.exchange_rate !== undefined 
                          ? (localRowValues[currentVendorRow.id]?.exchange_rate as number)
                          : (currentVendorRow.exchange_rate || DEFAULT_CURRENCY_RATES[currentVendorRow.currency || 'DKK'])}
                        onChange={(e) => updateLocalRowValue(currentVendorRow.id, 'exchange_rate', parseFloat(e.target.value) || DEFAULT_CURRENCY_RATES[currentVendorRow.currency || 'DKK'])}
                        onBlur={() => saveLocalRowValue(currentVendorRow.id, 'exchange_rate')}
                        className="w-full text-xs"
                        min="0"
                        step="0.0001"
                        placeholder="1.0"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Antal prøver (Collection)</label>
                      <div className="px-3 py-2 bg-gray-100 rounded text-xs font-medium">
                        {currentCollection?.antal_prøver || 9}
                      </div>
                      <div className="text-[10px] text-gray-500 mt-1">
                        Set at collection level. Multiplies all prices.
                      </div>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-[#C5D5CA]">
                    {scrapingJobId ? (
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-[#8FA894]">
                          {scrapingStatus || 'Scraping in progress...'}
                        </div>
                        {scrapingProgress && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-xs text-gray-600">
                              <span>
                                {scrapingProgress.currentStyle 
                                  ? `Processing: ${scrapingProgress.currentStyle}` 
                                  : 'Waiting...'}
                              </span>
                              <span>
                                {scrapingProgress.current}/{scrapingProgress.total}
                              </span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded bg-gray-100">
                              <div 
                                className="h-2 bg-[#8FA894] transition-all duration-300" 
                                style={{ 
                                  width: `${scrapingProgress.total > 0 
                                    ? (scrapingProgress.current / scrapingProgress.total) * 100 
                                    : 0}%` 
                                }} 
                              />
                            </div>
                          </div>
                        )}
                        <Button
                          onClick={() => {
                            setScrapingJobId(null);
                            setScrapingProgress(null);
                            setScrapingStatus('');
                          }}
                          variant="outline"
                          size="sm"
                          className="w-full border-gray-300 text-gray-600 hover:bg-gray-100"
                        >
                          Dismiss
                        </Button>
                      </div>
                    ) : (
                      <>
                        <Button
                          onClick={async () => {
                            if (!currentVendorRow.styles || currentVendorRow.styles.length === 0) {
                              alert('No styles to scrape. Please add styles first.');
                              return;
                            }
                            if (!window.confirm(`Scrape Raw Costs for ${currentVendorRow.styles.length} style(s)? This will update the price_per_sample for each style.`)) {
                              return;
                            }
                            try {
                              const res = await fetch('/api/enqueue', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  type: 'scrape_style_raw_costs',
                                  payload: { vendor_row_id: currentVendorRow.id }
                                })
                              });
                              if (!res.ok) throw new Error('Failed to start job');
                              const { jobId } = await res.json();
                              setScrapingJobId(jobId);
                              setScrapingProgress({ current: 0, total: currentVendorRow.styles?.length || 0 });
                              setScrapingStatus('Job started, waiting for progress...');
                            } catch (error: any) {
                              console.error('Failed to start scraping job:', error);
                              alert(`Failed to start job: ${error.message}`);
                            }
                          }}
                          variant="outline"
                          size="sm"
                          className="w-full border-[#8FA894] text-[#8FA894] hover:bg-[#8FA894]/10"
                        >
                          🔍 Scrape Raw Costs from SPY
                        </Button>
                        <div className="text-[10px] text-gray-500 mt-1">
                          Fetches Raw Cost from SPY for all styles in this vendor and updates price_per_sample
                        </div>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>

              <div className="text-sm text-gray-600">
                Add styles for this vendor. Prices will be calculated based on the selected currency ({currentVendorRow.currency || 'DKK'}) and prøvefaktor.
              </div>

              {/* Bulk Import Textarea */}
              <Card className="border-[#C5D5CA] bg-[#F5F3F0]">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Bulk Import Styles</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {currentCollection?.season_id ? (
                    <div className="text-xs text-gray-600 mb-2">
                      Season: {seasons?.find(s => s.id === currentCollection.season_id)?.name || 'Unknown'} - 
                      Style names will be automatically matched to style_no from this season
                    </div>
                  ) : (
                    <div className="text-xs text-amber-600 mb-2">
                      ⚠️ No season selected. Select a season in the collection tab to enable automatic style name matching.
                    </div>
                  )}
                  <textarea
                    value={bulkImportText}
                    onChange={(e) => setBulkImportText(e.target.value)}
                    placeholder="Paste style names or numbers here, one per line (e.g., from Excel)&#10;STYLE-001&#10;STYLE-002&#10;STYLE-003"
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
                        <TableHead className="w-[250px]">Style Name/Input</TableHead>
                        <TableHead className="w-[200px]">Connected Style No</TableHead>
                        <TableHead className="text-right w-[150px]">Price per Sample ({currentVendorRow.currency || 'DKK'})</TableHead>
                        <TableHead className="text-center w-[150px]">Out of Collection</TableHead>
                        <TableHead className="text-right w-[120px]">Price in DKK</TableHead>
                        <TableHead className="w-[80px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {currentVendorRow.styles.map((style) => {
                        const vendorCurrency = currentVendorRow.currency || 'DKK';
                        const vendorExchangeRate = currentVendorRow.exchange_rate || DEFAULT_CURRENCY_RATES[vendorCurrency];
                        const priceInDKK = convertToDKK(style.price_per_sample || 0, vendorCurrency, vendorExchangeRate);
                        // Price multiplied by collection's antal_prøver (default 9)
                        const collectionMultiplier = currentCollection?.antal_prøver ?? 9;
                        const totalPrice = priceInDKK * collectionMultiplier;
                        
                        return (
                          <TableRow key={style.id} className="hover:bg-gray-50">
                            <TableCell>
                              <Input
                                value={style.original_input || style.style_no}
                                onChange={(e) => {
                                  // Update both original_input and style_no
                                  updateStyle(currentVendorRow.id, style.id, 'original_input', e.target.value);
                                  updateStyle(currentVendorRow.id, style.id, 'style_no', e.target.value);
                                }}
                                placeholder="Style name or number"
                                className="w-full text-xs"
                              />
                              {style.original_input && style.original_input !== style.style_no && (
                                <div className="text-[10px] text-gray-400 mt-1">
                                  Original: {style.original_input}
                                </div>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="text-xs font-medium text-[#8FA894] py-2 px-2 bg-[#F5F3F0] rounded">
                                {style.style_no || '—'}
                              </div>
                              {style.original_input && style.original_input !== style.style_no && (
                                <div className="text-[10px] text-gray-500 mt-1">
                                  Matched from DB
                                </div>
                              )}
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                value={localStyleValues[`${currentVendorRow.id}-${style.id}`]?.price_per_sample !== undefined 
                                  ? (localStyleValues[`${currentVendorRow.id}-${style.id}`]?.price_per_sample as number)
                                  : (style.price_per_sample || '')}
                                onChange={(e) => updateLocalStyleValue(currentVendorRow.id, style.id, 'price_per_sample', parseFloat(e.target.value) || 0)}
                                onBlur={() => saveLocalStyleValue(currentVendorRow.id, style.id, 'price_per_sample')}
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
                              {formatCurrency(totalPrice, 'DKK')}
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
                const collectionMultiplier = currentCollection?.antal_prøver ?? 9;
                const calculated = calculateRow(currentVendorRow, collectionMultiplier);
                return (
                  <Card className="border-[#C5D5CA] bg-[#F5F3F0]">
                    <CardHeader>
                      <CardTitle className="text-sm">Summary</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-600">Antal prøver:</span>
                        <span className="font-medium">{calculated.antal_prøver}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Styles in Collection:</span>
                        <span className="font-medium">{calculated.styles_i_koll}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Ubrugte (out of collection):</span>
                        <span className={`font-medium ${calculated.total_ubrugte > 0 ? 'text-red-600' : 'text-gray-500'}`}>{calculated.total_ubrugte}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Prøvefaktor:</span>
                        <span className="font-medium">{calculated.prøvefaktor > 0 ? formatNumber(calculated.prøvefaktor) : '—'}</span>
                      </div>
                      <div className="flex justify-between pt-2 border-t">
                        <span className="font-semibold">Total (DKK):</span>
                        <span className="font-bold text-[#8FA894]">{formatCurrency(calculated.total)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="font-semibold">Brugbar (DKK):</span>
                        <span className="font-bold text-green-600">{formatCurrency(calculated.diff)}</span>
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

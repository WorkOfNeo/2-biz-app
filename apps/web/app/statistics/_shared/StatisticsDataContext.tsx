'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';

export type Season = { id: string; name: string; year: number | null; is_current?: boolean | null };
export type SeasonCompareSetting = { id: string; key: string; value: { s1?: string; s2?: string } } | null;
export type Salesperson = { id: string; name: string; currency?: string | null; sort_index?: number | null };
export type Customer = {
  customer_id: string;
  company?: string | null;
  city?: string | null;
  country?: string | null;
  salesperson_id: string | null;
  group_name?: string | null;
  nulled?: boolean | null;
  excluded?: boolean | null;
  permanently_closed?: boolean | null;
};
export type ClosedCustomers = { setClosed: Set<string>; setExcluded: Set<string>; setNulled: Set<string> };
export type Overrides = { id: string | null; value: { nulled: string[]; hidden: string[] } };

export type SalesStatRow = {
  id?: string;
  account_no: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  city?: string | null;
  qty: number | null;
  price: number | null;
  currency?: string | null;
  season_id: string;
  salesperson_id: string | null;
  updated_at?: string | null;
  frozen?: boolean | null;
};

export type InvoiceRow = {
  id?: string;
  account_no: string | null;
  customer_name?: string | null;
  qty: number | null;
  amount: number | null;
  currency: string | null;
  season_id: string;
  invoice_no?: string | null;
  invoice_date?: string | null;
  created_at?: string | null;
  manual_edited?: boolean | null;
};

type StatisticsData = {
  seasons: Season[] | undefined;
  savedCompare: SeasonCompareSetting | undefined;

  s1: string;
  s2: string;
  setS1: (next: string) => void;
  setS2: (next: string) => void;

  salespersons: Salesperson[] | undefined;
  customers: Customer[] | undefined;
  customerIndex: { byId: Record<string, string>; byName: Record<string, string>; groupById: Record<string, string> } | undefined;
  closedCustomers: ClosedCustomers | undefined;

  currencyRatesRow: Record<string, number> | undefined;
  ratesS1: Record<string, number> | undefined;
  ratesS2: Record<string, number> | undefined;

  stats: SalesStatRow[] | undefined;
  invoices: InvoiceRow[] | undefined;
  overrides: Overrides | undefined;

  ready: boolean;
  refreshing: boolean;
  refreshAll: () => Promise<void>;
};

const StatisticsDataContext = createContext<StatisticsData | null>(null);

function pickDefaultSeasons(seasons: Season[]): { s1?: string; s2?: string } {
  const list = seasons ?? [];
  const current = list.find((x) => x.is_current);
  const first = list[0];
  const second = list[1] || list.find((x) => x.id !== (current?.id || first?.id));
  return { s1: (current?.id || first?.id) ?? undefined, s2: second?.id ?? undefined };
}

export function StatisticsDataProvider({ children }: { children: React.ReactNode }) {
  const swrOpts = useMemo(
    () => ({
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      dedupingInterval: 10_000
    }),
    []
  );

  const { data: seasons } = useSWR(
    'statistics:seasons',
    async () => {
      const { data, error } = await supabase
        .from('seasons')
        .select('id, name, year, is_current')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Season[];
    },
    { ...swrOpts, refreshInterval: 1_800_000 }
  );

  const { data: savedCompare, mutate: mutateSavedCompare } = useSWR(
    'statistics:season-compare',
    async () => {
      const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
      if (error) throw new Error(error.message);
      return data as SeasonCompareSetting;
    },
    { ...swrOpts, refreshInterval: 0 }
  );

  const [s1, _setS1] = useState<string>('');
  const [s2, _setS2] = useState<string>('');
  const userTouchedRef = useRef(false);
  const didInitRef = useRef(false);

  const setS1 = (next: string) => {
    userTouchedRef.current = true;
    _setS1(next);
  };
  const setS2 = (next: string) => {
    userTouchedRef.current = true;
    _setS2(next);
  };

  // Initialize s1/s2 exactly once (unless the user changes it).
  useEffect(() => {
    if (didInitRef.current) return;
    if (!seasons || seasons.length === 0) return;

    const defaults = pickDefaultSeasons(seasons);
    const nextS1 = (savedCompare?.value?.s1 || defaults.s1 || '') as string;
    const nextS2 = (savedCompare?.value?.s2 || defaults.s2 || '') as string;

    if (nextS1 && nextS2) {
      didInitRef.current = true;
      _setS1(nextS1);
      _setS2(nextS2);
    }
  }, [seasons?.length, savedCompare?.id]);

  const { data: salespersons } = useSWR(
    'statistics:salespersons',
    async () => {
      const { data, error } = await supabase
        .from('salespersons')
        .select('id, name, currency, sort_index')
        .order('sort_index', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as Salesperson[];
    },
    { ...swrOpts, refreshInterval: 1_800_000 }
  );

  const { data: customers, mutate: mutateCustomers } = useSWR(
    'statistics:customers',
    async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('customer_id, company, city, country, salesperson_id, group_name, nulled, excluded, permanently_closed');
      if (error) throw new Error(error.message);
      return (data ?? []) as Customer[];
    },
    { ...swrOpts, refreshInterval: 1_800_000 }
  );

  const customerIndex = useMemo(() => {
    if (!customers) return undefined;
    const byId: Record<string, string> = {};
    const byName: Record<string, string> = {};
    const groupById: Record<string, string> = {};
    for (const c of customers) {
      if (c.customer_id) byId[c.customer_id] = c.city ?? '';
      if (c.company) byName[c.company] = c.city ?? '';
      if (c.customer_id) groupById[c.customer_id] = c.group_name ?? '';
    }
    return { byId, byName, groupById };
  }, [customers]);

  const closedCustomers = useMemo((): ClosedCustomers | undefined => {
    if (!customers) return undefined;
    const setClosed = new Set<string>();
    const setExcluded = new Set<string>();
    const setNulled = new Set<string>();
    for (const c of customers) {
      if (c.permanently_closed) setClosed.add(c.customer_id);
      if (c.excluded) setExcluded.add(c.customer_id);
      if (c.nulled) setNulled.add(c.customer_id);
    }
    return { setClosed, setExcluded, setNulled };
  }, [customers]);

  const { data: currencyRatesRow } = useSWR(
    'statistics:currency-rates',
    async () => {
      const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
      if (error) throw new Error(error.message);
      return ((data?.value as Record<string, number> | undefined) ?? {}) as Record<string, number>;
    },
    { ...swrOpts, refreshInterval: 1_800_000 }
  );

  const { data: ratesS1 } = useSWR(
    s1 ? ['statistics:currency-rates-season', s1] : null,
    async () => {
      const key = `currency_rates:${s1}`;
      const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
      return ((data?.value as any) || {}) as Record<string, number>;
    },
    { ...swrOpts, refreshInterval: 1_800_000 }
  );

  const { data: ratesS2 } = useSWR(
    s2 ? ['statistics:currency-rates-season', s2] : null,
    async () => {
      const key = `currency_rates:${s2}`;
      const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
      return ((data?.value as any) || {}) as Record<string, number>;
    },
    { ...swrOpts, refreshInterval: 1_800_000 }
  );

  const { data: stats, mutate: mutateStats } = useSWR(
    s1 && s2 ? ['statistics:sales-stats', s1, s2] : null,
    async () => {
      const { data, error } = await supabase
        .from('sales_stats')
        .select('id, account_no, customer_id, customer_name, city, qty, price, currency, season_id, salesperson_id, updated_at, frozen')
        .in('season_id', [s1, s2])
        .limit(200000);
      if (error) throw new Error(error.message);
      return (data ?? []) as SalesStatRow[];
    },
    { ...swrOpts, refreshInterval: 20_000 }
  );

  const { data: invoices, mutate: mutateInvoices } = useSWR(
    s1 && s2 ? ['statistics:sales-invoices', s1, s2] : null,
    async () => {
      const { data, error } = await supabase
        .from('sales_invoices')
        .select('id, account_no, customer_name, qty, amount, currency, season_id, invoice_no, invoice_date, created_at, manual_edited')
        .in('season_id', [s1, s2])
        .limit(200000);
      if (error) throw new Error(error.message);
      return (data ?? []) as InvoiceRow[];
    },
    { ...swrOpts, refreshInterval: 20_000 }
  );

  const overridesKey = s1 ? `season_overrides:${s1}` : null;
  const { data: overrides, mutate: mutateOverrides } = useSWR(
    overridesKey ? ['statistics:season-overrides', overridesKey] : null,
    async () => {
      if (!overridesKey) return { id: null, value: { nulled: [], hidden: [] as string[] } };
      const { data, error } = await supabase.from('app_settings').select('id, value').eq('key', overridesKey).maybeSingle();
      if (error) throw new Error(error.message);
      const val = (data?.value as any) || {};
      return {
        id: data?.id ?? null,
        value: {
          nulled: Array.isArray(val.nulled) ? val.nulled : [],
          hidden: Array.isArray(val.hidden) ? val.hidden : []
        }
      } as Overrides;
    },
    { ...swrOpts, refreshInterval: 0 }
  );

  const ready = Boolean(
    seasons?.length &&
      s1 &&
      s2 &&
      salespersons &&
      customers &&
      currencyRatesRow &&
      stats &&
      invoices &&
      overrides &&
      closedCustomers &&
      customerIndex
  );

  const [refreshing, setRefreshing] = useState(false);
  async function refreshAll() {
    setRefreshing(true);
    try {
      await Promise.all([mutateCustomers(), mutateStats(), mutateInvoices(), mutateOverrides(), mutateSavedCompare()]);
    } finally {
      setRefreshing(false);
    }
  }

  const value = useMemo(
    () =>
      ({
        seasons,
        savedCompare,
        s1,
        s2,
        setS1,
        setS2,
        salespersons,
        customers,
        customerIndex,
        closedCustomers,
        currencyRatesRow,
        ratesS1,
        ratesS2,
        stats,
        invoices,
        overrides,
        ready,
        refreshing,
        refreshAll
      }) satisfies StatisticsData,
    [
      seasons,
      savedCompare,
      s1,
      s2,
      salespersons,
      customers,
      customerIndex,
      closedCustomers,
      currencyRatesRow,
      ratesS1,
      ratesS2,
      stats,
      invoices,
      overrides,
      ready,
      refreshing
    ]
  );

  return <StatisticsDataContext.Provider value={value}>{children}</StatisticsDataContext.Provider>;
}

export function useStatisticsData(): StatisticsData {
  const ctx = useContext(StatisticsDataContext);
  if (!ctx) throw new Error('useStatisticsData must be used within <StatisticsDataProvider>');
  return ctx;
}




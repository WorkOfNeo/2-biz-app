'use client';

import { StatisticsDataProvider } from './_shared/StatisticsDataContext';

export default function StatisticsLayout({ children }: { children: React.ReactNode }) {
  return <StatisticsDataProvider>{children}</StatisticsDataProvider>;
}











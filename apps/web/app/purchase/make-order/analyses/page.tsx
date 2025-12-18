'use client';
import React from 'react';
import useSWR from 'swr';
import { useRouter } from 'next/navigation';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';

type SavedAnalysis = {
  id: string;
  selections: Array<{ style_no: string; color: string }>;
  date_range_start: string;
  date_range_end: string;
  weeks_cover: number;
  summary: {
    totalItems: number;
    criticalItems: number;
    lowItems: number;
    okItems: number;
    surplusItems: number;
    totalSuggestedOrder: number;
    totalUserOrder?: number;
  };
  ai_summary: string | null;
  pdf_url: string | null;
  created_at: string;
};

export default function AnalysesListPage() {
  const router = useRouter();
  const [type, setType] = React.useState<'call-off' | 'seasonal'>('call-off');

  const { data: callOffData, isLoading: callOffLoading } = useSWR(
    type === 'call-off' ? '/api/call-off/save' : null,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    }
  );

  const { data: seasonalData, isLoading: seasonalLoading } = useSWR(
    type === 'seasonal' ? '/api/seasonal/analyses' : null,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) return { data: [], count: 0 };
      return res.json();
    }
  );

  const analyses = type === 'call-off' 
    ? (callOffData?.data || []) as SavedAnalysis[]
    : (seasonalData?.data || []) as SavedAnalysis[];

  const isLoading = type === 'call-off' ? callOffLoading : seasonalLoading;

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateStr;
    }
  };

  const formatDateRange = (start: string, end: string) => {
    try {
      const s = new Date(start);
      const e = new Date(end);
      return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } catch {
      return `${start} - ${end}`;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">AI Purchase Analyses</h1>
          <p className="text-sm text-slate-600">View saved analyses and their recommendations</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={type === 'call-off' ? 'default' : 'outline'}
            onClick={() => setType('call-off')}
            className={type === 'call-off' ? 'bg-[#8FA894]' : ''}
          >
            NOOS Call-Off
          </Button>
          <Button
            variant={type === 'seasonal' ? 'default' : 'outline'}
            onClick={() => setType('seasonal')}
            className={type === 'seasonal' ? 'bg-[#B8A8D8]' : ''}
          >
            Seasonal
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-center space-y-4">
            <svg className="animate-spin h-8 w-8 mx-auto text-[#8FA894]" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-slate-500">Loading analyses...</p>
          </div>
        </div>
      ) : analyses.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <div className="text-slate-400 mb-4">
              <svg className="h-16 w-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-slate-700 mb-2">No analyses yet</h3>
            <p className="text-slate-500 mb-6">
              {type === 'call-off' 
                ? 'Run a Full AI Analysis from the NOOS Call-Off page to create your first analysis.'
                : 'Seasonal analyses will appear here once you run them.'}
            </p>
            {type === 'call-off' && (
              <Button onClick={() => router.push('/purchase/call-off')} className="bg-[#8FA894]">
                Go to NOOS Call-Off
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {analyses.map((analysis) => (
            <Card 
              key={analysis.id} 
              className="border-[#C5D5CA] hover:border-[#8FA894] transition-colors cursor-pointer"
              onClick={() => router.push(`/purchase/make-order/analyses/${analysis.id}`)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">
                      {formatDateRange(analysis.date_range_start, analysis.date_range_end)}
                    </CardTitle>
                    <CardDescription>
                      Created {formatDate(analysis.created_at)} • {analysis.weeks_cover} weeks cover
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    {analysis.summary.criticalItems > 0 && (
                      <Badge className="bg-red-500 text-white">
                        {analysis.summary.criticalItems} Critical
                      </Badge>
                    )}
                    {analysis.summary.lowItems > 0 && (
                      <Badge className="bg-amber-500 text-white">
                        {analysis.summary.lowItems} Low
                      </Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                  <div>
                    <div className="text-slate-500">Total Items</div>
                    <div className="font-semibold">{analysis.summary.totalItems}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Styles/Colors</div>
                    <div className="font-semibold">{analysis.selections?.length || 0}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">AI Suggested</div>
                    <div className="font-semibold text-[#B8A8D8]">+{analysis.summary.totalSuggestedOrder}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Your Order</div>
                    <div className="font-semibold text-[#8FA894]">
                      +{analysis.summary.totalUserOrder ?? analysis.summary.totalSuggestedOrder}
                    </div>
                  </div>
                  <div className="flex items-end justify-end">
                    <Button variant="outline" size="sm" className="text-xs">
                      View Details →
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}



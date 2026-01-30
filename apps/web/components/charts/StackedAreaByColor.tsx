'use client';

import React from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { getColorForName } from '../../lib/chartColors';

type DataPoint = {
  date: string;
  total: number;
  byColor?: Record<string, number>;
  label?: string;
};

type Props = {
  data: DataPoint[];
  colors: string[];
  maxColors?: number;
  height?: number;
  /** Optional explicit overrides for series colors (keyed by series name). */
  colorOverrides?: Record<string, string>;
};

export function StackedAreaByColor({ data, colors, maxColors = 8, height = 300, colorOverrides }: Props) {
  const topColors = colors.slice(0, maxColors);
  const hasOther = colors.length > maxColors;
  const otherColors = hasOther ? colors.slice(maxColors) : [];

  const formatDate = (date: string) => {
    const d = new Date(date);
    return d.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit' });
  };
  const formatX = (point: DataPoint) => point.label ?? formatDate(point.date);

  const chartData = data.map(point => {
    const result: Record<string, any> = {
      date: formatX(point),
    };
    
    // Add top colors
    for (const color of topColors) {
      result[color] = point.byColor?.[color] || 0;
    }
    
    // Aggregate "Other"
    if (hasOther) {
      let otherTotal = 0;
      for (const color of otherColors) {
        otherTotal += point.byColor?.[color] || 0;
      }
      result['Other'] = otherTotal;
    }
    
    return result;
  });

  const displayColors = hasOther ? [...topColors, 'Other'] : topColors;
  const resolveColor = (seriesName: string, index: number) => {
    return colorOverrides?.[seriesName] ?? getColorForName(seriesName, index);
  };

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;
    
    const total = payload.reduce((sum: number, entry: any) => sum + (entry.value || 0), 0);
    
    return (
      <div className="bg-white p-3 rounded-lg shadow-lg border border-slate-200 text-sm max-w-xs">
        <p className="font-medium text-slate-900 mb-2">{label}</p>
        <p className="text-slate-600 mb-2">Total: {total.toLocaleString('da-DK')}</p>
        <div className="space-y-1">
          {payload.reverse().map((entry: any, index: number) => (
            <div key={index} className="flex justify-between gap-4">
              <span style={{ color: entry.color }}>{entry.name}</span>
              <span className="font-medium">{entry.value?.toLocaleString('da-DK')}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis 
          dataKey="date" 
          tick={{ fontSize: 11 }} 
          tickLine={false}
          axisLine={{ stroke: '#e2e8f0' }}
        />
        <YAxis 
          tick={{ fontSize: 11 }} 
          tickLine={false}
          axisLine={{ stroke: '#e2e8f0' }}
          tickFormatter={(value) => value.toLocaleString('da-DK')}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend />
        {displayColors.map((color, index) => (
          <Area
            key={color}
            type="monotone"
            dataKey={color}
            name={color}
            stackId="1"
            stroke={resolveColor(color, index)}
            fill={resolveColor(color, index)}
            fillOpacity={0.7}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

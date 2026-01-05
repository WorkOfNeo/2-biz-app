/**
 * AI Prompts Registry
 * 
 * Centralized prompt management with database fallback.
 * Prompts stored in DB take precedence; code defaults used as fallback.
 */

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';

export type PromptKey = 'purchase_suggestions_v1';

export type PromptConfig = {
  key: PromptKey;
  version: number;
  content: string;
  model: string;
  temperature: number;
  maxTokens: number;
};

// Default prompts (fallback if not in DB)
const DEFAULT_PROMPTS: Record<PromptKey, Omit<PromptConfig, 'key'>> = {
  purchase_suggestions_v1: {
    version: 0,
    content: `You are a purchasing advisor for a fashion wholesale company. Analyze the in-season sales data and produce structured purchase order suggestions grouped by supplier.

## Context
{{context}}

## Supplier Master Data
{{suppliers}}

## Sales Summary by Supplier
{{sales_by_supplier}}

## Season Styles with No Sales Yet
{{no_sales_styles}}

## Customer Coverage Analysis
{{customer_analysis}}

## Year-over-Year Comparison (vs Last Season)
{{yoy_analysis}}

## Previous Feedback (Learning from past runs)
{{feedback}}

## Instructions
Consider ALL available data when making recommendations:
- If aggregated index is below 100%, be more conservative with order quantities
- Factor in nulled customers (lost potential) when projecting total demand
- Consider remaining potential from customers not yet visited
- Flag styles with NO SALES YET - these may need attention (new styles, slow starters, or potential duds)
- For no-sales styles: recommend small initial orders or skip if season is too far along
1. For each supplier, recommend which styles/colors to order and in what quantities.
2. Consider MOQ (minimum order quantity) and lead times.
3. Factor in sales velocity, customer coverage, and year-over-year indices.
4. Output MUST be valid JSON matching the schema.

## Output Schema
\`\`\`json
{
  "suppliers": [
    {
      "supplier_name": "string",
      "supplier_id": "uuid",
      "recommendation_summary": "string (2-3 sentences)",
      "total_units": number,
      "total_value_estimate": number,
      "lines": [
        {
          "style_no": "string",
          "color": "string",
          "suggested_qty": number,
          "reasoning": "string (1 sentence)",
          "priority": "high" | "medium" | "low"
        }
      ],
      "moq_status": "met" | "under" | "n/a",
      "notes": "string (optional)"
    }
  ],
  "overall_summary": "string (3-4 sentences)",
  "total_units": number,
  "warnings": ["string"]
}
\`\`\``,
    model: 'gpt-4o-mini',
    temperature: 0.3,
    maxTokens: 4000,
  },
};

/**
 * Get active prompt config from DB, falling back to code defaults
 */
export async function getPromptConfig(key: PromptKey): Promise<PromptConfig> {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    
    const { data, error } = await supabase
      .from('ai_prompts')
      .select('*')
      .eq('key', key)
      .eq('active', true)
      .single();
    
    if (error || !data) {
      console.log(`[prompts] No active DB prompt for "${key}", using default`);
      const defaults = DEFAULT_PROMPTS[key];
      return {
        key,
        ...defaults,
      };
    }
    
    return {
      key,
      version: data.version,
      content: data.content,
      model: data.model || 'gpt-4o-mini',
      temperature: Number(data.temperature) || 0.3,
      maxTokens: data.max_tokens || 4000,
    };
  } catch (e) {
    console.error('[prompts] Error fetching prompt, using default:', e);
    const defaults = DEFAULT_PROMPTS[key];
    return {
      key,
      ...defaults,
    };
  }
}

/**
 * Interpolate template variables in prompt content
 */
export function interpolatePrompt(
  content: string,
  variables: Record<string, string>
): string {
  let result = content;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

/**
 * Get default prompt content for a key (used for seeding DB)
 */
export function getDefaultPromptContent(key: PromptKey): string {
  return DEFAULT_PROMPTS[key]?.content || '';
}


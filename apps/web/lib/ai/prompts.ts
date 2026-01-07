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
    version: 1,
    content: `You are a purchasing advisor for a fashion wholesale company. Analyze the in-season sales data and produce structured purchase order suggestions grouped by supplier.

## Context
{{context}}

## Purchase Level Info
{{purchase_level}}

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

## CRITICAL RULES FOR QUANTITY SUGGESTIONS

**IMPORTANT**: Each style has a "CURRENT_SOLD_QTY" field - this is how many have ALREADY been sold. Your suggested_qty should almost always be HIGHER than this!

### Rule 1: Project full season demand
- CURRENT_SOLD_QTY = orders received so far (partial season)
- Suggested_qty = what you think we need for the ENTIRE season
- If only 6% of customers have ordered, multiply sold qty by ~10-15x

### Rule 2: Use this formula
  visit_rate = (customers_who_ordered / total_potential_customers) * 100
  projection_multiplier = 100 / visit_rate
  suggested_qty = CURRENT_SOLD_QTY * projection_multiplier * confidence_factor

Example: 
- Style sold 900 pcs, visit_rate = 6%
- 900 × (100/6) = 15,000 projected
- With 0.8 confidence: suggest 12,000

### Rule 3: Purchase level adjustments
See {{purchase_level}} section for whether this is early/middle/closing round.

### Rule 4: NEVER suggest less than CURRENT_SOLD_QTY
Unless BOTH of these are true:
- Style is clearly underperforming vs last year (check yoy_analysis)
- Customer visit rate is already >80%

### Rule 5: Include ALL styles
Every style with sales should have a suggestion. Don't skip any.

## Instructions
- If aggregated YoY index is below 100%, factor this into projections
- Factor in nulled customers (lost potential) when projecting total demand
- Consider remaining potential from customers not yet visited
- Flag styles with NO SALES YET - recommend small initial orders or skip
- Output MUST be valid JSON matching the schema

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
          "current_sold": number,
          "suggested_qty": number,
          "projection_basis": "string (e.g., 'visit rate extrapolation', 'YoY trend')",
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
    maxTokens: 16000,  // Increased to handle more styles
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


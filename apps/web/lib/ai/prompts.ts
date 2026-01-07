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

**IMPORTANT**: Each style has "CURRENT_SOLD_QTY" (already sold) and "SALES_REPS" (which reps sold it).

### Rule 1: Salesperson Coverage = Confidence
- If ALL salespersons are selling this style → HIGH confidence → can buy more
- If only 1-2 salespersons selling it → LOWER confidence → be conservative
- Check "sales_reps_count" vs "total_active_reps" in the data

### Rule 2: Season Timing (Purchase Round)
See {{purchase_level}} section. This is CRITICAL:

**EARLY SEASON (Run 1-2)**:
- Sold 400 → suggest 500-600 (buffer for growth, room to reorder)
- Be optimistic, better to have stock than miss sales

**MID SEASON (Run 3-4)**:
- Sold 600, already purchased 400 → suggest ~200-300 more
- Factor in what's already on order (PREVIOUS_PURCHASES field if available)
- Only add if style is performing well across multiple reps

**CLOSING (Run 5+, final 10-20% of season)**:
- Sold 900, already purchased 600 → suggest just to cover, or UNDER
- NEVER gamble on late-season purchases
- Only reorder proven bestsellers, and conservatively
- Example: Sold 900, purchased 600 → suggest 250-300 (not 1500!)

### Rule 3: Customer Potential per Rep
- Check how many customers each rep has LEFT to visit
- If a rep has sold 50 pcs and has 80% customers remaining → room to grow
- If a rep has sold 50 pcs but visited 90% of customers → style may be maxed out

### Rule 4: When to Suggest LESS than Sold
Suggest less than CURRENT_SOLD_QTY when:
- It's a CLOSING purchase round ({{purchase_level}})
- Style is only selling with 1-2 reps (not broad appeal)
- YoY comparison shows this style declining
- Customer visit rate is >80% (limited upside)

### Rule 5: YOU MUST INCLUDE EVERY SINGLE STYLE
**CRITICAL: Return a suggestion for EVERY style/color in the input data.**
- Do NOT skip any styles
- Do NOT summarize or abbreviate
- If there are 103 styles in input, return 103 lines in output
- Every single style with CURRENT_SOLD_QTY > 0 MUST appear in your output
- This is MANDATORY - incomplete responses will be rejected

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
    model: 'gpt-4o',  // Using gpt-4o for better instruction following
    temperature: 0.3,
    maxTokens: 32000,  // Increased to handle 100+ styles with size breakdowns
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


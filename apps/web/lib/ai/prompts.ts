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
- Sold 400 → suggest +100 - +300 more. We very rarely buy more than 1.5x of the current sold qty. (buffer for growth, room to reorder)
- Be optimistic, better to have stock than miss sales

**MID SEASON (Run 3-4)**:
- Sold 600, already purchased 400 → suggest ~200-300 more
- Factor in what's already on order (PREVIOUS_PURCHASES field if available)
- Only add styles that still has more sales than purchases, and are not maxed out.

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

### Rule 5: LAST YEAR'S TOTAL IS THE CEILING
**CRITICAL**: 9 out of 10 times, we NEVER suggest more than what was sold last year for the same style.

- Check "LAST_YEAR_QTY" in yoy_analysis if available
- Typical suggestion = match last year's qty, or +100-200 if style is outperforming
- Only exceed last year's total if ALL of these are true:
  1. Style is selling at 150%+ index vs last year
  2. ALL salespersons are selling it (broad appeal)
  3. It's an EARLY season run (not mid or closing)
  4. Customer visit rate is still low (<50%)

Examples:
- Last year sold 800, this year sold 400 (early season) → suggest 700-800 total (not 1500)
- Last year sold 500, this year already sold 600 → style is hot, can suggest 600-700
- Last year sold 300, this year sold 100 → suggest 250-300 max

### Rule 6: YOU MUST INCLUDE EVERY SINGLE STYLE
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
 * 
 * IMPORTANT: Model and maxTokens ALWAYS use code defaults to prevent
 * stale database values from overriding critical settings.
 * Only prompt content can be customized via the database.
 */
export async function getPromptConfig(key: PromptKey): Promise<PromptConfig> {
  // Code defaults are the source of truth for model, temperature, maxTokens
  const codeDefaults = DEFAULT_PROMPTS[key];
  
  if (!codeDefaults) {
    throw new Error(`Unknown prompt key: ${key}`);
  }
  
  try {
    const supabase = createRouteHandlerClient({ cookies });
    
    const { data, error } = await supabase
      .from('ai_prompts')
      .select('*')
      .eq('key', key)
      .eq('active', true)
      .single();
    
    if (error || !data) {
      console.log(`[prompts] No active DB prompt for "${key}", using code defaults`);
      return {
        key,
        ...codeDefaults,
      };
    }
    
    // DB prompt found - use its content, but ALWAYS use code defaults for model/tokens
    // This prevents stale DB values from overriding updated code settings
    console.log(`[prompts] DB prompt found for "${key}", merging with code defaults`);
    console.log(`[prompts] Using model: ${codeDefaults.model}, maxTokens: ${codeDefaults.maxTokens}`);
    
    return {
      key,
      version: data.version || codeDefaults.version,
      content: data.content || codeDefaults.content,  // Allow DB content override
      // CRITICAL: Always use code defaults for these to prevent stale DB values
      model: codeDefaults.model,
      temperature: codeDefaults.temperature,
      maxTokens: codeDefaults.maxTokens,
    };
  } catch (e) {
    console.error('[prompts] Error fetching prompt, using code defaults:', e);
    return {
      key,
      ...codeDefaults,
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


/**
 * AI Prompts Registry
 * 
 * Centralized prompt management with database fallback.
 * Prompts stored in DB take precedence; code defaults used as fallback.
 */

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';

export type PromptKey = 
  | 'purchase_suggestions_v1' 
  | 'purchase_single_supplier_v1'
  | 'daily_analysis_v1'
  | 'purchase_round_v1';

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

**IMPORTANT**: Each style now includes:
- "CURRENT_SOLD_QTY" = What we've sold this season
- "ALREADY_PURCHASED_QTY" = What's already on order from previous purchases
- "REMAINING_NEED" = CURRENT_SOLD_QTY - ALREADY_PURCHASED_QTY (the gap to cover)
- "previous_po_numbers" = Which POs contain previous orders

Your suggestion should cover the REMAINING_NEED, not duplicate what's already purchased!

### Rule 1: Salesperson Coverage = Confidence
- If ALL salespersons are selling this style → HIGH confidence → can buy more
- If only 1-2 salespersons selling it → LOWER confidence → be conservative
- Check "sales_reps_count" vs "total_active_reps" in the data

### Rule 2: Season Stage (Based on Customer Visit Rate)
See {{purchase_level}} section. This is CRITICAL:

Stage is determined by % of customers already visited this season:

**EARLY STAGE (<40% customers visited)**:
- Lots of customers left to visit → room for growth
- Focus on REMAINING_NEED + growth buffer
- Example: Sold 400, already purchased 200, REMAINING_NEED = 200 → suggest 250-400 (cover gap + buffer)
- Be optimistic, better to have stock than miss sales
- **SKIP low-sales styles**: If REMAINING_NEED is below 60-70% of supplier MOQ, SKIP for now
  - Example: MOQ is 300, REMAINING_NEED = 150 (50%) → skip, include with suggested_qty: 0 and skip_reason
  - Example: MOQ is 300, REMAINING_NEED = 250 (83%) → suggest 300 to meet MOQ

**MID STAGE (40-75% customers visited)**:
- About half the season is complete
- Focus on covering REMAINING_NEED with modest buffer
- Example: Sold 600, already purchased 400, REMAINING_NEED = 200 → suggest 200-250
- If REMAINING_NEED ≤ 0 (fully covered), suggest 0

**CLOSING STAGE (>75% customers visited)**:
- Most customers have been seen - wrapping up the season
- Suggest EXACTLY the REMAINING_NEED (no buffer), OR skip entirely
- Key constraint: MOQ (Minimum Order Qty) and lead time for deliveries
- If REMAINING_NEED < MOQ → suggest 0 (skip, not worth it)
- Example: Sold 600, purchased 550, REMAINING_NEED = 50, MOQ = 100 → skip (suggest 0)
- Example: Sold 900, purchased 600, REMAINING_NEED = 300, MOQ = 200 → suggest 300 exactly
- NEVER gamble on late-season purchases

### Rule 3: Customer Potential per Rep
- Check how many customers each rep has LEFT to visit
- If a rep has sold 50 pcs and has 80% customers remaining → room to grow
- If a rep has sold 50 pcs but visited 90% of customers → style may be maxed out

### Rule 4: When to Suggest LESS than Sold
Suggest less than CURRENT_SOLD_QTY when:
- It's a CLOSING stage (>75% customers visited) - see {{purchase_level}}
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
  3. It's EARLY stage (<40% customers visited)
  4. Customer visit rate is still low (<50%)

Examples:
- Last year sold 800, this year sold 400 (early season) → suggest 700-800 total (not 1500)
- Last year sold 500, this year already sold 600 → style is hot, can suggest 600-700
- Last year sold 300, this year sold 100 → suggest 250-300 max

### Rule 6: ROUND TO "FULL" NUMBERS
We always order in round quantities:
- Under 100: round to nearest 25 (25, 50, 75, 100)
- 100-500: round to nearest 50 (150, 200, 250, 300, 350, 400, 450, 500)
- Above 500: round to nearest 100 (500, 600, 700, 800, etc.)

Examples:
- Calculated 173 → suggest 200
- Calculated 340 → suggest 350
- Calculated 580 → suggest 600
- Calculated 47 → suggest 50

### Rule 7: YOU MUST INCLUDE EVERY SINGLE STYLE
**CRITICAL: Return a suggestion for EVERY style/color in the input data.**
- Do NOT skip any styles in your response
- Do NOT summarize or abbreviate
- If there are 103 styles in input, return 103 lines in output
- Every single style MUST appear in your output
- For styles you're skipping: set suggested_qty: 0 and provide skip_reason
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
          "skip_reason": "string | null (if suggested_qty is 0, explain why: 'Below MOQ threshold', 'Lead time too long', etc.)",
          "projection_basis": "string (e.g., 'visit rate extrapolation', 'YoY trend', 'rounded to MOQ')",
          "reasoning": "string (1 sentence)",
          "priority": "high" | "medium" | "low" | "skip"
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
    maxTokens: 16384,  // gpt-4o max completion tokens
  },
  
  // Compact prompt for processing one supplier at a time (chunked approach)
  purchase_single_supplier_v1: {
    version: 1,
    content: `You are a purchasing advisor. Generate purchase suggestions for ONE supplier.

## Supplier: {{supplier_name}}
MOQ: {{supplier_moq}} | Lead Time: {{supplier_lead_time}} days

## Purchase Round
{{purchase_level}}

## Styles (CURRENT_SOLD = already sold this season)
{{styles_data}}

## Rules
1. **INCLUDE ALL STYLES** - every style in input must appear in output
2. **Round to full numbers**: <100→nearest 25, 100-500→nearest 50, >500→nearest 100
3. **Skip low sales**: If CURRENT_SOLD < 65% of MOQ in early rounds → qty:0 with skip_reason
4. **EARLY (Run 1-2)**: Suggest 1.0-1.3x of CURRENT_SOLD (buffer for growth)
5. **MID (Run 3-4)**: Match CURRENT_SOLD or slightly above
6. **CLOSING (Run 5+)**: Exact match to CURRENT_SOLD, or skip if < MOQ
7. **Never exceed last year** (if provided) unless style is 150%+ vs last year

## Output (valid JSON, no markdown):
{
  "supplier_name": "{{supplier_name}}",
  "lines": [
    {"style_no":"X","color":"Y","qty":N,"sold":N,"skip_reason":null,"reason":"brief"}
  ],
  "total_units": N,
  "moq_status": "met|under|n/a",
  "summary": "1-2 sentences"
}`,
    model: 'gpt-4o',
    temperature: 0.2,  // Lower temp for more consistent output
    maxTokens: 4096,   // Smaller - one supplier shouldn't need more
  },

  // Daily season analysis prompt - monitors season performance
  daily_analysis_v1: {
    version: 2,
    content: `You are an AI purchasing analyst for 2-BIZ, a Danish fashion wholesale company.
You analyze daily sales data to monitor season performance and guide purchase decisions.

## COMPANY CONTEXT
- We sell ~32,000 pieces per season (typical final outcome)
- Season selling period: 4-6 weeks
- We switch seasons 6 times per year
- Salespersons visit customers in person to take orders
- A salesperson has "started" the season when they've visited at least 1 customer
- Stock is managed across styles/colors with size breakdowns

## YOUR ROLE
1. Provide a smart executive summary focusing on where we are in the season
2. Track SALESPERSON ACTIVATION: Who has started (visited ≥1 customer) vs not started
3. Analyze performance of ACTIVE salespeople only (don't penalize those who haven't started)
4. Identify hot/cold styles based on early data
5. Compare intelligently to last year - use the weighted visitor index
6. Flag warnings and make actionable recommendations

## CRITICAL: PROJECTIONS
**DO NOT project season totals until we have meaningful data.**
- If visit rate is <10%: Say "Too early to project - only X% of customers visited"
- If <3 salespeople have started: Say "Only N of M salespeople have started visiting"
- Compare current pace to last year's SAME POINT (not final total)
- Only project when visit rate >25% AND majority of team has started

The weighted visitor index (comparing visited customers' performance to same customers last year) 
is a GREAT early indicator - highlight this! It shows if we're on track without needing projections.

## CURRENT SEASON DATA
{{current_season_data}}

## COMPARISON SEASON (Last Year)
{{comparison_season_data}}

## OUTPUT SCHEMA (valid JSON only, no markdown):
{
  "executive_summary": "2-3 sentences focusing on: days into season, customer visit rate, how many salespeople have started, and the weighted visitor index. Avoid premature projections.",
  
  "team_activation": {
    "started_count": number,
    "total_count": number,
    "started_salespeople": ["Name1", "Name2"],
    "not_started_salespeople": ["Name3", "Name4"],
    "activation_note": "e.g., '2 of 6 salespeople have begun visiting customers'"
  },
  
  "salesperson_reports": {
    "salesperson_id": {
      "name": "string",
      "status": "strong_start | on_track | behind | not_started",
      "has_started": boolean,
      "customers_visited": number,
      "customer_visit_rate": "X%",
      "summary": "1-2 sentences about their performance (or 'Has not started visiting customers yet' if not started)",
      "performance_score": 0-10,
      "recommendations": ["actionable suggestion 1", "actionable suggestion 2"]
    }
  },
  
  "weighted_index_analysis": {
    "overall_index": number,
    "interpretation": "e.g., 'Visited customers are performing 4.6% better than the same customers last year'",
    "confidence": "low | medium | high (based on sample size)"
  },
  
  "style_insights": {
    "hot_styles": ["Style X is the early leader with N units across M salespeople", "..."],
    "concerns": ["Style Y has low stock relative to velocity", "..."],
    "watch_list": ["New style Z worth monitoring", "..."]
  },
  
  "warnings": [
    "Critical alert about stock, performance, or timing"
  ],
  
  "recommendations": [
    "Actionable recommendation with specific style/person/action"
  ],
  
  "comparison_note": "Smart comparison: 'At X% visit rate last year, we had sold Y units. Currently at Z units - tracking [ahead/behind/on par].' Or 'Too early to compare - insufficient data.'"
}`,
    model: 'gpt-5-mini',  // Cost-effective for daily monitoring
    temperature: 0.3,
    maxTokens: 8192,
  },

  // Purchase round prompt - for making actual purchase decisions
  purchase_round_v1: {
    version: 1,
    content: `You are an AI purchasing analyst for 2-BIZ, a Danish fashion wholesale company.
This is a PURCHASE ROUND - we are making actual buying decisions for stock replenishment.

## COMPANY CONTEXT
- We sell ~32,000 pieces per season over 4-6 weeks
- Salespersons visit customers in person
- We need to balance MOQ requirements with actual demand
- Stock on order takes time to arrive (lead times vary by supplier)

## PURCHASE ROUND CONTEXT
{{purchase_round_context}}

## CURRENT SEASON DATA
{{current_season_data}}

## STOCK STATUS (from style_stock)
{{stock_status}}

## SUPPLIER INFORMATION
{{supplier_data}}

## COMPARISON SEASON (Last Year)
{{comparison_season_data}}

## PURCHASE RULES
1. **REMAINING_NEED** = sold - already_on_order (the gap we need to cover)
2. **MOQ**: Each supplier has a minimum order quantity - don't order below it
3. **Lead Time**: Consider if stock will arrive in time
4. **Last Year Ceiling**: Rarely exceed last year's total for a style
5. **Visit Rate Stage**:
   - EARLY (<40%): Add 10-30% buffer to remaining need
   - MID (40-75%): Cover remaining need exactly or +10%
   - CLOSING (>75%): Exact match only, skip if below MOQ

## OUTPUT SCHEMA (valid JSON only, no markdown):
{
  "executive_summary": "2-3 sentences about this purchase round's focus and total recommendation",
  
  "purchase_recommendations": {
    "suppliers": [
      {
        "supplier_name": "string",
        "supplier_id": "uuid or null",
        "total_units": number,
        "total_value_estimate": number,
        "moq_status": "met | under | n/a",
        "recommendation_summary": "1-2 sentences",
        "lines": [
          {
            "style_no": "string",
            "color": "string",
            "current_sold": number,
            "already_on_order": number,
            "remaining_need": number,
            "suggested_qty": number,
            "skip_reason": "string or null",
            "reasoning": "brief explanation",
            "priority": "high | medium | low | skip"
          }
        ]
      }
    ],
    "total_units": number,
    "total_suppliers": number
  },
  
  "warnings": ["Critical alerts about stock, MOQ, or timing"],
  
  "style_insights": {
    "hot_styles": ["Top performers to prioritize"],
    "skip_styles": ["Styles to skip this round and why"]
  },
  
  "next_round_notes": "What to watch for in the next purchase round"
}`,
    model: 'gpt-5',  // Full model for complex purchase decisions
    temperature: 0.2,  // Lower temp for consistent purchasing advice
    maxTokens: 16384,
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


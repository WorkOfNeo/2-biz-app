/**
 * Rules Engine for Supplier and Purchasing Rules
 * 
 * This module provides an extensible rules evaluation system that processes
 * supplier_rules from the database and applies them to purchasing decisions.
 * 
 * Rule Types:
 * - moq_check: Minimum Order Quantity validation
 * - lead_time_buffer: Add buffer days to lead time calculations
 * - travel_time_buffer: Add buffer days to travel time calculations
 * - pull_first: Prioritize pulling from specific supplier (e.g., BELL_RAIN)
 * - seasonality_uplift: Increase order by percentage during seasonal peaks
 * - country_priority: Prioritize certain countries for allocation
 * 
 * Usage:
 * ```typescript
 * import { evaluateRules, applyOrderRules } from '@/lib/rulesEngine';
 * 
 * const result = evaluateRules(rules, {
 *   suggestedOrder: 100,
 *   supplier: { name: 'BELL_RAIN', moq: 50, lead_time_days: 14 },
 *   context: { isNOOS: true, season: 'spring' }
 * });
 * ```
 */

export type SupplierRule = {
  id: string;
  supplier_id: string | null;
  rule_name: string;
  rule_type: string;
  params: Record<string, any>;
  priority: number;
  active: boolean;
};

export type Supplier = {
  id: string;
  name: string;
  external_name?: string;
  spy_id?: string;
  lead_time_days: number;
  travel_time_days: number;
  moq: number;
  tags: string[];
  active: boolean;
};

export type RuleContext = {
  suggestedOrder: number;
  supplier?: Supplier;
  availablePullStock?: number; // Stock available from BELL_RAIN or similar
  isNOOS?: boolean;
  season?: string;
  country?: string;
  dateNeeded?: Date;
  [key: string]: any;
};

export type RuleResult = {
  ruleName: string;
  ruleType: string;
  applied: boolean;
  adjustment: number;
  message: string;
  details?: Record<string, any>;
};

export type EvaluationResult = {
  originalOrder: number;
  adjustedOrder: number;
  pullFromStock: number;
  buyNew: number;
  totalAdjustment: number;
  appliedRules: RuleResult[];
  warnings: string[];
  recommendations: string[];
};

/**
 * Individual rule evaluators
 */
const ruleEvaluators: Record<string, (rule: SupplierRule, context: RuleContext) => RuleResult> = {
  /**
   * MOQ Check - Ensure order meets minimum order quantity
   */
  moq_check: (rule, context) => {
    const moq = rule.params.moq ?? context.supplier?.moq ?? 0;
    const currentOrder = context.suggestedOrder;
    
    if (moq > 0 && currentOrder > 0 && currentOrder < moq) {
      return {
        ruleName: rule.rule_name,
        ruleType: rule.rule_type,
        applied: true,
        adjustment: moq - currentOrder,
        message: `Order increased from ${currentOrder} to ${moq} to meet MOQ`,
        details: { moq, originalOrder: currentOrder }
      };
    }
    
    return {
      ruleName: rule.rule_name,
      ruleType: rule.rule_type,
      applied: false,
      adjustment: 0,
      message: 'MOQ requirement already met'
    };
  },

  /**
   * Lead Time Buffer - Add buffer days for safety
   */
  lead_time_buffer: (rule, context) => {
    const bufferDays = rule.params.buffer_days ?? 0;
    const leadTime = context.supplier?.lead_time_days ?? 0;
    
    return {
      ruleName: rule.rule_name,
      ruleType: rule.rule_type,
      applied: bufferDays > 0,
      adjustment: 0, // This affects timing, not quantity
      message: `Lead time adjusted: ${leadTime} + ${bufferDays} buffer = ${leadTime + bufferDays} days`,
      details: { originalLeadTime: leadTime, buffer: bufferDays, totalLeadTime: leadTime + bufferDays }
    };
  },

  /**
   * Pull First - Prioritize pulling from secondary storage (e.g., BELL_RAIN)
   */
  pull_first: (rule, context) => {
    const pullTag = rule.params.tag ?? 'BELL_RAIN';
    const supplierHasTag = context.supplier?.tags?.includes(pullTag) ?? false;
    const availablePull = context.availablePullStock ?? 0;
    
    if (!supplierHasTag || availablePull <= 0) {
      return {
        ruleName: rule.rule_name,
        ruleType: rule.rule_type,
        applied: false,
        adjustment: 0,
        message: `No ${pullTag} stock available to pull`
      };
    }
    
    const pullAmount = Math.min(availablePull, context.suggestedOrder);
    const buyAmount = Math.max(0, context.suggestedOrder - pullAmount);
    
    return {
      ruleName: rule.rule_name,
      ruleType: rule.rule_type,
      applied: true,
      adjustment: -pullAmount, // Negative because we're reducing the buy order
      message: `Pull ${pullAmount} from ${pullTag} stock, buy ${buyAmount} new`,
      details: { pullAmount, buyAmount, availableStock: availablePull }
    };
  },

  /**
   * Seasonality Uplift - Increase order during peak seasons
   */
  seasonality_uplift: (rule, context) => {
    const seasons = rule.params.seasons as string[] ?? [];
    const upliftPercent = rule.params.uplift_percent ?? 0;
    
    if (!context.season || !seasons.includes(context.season) || upliftPercent <= 0) {
      return {
        ruleName: rule.rule_name,
        ruleType: rule.rule_type,
        applied: false,
        adjustment: 0,
        message: 'Seasonality uplift not applicable'
      };
    }
    
    const uplift = Math.ceil(context.suggestedOrder * (upliftPercent / 100));
    
    return {
      ruleName: rule.rule_name,
      ruleType: rule.rule_type,
      applied: true,
      adjustment: uplift,
      message: `${upliftPercent}% seasonal uplift applied for ${context.season}`,
      details: { season: context.season, upliftPercent, upliftAmount: uplift }
    };
  },

  /**
   * Country Priority - Adjust allocation based on country performance
   */
  country_priority: (rule, context) => {
    const priorityCountries = rule.params.priority_countries as string[] ?? [];
    const priorityMultiplier = rule.params.multiplier ?? 1;
    
    if (!context.country || !priorityCountries.includes(context.country)) {
      return {
        ruleName: rule.rule_name,
        ruleType: rule.rule_type,
        applied: false,
        adjustment: 0,
        message: 'Country priority not applicable'
      };
    }
    
    const adjustment = Math.ceil(context.suggestedOrder * (priorityMultiplier - 1));
    
    return {
      ruleName: rule.rule_name,
      ruleType: rule.rule_type,
      applied: true,
      adjustment,
      message: `${priorityMultiplier}x priority applied for ${context.country}`,
      details: { country: context.country, multiplier: priorityMultiplier }
    };
  },

  /**
   * NOOS Only - Only apply to NOOS items
   */
  noos_only: (rule, context) => {
    return {
      ruleName: rule.rule_name,
      ruleType: rule.rule_type,
      applied: context.isNOOS === true,
      adjustment: 0,
      message: context.isNOOS ? 'NOOS item - rules applied' : 'Not a NOOS item - skipping rules'
    };
  }
};

/**
 * Evaluate all applicable rules for a given context
 */
export function evaluateRules(rules: SupplierRule[], context: RuleContext): EvaluationResult {
  const result: EvaluationResult = {
    originalOrder: context.suggestedOrder,
    adjustedOrder: context.suggestedOrder,
    pullFromStock: 0,
    buyNew: context.suggestedOrder,
    totalAdjustment: 0,
    appliedRules: [],
    warnings: [],
    recommendations: []
  };

  // Sort rules by priority (higher first)
  const sortedRules = [...rules]
    .filter(r => r.active)
    .sort((a, b) => b.priority - a.priority);

  // Evaluate each rule
  for (const rule of sortedRules) {
    const evaluator = ruleEvaluators[rule.rule_type];
    
    if (!evaluator) {
      result.warnings.push(`Unknown rule type: ${rule.rule_type}`);
      continue;
    }

    const ruleResult = evaluator(rule, context);
    result.appliedRules.push(ruleResult);

    if (ruleResult.applied) {
      // Handle pull_first specially
      if (rule.rule_type === 'pull_first' && ruleResult.details) {
        result.pullFromStock = ruleResult.details.pullAmount ?? 0;
        result.buyNew = ruleResult.details.buyAmount ?? context.suggestedOrder;
      } else {
        result.adjustedOrder += ruleResult.adjustment;
        result.totalAdjustment += ruleResult.adjustment;
      }
    }
  }

  // Ensure order doesn't go negative
  result.adjustedOrder = Math.max(0, result.adjustedOrder);
  result.buyNew = Math.max(0, result.buyNew);

  // Add recommendations
  if (result.pullFromStock > 0) {
    result.recommendations.push(`Pull ${result.pullFromStock} units from secondary storage first`);
  }
  
  if (result.buyNew > 0 && context.supplier?.moq && result.buyNew < context.supplier.moq) {
    result.recommendations.push(`Consider ordering ${context.supplier.moq} to meet MOQ`);
  }

  if (result.totalAdjustment > 0) {
    result.recommendations.push(`Total adjustment: +${result.totalAdjustment} units from rules`);
  }

  return result;
}

/**
 * Helper to apply rules to an order and get the final quantities
 */
export function applyOrderRules(
  suggestedOrder: number,
  rules: SupplierRule[],
  supplier?: Supplier,
  options?: {
    availablePullStock?: number;
    isNOOS?: boolean;
    season?: string;
    country?: string;
  }
): { order: number; pull: number; buy: number; summary: string } {
  const context: RuleContext = {
    suggestedOrder,
    supplier,
    ...options
  };

  const result = evaluateRules(rules, context);

  return {
    order: result.adjustedOrder,
    pull: result.pullFromStock,
    buy: result.buyNew,
    summary: result.recommendations.join('. ') || 'No adjustments applied'
  };
}

/**
 * Check if a supplier has a specific tag
 */
export function hasSupplierTag(supplier: Supplier | undefined, tag: string): boolean {
  return supplier?.tags?.includes(tag) ?? false;
}

/**
 * Calculate effective lead time with buffers
 */
export function calculateEffectiveLeadTime(
  supplier: Supplier | undefined,
  rules: SupplierRule[]
): number {
  const baseLeadTime = supplier?.lead_time_days ?? 0;
  const baseTravelTime = supplier?.travel_time_days ?? 0;
  
  let buffer = 0;
  for (const rule of rules.filter(r => r.active)) {
    if (rule.rule_type === 'lead_time_buffer') {
      buffer += rule.params.buffer_days ?? 0;
    }
  }

  return baseLeadTime + baseTravelTime + buffer;
}







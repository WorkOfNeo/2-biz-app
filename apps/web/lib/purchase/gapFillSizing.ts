/**
 * Gap-fill sizing algorithm for smart draft orders.
 * 
 * Given:
 * - weights: raw weights per size (e.g., [1, 2, 2, 1])
 * - base: current available per size (stock - sold + purchase/incoming)
 * - targetBuy: total units to purchase (e.g., 400)
 * 
 * Returns:
 * - buyBySize: integer array that sums to targetBuy
 * - normalizedWeights: the weights converted to percentages
 * 
 * The algorithm allocates purchases so that the FINAL state 
 * (base + buyBySize) matches the target distribution as closely as possible.
 */

export type GapFillInput = {
  weights: number[];
  base: number[];
  targetBuy: number;
};

export type GapFillResult = {
  buyBySize: number[];
  normalizedWeights: number[];
  finalDistribution: number[];
  finalTotal: number;
};

/**
 * Parse a weights string into an array of numbers.
 * Accepts comma, space, tab, semicolon, or newline as delimiters.
 */
export function parseWeights(input: string): number[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  
  // Split by common delimiters
  const parts = trimmed.split(/[\s,;\t\n]+/).filter(Boolean);
  
  const weights: number[] = [];
  for (const part of parts) {
    const num = parseFloat(part);
    if (!isNaN(num) && num >= 0) {
      weights.push(num);
    }
  }
  
  return weights;
}

/**
 * Normalize weights to percentages (fractions summing to 1).
 */
export function normalizeWeights(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    // Fallback to even distribution
    const len = weights.length;
    return len > 0 ? weights.map(() => 1 / len) : [];
  }
  return weights.map(w => w / sum);
}

/**
 * Gap-fill sizing: allocate targetBuy units across sizes so that
 * (base + buy) matches the normalized weight distribution as closely as possible.
 * 
 * Algorithm:
 * 1. Compute target final total = sum(base) + targetBuy
 * 2. Compute desired final per size = targetFinalTotal * p[i]
 * 3. Compute ideal buy[i] = desired[i] - base[i]
 * 4. Clamp negative buys to 0 (can't return stock)
 * 5. Adjust to ensure sum(buy) = targetBuy using greedy remainder distribution
 */
export function gapFillSizing(input: GapFillInput): GapFillResult {
  const { weights, base, targetBuy } = input;
  
  const n = weights.length;
  
  // Validate inputs
  if (n === 0 || base.length !== n) {
    return {
      buyBySize: [],
      normalizedWeights: [],
      finalDistribution: [],
      finalTotal: 0,
    };
  }
  
  if (targetBuy <= 0) {
    return {
      buyBySize: Array(n).fill(0),
      normalizedWeights: normalizeWeights(weights),
      finalDistribution: [...base],
      finalTotal: base.reduce((a, b) => a + b, 0),
    };
  }
  
  const normalizedP = normalizeWeights(weights);
  const baseTotal = base.reduce((a, b) => a + b, 0);
  const targetFinalTotal = baseTotal + targetBuy;
  
  // Compute desired final per size
  const desiredFinal = normalizedP.map(p => p * targetFinalTotal);
  
  // Compute ideal buy (can be negative if over-stocked)
  const idealBuy = desiredFinal.map((d, i) => d - (base[i] || 0));
  
  // Clamp negatives to 0 and floor positives
  const clampedBuy = idealBuy.map(b => Math.max(0, Math.floor(b)));
  
  // Calculate current sum and remainder
  let currentSum = clampedBuy.reduce((a, b) => a + b, 0);
  let remainder = targetBuy - currentSum;
  
  // If we're under, add remainder to sizes with biggest fractional parts
  // from the ideal calculation (prioritizing under-stocked sizes)
  if (remainder > 0) {
    // Calculate fractional parts and deficit scores
    const scores = idealBuy.map((ideal, i) => {
      const floored = Math.max(0, Math.floor(ideal));
      const frac = ideal - floored;
      // Bonus for sizes that are under-stocked (negative base relative to desired)
      const deficitBonus = Math.max(0, (desiredFinal[i] || 0) - (base[i] || 0)) / Math.max(1, targetFinalTotal);
      return { i, score: frac + deficitBonus };
    });
    
    scores.sort((a, b) => b.score - a.score);
    
    for (let k = 0; k < remainder && k < scores.length; k++) {
      const item = scores[k];
      if (item !== undefined) {
        clampedBuy[item.i] = (clampedBuy[item.i] || 0) + 1;
      }
    }
  }
  
  // If we're over (due to clamping), reduce from sizes with smallest deficit
  currentSum = clampedBuy.reduce((a, b) => a + b, 0);
  remainder = currentSum - targetBuy;
  
  if (remainder > 0) {
    // Find sizes where we can reduce
    const reducible = clampedBuy
      .map((buy, i) => ({ i, buy, surplus: ((base[i] || 0) + buy) - (desiredFinal[i] || 0) }))
      .filter(x => x.buy > 0)
      .sort((a, b) => b.surplus - a.surplus);
    
    for (const item of reducible) {
      if (remainder <= 0) break;
      const canReduce = Math.min(item.buy, remainder);
      const currentVal = clampedBuy[item.i] || 0;
      clampedBuy[item.i] = currentVal - canReduce;
      remainder -= canReduce;
    }
  }
  
  // Final distribution
  const finalDistribution = base.map((b, i) => b + (clampedBuy[i] || 0));
  const finalTotal = finalDistribution.reduce((a, b) => a + b, 0);
  
  return {
    buyBySize: clampedBuy,
    normalizedWeights: normalizedP,
    finalDistribution,
    finalTotal,
  };
}

/**
 * Calculate what the "ideal" distribution would look like if we just
 * applied weights directly to the buy quantity (simple split).
 * This is for comparison/display purposes.
 */
export function simpleSplitBuy(weights: number[], targetBuy: number): number[] {
  const n = weights.length;
  if (n === 0 || targetBuy <= 0) return Array(n).fill(0);
  
  const normalizedP = normalizeWeights(weights);
  
  // Floor each allocation
  const floored = normalizedP.map(p => Math.floor(p * targetBuy));
  let currentSum = floored.reduce((a, b) => a + b, 0);
  let remainder = targetBuy - currentSum;
  
  // Distribute remainder by fractional parts
  const fractional = normalizedP
    .map((p, i) => ({ i, frac: (p * targetBuy) - Math.floor(p * targetBuy) }))
    .sort((a, b) => b.frac - a.frac);
  
  for (let k = 0; k < remainder && k < fractional.length; k++) {
    const item = fractional[k];
    if (item !== undefined) {
      floored[item.i] += 1;
    }
  }
  
  return floored;
}


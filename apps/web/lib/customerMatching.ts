/**
 * Local fuzzy customer matching logic.
 * No OpenAI — purely algorithmic matching using string normalization and similarity scoring.
 */

export type Customer = {
  customer_id: string;
  company: string | null;
  city: string | null;
};

export type MatchCandidate = {
  customerId: string;
  company: string;
  city: string;
  score: number;
  reason: string;
};

export type MatchResult = {
  rowIndex: number;
  originalName: string;
  originalCity: string;
  qty: number;
  price: number;
  bestMatch: MatchCandidate | null;
  confidence: number;
  topCandidates: MatchCandidate[];
  status: 'matched' | 'review' | 'unmatched';
};

// Common company suffixes to strip for matching
const COMPANY_SUFFIXES = [
  'aps', 'a/s', 'as', 'ab', 'oy', 'oyj', 'gmbh', 'ltd', 'llc', 'inc', 'co', 'corp',
  'plc', 'sa', 'srl', 'bv', 'nv', 'ag', 'kg', 'ug', 'se', 'i/s', 'k/s', 'p/s',
  'amba', 'fmba', 'smba', 'ivs', 'holding', 'group', 'international', 'intl'
];

// Scandinavian character normalization map
const SCANDINAVIAN_MAP: Record<string, string> = {
  'æ': 'ae', 'ø': 'oe', 'å': 'aa', 'ä': 'ae', 'ö': 'oe', 'ü': 'ue',
  'ß': 'ss', 'ð': 'd', 'þ': 'th', 'œ': 'oe', 'ÿ': 'y'
};

/**
 * Normalize a string for matching:
 * - Lowercase
 * - Normalize Scandinavian characters
 * - Remove punctuation
 * - Collapse whitespace
 * - Strip common company suffixes
 */
export function normalize(str: string): string {
  if (!str) return '';
  
  let s = str.toLowerCase().trim();
  
  // Normalize Scandinavian characters
  for (const [char, replacement] of Object.entries(SCANDINAVIAN_MAP)) {
    s = s.replace(new RegExp(char, 'g'), replacement);
  }
  
  // Remove punctuation except spaces
  s = s.replace(/[^\w\s]/g, ' ');
  
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  
  // Strip common suffixes
  const tokens = s.split(' ');
  const filtered = tokens.filter(t => !COMPANY_SUFFIXES.includes(t));
  
  return filtered.join(' ').trim() || s;
}

/**
 * Generate trigrams from a string for similarity comparison
 */
function trigrams(str: string): Set<string> {
  const s = `  ${str} `;
  const result = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) {
    result.add(s.slice(i, i + 3));
  }
  return result;
}

/**
 * Calculate Dice coefficient between two sets of trigrams
 */
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  
  return (2 * intersection) / (a.size + b.size);
}

/**
 * Calculate token-based Jaccard similarity
 */
function tokenJaccard(a: string, b: string): number {
  const tokensA = new Set(a.split(' ').filter(Boolean));
  const tokensB = new Set(b.split(' ').filter(Boolean));
  
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  
  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union;
}

/**
 * Calculate name similarity using combined trigram and token approaches
 */
function nameSimilarity(name1: string, name2: string): number {
  const n1 = normalize(name1);
  const n2 = normalize(name2);
  
  if (n1 === n2) return 1;
  if (!n1 || !n2) return 0;
  
  // Combine trigram similarity and token Jaccard
  const trigramScore = diceCoefficient(trigrams(n1), trigrams(n2));
  const tokenScore = tokenJaccard(n1, n2);
  
  // Weight trigrams more for partial matches, tokens for word-level matches
  return trigramScore * 0.6 + tokenScore * 0.4;
}

/**
 * Score a candidate customer against an input row
 */
function scoreCandidate(
  inputName: string,
  inputCity: string,
  candidate: Customer
): { score: number; reason: string } {
  const candidateName = candidate.company || '';
  const candidateCity = candidate.city || '';
  
  // Name similarity (primary factor)
  const nameScore = nameSimilarity(inputName, candidateName);
  
  // City matching (bonus/penalty)
  const normInputCity = normalize(inputCity);
  const normCandidateCity = normalize(candidateCity);
  
  let cityBonus = 0;
  let reason = '';
  
  if (normInputCity && normCandidateCity) {
    if (normInputCity === normCandidateCity) {
      cityBonus = 0.15; // Exact city match bonus
      reason = 'exact city match';
    } else {
      const citySim = nameSimilarity(inputCity, candidateCity);
      if (citySim > 0.8) {
        cityBonus = 0.1; // Close city match
        reason = 'similar city';
      } else if (citySim < 0.3) {
        cityBonus = -0.1; // City mismatch penalty
        reason = 'city mismatch';
      }
    }
  } else if (!normInputCity && !normCandidateCity) {
    // Both missing city - no penalty
    reason = 'no city data';
  }
  
  const finalScore = Math.min(1, Math.max(0, nameScore + cityBonus));
  
  if (!reason) {
    if (nameScore > 0.9) reason = 'very similar name';
    else if (nameScore > 0.7) reason = 'similar name';
    else if (nameScore > 0.5) reason = 'partial name match';
    else reason = 'weak match';
  }
  
  return { score: finalScore, reason };
}

/**
 * Build an index of customers by first meaningful token for faster candidate narrowing
 */
function buildTokenIndex(customers: Customer[]): Map<string, Customer[]> {
  const index = new Map<string, Customer[]>();
  
  for (const customer of customers) {
    const normalized = normalize(customer.company || '');
    const tokens = normalized.split(' ').filter(Boolean);
    
    // Index by first 1-2 tokens
    for (const token of tokens.slice(0, 2)) {
      if (token.length < 2) continue;
      const key = token.slice(0, 3); // First 3 chars of token
      const list = index.get(key) || [];
      list.push(customer);
      index.set(key, list);
    }
  }
  
  return index;
}

/**
 * Build an index of customers by normalized city
 */
function buildCityIndex(customers: Customer[]): Map<string, Customer[]> {
  const index = new Map<string, Customer[]>();
  
  for (const customer of customers) {
    const city = normalize(customer.city || '');
    if (!city) continue;
    const list = index.get(city) || [];
    list.push(customer);
    index.set(city, list);
  }
  
  return index;
}

/**
 * Get candidate customers for a given input name and city
 */
function getCandidates(
  inputName: string,
  inputCity: string,
  customers: Customer[],
  tokenIndex: Map<string, Customer[]>,
  cityIndex: Map<string, Customer[]>
): Customer[] {
  const candidates = new Set<Customer>();
  
  const normCity = normalize(inputCity);
  const normName = normalize(inputName);
  
  // First, try to get candidates from same city
  if (normCity) {
    const cityMatches = cityIndex.get(normCity) || [];
    for (const c of cityMatches) candidates.add(c);
    
    // Also check similar cities
    for (const [city, custs] of cityIndex.entries()) {
      if (nameSimilarity(normCity, city) > 0.8) {
        for (const c of custs) candidates.add(c);
      }
    }
  }
  
  // Add candidates by token prefix
  const tokens = normName.split(' ').filter(Boolean);
  for (const token of tokens.slice(0, 2)) {
    if (token.length < 2) continue;
    const key = token.slice(0, 3);
    const matches = tokenIndex.get(key) || [];
    for (const c of matches) candidates.add(c);
  }
  
  // If we have very few candidates, include all customers
  if (candidates.size < 10) {
    for (const c of customers) candidates.add(c);
  }
  
  return Array.from(candidates);
}

// Thresholds for classification
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.65;

export type ParsedRow = {
  name: string;
  city: string;
  qty: number;
  price: number;
  originalRow: Record<string, any>;
};

/**
 * Main matching function: match parsed rows against customer database
 */
export function matchCustomers(
  rows: ParsedRow[],
  customers: Customer[]
): MatchResult[] {
  const tokenIndex = buildTokenIndex(customers);
  const cityIndex = buildCityIndex(customers);
  
  const results: MatchResult[] = [];
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const candidates = getCandidates(row.name, row.city, customers, tokenIndex, cityIndex);
    
    // Score all candidates
    const scored: MatchCandidate[] = candidates.map(c => {
      const { score, reason } = scoreCandidate(row.name, row.city, c);
      return {
        customerId: c.customer_id,
        company: c.company || '',
        city: c.city || '',
        score,
        reason
      };
    });
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    // Get top 3 candidates
    const topCandidates = scored.slice(0, 3);
    const bestMatch = topCandidates[0] || null;
    const confidence = bestMatch?.score || 0;
    
    // Determine status
    let status: 'matched' | 'review' | 'unmatched';
    if (confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      status = 'matched';
    } else if (confidence >= REVIEW_THRESHOLD) {
      status = 'review';
    } else {
      status = 'unmatched';
    }
    
    results.push({
      rowIndex: i,
      originalName: row.name,
      originalCity: row.city,
      qty: row.qty,
      price: row.price,
      bestMatch,
      confidence,
      topCandidates,
      status
    });
  }
  
  return results;
}

/**
 * Auto-detect header mappings from column names
 */
export function autoDetectHeaders(headers: string[]): {
  name: string | null;
  city: string | null;
  qty: string | null;
  price: string | null;
} {
  const normalized = headers.map(h => ({ original: h, norm: h.toLowerCase().trim() }));
  
  const namePatterns = ['customer', 'name', 'company', 'kunde', 'firma', 'butik', 'shop', 'store'];
  const cityPatterns = ['city', 'town', 'by', 'stad', 'ort', 'location', 'place'];
  const qtyPatterns = ['qty', 'quantity', 'antal', 'stk', 'pieces', 'units', 'amount', 'count'];
  const pricePatterns = ['price', 'total', 'sum', 'amount', 'value', 'pris', 'beloeb', 'beløb', 'omsætning', 'revenue', 'sales'];
  
  function findMatch(patterns: string[]): string | null {
    for (const pattern of patterns) {
      const found = normalized.find(h => h.norm.includes(pattern));
      if (found) return found.original;
    }
    return null;
  }
  
  return {
    name: findMatch(namePatterns),
    city: findMatch(cityPatterns),
    qty: findMatch(qtyPatterns),
    price: findMatch(pricePatterns)
  };
}

/**
 * Generate CSV content for unmatched rows
 */
export function generateUnmatchedCsv(results: MatchResult[]): string {
  const unmatched = results.filter(r => r.status === 'unmatched');
  if (unmatched.length === 0) return '';
  
  const headers = ['Name', 'City', 'Qty', 'Price', 'Best Match', 'Best Score'];
  const rows = unmatched.map(r => [
    r.originalName,
    r.originalCity,
    String(r.qty),
    String(r.price),
    r.bestMatch?.company || '',
    r.bestMatch ? String(Math.round(r.bestMatch.score * 100)) + '%' : ''
  ]);
  
  const escape = (s: string) => {
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  
  return [
    headers.map(escape).join(','),
    ...rows.map(row => row.map(escape).join(','))
  ].join('\n');
}


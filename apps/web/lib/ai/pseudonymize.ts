/**
 * Customer Pseudonymization
 * 
 * Creates stable, reversible pseudonyms for customer identifiers
 * using HMAC with a server-side secret.
 * 
 * This ensures:
 * - Same customer always gets the same pseudonym (stable)
 * - Pseudonyms are not reversible without the secret
 * - Customer names/identifiers are never sent to OpenAI
 */

import { createHmac } from 'crypto';

const PSEUDONYM_SECRET = process.env.CUSTOMER_PSEUDONYM_SECRET || 'clerkr-default-secret-change-in-prod';

/**
 * Generate a stable pseudonymized identifier for a customer
 * 
 * @param customerId - Original customer identifier (name, ID, etc.)
 * @returns A short, stable pseudonymized reference like "C_a1b2c3"
 */
export function pseudonymizeCustomer(customerId: string): string {
  if (!customerId) return 'C_unknown';
  
  const hmac = createHmac('sha256', PSEUDONYM_SECRET);
  hmac.update(customerId.toLowerCase().trim());
  const hash = hmac.digest('hex');
  
  // Return first 8 chars with prefix for readability
  return `C_${hash.slice(0, 8)}`;
}

/**
 * Generate pseudonymized references for a batch of customers
 * Returns a map from original ID to pseudonymized ref
 */
export function pseudonymizeCustomerBatch(
  customerIds: string[]
): Map<string, string> {
  const map = new Map<string, string>();
  
  for (const id of customerIds) {
    if (id && !map.has(id)) {
      map.set(id, pseudonymizeCustomer(id));
    }
  }
  
  return map;
}

/**
 * Create a lookup table for display purposes
 * (pseudonym -> original display name)
 */
export function createPseudonymLookup(
  customers: Array<{ id: string; displayName: string }>
): Map<string, string> {
  const lookup = new Map<string, string>();
  
  for (const customer of customers) {
    const pseudonym = pseudonymizeCustomer(customer.id);
    lookup.set(pseudonym, customer.displayName);
  }
  
  return lookup;
}

/**
 * Pseudonymize a sales rep name
 * Returns a stable identifier like "Rep_A", "Rep_B", etc.
 */
export function pseudonymizeSalesRep(salesRep: string): string {
  if (!salesRep) return 'Rep_Unknown';
  
  const hmac = createHmac('sha256', PSEUDONYM_SECRET);
  hmac.update(`salesrep:${salesRep.toLowerCase().trim()}`);
  const hash = hmac.digest('hex');
  
  return `Rep_${hash.slice(0, 4).toUpperCase()}`;
}

/**
 * Pseudonymize country to region
 * Countries are aggregated to regions for privacy
 */
export function pseudonymizeCountry(country: string): string {
  if (!country) return 'Region_Unknown';
  
  const normalized = country.toLowerCase().trim();
  
  // Map to broad regions (still useful for AI analysis but not identifying)
  const nordicCountries = ['denmark', 'sweden', 'norway', 'finland', 'iceland'];
  const euCountries = ['germany', 'france', 'italy', 'spain', 'netherlands', 'belgium', 'austria', 'poland'];
  
  if (nordicCountries.includes(normalized)) return 'Nordic';
  if (euCountries.includes(normalized)) return 'EU_Central';
  if (normalized === 'uk' || normalized === 'united kingdom') return 'UK';
  
  return 'Other';
}

/**
 * Create a complete pseudonymization context for AI requests
 * Returns both the pseudonymized data and lookup maps for de-pseudonymization
 */
export interface PseudonymContext {
  salesRepMap: Map<string, string>;  // original -> pseudonym
  salesRepReverse: Map<string, string>;  // pseudonym -> original
}

export function createPseudonymContext(
  salesReps: string[]
): PseudonymContext {
  const salesRepMap = new Map<string, string>();
  const salesRepReverse = new Map<string, string>();
  
  for (const rep of salesReps) {
    if (rep && !salesRepMap.has(rep)) {
      const pseudonym = pseudonymizeSalesRep(rep);
      salesRepMap.set(rep, pseudonym);
      salesRepReverse.set(pseudonym, rep);
    }
  }
  
  return { salesRepMap, salesRepReverse };
}


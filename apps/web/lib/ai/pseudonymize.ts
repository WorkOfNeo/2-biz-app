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


/**
 * Email sending - re-exports from organized email modules
 * 
 * Structure:
 * - emails/core.ts - Core email sender (EmailJS integration)
 * - emails/stockListEmail.ts - Stock list email handler
 * - emails/index.ts - All exports
 * 
 * Add new email types in emails/ folder
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmailCore, sendStockListEmail, sendSalesmenEmail, type SendEmailPayload, type EmailResult } from './emails/index.js';

/**
 * Main entry point for send_email jobs from the worker.
 * Routes to appropriate email handler based on context.
 */
export async function sendEmail(
  supabase: SupabaseClient,
  payload: SendEmailPayload,
  log: (level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>
): Promise<EmailResult> {
  const { context } = payload;
  
  // Route to specific handler based on context
  switch (context) {
    case 'stock_list':
    case 'stock_list_schedule':
      return sendStockListEmail(payload as any, log);
    
    case 'salesmen_schedule':
      return sendSalesmenEmail(payload as any, log);
    
    default:
      // Use core sender for unknown/generic emails
      return sendEmailCore(payload, log);
  }
}

// Re-export types for convenience
export type { SendEmailPayload, EmailResult } from './emails/index.js';


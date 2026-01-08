/**
 * Email handlers index
 * Add new email types here as they're created
 */

// Core sender
export { sendEmailCore, type SendEmailPayload, type EmailResult, type LogFn } from './core.js';

// Specific email types
export { sendStockListEmail, type StockListEmailPayload } from './stockListEmail.js';
export { sendSalesmenEmail, type SalesmenEmailPayload } from './salesmenEmail.js';



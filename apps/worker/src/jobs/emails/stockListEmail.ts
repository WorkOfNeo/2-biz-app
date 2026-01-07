/**
 * Stock List Email Handler
 * Sends scheduled stock list PDFs to recipients
 */

import { sendEmailCore, type EmailResult, type LogFn } from './core.js';

/**
 * Payload for stock list emails (from cron job)
 */
export interface StockListEmailPayload {
  recipient: string;
  subject: string;
  body: string;
  context?: string;
  contextId?: string;
  contextName?: string;
  templateParams?: {
    stock_list_1_url?: string;
    stock_list_1_name?: string;
    stock_list_1_filename?: string;
    [key: string]: string | undefined;
  };
}

/**
 * Sends a stock list email.
 * Called by the worker when processing 'send_email' jobs with context='stock_list_schedule'
 */
export async function sendStockListEmail(
  payload: StockListEmailPayload,
  log: LogFn
): Promise<EmailResult> {
  const { recipient, subject, body, contextId, contextName, templateParams } = payload;
  
  await log('info', `Processing stock list email for schedule "${contextName}"`, {
    scheduleId: contextId,
    scheduleName: contextName,
    recipient,
    listName: templateParams?.stock_list_1_name,
  });

  return sendEmailCore(
    {
      recipient,
      subject,
      body,
      context: 'stock_list',
      contextId,
      contextName,
      templateParams: templateParams as Record<string, string>,
    },
    log
  );
}



/**
 * Core email sending functionality using EmailJS.
 * This is the low-level sender - specific email types should use this.
 */

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';

/**
 * Generic email payload - used by all email types
 */
export interface SendEmailPayload {
  /**
   * Single recipient.
   * Backwards-compatible with older job payloads.
   */
  recipient?: string;

  /**
   * Multiple recipients (sent as one email with comma-separated "To").
   * Used for the manual send-out email list.
   */
  recipients?: string[];
  subject: string;
  body: string;
  
  // Optional metadata (for logging/tracking)
  context?: string; // e.g. "stock_list", "salesperson_report", etc.
  contextId?: string; // e.g. schedule ID, report ID, etc.
  contextName?: string; // e.g. schedule name, report name, etc.
  
  // Optional template params for EmailJS
  templateParams?: Record<string, string>;
}

export interface EmailResult {
  success: boolean;
  message?: string;
  data?: Record<string, any>;
}

export type LogFn = (level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>;

/**
 * Core email sender using EmailJS REST API.
 * Runs on Railway worker (server-side), requires private key.
 */
export async function sendEmailCore(
  payload: SendEmailPayload,
  log: LogFn
): Promise<EmailResult> {
  const { subject, body, context, contextId, contextName, templateParams } = payload;
  const recipients = (payload.recipients ?? []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
  const uniqueRecipients = [...new Set(recipients)];
  const recipient = uniqueRecipients.length > 0 ? uniqueRecipients.join(', ') : (payload.recipient || '').trim();

  if (!recipient) {
    await log('error', 'Missing recipient(s) for email', {
      context,
      contextId,
      contextName,
    });
    return { success: false, message: 'Missing recipient(s)' };
  }

  // Get EmailJS config from environment
  const serviceId = process.env.EMAILJS_SERVICE_ID || '';
  const templateId = process.env.EMAILJS_TEMPLATE_ID || '';
  const publicKey = process.env.EMAILJS_PUBLIC_KEY || '';
  const privateKey = process.env.EMAILJS_PRIVATE_KEY || '';
  const fromEmail = process.env.EMAILJS_FROM_EMAIL || '';
  const fromName = process.env.EMAILJS_FROM_NAME || '2-BIZ';

  if (!serviceId || !templateId || !publicKey || !privateKey) {
    await log('error', 'EmailJS configuration missing', {
      hasServiceId: !!serviceId,
      hasTemplateId: !!templateId,
      hasPublicKey: !!publicKey,
      hasPrivateKey: !!privateKey,
    });
    return {
      success: false,
      message: 'EmailJS configuration missing. Set EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY',
    };
  }

  const contextLabel = context ? `[${context}]` : '';
  await log('info', `Sending email ${contextLabel} to ${recipient}`, {
    context,
    contextId,
    contextName,
    recipient,
    recipientCount: uniqueRecipients.length || 1,
    subject,
  });

  // Build EmailJS payload with accessToken for server-side calls
  const emailPayload = {
    service_id: serviceId,
    template_id: templateId,
    user_id: publicKey,
    accessToken: privateKey,
    template_params: {
      to_email: recipient,
      subject,
      message_html: body,
      from_name: fromName,
      from_email: fromEmail,
      // Merge any additional template params
      ...(templateParams || {}),
    },
  };

  try {
    const res = await fetch(EMAILJS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload),
    });

    const responseText = await res.text();
    
    if (res.ok) {
      await log('info', `Successfully sent email to ${recipient}`, {
        context,
        contextName,
        recipient,
        recipientCount: uniqueRecipients.length || 1,
        subject,
      });
      return {
        success: true,
        message: `Sent to ${recipient}`,
        data: { recipient, recipients: uniqueRecipients, subject, context },
      };
    } else {
      await log('error', `Failed to send email to ${recipient}: ${responseText}`, {
        context,
        recipient,
        recipientCount: uniqueRecipients.length || 1,
        status: res.status,
        error: responseText,
      });
      return {
        success: false,
        message: `EmailJS error: ${res.status} - ${responseText}`,
      };
    }
  } catch (err: any) {
    await log('error', `Exception sending email to ${recipient}: ${err?.message || String(err)}`, {
      context,
      recipient,
      recipientCount: uniqueRecipients.length || 1,
      error: err?.message || String(err),
    });
    return {
      success: false,
      message: `Exception: ${err?.message || String(err)}`,
    };
  }
}




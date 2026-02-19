import {
  DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
  DEFAULT_TEMPLATE_INTERVIEW_INVITE,
  DEFAULT_TEMPLATE_LANGUAGE_CODE,
  DEFAULT_WHATSAPP_BASE_URL,
  getEffectiveOutboundAllowlist,
  getOutboundPolicy,
  getSystemConfig
} from './configService';
import { normalizeEscapedWhitespace } from '../utils/text';
import { normalizeWhatsAppId } from '../utils/whatsapp';

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

function checkSafeOutbound(toWaId: string, config: any): { allowed: boolean; reason?: string } {
  if (toWaId === 'sandbox') return { allowed: true };
  const policy = getOutboundPolicy(config);
  if (policy === 'ALLOW_ALL') return { allowed: true };
  if (policy === 'BLOCK_ALL') return { allowed: false, reason: 'BLOCK_ALL' };

  const normalizedTo = normalizeWhatsAppId(toWaId);
  if (!normalizedTo) return { allowed: false, reason: 'INVALID_TO' };
  const allowlist = getEffectiveOutboundAllowlist(config);
  if (allowlist.includes(normalizedTo)) return { allowed: true };
  return { allowed: false, reason: 'NOT_IN_ALLOWLIST' };
}

export async function sendWhatsAppText(
  toWaId: string,
  text: string,
  options?: { phoneNumberId?: string | null; enforceSafeMode?: boolean }
): Promise<SendResult> {
  const config = await getSystemConfig();
  const normalizedText = normalizeEscapedWhitespace(text);

  if (options?.enforceSafeMode !== false) {
    const safe = checkSafeOutbound(toWaId, config);
    if (!safe.allowed) {
      const policy = getOutboundPolicy(config);
      return {
        success: false,
        error: `SAFE_OUTBOUND_BLOCKED:${policy}:${safe.reason || 'BLOCKED'}`,
      };
    }
  }

  const phoneNumberId = options?.phoneNumberId || config.whatsappPhoneId;
  if (!config?.whatsappToken || !phoneNumberId) {
    return { success: false, error: 'WhatsApp Cloud API no está configurado (phone_number_id / token faltan)' };
  }

  const baseUrl = (config.whatsappBaseUrl || DEFAULT_WHATSAPP_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/${phoneNumberId}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: toWaId,
    type: 'text',
    text: { body: normalizedText }
  };

  const authHeader = `Bearer ${config.whatsappToken}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { success: false, error: errorText || `HTTP ${res.status}` };
    }

    const data = (await res.json()) as any;

    return {
      success: true,
      messageId: data.messages?.[0]?.id
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

export async function sendWhatsAppTemplate(
  toWaId: string,
  templateName: string,
  variables?: string[],
  options?: { phoneNumberId?: string | null; enforceSafeMode?: boolean; languageCode?: string | null }
): Promise<SendResult> {
  const config = await getSystemConfig();

  if (options?.enforceSafeMode !== false) {
    const safe = checkSafeOutbound(toWaId, config);
    if (!safe.allowed) {
      const policy = getOutboundPolicy(config);
      return {
        success: false,
        error: `SAFE_OUTBOUND_BLOCKED:${policy}:${safe.reason || 'BLOCKED'}`,
      };
    }
  }

  const phoneNumberId = options?.phoneNumberId || config.whatsappPhoneId;
  if (!config?.whatsappToken || !phoneNumberId) {
    return { success: false, error: 'WhatsApp Cloud API no está configurado (phone_number_id / token faltan)' };
  }

  const baseUrl = (config.whatsappBaseUrl || DEFAULT_WHATSAPP_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/${phoneNumberId}/messages`;
  const components =
    variables && variables.length > 0
      ? [
          {
            type: 'body',
            parameters: variables.map(value => ({
              type: 'text',
              text: normalizeEscapedWhitespace(value)
            }))
          }
        ]
      : undefined;

  const baseLanguageCode =
    options?.languageCode?.trim() ||
    config.templateLanguageCode?.trim() ||
    DEFAULT_TEMPLATE_LANGUAGE_CODE;
  const forcedLanguageByTemplate: Record<string, string> = {
    [DEFAULT_TEMPLATE_GENERAL_FOLLOWUP]: DEFAULT_TEMPLATE_LANGUAGE_CODE,
    [DEFAULT_TEMPLATE_INTERVIEW_INVITE]: DEFAULT_TEMPLATE_LANGUAGE_CODE
  };

  const requestedCodes = [
    forcedLanguageByTemplate[templateName] || baseLanguageCode,
    baseLanguageCode,
    'es',
    'es_419',
    'es_CL',
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .filter((v, idx, arr) => arr.indexOf(v) === idx);

  const authHeader = `Bearer ${config.whatsappToken}`;
  let lastError = 'Unknown error';
  for (const languageCode of requestedCodes) {
    const body: any = {
      messaging_product: 'whatsapp',
      to: toWaId,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode }
      }
    };
    if (components) {
      body.template.components = components;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const errorText = await res.text();
        lastError = errorText || `HTTP ${res.status}`;
        // Retry with next language only when translation is missing for this locale.
        const low = String(lastError || '').toLowerCase();
        const shouldRetryLanguage =
          low.includes('template name') && low.includes('does not exist in');
        if (shouldRetryLanguage) {
          continue;
        }
        return { success: false, error: lastError };
      }

      const data = (await res.json()) as any;
      return {
        success: true,
        messageId: data.messages?.[0]?.id
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: lastError };
    }
  }

  return { success: false, error: lastError };
}

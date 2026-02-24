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
  mediaId?: string;
  error?: string;
}

function normalizeLanguageCode(value: unknown): string | null {
  const code = String(value || '').trim();
  return code ? code : null;
}

function isLegacyEsClTemplate(templateName: string): boolean {
  const key = String(templateName || '').trim().toLowerCase();
  if (!key) return false;
  return (
    key === String(DEFAULT_TEMPLATE_GENERAL_FOLLOWUP || '').trim().toLowerCase() ||
    key === String(DEFAULT_TEMPLATE_INTERVIEW_INVITE || '').trim().toLowerCase()
  );
}

function preferredLanguageForTemplate(templateName: string, baseLanguageCode: string): string {
  const base = normalizeLanguageCode(baseLanguageCode) || DEFAULT_TEMPLATE_LANGUAGE_CODE;
  if (isLegacyEsClTemplate(templateName)) return base;
  if (base.toLowerCase() === 'es_cl') return 'es';
  return base;
}

function shouldRetryTemplateLanguage(errorText: string): boolean {
  const raw = String(errorText || '').trim();
  if (!raw) return false;
  const low = raw.toLowerCase();
  if (low.includes('template name') && low.includes('does not exist in')) return true;
  if (low.includes('does not exist in the translation')) return true;
  if (low.includes('"code":132001')) return true;
  try {
    const parsed = JSON.parse(raw) as any;
    const code = Number(parsed?.error?.code);
    const details = String(parsed?.error?.error_data?.details || '');
    if (code === 132001) return true;
    if (details.toLowerCase().includes('does not exist in')) return true;
  } catch {
    // ignore parse errors
  }
  return false;
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
    normalizeLanguageCode(options?.languageCode) ||
    normalizeLanguageCode(config.templateLanguageCode) ||
    DEFAULT_TEMPLATE_LANGUAGE_CODE;
  const preferredLanguageCode = preferredLanguageForTemplate(templateName, baseLanguageCode);

  const requestedCodes = [
    preferredLanguageCode,
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
        if (shouldRetryTemplateLanguage(lastError)) {
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

function normalizeAttachmentType(mimeType: string): 'image' | 'document' | 'video' | 'audio' {
  const low = mimeType.toLowerCase();
  if (low.startsWith('image/')) return 'image';
  if (low.startsWith('video/')) return 'video';
  if (low.startsWith('audio/')) return 'audio';
  return 'document';
}

async function uploadWhatsAppMedia(args: {
  phoneNumberId: string;
  token: string;
  baseUrl: string;
  buffer: Buffer;
  mimeType: string;
  filename: string;
}): Promise<{ ok: true; mediaId: string } | { ok: false; error: string }> {
  const url = `${args.baseUrl.replace(/\/$/, '')}/${args.phoneNumberId}/media`;
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    const blob = new Blob([new Uint8Array(args.buffer)], { type: args.mimeType || 'application/octet-stream' });
    form.append('file', blob, args.filename || 'adjunto');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.token}`,
      },
      body: form as any,
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
    const data = (await res.json()) as any;
    const mediaId = String(data?.id || '').trim();
    if (!mediaId) return { ok: false, error: 'Meta no devolvió media id' };
    return { ok: true, mediaId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'upload_failed' };
  }
}

export async function sendWhatsAppAttachment(
  toWaId: string,
  file: { buffer: Buffer; mimeType: string; filename: string; caption?: string | null },
  options?: { phoneNumberId?: string | null; enforceSafeMode?: boolean }
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

  const mimeType = String(file?.mimeType || '').trim().toLowerCase() || 'application/octet-stream';
  const filename = String(file?.filename || '').trim() || 'adjunto';
  if (!file?.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length <= 0) {
    return { success: false, error: 'Archivo inválido o vacío' };
  }
  if (file.buffer.length > 100 * 1024 * 1024) {
    return { success: false, error: 'Archivo demasiado grande (máx 100MB)' };
  }

  const baseUrl = (config.whatsappBaseUrl || DEFAULT_WHATSAPP_BASE_URL).replace(/\/$/, '');
  const uploaded = await uploadWhatsAppMedia({
    phoneNumberId,
    token: config.whatsappToken,
    baseUrl,
    buffer: file.buffer,
    mimeType,
    filename,
  });
  if (!uploaded.ok) return { success: false, error: uploaded.error };

  const type = normalizeAttachmentType(mimeType);
  const caption = normalizeEscapedWhitespace(String(file?.caption || '').trim());
  const body: any = {
    messaging_product: 'whatsapp',
    to: toWaId,
    type,
    [type]: {
      id: uploaded.mediaId,
    },
  };
  if (caption && (type === 'image' || type === 'video' || type === 'document')) body[type].caption = caption;
  if (type === 'document' && filename) body.document.filename = filename;

  try {
    const res = await fetch(`${baseUrl}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.whatsappToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorText = await res.text();
      return { success: false, error: errorText || `HTTP ${res.status}` };
    }
    const data = (await res.json()) as any;
    return {
      success: true,
      mediaId: uploaded.mediaId,
      messageId: data?.messages?.[0]?.id || undefined,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

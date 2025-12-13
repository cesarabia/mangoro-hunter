import {
  DEFAULT_TEMPLATE_GENERAL_FOLLOWUP,
  DEFAULT_TEMPLATE_INTERVIEW_INVITE,
  DEFAULT_TEMPLATE_LANGUAGE_CODE,
  DEFAULT_WHATSAPP_BASE_URL,
  getSystemConfig
} from './configService';

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendWhatsAppText(toWaId: string, text: string): Promise<SendResult> {
  const config = await getSystemConfig();

  if (!config?.whatsappToken || !config.whatsappPhoneId) {
    return { success: false, error: 'WhatsApp Cloud API no está configurado (phone_number_id / token faltan)' };
  }

  const baseUrl = (config.whatsappBaseUrl || DEFAULT_WHATSAPP_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/${config.whatsappPhoneId}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: toWaId,
    type: 'text',
    text: { body: text }
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
  variables?: string[]
): Promise<SendResult> {
  const config = await getSystemConfig();

  if (!config?.whatsappToken || !config.whatsappPhoneId) {
    return { success: false, error: 'WhatsApp Cloud API no está configurado (phone_number_id / token faltan)' };
  }

  const baseUrl = (config.whatsappBaseUrl || DEFAULT_WHATSAPP_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/${config.whatsappPhoneId}/messages`;
  const components =
    variables && variables.length > 0
      ? [
          {
            type: 'body',
            parameters: variables.map(value => ({
              type: 'text',
              text: value
            }))
          }
        ]
      : undefined;

  const baseLanguageCode =
    config.templateLanguageCode?.trim() || DEFAULT_TEMPLATE_LANGUAGE_CODE;
  const forcedLanguageByTemplate: Record<string, string> = {
    [DEFAULT_TEMPLATE_GENERAL_FOLLOWUP]: DEFAULT_TEMPLATE_LANGUAGE_CODE,
    [DEFAULT_TEMPLATE_INTERVIEW_INVITE]: DEFAULT_TEMPLATE_LANGUAGE_CODE
  };
  const languageCode = forcedLanguageByTemplate[templateName] || baseLanguageCode;

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

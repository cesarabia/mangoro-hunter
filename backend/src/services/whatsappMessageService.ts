import { DEFAULT_WHATSAPP_BASE_URL, getSystemConfig } from './configService';

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

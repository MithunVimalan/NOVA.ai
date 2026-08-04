import { bearerJsonHeaders, requestJson } from '@nova/shared';

const GRAPH_API_BASE = 'https://graph.facebook.com/v18.0';

/**
 * Sends a text message through the WhatsApp Cloud API.
 * `phoneId` defaults to the token owner's own number ("me").
 */
export async function sendWhatsAppCloudMessage(
  accessToken: string,
  recipient: string,
  text: string,
  phoneId: string = 'me'
): Promise<void> {
  await requestJson(`${GRAPH_API_BASE}/${phoneId}/messages`, {
    label: 'Meta Graph API',
    headers: bearerJsonHeaders(accessToken),
    body: {
      messaging_product: 'whatsapp',
      to: recipient,
      text: { body: text },
    },
  });
}

/**
 * Sends a direct message through the Instagram Messaging API.
 */
export async function sendInstagramMessage(
  accessToken: string,
  recipientId: string,
  text: string
): Promise<void> {
  await requestJson(`${GRAPH_API_BASE}/me/messages`, {
    label: 'Meta Instagram API',
    headers: bearerJsonHeaders(accessToken),
    body: {
      recipient: { id: recipientId },
      message: { text },
    },
  });
}

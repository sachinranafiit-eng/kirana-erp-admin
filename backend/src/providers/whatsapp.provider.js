/**
 * WhatsApp Cloud API provider (Meta).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Requires a WhatsApp Business Account + phone number registered with
 * Meta, plus a permanent access token. Free-form text messages can only
 * be sent within a 24h customer-service window that opens when the
 * customer messages you first; outside that window Meta requires an
 * approved message *template* (hence WHATSAPP_USE_TEMPLATES below).
 */
const BASE_URL = (version, phoneNumberId) =>
  `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

async function sendWhatsAppText({ to, body }) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v19.0';

  if (!phoneNumberId || !accessToken) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not configured in .env');
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: normalizeIndianMobile(to),
    type: 'text',
    text: { preview_url: true, body },
  };

  const response = await fetch(BASE_URL(apiVersion, phoneNumberId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `WhatsApp API error (${response.status})`);
    err.providerResponse = data;
    throw err;
  }
  return data;
}

/**
 * Send an approved WhatsApp message *template* (required for the first
 * message to a customer, or any message outside the 24h window — e.g.
 * order confirmations, payment reminders sent proactively).
 */
async function sendWhatsAppTemplate({ to, templateName, languageCode = 'en', components = [] }) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v19.0';

  if (!phoneNumberId || !accessToken) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not configured in .env');
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: normalizeIndianMobile(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  };

  const response = await fetch(BASE_URL(apiVersion, phoneNumberId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `WhatsApp API error (${response.status})`);
    err.providerResponse = data;
    throw err;
  }
  return data;
}

function normalizeIndianMobile(mobile) {
  const digits = String(mobile).replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;   // assume India if bare 10-digit
  return digits;
}

module.exports = { sendWhatsAppText, sendWhatsAppTemplate, normalizeIndianMobile };

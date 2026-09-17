/**
 * MSG91 SMS provider — one of the most common transactional/promotional
 * SMS gateways for Indian businesses (supports DLT-registered sender IDs
 * as required by TRAI regulations for commercial SMS in India).
 * Docs: https://docs.msg91.com/p/tf9GTextf/e/Bs2xkjAK9v/MSG91
 *
 * Swap this file for a Twilio/Kaleyra provider if preferred — the rest
 * of the app only depends on the exported `sendSms` function signature.
 */
async function sendSms({ to, body, templateId }) {
  const authKey = process.env.MSG91_AUTH_KEY;
  const senderId = process.env.MSG91_SENDER_ID;

  if (!authKey || !senderId) {
    throw new Error('MSG91_AUTH_KEY / MSG91_SENDER_ID not configured in .env');
  }

  const mobile = normalizeIndianMobile(to);

  // MSG91's flow API requires a pre-approved DLT template for commercial
  // SMS in India. For a flow-based (templated) send:
  if (templateId) {
    const response = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: {
        authkey: authKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: templateId,
        short_url: '1',
        recipients: [{ mobiles: mobile, VAR: body }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.type === 'error') {
      const err = new Error(data.message || `MSG91 API error (${response.status})`);
      err.providerResponse = data;
      throw err;
    }
    return data;
  }

  // Plain transactional send (works for accounts using MSG91's simple
  // send API with a pre-registered sender ID + DLT template on file).
  const params = new URLSearchParams({
    authkey: authKey,
    mobiles: mobile,
    message: body,
    sender: senderId,
    route: '4',   // transactional route
    country: '91',
  });
  const response = await fetch(`https://api.msg91.com/api/sendhttp.php?${params.toString()}`, {
    method: 'GET',
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`MSG91 API error (${response.status})`);
    err.providerResponse = text;
    throw err;
  }
  return { raw: text };
}

function normalizeIndianMobile(mobile) {
  const digits = String(mobile).replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

module.exports = { sendSms, normalizeIndianMobile };

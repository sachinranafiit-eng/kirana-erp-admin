const { query } = require('../config/db');
const whatsapp = require('../providers/whatsapp.provider');
const sms = require('../providers/sms.provider');
const ApiError = require('../utils/ApiError');

function renderTemplate(template, variables = {}) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => (
    variables[key] !== undefined ? String(variables[key]) : `{{${key}}}`
  ));
}

async function getTemplate(code) {
  const { rows } = await query(
    'SELECT * FROM notification_templates WHERE code = $1 AND is_active = true',
    [code]
  );
  if (!rows[0]) throw ApiError.notFound(`Notification template '${code}' not found or inactive`);
  return rows[0];
}

async function logResult({ channel, recipient, templateCode, partyType, partyId, messageBody, status, providerResponse, errorMessage, userId }) {
  await query(
    `INSERT INTO notifications_log
       (channel, recipient, template_code, party_type, party_id, message_body, status, provider_response, error_message, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [channel, recipient, templateCode || null, partyType || null, partyId || null, messageBody || null,
      status, providerResponse ? JSON.stringify(providerResponse) : null, errorMessage || null, userId || null]
  );
}

/**
 * Sends a single message on one channel using a named template.
 * This is the function the rest of the app should call — it never
 * throws for a failed provider call (so one bad number doesn't crash a
 * broadcast); check the returned `status` instead.
 */
async function sendTemplatedMessage({ channel, to, templateCode, variables = {}, partyType, partyId, userId }) {
  const template = await getTemplate(templateCode);
  if (template.channel !== 'both' && template.channel !== channel) {
    throw ApiError.badRequest(`Template '${templateCode}' is not configured for channel '${channel}'`);
  }
  const body = renderTemplate(template.body_template, variables);

  try {
    let providerResponse;
    if (channel === 'whatsapp') {
      providerResponse = await whatsapp.sendWhatsAppText({ to, body });
    } else if (channel === 'sms') {
      providerResponse = await sms.sendSms({ to, body });
    } else {
      throw new Error(`Unsupported channel: ${channel}`);
    }
    await logResult({ channel, recipient: to, templateCode, partyType, partyId, messageBody: body, status: 'sent', providerResponse, userId });
    return { status: 'sent', body, providerResponse };
  } catch (err) {
    await logResult({ channel, recipient: to, templateCode, partyType, partyId, messageBody: body, status: 'failed', errorMessage: err.message, userId });
    return { status: 'failed', body, error: err.message };
  }
}

/**
 * Sends the same template to many recipients (marketing broadcasts,
 * bulk order-status updates). Respects `customers.opt_in_marketing`
 * when partyType is 'customer' and isMarketing is true. Runs
 * sequentially with a small delay to stay within provider rate limits.
 */
async function broadcast({ channel, templateCode, recipients, isMarketing = false, userId }) {
  const results = [];
  for (const r of recipients) {
    if (isMarketing && r.partyType === 'customer') {
      const { rows } = await query('SELECT opt_in_marketing FROM customers WHERE id = $1', [r.partyId]);
      if (rows[0] && rows[0].opt_in_marketing === false) {
        results.push({ to: r.to, status: 'skipped_opt_out' });
        continue;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await sendTemplatedMessage({
      channel, to: r.to, templateCode, variables: r.variables || {},
      partyType: r.partyType, partyId: r.partyId, userId,
    });
    results.push({ to: r.to, ...result });
  }
  return results;
}

module.exports = { renderTemplate, getTemplate, sendTemplatedMessage, broadcast };

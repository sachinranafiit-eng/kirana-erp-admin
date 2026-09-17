const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');

const OTP_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;

function generateOtp() {
  // 6-digit numeric OTP using a CSPRNG, not Math.random().
  return String(crypto.randomInt(100000, 999999));
}

async function requestOtp({ mobile, purpose = 'storefront_login', shopName = 'the store' }) {
  if (!/^\d{10}$/.test(mobile)) throw ApiError.badRequest('A valid 10-digit mobile number is required');

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await query(
    `INSERT INTO otp_verifications (mobile, otp_hash, purpose, expires_at) VALUES ($1,$2,$3,$4)`,
    [mobile, otpHash, purpose, expiresAt]
  );

  // Send via SMS (works even for customers who haven't messaged the
  // WhatsApp business number first, unlike free-form WhatsApp text).
  await notificationService.sendTemplatedMessage({
    channel: 'sms',
    to: mobile,
    templateCode: 'otp_login',
    variables: { shopName, otp },
    partyType: 'customer_otp',
  });

  return { expiresInMinutes: OTP_TTL_MINUTES };
}

async function verifyOtp({ mobile, otp, purpose = 'storefront_login' }) {
  const { rows } = await query(
    `SELECT * FROM otp_verifications
     WHERE mobile = $1 AND purpose = $2 AND verified_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [mobile, purpose]
  );
  const record = rows[0];
  if (!record) throw ApiError.badRequest('OTP expired or not requested. Please request a new one.');

  if (record.attempts >= MAX_ATTEMPTS) {
    throw ApiError.badRequest('Too many incorrect attempts. Please request a new OTP.');
  }

  const ok = await bcrypt.compare(String(otp), record.otp_hash);
  if (!ok) {
    await query('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = $1', [record.id]);
    throw ApiError.badRequest('Incorrect OTP');
  }

  await query('UPDATE otp_verifications SET verified_at = now() WHERE id = $1', [record.id]);
  return true;
}

module.exports = { requestOtp, verifyOtp };

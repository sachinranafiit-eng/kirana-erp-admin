const { query } = require('../config/db');

/**
 * Records a row-level audit trail entry (who changed what).
 * Call this inside the same DB transaction as the write where possible;
 * for simple single-table writes it can run right after the write.
 */
async function logAudit({ client, userId, tableName, recordId, operation, oldData = null, newData = null }) {
  const redact = data => { if(!data || typeof data !== 'object') return data; const copy={...data}; for(const k of ['password_hash','pin_hash','password','token_version']) delete copy[k]; return copy; };
  oldData=redact(oldData); newData=redact(newData);
  const runner = client || { query };
  const exec = client ? client.query.bind(client) : query;
  await exec(
    `INSERT INTO audit_logs (user_id, table_name, record_id, operation, old_data, new_data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, tableName, String(recordId), operation, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null]
  );
  // `runner` kept for readability of intent; `exec` is what actually runs.
  void runner;
}

/**
 * Records a coarser, human-readable activity log entry (for the
 * "User Activity Logs" screen: login, invoice created, price changed...).
 */
async function logActivity({ userId, action, entityType = null, entityId = null, details = null, ip = null }) {
  await query(
    `INSERT INTO user_activity_logs (user_id, action, entity_type, entity_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, entityType, entityId ? String(entityId) : null, details ? JSON.stringify(details) : null, ip]
  );
}

module.exports = { logAudit, logActivity };

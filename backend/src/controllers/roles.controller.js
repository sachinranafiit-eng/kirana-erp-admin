const { query, withTransaction } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { logAudit, logActivity } = require('../utils/audit');

const listRoles = asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM roles ORDER BY id');
  res.json({ success: true, data: rows });
});

const createRole = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name) throw ApiError.badRequest('name is required');
  const { rows } = await query(
    'INSERT INTO roles (name, description, is_system) VALUES ($1,$2,false) RETURNING *',
    [name, description || null]
  );
  await logActivity({ userId: req.user.id, action: 'roles.create', entityType: 'role', entityId: rows[0].id });
  res.status(201).json({ success: true, data: rows[0] });
});

const listPermissions = asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM permissions ORDER BY module, action');
  res.json({ success: true, data: rows });
});

// Returns the full matrix: every role × every permission with a boolean.
// This is exactly what an Admin Panel permission-matrix grid needs to render.
const getMatrix = asyncHandler(async (req, res) => {
  const roles = (await query('SELECT id, name, is_system FROM roles ORDER BY id')).rows;
  const permissions = (await query('SELECT id, module, action, code FROM permissions ORDER BY module, action')).rows;
  const assigned = (await query('SELECT role_id, permission_id FROM role_permissions')).rows;

  const assignedSet = new Set(assigned.map((a) => `${a.role_id}:${a.permission_id}`));

  const matrix = roles.map((role) => ({
    role,
    permissions: permissions.map((perm) => ({
      permissionId: perm.id,
      code: perm.code,
      module: perm.module,
      action: perm.action,
      granted: role.name === 'super_admin' ? true : assignedSet.has(`${role.id}:${perm.id}`),
    })),
  }));

  res.json({ success: true, data: matrix });
});

// Replaces the full set of permissions for one role in a single transaction.
// Body: { permissionIds: [1,2,3,...] }
const setRolePermissions = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const { permissionIds } = req.body;
  if (!Array.isArray(permissionIds)) throw ApiError.badRequest('permissionIds must be an array');

  const role = (await query('SELECT * FROM roles WHERE id = $1', [roleId])).rows[0];
  if (!role) throw ApiError.notFound('Role not found');
  if (role.name === 'super_admin') {
    throw ApiError.forbidden('super_admin permissions cannot be modified');
  }

  await withTransaction(async (client) => {
    const before = (await client.query('SELECT permission_id FROM role_permissions WHERE role_id = $1', [roleId])).rows;
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    for (const permId of permissionIds) {
      await client.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [roleId, permId]
      );
    }
    await logAudit({
      client, userId: req.user.id, tableName: 'role_permissions', recordId: roleId,
      operation: 'UPDATE', oldData: before, newData: { permissionIds },
    });
  });

  await logActivity({ userId: req.user.id, action: 'roles.permissions_updated', entityType: 'role', entityId: roleId, details: { permissionIds } });

  res.json({ success: true, message: 'Permissions updated for role' });
});

module.exports = { listRoles, createRole, listPermissions, getMatrix, setRolePermissions };

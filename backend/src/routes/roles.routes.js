const express = require('express');
const router = express.Router();
const controller = require('../controllers/roles.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticate, requirePermission('users.manage'));

router.get('/', controller.listRoles);
router.post('/', controller.createRole);
router.get('/permissions/all', controller.listPermissions);
router.get('/permissions/matrix', controller.getMatrix);
router.put('/:roleId/permissions', controller.setRolePermissions);

module.exports = router;

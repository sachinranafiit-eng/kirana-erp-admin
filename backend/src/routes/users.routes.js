const express = require('express');
const router = express.Router();
const controller = require('../controllers/users.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticate, requirePermission('users.manage'));

router.get('/', controller.list);
router.get('/:id', controller.getOne);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.post('/:id/reset-password', controller.resetPassword);
router.post('/:id/deactivate', controller.deactivate);

module.exports = router;

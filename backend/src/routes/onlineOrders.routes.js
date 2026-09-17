const express = require('express');
const router = express.Router();
const controller = require('../controllers/onlineOrders.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticate);

router.get('/', requirePermission('online_store.view'), controller.list);
router.get('/settings', requirePermission('online_store.view'), controller.getSettings);
router.put('/settings', requirePermission('online_store.manage'), controller.updateSettings);
router.get('/:id', requirePermission('online_store.view'), controller.getOne);
router.put('/:id/status', requirePermission('online_store.manage'), controller.updateStatus);
router.put('/products/:productId/visibility', requirePermission('online_store.manage'), controller.setProductVisibility);

module.exports = router;

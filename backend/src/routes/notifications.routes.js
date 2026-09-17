const express = require('express');
const router = express.Router();
const controller = require('../controllers/notifications.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticate);

router.get('/templates', requirePermission('notifications.manage'), controller.listTemplates);
router.post('/templates', requirePermission('notifications.manage'), controller.createTemplate);
router.put('/templates/:id', requirePermission('notifications.manage'), controller.updateTemplate);

router.post('/send', requirePermission('notifications.send'), controller.send);
router.post('/payment-reminder', requirePermission('notifications.send'), controller.paymentReminder);
router.post('/broadcast', requirePermission('notifications.manage'), controller.broadcast);
router.get('/logs', requirePermission('notifications.manage'), controller.logs);

module.exports = router;

const express = require('express');
const router = express.Router();
const controller = require('../controllers/logs.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticate, requirePermission('users.manage'));

router.get('/activity', controller.activity);
router.get('/logins', controller.logins);

module.exports = router;

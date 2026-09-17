const express = require('express');
const router = express.Router();
const controller = require('../controllers/customers.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticate);

router.get('/', requirePermission('customers.view'), controller.list);
router.get('/:id', requirePermission('customers.view'), controller.getOne);
router.get('/:id/ledger', requirePermission('customers.view'), controller.ledger);
router.post('/', requirePermission('customers.manage'), controller.create);
router.put('/:id', requirePermission('customers.manage'), controller.update);

module.exports = router;

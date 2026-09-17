const express = require('express');
const router = express.Router();
const controller = require('../controllers/suppliers.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticate);

router.get('/', requirePermission('suppliers.view'), controller.list);
router.get('/:id', requirePermission('suppliers.view'), controller.getOne);
router.get('/:id/ledger', requirePermission('suppliers.view'), controller.ledger);
router.post('/', requirePermission('suppliers.manage'), controller.create);
router.put('/:id', requirePermission('suppliers.manage'), controller.update);

module.exports = router;

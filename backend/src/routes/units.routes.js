const express = require('express');
const router = express.Router();
const controller = require('../controllers/units.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticate);

router.get('/', requirePermission('products.view'), controller.list);
router.post('/', requirePermission('products.add'), controller.create);
router.delete('/:id', requirePermission('products.delete'), controller.remove);

module.exports = router;

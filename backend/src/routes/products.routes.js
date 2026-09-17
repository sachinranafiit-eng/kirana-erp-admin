const express = require('express');
const router = express.Router();
const controller = require('../controllers/products.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticate);

router.get('/', requirePermission('products.view'), controller.list);
router.get('/barcode/:code', requirePermission('products.view'), controller.findByBarcode);
router.get('/:id', requirePermission('products.view'), controller.getOne);
router.post('/', requirePermission('products.add'), controller.create);
router.put('/:id', requirePermission('products.edit'), controller.update);
router.post('/:id/barcodes', requirePermission('products.edit'), controller.addBarcode);
router.post('/:id/deactivate', requirePermission('products.delete'), controller.deactivate);

module.exports = router;

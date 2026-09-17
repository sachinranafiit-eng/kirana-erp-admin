const express = require('express');
const router = express.Router();
const controller = require('../controllers/storefront.controller');
const { authenticateCustomer } = require('../middleware/customerAuth.middleware');

// --- Public: catalog browsing & OTP login (no auth) ---
router.get('/products', controller.listCatalog);
router.get('/products/:id', controller.getCatalogItem);
router.post('/auth/request-otp', controller.requestOtp);
router.post('/auth/verify-otp', controller.verifyOtp);

// --- Customer-authenticated: cart & orders ---
router.use(authenticateCustomer);
router.get('/cart', controller.getCart);
router.post('/cart/items', controller.addToCart);
router.put('/cart/items/:itemId', controller.updateCartItem);
router.delete('/cart/items/:itemId', controller.removeCartItem);
router.post('/orders', controller.placeOrder);
router.get('/orders', controller.myOrders);
router.get('/orders/:id', controller.myOrderDetail);

module.exports = router;

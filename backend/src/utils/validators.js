const { validationResult } = require('express-validator');
const ApiError = require('./ApiError');

/**
 * Drop this after a chain of express-validator checks on a route:
 *   router.post('/', [body('name').notEmpty()], validate, controller.create)
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(ApiError.badRequest('Validation failed', errors.array()));
  }
  next();
}

module.exports = validate;

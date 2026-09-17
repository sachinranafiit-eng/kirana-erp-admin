const ApiError = require('../utils/ApiError');

function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let { statusCode, message, details } = err;

  // Postgres unique-violation → friendlier 409 instead of a raw 500
  if (err.code === '23505') {
    statusCode = 409;
    message = 'A record with this value already exists (duplicate).';
    details = err.detail;
  }
  // Postgres foreign-key violation
  if (err.code === '23503') {
    statusCode = 409;
    message = 'This action references a record that does not exist or is in use.';
    details = err.detail;
  }

  if(['23514','22003','22P02','22007','22008'].includes(err.code)){statusCode=400;message='Invalid value. Check quantities, amounts, dates, and required fields.';details=undefined;}
  if(err.code==='LIMIT_FILE_SIZE'){statusCode=400;message='File exceeds 10 MB';}
  statusCode = statusCode || 500;
  if (statusCode === 500) {
    console.error('Unhandled error:', err);
  }

  res.status(statusCode).json({
    success: false,
    message: statusCode===500?'The request could not be completed. Please contact your administrator.':message || 'Request failed',
    details: statusCode===500?undefined:details || undefined,
  });
}

module.exports = { notFoundHandler, errorHandler };

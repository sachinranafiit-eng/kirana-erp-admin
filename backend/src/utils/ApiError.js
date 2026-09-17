class ApiError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }

  static badRequest(message, details) { return new ApiError(400, message, details); }
  static unauthorized(message = 'Unauthorized') { return new ApiError(401, message); }
  static forbidden(message = 'Forbidden — you do not have permission to do this') {
    return new ApiError(403, message);
  }
  static notFound(message = 'Not found') { return new ApiError(404, message); }
  static conflict(message, details) { return new ApiError(409, message, details); }
}

module.exports = ApiError;

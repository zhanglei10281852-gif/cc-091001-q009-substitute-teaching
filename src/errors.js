// 统一的业务错误类型，HTTP 层据此映射状态码
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends ApiError {
  constructor(message, details) {
    super(400, 'invalid-request', message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends ApiError {
  constructor(resource = 'resource') {
    super(404, 'not-found', `${resource} 不存在`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(code, message, details) {
    super(409, code, message, details);
    this.name = 'ConflictError';
  }
}

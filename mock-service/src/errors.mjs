// 错误信封（契约 §2.2）：所有错误统一 { error: { code, message, details } }
export const CODES = {
  BATCH_LIMIT_EXCEEDED: 400,
  COMIC_NAME_REQUIRED: 400,
  INVALID_COMIC_NAME: 400,
  INVALID_IMAGE: 400,
  IDEMPOTENT_REPLAY: 200,
  TASK_NOT_FOUND: 404,
  TASK_NOT_APPENDABLE: 409,
  TASK_NOT_CANCELABLE: 409,
  SEQUENCE_OVERFLOW: 409,
  DISK_FULL: 507,
  PERMISSION_DENIED: 403,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = CODES[code] ?? 500;
    this.details = details || {};
  }
}

/** 令牌错误与 Origin 拒绝共用同一个错误码，不泄露是哪一项失败（契约 §2.1） */
export function permissionDenied() {
  return new ApiError('PERMISSION_DENIED', '鉴权失败或来源不被允许', {});
}

export function errorEnvelope(err) {
  const code = err instanceof ApiError ? err.code : 'INTERNAL';
  const status = err instanceof ApiError ? err.status : 500;
  const message = err instanceof ApiError ? err.message : '服务内部错误';
  const details = err instanceof ApiError ? err.details : { reason: String(err && err.message) };
  return {
    status,
    body: { error: { code, message, details: details || {} } },
  };
}

export type HostAdapterErrorCode =
  | 'not_connected' // connect() not called, failed, or dispose() was called
  | 'session_not_found' // unknown or deleted sessionId
  | 'permission_denied' // host refused (scope, allowlist, user denial)
  | 'rate_limited' // host throttled; see retryAfterMs
  | 'payload_too_large' // text exceeds maxInjectBytes / maxSendBytes or a host cap
  | 'unsupported' // capability is false or method not implemented
  | 'host_error'; // anything else; put the host's message in `message`

export class HostAdapterError extends Error {
  readonly name = 'HostAdapterError';
  constructor(
    readonly code: HostAdapterErrorCode,
    message: string,
    readonly options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
  }
}

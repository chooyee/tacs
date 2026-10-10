// fetch wrapper for the JSON API (docs/06 §1): sends JSON and the CSRF token, unwraps { data },
// and turns { error } responses into an ApiError with the server's user-safe message.

/** An error returned by the API: `code` and `requestId` come from the server's error body. */
export class ApiError extends Error {
  constructor(message, { status, code, requestId, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

const csrfToken = () => document.querySelector('meta[name="csrf-token"]')?.content ?? '';

/**
 * Call the API.
 * @param {string} url
 * @param {{method?: string, body?: unknown}} [opts]
 * @returns {Promise<unknown>} the `data` part of the response (undefined for 204)
 * @throws {ApiError}
 */
export async function api(url, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(method !== 'GET' && { 'X-CSRF-Token': csrfToken() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('No connection. Check your network and try again.', { code: 'NETWORK_ERROR' });
  }

  if (response.status === 204) return undefined;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = payload.error ?? {};
    if (response.status === 401) {
      throw new ApiError('Your session has ended. Reload the page to sign in again.', {
        status: 401,
        code: err.code,
      });
    }
    throw new ApiError(err.message ?? 'Something went wrong. Please try again.', {
      status: response.status,
      ...err,
    });
  }
  return payload.data;
}

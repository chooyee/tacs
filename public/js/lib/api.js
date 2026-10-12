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
 * @param {{method?: string, body?: unknown}} [opts]  body: an object (sent as JSON) or FormData (uploads)
 * @returns {Promise<unknown>} the `data` part of the response (undefined for 204)
 * @throws {ApiError}
 */
export async function api(url, { method = 'GET', body } = {}) {
  // FormData sets its own multipart Content-Type (with the boundary), so we must not set one.
  const isForm = body instanceof FormData;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && !isForm && { 'Content-Type': 'application/json' }),
        ...(method !== 'GET' && { 'X-CSRF-Token': csrfToken() }),
      },
      body: body === undefined || isForm ? body : JSON.stringify(body),
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

/**
 * Fetch a server-rendered HTML fragment (e.g. an editor card) to swap into the page.
 * @param {string} url
 * @returns {Promise<string>} the HTML
 * @throws {ApiError}
 */
export async function fetchHtml(url) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
  } catch {
    throw new ApiError('No connection. Check your network and try again.', { code: 'NETWORK_ERROR' });
  }
  if (response.status === 401 || response.redirected) {
    throw new ApiError('Your session has ended. Reload the page to sign in again.', { status: 401 });
  }
  if (!response.ok)
    throw new ApiError('The page could not be refreshed. Reload it.', { status: response.status });
  return response.text();
}

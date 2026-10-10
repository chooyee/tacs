'use strict';

/**
 * Microsoft Entra ID sign-in (OIDC authorization code flow + PKCE) with `@azure/msal-node`
 * (docs/08 §1.2). The only file that talks to MSAL; `auth.service` holds the rules.
 *
 * Call the functions through the module object (`entra.exchangeCode(...)`) so tests can replace them.
 */
const fs = require('node:fs');
const msal = require('@azure/msal-node');
const config = require('../../config');
const { logger } = require('../../utils/logger');
const { ExternalServiceError } = require('../../utils/errors');

const SCOPES = ['openid', 'profile', 'email'];
const log = logger.child({ module: 'entra' });

let client; // created on first use, then reused

/** Build the MSAL client: client secret (dev / test) or certificate (production, preferred). */
function getClient() {
  if (client) return client;
  const { clientId, authority, clientSecret, certThumbprint, certPrivateKeyPath } = config.entra;
  const credential = clientSecret
    ? { clientSecret }
    : {
        clientCertificate: {
          thumbprintSha256: certThumbprint,
          privateKey: fs.readFileSync(certPrivateKeyPath, 'utf8'),
        },
      };
  client = new msal.ConfidentialClientApplication({
    auth: { clientId, authority, ...credential },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        logLevel: msal.LogLevel.Warning,
        loggerCallback: (level, message, containsPii) => {
          if (!containsPii) log.debug({ msalLevel: level }, message);
        },
      },
    },
  });
  return client;
}

/**
 * A new PKCE verifier + challenge for one sign-in.
 * @returns {Promise<{verifier: string, challenge: string}>}
 */
async function createPkce() {
  return new msal.CryptoProvider().generatePkceCodes();
}

/**
 * The Entra URL that starts the sign-in.
 * @param {{state: string, nonce: string, codeChallenge: string}} params
 * @returns {Promise<string>}
 * @throws {ExternalServiceError} if MSAL cannot build it (e.g. Entra metadata unreachable)
 */
async function buildAuthUrl({ state, nonce, codeChallenge }) {
  try {
    return await getClient().getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: config.entra.redirectUri,
      responseMode: 'query',
      state,
      nonce,
      codeChallenge,
      codeChallengeMethod: 'S256',
    });
  } catch (err) {
    throw new ExternalServiceError('We could not reach Microsoft sign-in. Please try again.', {
      code: 'SIGNIN_UNAVAILABLE',
      cause: err,
    });
  }
}

/**
 * Exchange the authorization code for the ID token. MSAL validates the signature, issuer, audience,
 * expiry and the nonce. We keep no tokens: only the ID token claims are returned.
 *
 * @param {{code: string, codeVerifier: string, nonce: string}} params
 * @returns {Promise<{oid?: string, name?: string, preferred_username?: string, email?: string}>}
 * @throws {ExternalServiceError} SIGNIN_FAILED
 */
async function exchangeCode({ code, codeVerifier, nonce }) {
  try {
    const result = await getClient().acquireTokenByCode({
      code,
      codeVerifier,
      nonce,
      scopes: SCOPES,
      redirectUri: config.entra.redirectUri,
    });
    // MSAL caches tokens per account; we never use them, so drop them to keep memory flat.
    if (result.account) await getClient().getTokenCache().removeAccount(result.account);
    return result.idTokenClaims ?? {};
  } catch (err) {
    throw new ExternalServiceError('We could not sign you in. Please try again.', {
      code: 'SIGNIN_FAILED',
      cause: err,
    });
  }
}

/**
 * Entra's sign-out URL; Entra sends the browser back to /auth/logged-out afterwards.
 * @returns {string}
 */
function logoutUrl() {
  const back = encodeURIComponent(`${config.baseUrl}/auth/logged-out`);
  return `${config.entra.authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${back}`;
}

module.exports = { createPkce, buildAuthUrl, exchangeCode, logoutUrl };

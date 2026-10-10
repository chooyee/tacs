'use strict';

const helmet = require('helmet');
const config = require('../config');

/**
 * Security headers via helmet, including the Content Security Policy of NFR-SEC-02.
 *
 * - No inline scripts or styles: page data goes in `<script type="application/json">` and is read
 *   with JSON.parse; all JS is in /public.
 * - `form-action` must include Entra: the sign-out form redirects there, and browsers check
 *   redirects after a form post against this list.
 * - HSTS and upgrade-insecure-requests only in production (local development runs on http).
 *
 * @type {import('express').RequestHandler}
 */
const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      workerSrc: ["'self'", 'blob:'], // pdf.js worker (M4)
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'", 'https://login.microsoftonline.com'],
      upgradeInsecureRequests: config.isProduction ? [] : null,
    },
  },
  strictTransportSecurity: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'same-origin' },
});

module.exports = { securityHeaders };

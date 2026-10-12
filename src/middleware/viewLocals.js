'use strict';

const config = require('../config');
const strings = require('../views/strings/en');
const icons = require('../views/icons');
const { sanitizeRichText } = require('../utils/richText');
const { version } = require('../../package.json');

/** Two-letter initials for the avatar button ("Dana Tan" → "DT"). */
function initialsOf(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The top bar's view model (docs/03 §2, FR-ACC-05). Computed when the page renders, so it sees the
 * `req.user` set by requireAuth.
 * @param {import('express').Request} req
 */
function buildNav(req) {
  const user = req.user;
  const isLocal = user?.kind === 'local';
  const mode = isLocal || req.path.startsWith('/admin') ? 'admin' : 'architect';
  const roleNames = (user?.roles ?? []).map((r) =>
    r === 'Admin' ? strings.topbar.roleAdmin : strings.topbar.roleArchitect,
  );
  return {
    mode,
    homeHref: mode === 'admin' ? '/admin/types' : '/papers',
    // Local admins only have Admin mode; Entra admins can switch.
    showModeSwitch: Boolean(user && !isLocal && user.roles.includes('Admin')),
    user: user && {
      name: user.name,
      email: user.email,
      initials: initialsOf(user.name),
      rolesLabel: isLocal ? strings.topbar.localAdmin : roleNames.join(' · '),
    },
  };
}

/**
 * Values every view can use: `t` (strings), `assetVersion` (cache busting), `nav` (top bar) and
 * `accessRequestText` (403 page). Registered early so error pages have them too.
 * @type {import('express').RequestHandler}
 */
function viewLocals(req, res, next) {
  res.locals.t = strings;
  res.locals.icons = icons; // for views/partials/icon.ejs
  res.locals.sanitizeRich = sanitizeRichText; // for views/partials/richText.ejs only (D-37)
  res.locals.assetVersion = version;
  res.locals.accessRequestText = config.access.requestText;
  Object.defineProperty(res.locals, 'nav', {
    enumerable: true,
    configurable: true,
    get: () => buildNav(req),
  });
  next();
}

module.exports = { viewLocals, buildNav };

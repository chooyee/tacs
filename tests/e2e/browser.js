'use strict';

/**
 * Browser test helpers (`npm run test:e2e`). The app runs in this process on a free port with the
 * test database / schema and in-memory file storage (NODE_ENV=test), and a real Chrome or Edge
 * drives it through puppeteer-core. Nothing touches your dev data or S3.
 *
 * Browser: CHROME_PATH if set, otherwise the usual Chrome / Edge install locations.
 */
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');
const { createApp } = require('../../src/app');
const localAdminModel = require('../../src/models/localAdmin.model');
const { hashPassword } = require('../../src/utils/password');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const ADMIN = { username: 'e2e-admin', password: 'e2e-password-123' };

/** First installed browser, or null (the tests are then skipped with a clear reason). */
function findBrowser() {
  return CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Start the app on a free port and launch the browser.
 * @param {{testAuth?: import('express').RequestHandler}} [opts]  tests/helpers/fakeAuth.js, to sign in Entra test users
 * @returns {Promise<{base: string, browser: import('puppeteer-core').Browser, close: () => Promise<void>}>}
 */
async function start({ testAuth } = {}) {
  const server = await new Promise((resolve) => {
    const s = createApp({ testAuth }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ['--no-sandbox'],
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    browser,
    close: async () => {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A new page that records script errors, console errors and failed requests in `page.problems`.
 * @param {import('puppeteer-core').Browser} browser
 * @param {{width?: number, height?: number, userId?: string}} [opts]  userId: sign in as this Entra user (needs start({ testAuth }))
 */
async function newPage(browser, { width = 1280, height = 900, userId } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  // With start({ testAuth }), this header signs the page in as an Entra user (tests/helpers/fakeAuth.js).
  if (userId) await page.setExtraHTTPHeaders({ 'x-test-user': userId });
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`script error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && page.problems.push(`console: ${m.text()}`));
  page.on('response', (r) => r.status() >= 400 && page.problems.push(`HTTP ${r.status()} ${r.url()}`));
  page.on('dialog', (d) => d.accept()); // window.confirm → OK
  return page;
}

/** Create the local admin used by the tests (after resetDb). */
async function createAdmin() {
  await localAdminModel.create({
    username: ADMIN.username,
    passwordHash: await hashPassword(ADMIN.password),
    createdBy: 'e2e',
    mustChangePassword: false,
  });
}

/** Sign in through the real local sign-in form. */
async function signIn(page, base) {
  await page.goto(`${base}/auth/local`);
  await page.type('#username', ADMIN.username);
  await page.type('#password', ADMIN.password);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
}

/** Wait until no fetch is in flight and the DOM settled (cards are re-rendered after each change). */
async function settle(page, ms = 400) {
  await page.waitForNetworkIdle({ idleTime: 150, timeout: 10_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, ms));
}

module.exports = { findBrowser, start, newPage, createAdmin, signIn, settle, ADMIN };

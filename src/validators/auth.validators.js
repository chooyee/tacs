'use strict';

const { z } = require('zod');

// Form fields arrive as strings; anything missing becomes '' so the service shows a friendly message.
const field = z.string().max(1000).catch('');

/** GET /auth/login and GET /auth/local — `returnTo` is checked again by the service. */
const loginQuerySchema = {
  query: z.object({ returnTo: z.string().max(2000).optional().catch(undefined) }).loose(),
};

/** POST /auth/local */
const localLoginSchema = {
  body: z
    .object({ username: field, password: field, returnTo: z.string().max(2000).optional().catch(undefined) })
    .loose(),
};

/** POST /auth/local/password */
const changePasswordSchema = { body: z.object({ password: field, confirm: field }).loose() };

module.exports = { loginQuerySchema, localLoginSchema, changePasswordSchema };

'use strict';

const { z } = require('zod');

// Missing fields become '' so the service answers with a friendly message.
const field = z.string().max(1000).catch('');

/** POST /setup */
const setupSchema = {
  body: z.object({ token: field, username: field, password: field, confirm: field }).loose(),
};

module.exports = { setupSchema };

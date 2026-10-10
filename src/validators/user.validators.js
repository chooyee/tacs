'use strict';

const { z } = require('zod');

/** PATCH /api/admin/users/:userId (FR-ACC-09) */
const updateUserSchema = {
  params: z.object({ userId: z.uuid() }),
  body: z
    .object({
      role: z.enum(['architect', 'admin']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
    })
    .strict()
    .refine((b) => b.role || b.status, { message: 'Send a role or a status.' }),
};

module.exports = { updateUserSchema };

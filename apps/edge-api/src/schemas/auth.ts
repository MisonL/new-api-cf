import { z } from 'zod';

export const loginRequestSchema = z.object({
  token: z.string().min(1)
});


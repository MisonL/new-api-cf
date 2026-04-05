import { z } from 'zod';

export const moderationsCreateRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1)
  ])
});

export type ModerationsCreateRequestInput = z.infer<typeof moderationsCreateRequestSchema>;

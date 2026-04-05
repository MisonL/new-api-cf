import { z } from 'zod';

export const completionCreateRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1)
  ]),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional()
});

export type CompletionCreateRequestInput = z.infer<typeof completionCreateRequestSchema>;

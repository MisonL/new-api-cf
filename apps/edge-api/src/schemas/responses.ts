import { z } from 'zod';

export const responseCreateRequestSchema = z.object({
  model: z.string().min(1),
  input: z.unknown(),
  instructions: z.string().optional(),
  stream: z.boolean().optional()
}).passthrough();

export type ResponseCreateRequestInput = z.infer<typeof responseCreateRequestSchema>;

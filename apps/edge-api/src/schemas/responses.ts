import { z } from 'zod';

export const responseCreateRequestSchema = z.object({
  model: z.string().min(1),
  input: z.unknown().optional(),
  instructions: z.string().optional(),
  previous_response_id: z.string().min(1).nullable().optional(),
  stream: z.boolean().optional()
}).passthrough();

export type ResponseCreateRequestInput = z.infer<typeof responseCreateRequestSchema>;

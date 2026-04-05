import { z } from 'zod';

export const imageGenerationRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  size: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  response_format: z.enum(['url', 'b64_json']).optional()
});

export type ImageGenerationRequestInput = z.infer<typeof imageGenerationRequestSchema>;

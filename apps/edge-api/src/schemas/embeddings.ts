import { z } from 'zod';

const embeddingInputSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.array(z.number()).min(1),
  z.array(z.array(z.number()).min(1)).min(1)
]);

export const embeddingsCreateRequestSchema = z.object({
  model: z.string().min(1),
  input: embeddingInputSchema,
  dimensions: z.number().int().positive().optional(),
  encoding_format: z.enum(['float', 'base64']).optional(),
  user: z.string().min(1).optional()
});

export type EmbeddingsCreateRequestInput = z.infer<typeof embeddingsCreateRequestSchema>;

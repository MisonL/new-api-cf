import { z } from 'zod';

export const speechCreateRequestSchema = z.object({
  model: z.string().min(1),
  input: z.string().min(1),
  voice: z.string().min(1),
  response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
  speed: z.number().positive().max(4).optional()
});

export type SpeechCreateRequestInput = z.infer<typeof speechCreateRequestSchema>;

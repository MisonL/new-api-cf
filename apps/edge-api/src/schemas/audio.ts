import { z } from 'zod';

export const speechCreateRequestSchema = z.object({
  model: z.string().min(1),
  input: z.string().min(1),
  voice: z.string().min(1),
  response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
  speed: z.number().positive().max(4).optional()
});

export type SpeechCreateRequestInput = z.infer<typeof speechCreateRequestSchema>;

const transcriptionFileSchema = z.custom<File>((value) => value instanceof File && value.size > 0, {
  message: 'file is required'
});

const transcriptionResponseFormatSchema = z.enum(['json', 'text', 'srt', 'verbose_json', 'vtt']);

export const transcriptionCreateRequestSchema = z.object({
  model: z.string().min(1),
  file: transcriptionFileSchema,
  language: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  response_format: transcriptionResponseFormatSchema.optional(),
  temperature: z.number().min(0).max(1).optional()
});

export type TranscriptionCreateRequestInput = z.infer<typeof transcriptionCreateRequestSchema>;

export function parseTranscriptionRequest(formData: FormData): TranscriptionCreateRequestInput {
  const rawTemperature = formData.get('temperature');
  return transcriptionCreateRequestSchema.parse({
    model: formData.get('model'),
    file: formData.get('file'),
    language: formData.get('language') || undefined,
    prompt: formData.get('prompt') || undefined,
    response_format: formData.get('response_format') || undefined,
    temperature: typeof rawTemperature === 'string' && rawTemperature.trim() ? Number(rawTemperature) : undefined
  });
}

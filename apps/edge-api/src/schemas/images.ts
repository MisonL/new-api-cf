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

const imageFileSchema = z.custom<File>((value) => value instanceof File && value.size > 0, {
  message: 'image file is required'
});

export const imageEditRequestSchema = z.object({
  model: z.string().min(1),
  image: imageFileSchema,
  prompt: z.string().min(1),
  mask: z.custom<File>((value) => value instanceof File && value.size > 0).optional(),
  size: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  response_format: z.enum(['url', 'b64_json']).optional()
});

export type ImageEditRequestInput = z.infer<typeof imageEditRequestSchema>;

export function parseImageEditRequest(formData: FormData): ImageEditRequestInput {
  return imageEditRequestSchema.parse({
    model: formData.get('model'),
    image: formData.get('image'),
    prompt: formData.get('prompt'),
    mask: formData.get('mask') || undefined,
    size: formData.get('size') || undefined,
    quality: formData.get('quality') || undefined,
    response_format: formData.get('response_format') || undefined
  });
}

export const imageVariationRequestSchema = z.object({
  model: z.string().min(1),
  image: imageFileSchema,
  size: z.string().min(1).optional(),
  response_format: z.enum(['url', 'b64_json']).optional()
});

export type ImageVariationRequestInput = z.infer<typeof imageVariationRequestSchema>;

export function parseImageVariationRequest(formData: FormData): ImageVariationRequestInput {
  return imageVariationRequestSchema.parse({
    model: formData.get('model'),
    image: formData.get('image'),
    size: formData.get('size') || undefined,
    response_format: formData.get('response_format') || undefined
  });
}

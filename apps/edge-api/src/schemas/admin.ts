import { z } from 'zod';

export const controlSettingsSchema = z.object({
  publicAppName: z.string().min(1).max(120),
  welcomeMessage: z.string().min(1).max(400),
  playgroundEnabled: z.boolean()
});

export const updateModelSchema = z.object({
  label: z.string().min(1).max(120),
  enabled: z.boolean(),
  upstreamProfileId: z.string().min(1).max(120)
});

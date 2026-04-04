import { z } from 'zod';
import { recordUsage, recordUsageBatch, type UsageActor, type UsageWriteInput } from './usage';

const usageEventSchema = z.object({
  usageDate: z.string().min(10).max(10),
  occurredAt: z.string().min(1),
  actor: z.object({
    kind: z.enum(['admin-session', 'api-token']),
    actorId: z.string().min(1)
  }),
  upstreamProfileId: z.string(),
  model: z.string().min(1),
  outcome: z.enum(['success', 'error']),
  statusCode: z.number().int()
});

type QueueEnv = Env & {
  USAGE_EVENTS?: Queue<UsageWriteInput>;
};

function now(): string {
  return new Date().toISOString();
}

function todayUtc(): string {
  return now().slice(0, 10);
}

function getUsageQueue(env: Env): Queue<UsageWriteInput> | null {
  return (env as QueueEnv).USAGE_EVENTS ?? null;
}

export function isUsageQueueConfigured(env: Env): boolean {
  return Boolean(getUsageQueue(env));
}

export async function dispatchUsageEvent(env: Env, input: {
  actor: UsageActor;
  upstreamProfileId: string;
  model: string;
  outcome: 'success' | 'error';
  statusCode: number;
}) {
  const queue = getUsageQueue(env);
  if (!queue) {
    await recordUsage(env, input);
    return;
  }

  const occurredAt = now();
  await queue.send({
    usageDate: todayUtc(),
    occurredAt,
    actor: input.actor,
    upstreamProfileId: input.upstreamProfileId,
    model: input.model,
    outcome: input.outcome,
    statusCode: input.statusCode
  });
}

export async function consumeUsageQueue(batch: MessageBatch<unknown>, env: Env) {
  const inputs = batch.messages.map((message) => usageEventSchema.parse(message.body));
  await recordUsageBatch(env, inputs);
}

import type {
  RuntimeConfig
} from './config';
import {
  getUpstreamProfileById
} from './config';
import type {
  UsageActorKind,
  UsageAggregateRow,
  UsageOverviewShape
} from '../../../../packages/shared/src/contracts';
import { execute, queryAll } from './d1';

type UsageOutcome = 'success' | 'error';

type UsageDailyRow = {
  usage_date: string;
  actor_kind: UsageActorKind;
  actor_id: string;
  actor_label: string;
  actor_last4: string | null;
  upstream_profile_id: string;
  model: string;
  request_count: number;
  success_count: number;
  error_count: number;
  last_status: number;
  updated_at: string;
};

export type UsageActor = {
  kind: UsageActorKind;
  actorId: string;
};

function resolveUsageProfileLabel(config: RuntimeConfig, upstreamProfileId: string): string {
  if (!upstreamProfileId) {
    return 'default profile';
  }

  return getUpstreamProfileById(config, upstreamProfileId)?.label || upstreamProfileId;
}

function now(): string {
  return new Date().toISOString();
}

function todayUtc(): string {
  return now().slice(0, 10);
}

function startDateUtc(windowDays: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (windowDays - 1));
  return date.toISOString().slice(0, 10);
}

function toUsageAggregateRow(config: RuntimeConfig, row: UsageDailyRow): UsageAggregateRow {
  return {
    usageDate: row.usage_date,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    actorLast4: row.actor_last4 ?? undefined,
    upstreamProfileId: row.upstream_profile_id,
    upstreamProfileLabel: resolveUsageProfileLabel(config, row.upstream_profile_id),
    model: row.model,
    requestCount: row.request_count,
    successCount: row.success_count,
    errorCount: row.error_count,
    lastStatus: row.last_status,
    updatedAt: row.updated_at
  };
}

export async function recordUsage(env: Env, input: {
  actor: UsageActor;
  upstreamProfileId: string;
  model: string;
  outcome: UsageOutcome;
  statusCode: number;
}) {
  if (!env.DB) {
    return;
  }

  const timestamp = now();
  const successDelta = input.outcome === 'success' ? 1 : 0;
  const errorDelta = input.outcome === 'error' ? 1 : 0;

  await execute(
    env,
    `INSERT INTO usage_daily (
       usage_date,
       actor_kind,
       actor_id,
       upstream_profile_id,
       model,
       request_count,
       success_count,
       error_count,
       last_status,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(usage_date, actor_kind, actor_id, upstream_profile_id, model) DO UPDATE SET
       request_count = usage_daily.request_count + 1,
       success_count = usage_daily.success_count + excluded.success_count,
       error_count = usage_daily.error_count + excluded.error_count,
       last_status = excluded.last_status,
       updated_at = excluded.updated_at`,
    todayUtc(),
    input.actor.kind,
    input.actor.actorId,
    input.upstreamProfileId,
    input.model,
    successDelta,
    errorDelta,
    input.statusCode,
    timestamp
  );
}

export async function getUsageOverview(
  env: Env,
  config: RuntimeConfig,
  windowDays: number
): Promise<UsageOverviewShape> {
  const rows = await queryAll<UsageDailyRow>(
    env,
    `SELECT
       usage_daily.usage_date,
       usage_daily.actor_kind,
       usage_daily.actor_id,
       CASE
         WHEN usage_daily.actor_kind = 'api-token' THEN COALESCE(api_tokens.name, 'deleted token')
         ELSE 'admin access'
       END AS actor_label,
       CASE
         WHEN usage_daily.actor_kind = 'api-token' THEN api_tokens.last4
         ELSE NULL
       END AS actor_last4,
       usage_daily.upstream_profile_id,
       usage_daily.model,
       usage_daily.request_count,
       usage_daily.success_count,
       usage_daily.error_count,
       usage_daily.last_status,
       usage_daily.updated_at
     FROM usage_daily
     LEFT JOIN api_tokens
       ON usage_daily.actor_kind = 'api-token'
      AND usage_daily.actor_id = api_tokens.id
     WHERE usage_daily.usage_date >= ?
     ORDER BY usage_daily.usage_date DESC, usage_daily.updated_at DESC, usage_daily.model ASC`,
    startDateUtc(windowDays)
  );

  const usageRows = rows.map((row) => toUsageAggregateRow(config, row));
  const actorKeys = new Set(usageRows.map((row) => `${row.actorKind}:${row.actorId}`));
  const models = new Set(usageRows.map((row) => row.model));

  return {
    windowDays,
    totals: {
      requestCount: usageRows.reduce((sum, row) => sum + row.requestCount, 0),
      successCount: usageRows.reduce((sum, row) => sum + row.successCount, 0),
      errorCount: usageRows.reduce((sum, row) => sum + row.errorCount, 0),
      activeActorCount: actorKeys.size,
      activeModelCount: models.size
    },
    rows: usageRows
  };
}

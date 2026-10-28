import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { NAME_RE } from './config';

const name = z.string().regex(NAME_RE);
const credential = z.string().min(32);
const coordinatorConfigSchema = z
  .object({
    id: name,
    host: z.string().min(1),
    port: z.number().int().min(0).max(65535),
    databaseUrl: z.string().regex(/^postgres(?:ql)?:\/\//),
    leaseTtlSec: z.number().int().min(15).max(900),
    clients: z.array(z.object({ id: name, token: credential, admin: z.boolean() })).min(1),
    workers: z
      .array(
        z.object({
          id: name,
          url: z
            .string()
            .url()
            .refine((value) => {
              try {
                const url = new URL(value);
                return (
                  ['http:', 'https:'].includes(url.protocol) &&
                  !url.username &&
                  !url.password &&
                  !url.search &&
                  !url.hash &&
                  url.pathname === '/'
                );
              } catch {
                return false;
              }
            }, 'worker URL must be an HTTP(S) origin')
            .transform((value) => new URL(value).origin),
          token: credential,
        }),
      )
      .min(1),
  })
  .superRefine((config, context) => {
    if (!config.clients.some((client) => client.admin)) {
      context.addIssue({ code: 'custom', message: 'an administrator client is required' });
    }
    for (const entries of [config.clients, config.workers]) {
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
        context.addIssue({ code: 'custom', message: 'duplicate identity' });
      }
      if (new Set(entries.map((entry) => entry.token)).size !== entries.length) {
        context.addIssue({ code: 'custom', message: 'credentials must be unique' });
      }
    }
    if (
      config.clients.some((client) =>
        config.workers.some((worker) => worker.token === client.token),
      )
    ) {
      context.addIssue({ code: 'custom', message: 'worker and client credentials must differ' });
    }
  });

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;
export type CoordinatorClient = CoordinatorConfig['clients'][number];
export type CoordinatorWorker = CoordinatorConfig['workers'][number];

export const workerInventorySchema = z.object({
  id: name,
  profiles: z
    .array(
      z.object({
        name,
        port: z.number().int().min(1).max(65535),
        labels: z.array(z.string()),
        enabled: z.boolean(),
        purpose: z.string().nullable(),
        state: z.enum(['stopped', 'starting', 'running', 'healthy', 'backoff', 'unreachable']),
        pid: z.number().int().nullable(),
        leasedBy: z.string().nullable(),
        lastError: z.string().nullable(),
        startedBy: z.object({ agent: z.string(), request: z.string(), at: z.string() }).nullable(),
      }),
    )
    .refine(
      (profiles) => new Set(profiles.map((profile) => profile.name)).size === profiles.length,
      'duplicate profile',
    ),
});

export async function loadCoordinatorConfig(file: string): Promise<CoordinatorConfig> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    const value = z.record(z.string(), z.unknown()).parse(parsed);
    return validateCoordinatorConfig({
      ...value,
      databaseUrl: process.env.HC_COORDINATOR_DATABASE_URL ?? value.databaseUrl,
    });
  } catch {
    throw new Error('unable to load valid coordinator configuration');
  }
}

export function validateCoordinatorConfig(config: unknown): CoordinatorConfig {
  const result = coordinatorConfigSchema.safeParse(config);
  // Configuration contains credentials; do not serialize input-bearing diagnostics.
  if (!result.success)
    throw new Error(
      'invalid coordinator configuration: check identities, credentials, worker origins, database URL and lease limits',
    );
  return result.data;
}

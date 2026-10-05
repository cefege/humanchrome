import { Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import { loadConfig, saveConfig, FleetConfig } from './config';
import { FleetLeases } from './leases';
import { ProfileSupervisor } from './supervisor';

export interface FleetMcpDeps {
  supervisor: ProfileSupervisor;
  leases: FleetLeases;
  /**
   * Frees the released agent's client lane inside the browser. The gateway
   * assigns this after construction because it needs its own route table.
   */
  releaseBridge: (agent: string, profile: string) => Promise<void>;
}
/**
 * Fleet control as MCP tools, served from its own endpoint (`/v1/fleet/mcp`)
 * rather than from the pool endpoint that fronts leased browsers: an agent gets
 * fleet control and a browser from two clearly-named URLs. Every tool name is
 * `fleet_`-prefixed so a client merging both servers cannot collide.
 *
 * Deliberately the low-level `Server` (like `src/mcp/mcp-server.ts`): these
 * tools carry raw JSON Schema and custom errors, which `McpServer.registerTool`'s
 * Standard Schema validation would reject.
 */
export const createFleetMcpServer = (deps: FleetMcpDeps): Server => {
  const server = new Server(
    { name: 'HumanChromeFleet', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler('tools/list', () => ({ tools: TOOLS }));

  server.setRequestHandler('tools/call', async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (request.params.name) {
        case 'fleet_profiles':
          return json(deps.supervisor.snapshot(leaseHolder(deps)));
        case 'fleet_profile':
          return await fleetProfile(deps, args);
        case 'fleet_leases':
          return await fleetLeases(deps, args);
        case 'fleet_purposes':
          return await fleetPurposes(deps);
        case 'fleet_park':
          return await fleetPark(deps, args);
        default:
          return failure(`unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      // Never throw out of a handler: an exception here surfaces to the client
      // as a protocol error rather than a tool result.
      return failure((error as Error).message);
    }
  });

  return server;
};

const leaseHolder =
  (deps: FleetMcpDeps) =>
  (profile: string): string | null =>
    deps.leases.list().find((lease) => lease.profile === profile)?.agent ?? null;

async function fleetProfile(
  deps: FleetMcpDeps,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const action = args.action;
  const name = args.name;
  if (typeof name !== 'string' || !name) return failure('`name` is required (string)');
  if (!deps.supervisor.state(name)) return failure(`unknown profile: ${name}`);
  if (action === 'start') await deps.supervisor.startProfile(name);
  else if (action === 'stop') await deps.supervisor.stopProfile(name);
  else if (action === 'restart') await deps.supervisor.restartProfile(name);
  else return failure(`unknown action: ${String(action)} — use start, stop or restart`);
  return json({ action, name });
}
async function fleetLeases(
  deps: FleetMcpDeps,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const action = args.action ?? 'list';
  if (action === 'list') return json({ leases: deps.leases.list() });
  if (action !== 'release') {
    return failure(`unknown action: ${String(action)} — use list or release`);
  }
  const agent = args.agent;
  if (typeof agent !== 'string' || !agent) return failure('`agent` is required for release');
  const released = deps.leases.release(agent);
  await Promise.all(released.map((profile) => deps.releaseBridge(agent, profile)));
  return json({ agent, released });
}

async function fleetPurposes(deps: FleetMcpDeps): Promise<CallToolResult> {
  const config = await loadConfig();
  // State comes from the live supervisor, never a fabricated `stopped`.
  const states = new Map(
    deps.supervisor.snapshot().map((entry) => [entry.name, entry.state] as const),
  );
  return json({
    purposes: config.profiles
      .filter((profile) => Boolean(profile.purpose))
      .map((profile) => ({
        purpose: profile.purpose,
        profile: profile.name,
        node: config.nodeId,
        state: states.get(profile.name) ?? 'unknown',
        labels: profile.labels,
      })),
  });
}

async function fleetPark(
  deps: FleetMcpDeps,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parked = args.parked;
  if (typeof parked !== 'boolean') return failure('`parked` is required (boolean)');
  const config: FleetConfig = await loadConfig();
  if (config.parked === parked) {
    return json({ parked, changed: false });
  }
  config.parked = parked;
  await saveConfig(config);
  await deps.supervisor.reload(config);
  return json({ parked, changed: true });
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const failure = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

export const TOOLS = [
  {
    name: 'fleet_profiles',
    description:
      'List every browser in the fleet with its state, lease holder and last failure. Start here.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'fleet_profile',
    description:
      'Start, stop or restart one browser. Restart loses its tabs and cookies stay on disk.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'restart'] },
        name: {
          type: 'string',
          description: 'Profile name, or nodeId:profile on a peer',
        },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet_leases',
    description: "List which agent holds which browser, or release one agent's holds.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'release'], default: 'list' },
        agent: { type: 'string', description: 'Required for release' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fleet_purposes',
    description: 'Map each purpose tag to the browser serving it.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'fleet_park',
    description: 'Stop every browser and keep them stopped, or start them all again.',
    inputSchema: {
      type: 'object' as const,
      properties: { parked: { type: 'boolean' } },
      required: ['parked'],
      additionalProperties: false,
    },
  },
] as unknown as Tool[];

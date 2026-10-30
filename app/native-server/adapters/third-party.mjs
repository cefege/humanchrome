import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

let traceDependencies;
let traceTail = Promise.resolve();
let activeQuery;
let outputTail = Promise.resolve();

function emit(id, event, value) {
  const line = `${JSON.stringify({ id, event, value })}\n`;
  outputTail = outputTail.then(() => new Promise((resolve, reject) => {
    process.stdout.write(line, (error) => error ? reject(error) : resolve());
  }));
  return outputTail;
}

function errorValue(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message : String(error),
  };
}

async function loadTraceDependencies() {
  traceDependencies ??= import('./devtools-engine.mjs').then((dependencies) => ({
    ...dependencies,
    engine: dependencies.TraceEngine.TraceModel.Model.createWithAllHandlers(),
  }));
  return traceDependencies;
}

// This is the existing DevTools formatter boundary, not a replacement summary.
export async function analyzeTraceFile(path, insightName) {
  const { TraceEngine, engine, PerformanceTraceFormatter, PerformanceInsightFormatter, AgentFocus } = await loadTraceDependencies();
  const json = JSON.parse(await readFile(path, 'utf8'));
  engine.resetProcessor();
  const events = Array.isArray(json) ? json : json.traceEvents;
  if (!events || !Array.isArray(events)) {
    throw new Error('Invalid trace format: expected array or {traceEvents: []}');
  }
  await engine.parse(events);
  const parsedTrace = engine.parsedTrace();
  const insights = parsedTrace?.insights ?? null;
  if (!parsedTrace) throw new Error('No parsed trace returned by engine');
  const focus = AgentFocus.fromParsedTrace(parsedTrace);
  const summary = new PerformanceTraceFormatter(focus).formatTraceSummary();
  if (insightName) {
    try {
      if (!insights) throw new Error('No insights available for this trace');
      const mainNavId = parsedTrace.data?.Meta?.mainFrameNavigations?.at(0)?.args?.data?.navigationId;
      const set = insights.get(mainNavId ?? TraceEngine.Types.Events.NO_NAVIGATION);
      if (!set) throw new Error('No insights for selected navigation');
      const model = set.model || {};
      if (!(insightName in model)) throw new Error(`Insight not found: ${insightName}`);
      const insight = new PerformanceInsightFormatter(focus, model[insightName]).formatInsight();
      return { summary, insight };
    } catch {
      // Existing behavior: a missing requested insight still returns the full summary.
      return { summary };
    }
  }
  return { summary };
}

async function executeClaude(id, params, controller) {
  const specifier = params.sdkRoot
    ? pathToFileURL(createRequire(resolve(params.sdkRoot, 'package.json')).resolve('@anthropic-ai/claude-agent-sdk')).href
    : '@anthropic-ai/claude-agent-sdk';
  const sdk = await import(specifier);
  if (typeof sdk.query !== 'function') {
    throw new Error('@anthropic-ai/claude-agent-sdk does not export query()');
  }
  const response = sdk.query({
    prompt: params.prompt,
    options: {
      ...params.options,
      abortController: controller,
      stderr: (value) => { void emit(id, 'stderr', value); },
    },
  });
  for await (const value of response) await emit(id, 'sdk_message', value);
  await emit(id, 'result', { completed: true });
}

async function dispatch({ id, method, params = {} }) {
  switch (method) {
    case 'claude.query': {
      if (activeQuery) throw new Error('A Claude query is already running in this adapter');
      const controller = new AbortController();
      const running = { id, controller, done: executeClaude(id, params, controller) };
      activeQuery = running;
      const clear = () => { if (activeQuery === running) activeQuery = undefined; };
      running.done.then(clear, clear);
      await running.done;
      return;
    }
    case 'claude.cancel': {
      const running = activeQuery;
      if (running?.id !== id) {
        await emit(id, 'result', { cancelled: false });
        return;
      }
      running.controller.abort();
      // The query error is emitted by its own request; cancellation acknowledges reaping readiness.
      await running.done.catch(() => undefined);
      await emit(id, 'result', { cancelled: true });
      return;
    }
    case 'trace.analyze': {
      // The retained DevTools model is mutable and must not parse overlapping traces.
      const operation = traceTail.then(() => analyzeTraceFile(params.path, params.insight));
      traceTail = operation.then(() => undefined, () => undefined);
      await emit(id, 'result', await operation);
      return;
    }
    default:
      throw new Error(`Unknown third-party adapter method: ${method}`);
  }
}

async function serve() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      await emit(null, 'error', errorValue(error));
      continue;
    }
    const operation = dispatch(request).catch((error) => emit(request.id, 'error', errorValue(error)));
    pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
  }
  await Promise.all(pending);
  await outputTail;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  await serve();
}

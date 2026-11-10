import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { AgentService, type AgentServiceOptions } from '../agent/clueAgent.js';
import { COMMANDER_ID, IDENTITY_MAX_BYTES } from '../agent/identityDocument.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.literal(COMMANDER_ID);
const validate = z.object({ id, text: z.string().min(1) }).strict();
const apply = validate.extend({ expectedHash: hash.nullable(), note: z.string().max(200).optional() }).strict();
const revert = z.object({ id, hash, expectedHash: hash.nullable() }).strict();
const line = z.object({ line: z.string().trim().min(1).max(4000) }).strict();
const legacy = z.object({
  message: z.string().trim().min(1).max(2048),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2048) }).strict()).max(8).optional(),
}).strict();
const test = z.object({ id }).strict();

interface AgentApiOptions extends AgentServiceOptions {
  readonly readBody: (request: IncomingMessage, maxBytes: number) => Promise<string>;
  readonly profileCurrent: () => boolean;
  readonly stopping: () => boolean;
  readonly local: boolean;
}

export function createAgentApi(options: AgentApiOptions) {
  let service: AgentService | null = null;
  const controllers = new Set<AbortController>();
  const current = (): boolean => !options.stopping() && options.profileCurrent();

  return {
    async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
      const legacyRoute = url.pathname === '/api/control/agent';
      if (!legacyRoute && !url.pathname.startsWith('/api/agent/')) return false;
      const route = legacyRoute ? 'console' : url.pathname.slice('/api/agent/'.length);
      const send = (status: number, body: unknown): true => {
        if (!response.destroyed) {
          response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify(body));
        }
        return true;
      };
      const problem = (status: number, code: string, reason: string): true =>
        send(status, legacyRoute ? { code, reply: reason } : { code, reason });
      const invalid = (): true => problem(400, 'AGENT_REQUEST_INVALID', 'The request does not match this agent route.');
      const stale = (): true => problem(409, 'DASHBOARD_RUNTIME_CHANGED', 'Project settings changed. Restart the dashboard before using CLUE.');
      if (!options.local) return problem(403, 'AGENT_LOCAL_ONLY', 'Use CLUE from the local dashboard.');
      if (!current()) return stale();

      let payload: unknown;
      if (request.method === 'POST') {
        if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return problem(415, 'AGENT_CONTENT_TYPE', 'The agent API requires JSON.');
        }
        const limit = route.startsWith('identity/') ? IDENTITY_MAX_BYTES * 6 + 1024 : 32 * 1024;
        let raw: string;
        try {
          raw = await options.readBody(request, limit);
        } catch {
          return problem(413, 'AGENT_BODY_LIMIT', 'The agent request is too large.');
        }
        try {
          payload = JSON.parse(raw);
        } catch {
          return invalid();
        }
        if (!current()) return stale();
      }

      try {
        const active = service ??= new AgentService(options);
        if (request.method === 'GET' && !legacyRoute) {
          if (route === 'state') return send(200, active.state());
          if (route === 'activity') {
            const after = Number(url.searchParams.get('after') ?? '0');
            return send(200, active.activity(Number.isSafeInteger(after) ? after : 0));
          }
          if (route === 'dialogue') return send(200, { turns: active.dialogue() });
          if (route === 'agents') return send(200, { agents: [COMMANDER_ID] });
          if (route === 'identity') {
            if ((url.searchParams.get('id') ?? COMMANDER_ID) !== COMMANDER_ID) return invalid();
            return send(200, active.readIdentity());
          }
          return problem(404, 'AGENT_ROUTE_UNKNOWN', 'No such agent route.');
        }
        if (request.method !== 'POST') return problem(405, 'AGENT_METHOD', 'Use GET or POST.');
        if (route === 'identity/validate') {
          const parsed = validate.safeParse(payload);
          if (!parsed.success) return invalid();
          const result = active.validateIdentity(parsed.data.text);
          return send(200, result.ok
            ? { valid: true, problems: [], version: result.identity.version, hash: result.identity.hash }
            : { valid: false, problems: result.problems });
        }
        if (route === 'identity/apply' || route === 'identity/revert') {
          const result = route === 'identity/apply'
            ? ((input) => input.success ? active.applyIdentity(input.data.text, input.data.expectedHash, input.data.note ?? '') : undefined)(apply.safeParse(payload))
            : ((input) => input.success ? active.revertIdentity(input.data.hash, input.data.expectedHash) : undefined)(revert.safeParse(payload));
          if (result === undefined) return invalid();
          return send(200, result.ok
            ? { ok: true, problems: [], version: result.identity.version, hash: result.identity.hash, previousHash: result.previousHash, unchanged: result.unchanged }
            : { ok: false, problems: result.problems });
        }
        if (route !== 'console' && route !== 'brain/test') return problem(404, 'AGENT_ROUTE_UNKNOWN', 'No such agent route.');
        const inputLine = route !== 'console' ? null : legacyRoute
          ? ((input) => input.success ? input.data.message : null)(legacy.safeParse(payload))
          : ((input) => input.success ? input.data.line : null)(line.safeParse(payload));
        if (route === 'console' && inputLine === null) return invalid();
        if (legacyRoute && inputLine?.startsWith('/') === true) {
          return problem(409, 'AGENT_REQUEST_REFUSED', 'Use the exact Q4 operator controls for slash commands.');
        }
        if (route === 'brain/test' && !test.safeParse(payload).success) return invalid();
        if (response.destroyed) return true;
        const controller = new AbortController();
        controllers.add(controller);
        const disconnected = (): void => controller.abort();
        response.once('close', disconnected);
        const monitor = setInterval(() => {
          if (!current()) controller.abort();
        }, 500);
        monitor.unref();
        try {
          if (inputLine === null) {
            const result = await active.testBrain(controller.signal);
            return current() ? send(200, result) : stale();
          }
          const result = await active.console(inputLine, controller.signal, current);
          if (!current()) return stale();
          if (legacyRoute) {
            const reply = result.lines.map((entry) => entry.text).join('\n');
            return result.ok ? send(200, { reply }) : problem(409, 'AGENT_REQUEST_REFUSED', reply);
          }
          return send(200, result);
        } finally {
          clearInterval(monitor);
          controllers.delete(controller);
          response.off('close', disconnected);
        }
      } catch {
        return problem(503, 'AGENT_UNAVAILABLE', 'The operator agent or its workspace journal could not be opened.');
      }
    },
    close(): void {
      for (const controller of controllers) controller.abort();
      service?.close();
      service = null;
    },
  };
}

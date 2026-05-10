/**
 * Session-scoped HTTP routes (IMP-0023 slice 1).
 *
 * Owns the /agent/sessions and /agent/projects/:projectId/sessions surfaces
 * plus per-session sub-resources (history, reset, claude-info). Extracted
 * from agent.ts as a Fastify-plugin-style registration so the orchestrator
 * just calls registerSessionRoutes(fastify).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HTTP_STATUS, ERROR_MESSAGES } from '../../../constant';
import { getProject } from '../../../agent/project-service';
import {
  deleteMessagesBySessionId,
  getMessagesBySessionId,
  getMessagesCountBySessionId,
} from '../../../agent/message-service';
import {
  createSession,
  deleteSession,
  getSession,
  getSessionsByProject,
  getSessionsByProjectAndEngine,
  getAllSessions,
  updateSession,
  type CreateSessionOptions,
  type UpdateSessionInput,
} from '../../../agent/session-service';
import type { EngineName } from '../../../agent/engines/types';

const VALID_ENGINE_NAMES: readonly EngineName[] = ['claude', 'codex', 'cursor', 'qwen', 'glm'];

function isValidEngineName(name: string): name is EngineName {
  return VALID_ENGINE_NAMES.includes(name as EngineName);
}

export function registerSessionRoutes(fastify: FastifyInstance): void {
  // List all sessions across all projects
  fastify.get('/agent/sessions', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const sessions = await getAllSessions();
      return reply.status(HTTP_STATUS.OK).send({ sessions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, 'Failed to list all sessions');
      return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
        error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
      });
    }
  });

  // List sessions for a project
  fastify.get(
    '/agent/projects/:projectId/sessions',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const { projectId } = request.params;
      if (!projectId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
      }

      try {
        const sessions = await getSessionsByProject(projectId);
        return reply.status(HTTP_STATUS.OK).send({ sessions });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to list sessions');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Create a new session for a project
  fastify.post(
    '/agent/projects/:projectId/sessions',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: CreateSessionOptions & { engineName: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      const body = request.body || {};

      if (!projectId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
      }
      if (!body.engineName) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'engineName is required' });
      }
      if (!isValidEngineName(body.engineName)) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({
          error: `Invalid engineName. Must be one of: ${VALID_ENGINE_NAMES.join(', ')}`,
        });
      }

      try {
        const project = await getProject(projectId);
        if (!project) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Project not found' });
        }

        const session = await createSession(projectId, body.engineName, {
          name: body.name,
          model: body.model,
          permissionMode: body.permissionMode,
          allowDangerouslySkipPermissions: body.allowDangerouslySkipPermissions,
          systemPromptConfig: body.systemPromptConfig,
          optionsConfig: body.optionsConfig,
        });
        return reply.status(HTTP_STATUS.CREATED).send({ session });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to create session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Get a specific session
  fastify.get(
    '/agent/sessions/:sessionId',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        const session = await getSession(sessionId);
        if (!session) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }
        return reply.status(HTTP_STATUS.OK).send({ session });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to get session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Update a session
  fastify.patch(
    '/agent/sessions/:sessionId',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Body: UpdateSessionInput;
      }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = request.params;
      const updates = request.body || {};

      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        const existing = await getSession(sessionId);
        if (!existing) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }

        await updateSession(sessionId, updates);
        const updated = await getSession(sessionId);
        return reply.status(HTTP_STATUS.OK).send({ session: updated });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to update session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Delete a session
  fastify.delete(
    '/agent/sessions/:sessionId',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        await deleteSession(sessionId);
        return reply.status(HTTP_STATUS.NO_CONTENT).send();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to delete session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Get message history for a session
  fastify.get(
    '/agent/sessions/:sessionId/history',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Querystring: { limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      const limitRaw = request.query.limit;
      const offsetRaw = request.query.offset;
      const limit = Number.parseInt(limitRaw || '', 10);
      const offset = Number.parseInt(offsetRaw || '', 10);
      const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
      const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

      try {
        const session = await getSession(sessionId);
        if (!session) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }

        const [messages, totalCount] = await Promise.all([
          getMessagesBySessionId(sessionId, safeLimit, safeOffset),
          getMessagesCountBySessionId(sessionId),
        ]);

        return reply.status(HTTP_STATUS.OK).send({
          success: true,
          sessionId,
          messages,
          totalCount,
          pagination: {
            limit: safeLimit,
            offset: safeOffset,
            count: messages.length,
            hasMore: safeLimit > 0 ? safeOffset + messages.length < totalCount : false,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to get session history');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Reset a session conversation (clear messages + engineSessionId)
  fastify.post(
    '/agent/sessions/:sessionId/reset',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        const existing = await getSession(sessionId);
        if (!existing) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }

        // Clear resume state first, then delete messages
        await updateSession(sessionId, { engineSessionId: null });
        const deletedMessages = await deleteMessagesBySessionId(sessionId);
        const updated = await getSession(sessionId);

        return reply.status(HTTP_STATUS.OK).send({
          success: true,
          sessionId,
          deletedMessages,
          clearedEngineSessionId: Boolean(existing.engineSessionId),
          session: updated || null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to reset session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Get Claude management info for a session
  fastify.get(
    '/agent/sessions/:sessionId/claude-info',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        const session = await getSession(sessionId);
        if (!session) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }

        return reply.status(HTTP_STATUS.OK).send({
          managementInfo: session.managementInfo || null,
          sessionId,
          engineName: session.engineName,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to get Claude info');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Get aggregated Claude management info for a project
  // Returns the most recent management info from any Claude session in the project.
  fastify.get(
    '/agent/projects/:projectId/claude-info',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const { projectId } = request.params;
      if (!projectId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
      }

      try {
        const project = await getProject(projectId);
        if (!project) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Project not found' });
        }

        // Get only Claude sessions (more efficient than fetching all and filtering)
        const claudeSessions = await getSessionsByProjectAndEngine(projectId, 'claude');
        const sessionsWithInfo = claudeSessions.filter((s) => s.managementInfo);

        // Sort by lastUpdated in management info (fallback to session.updatedAt for old data)
        sessionsWithInfo.sort((a, b) => {
          const aTime = a.managementInfo?.lastUpdated || a.updatedAt || '';
          const bTime = b.managementInfo?.lastUpdated || b.updatedAt || '';
          return bTime.localeCompare(aTime);
        });

        const latestInfo = sessionsWithInfo[0]?.managementInfo || null;
        const sourceSessionId = sessionsWithInfo[0]?.id;

        return reply.status(HTTP_STATUS.OK).send({
          managementInfo: latestInfo,
          sourceSessionId,
          projectId,
          sessionsWithInfo: sessionsWithInfo.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to get project Claude info');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );
}

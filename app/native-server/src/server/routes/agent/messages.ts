/**
 * Chat-message HTTP routes (IMP-0023 slice 2).
 *
 * Owns the /agent/chat/:projectId/messages surface (list + create + delete).
 * Extracted from agent.ts as a Fastify-plugin-style registration.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HTTP_STATUS, ERROR_MESSAGES } from '../../../constant';
import {
  createMessage as createStoredMessage,
  deleteMessagesByProjectId,
  getMessagesByProjectId,
  getMessagesCountByProjectId,
} from '../../../agent/message-service';

export function registerMessageRoutes(fastify: FastifyInstance): void {
  fastify.get(
    '/agent/chat/:projectId/messages',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Querystring: { limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      if (!projectId) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
        return;
      }

      const limitRaw = request.query.limit;
      const offsetRaw = request.query.offset;
      const limit = Number.parseInt(limitRaw || '', 10);
      const offset = Number.parseInt(offsetRaw || '', 10);
      const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
      const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

      try {
        const [messages, totalCount] = await Promise.all([
          getMessagesByProjectId(projectId, safeLimit, safeOffset),
          getMessagesCountByProjectId(projectId),
        ]);

        reply.status(HTTP_STATUS.OK).send({
          success: true,
          data: messages,
          totalCount,
          pagination: {
            limit: safeLimit,
            offset: safeOffset,
            count: messages.length,
            hasMore: safeOffset + messages.length < totalCount,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to load agent chat messages');
        reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: 'Failed to fetch messages',
          message: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  fastify.post(
    '/agent/chat/:projectId/messages',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: {
          content?: string;
          role?: string;
          messageType?: string;
          conversationId?: string;
          sessionId?: string;
          cliSource?: string;
          metadata?: Record<string, unknown>;
          requestId?: string;
          id?: string;
          createdAt?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      if (!projectId) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
        return;
      }

      const body = request.body || {};
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) {
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'content is required' });
        return;
      }

      const rawRole = typeof body.role === 'string' ? body.role.toLowerCase().trim() : 'user';
      const role: 'assistant' | 'user' | 'system' | 'tool' =
        rawRole === 'assistant' || rawRole === 'system' || rawRole === 'tool'
          ? (rawRole as 'assistant' | 'system' | 'tool')
          : 'user';

      const rawType = typeof body.messageType === 'string' ? body.messageType.toLowerCase() : '';
      const allowedTypes = ['chat', 'tool_use', 'tool_result', 'status'] as const;
      const fallbackType: (typeof allowedTypes)[number] = role === 'system' ? 'status' : 'chat';
      const messageType =
        (allowedTypes as readonly string[]).includes(rawType) && rawType
          ? (rawType as (typeof allowedTypes)[number])
          : fallbackType;

      try {
        const stored = await createStoredMessage({
          projectId,
          role,
          messageType,
          content,
          metadata: body.metadata,
          sessionId: body.sessionId,
          conversationId: body.conversationId,
          cliSource: body.cliSource,
          requestId: body.requestId,
          id: body.id,
          createdAt: body.createdAt,
        });

        reply.status(HTTP_STATUS.CREATED).send({ success: true, data: stored });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to create agent chat message');
        reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: 'Failed to create message',
          message: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  fastify.delete(
    '/agent/chat/:projectId/messages',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Querystring: { conversationId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      if (!projectId) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
        return;
      }

      const { conversationId } = request.query;

      try {
        const deleted = await deleteMessagesByProjectId(projectId, conversationId || undefined);
        reply.status(HTTP_STATUS.OK).send({ success: true, deleted });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to delete agent chat messages');
        reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: 'Failed to delete messages',
          message: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );
}

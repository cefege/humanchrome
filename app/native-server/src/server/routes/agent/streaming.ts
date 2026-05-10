/**
 * Chat streaming + action HTTP routes (IMP-0023 slice 3).
 *
 * Owns:
 *   - GET /agent/chat/:sessionId/stream — SSE event stream
 *   - POST /agent/chat/:sessionId/act — submit a turn (image-attachment-aware
 *     50 MB body limit)
 *   - DELETE /agent/chat/:sessionId/cancel(/:requestId)? — cancel one or all
 *
 * Streaming + cancel are the runtime-hot paths; keeping them in their own
 * module means SSE work doesn't sit behind 600 lines of CRUD.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HTTP_STATUS, ERROR_MESSAGES } from '../../../constant';
import { AgentStreamManager } from '../../../agent/stream-manager';
import { AgentChatService } from '../../../agent/chat-service';
import type { AgentActRequest, AgentActResponse, RealtimeEvent } from '../../../agent/types';

export interface StreamingRoutesOptions {
  streamManager: AgentStreamManager;
  chatService: AgentChatService;
}

export function registerStreamingRoutes(
  fastify: FastifyInstance,
  options: StreamingRoutesOptions,
): void {
  const { streamManager, chatService } = options;

  fastify.get(
    '/agent/chat/:sessionId/stream',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: 'sessionId is required for agent stream' });
        return;
      }

      try {
        reply.raw.writeHead(HTTP_STATUS.OK, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        // Ensure client immediately receives an open event
        reply.raw.write(':\n\n');

        streamManager.addSseStream(sessionId, reply.raw);

        const connectedEvent: RealtimeEvent = {
          type: 'connected',
          data: {
            sessionId,
            transport: 'sse',
            timestamp: new Date().toISOString(),
          },
        };
        streamManager.publish(connectedEvent);

        reply.raw.on('close', () => {
          streamManager.removeSseStream(sessionId, reply.raw);
        });
      } catch {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    },
  );

  fastify.post(
    '/agent/chat/:sessionId/act',
    {
      // 50 MB body cap supports multiple base64-encoded image attachments
      // (Fastify's 1 MB default is too small for the act-with-images flow).
      config: {
        rawBody: false,
      },
      bodyLimit: 50 * 1024 * 1024,
    },
    async (
      request: FastifyRequest<{ Params: { sessionId: string }; Body: AgentActRequest }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = request.params;
      const payload = request.body;

      if (!sessionId) {
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: 'sessionId is required for agent act' });
        return;
      }

      try {
        const { requestId } = await chatService.handleAct(sessionId, payload);
        const response: AgentActResponse = {
          requestId,
          sessionId,
          status: 'accepted',
        };
        reply.status(HTTP_STATUS.OK).send(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    },
  );

  // Cancel specific request
  fastify.delete(
    '/agent/chat/:sessionId/cancel/:requestId',
    async (
      request: FastifyRequest<{ Params: { sessionId: string; requestId: string } }>,
      reply: FastifyReply,
    ) => {
      const { sessionId, requestId } = request.params;

      if (!sessionId || !requestId) {
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: 'sessionId and requestId are required' });
        return;
      }

      const cancelled = chatService.cancelExecution(requestId);
      if (cancelled) {
        reply.status(HTTP_STATUS.OK).send({
          success: true,
          message: 'Execution cancelled',
          requestId,
          sessionId,
        });
      } else {
        reply.status(HTTP_STATUS.OK).send({
          success: false,
          message: 'No running execution found with this requestId',
          requestId,
          sessionId,
        });
      }
    },
  );

  // Cancel all executions for a session
  fastify.delete(
    '/agent/chat/:sessionId/cancel',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;

      if (!sessionId) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
        return;
      }

      const cancelledCount = chatService.cancelSessionExecutions(sessionId);
      reply.status(HTTP_STATUS.OK).send({
        success: true,
        cancelledCount,
        sessionId,
      });
    },
  );
}

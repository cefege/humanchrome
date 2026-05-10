/**
 * Agent Routes - All agent-related HTTP endpoints.
 *
 * Handles:
 * - Projects CRUD
 * - Chat messages CRUD
 * - Chat streaming (SSE)
 * - Chat actions (act, cancel)
 * - Engine listing
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HTTP_STATUS, ERROR_MESSAGES } from '../../constant';
import { AgentStreamManager } from '../../agent/stream-manager';
import { AgentChatService } from '../../agent/chat-service';
import { getSession } from '../../agent/session-service';
import { getProject } from '../../agent/project-service';
import { registerProjectRoutes } from './agent/projects';
import { registerAttachmentRoutes } from './agent/attachments';
import { registerSessionRoutes } from './agent/sessions';
import { registerMessageRoutes } from './agent/messages';
import { registerStreamingRoutes } from './agent/streaming';
import { openProjectDirectory, openFileInVSCode } from '../../agent/open-project';
import type { OpenProjectRequest, OpenProjectTarget } from 'humanchrome-shared';

// Valid open project targets
const VALID_OPEN_TARGETS: readonly OpenProjectTarget[] = ['vscode', 'terminal'];

function isValidOpenTarget(target: string): target is OpenProjectTarget {
  return VALID_OPEN_TARGETS.includes(target as OpenProjectTarget);
}

// ============================================================
// Types
// ============================================================

export interface AgentRoutesOptions {
  streamManager: AgentStreamManager;
  chatService: AgentChatService;
}

// ============================================================
// Route Registration
// ============================================================

/**
 * Register all agent-related routes on the Fastify instance.
 */
export function registerAgentRoutes(fastify: FastifyInstance, options: AgentRoutesOptions): void {
  const { streamManager, chatService } = options;

  // ============================================================
  // Engine Routes
  // ============================================================

  fastify.get('/agent/engines', async (_request, reply) => {
    try {
      const engines = chatService.getEngineInfos();
      reply.status(HTTP_STATUS.OK).send({ engines });
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to list agent engines');
      if (!reply.sent) {
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    }
  });

  // ============================================================
  // Project Routes (delegated to ./agent/projects)
  // ============================================================
  registerProjectRoutes(fastify);

  // ============================================================
  // Session Routes (delegated to ./agent/sessions — IMP-0023 slice 1)
  // ============================================================
  registerSessionRoutes(fastify);

  // ============================================================
  // Chat Message Routes (delegated to ./agent/messages — IMP-0023 slice 2)
  // ============================================================
  registerMessageRoutes(fastify);

  // ============================================================
  // Open Project Routes
  // ============================================================

  /**
   * POST /agent/sessions/:sessionId/open
   * Open session's project directory in VSCode or terminal.
   */
  fastify.post(
    '/agent/sessions/:sessionId/open',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Body: OpenProjectRequest;
      }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = request.params;
      const { target } = request.body || {};

      if (!sessionId) {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'sessionId is required' });
      }
      if (!target || typeof target !== 'string') {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'target is required' });
      }
      if (!isValidOpenTarget(target)) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({
          success: false,
          error: `Invalid target. Must be one of: ${VALID_OPEN_TARGETS.join(', ')}`,
        });
      }

      try {
        // Get session and its project
        const session = await getSession(sessionId);
        if (!session) {
          return reply
            .status(HTTP_STATUS.NOT_FOUND)
            .send({ success: false, error: 'Session not found' });
        }

        const project = await getProject(session.projectId);
        if (!project) {
          return reply
            .status(HTTP_STATUS.NOT_FOUND)
            .send({ success: false, error: 'Project not found' });
        }

        // Open the project directory
        const result = await openProjectDirectory(project.rootPath, target);
        if (result.success) {
          return reply.status(HTTP_STATUS.OK).send({ success: true });
        }
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: result.error,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to open session project');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  /**
   * POST /agent/projects/:projectId/open
   * Open project directory in VSCode or terminal.
   */
  fastify.post(
    '/agent/projects/:projectId/open',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: OpenProjectRequest;
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      const { target } = request.body || {};

      if (!projectId) {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'projectId is required' });
      }
      if (!target || typeof target !== 'string') {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'target is required' });
      }
      if (!isValidOpenTarget(target)) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({
          success: false,
          error: `Invalid target. Must be one of: ${VALID_OPEN_TARGETS.join(', ')}`,
        });
      }

      try {
        const project = await getProject(projectId);
        if (!project) {
          return reply
            .status(HTTP_STATUS.NOT_FOUND)
            .send({ success: false, error: 'Project not found' });
        }

        // Open the project directory
        const result = await openProjectDirectory(project.rootPath, target);
        if (result.success) {
          return reply.status(HTTP_STATUS.OK).send({ success: true });
        }
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: result.error,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to open project');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  /**
   * POST /agent/projects/:projectId/open-file
   * Open a file in VSCode at a specific line/column.
   *
   * Request body:
   * - filePath: string (required) - File path (relative or absolute)
   * - line?: number - Line number (1-based)
   * - column?: number - Column number (1-based)
   */
  fastify.post(
    '/agent/projects/:projectId/open-file',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: { filePath?: string; line?: number; column?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      const { filePath, line, column } = request.body || {};

      if (!projectId) {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'projectId is required' });
      }
      if (!filePath || typeof filePath !== 'string') {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'filePath is required' });
      }

      try {
        const project = await getProject(projectId);
        if (!project) {
          return reply
            .status(HTTP_STATUS.NOT_FOUND)
            .send({ success: false, error: 'Project not found' });
        }

        // Open the file in VSCode
        const result = await openFileInVSCode(project.rootPath, filePath, line, column);
        if (result.success) {
          return reply.status(HTTP_STATUS.OK).send({ success: true });
        }
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: result.error,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to open file in VSCode');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // ============================================================
  // Chat Streaming + Action Routes (delegated to ./agent/streaming — IMP-0023 slice 3)
  // ============================================================
  registerStreamingRoutes(fastify, { streamManager, chatService });

  // ============================================================
  // Attachment Routes (delegated to ./agent/attachments)
  // ============================================================
  registerAttachmentRoutes(fastify);
}

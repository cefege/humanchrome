/**
 * Agent attachment routes — stats, file serving, and cleanup.
 *
 * Surface: 4 endpoints under `/agent/attachments`:
 *   - GET    /agent/attachments/stats              — per-project byte/file counts
 *   - GET    /agent/attachments/:projectId/:filename — serve an attachment
 *   - DELETE /agent/attachments/:projectId         — clean up one project's attachments
 *   - DELETE /agent/attachments                    — clean up all (or selected) projects
 *
 * The stats endpoint joins against `listProjects()` so the response can
 * enrich each project entry with its display name and flag rows whose
 * directory exists on disk but whose project record has been deleted
 * ("orphan" rows the UI surfaces for cleanup).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HTTP_STATUS, ERROR_MESSAGES } from '../../../constant';
import { attachmentService, extToMimeType } from '../../../agent/attachment-service';
import { listProjects } from '../../../agent/project-service';
import type {
  AttachmentStatsResponse,
  AttachmentCleanupRequest,
  AttachmentCleanupResponse,
} from 'humanchrome-shared';

export function registerAttachmentRoutes(fastify: FastifyInstance): void {
  /**
   * GET /agent/attachments/stats
   * Get statistics for all attachment caches.
   */
  fastify.get('/agent/attachments/stats', async (_request, reply) => {
    try {
      const [stats, projects] = await Promise.all([
        attachmentService.getAttachmentStats(),
        listProjects(),
      ]);

      const projectMap = new Map(projects.map((p) => [p.id, p.name]));
      const dbProjectIds = new Set(projects.map((p) => p.id));

      const enrichedProjects: AttachmentStatsResponse['projects'] = [];
      const orphanProjectIds: string[] = [];
      for (const p of stats.projects) {
        const existsInDb = dbProjectIds.has(p.projectId);
        enrichedProjects.push({
          ...p,
          projectName: projectMap.get(p.projectId),
          existsInDb,
        });
        if (!existsInDb) orphanProjectIds.push(p.projectId);
      }

      const response: AttachmentStatsResponse = {
        success: true,
        rootDir: stats.rootDir,
        totalFiles: stats.totalFiles,
        totalBytes: stats.totalBytes,
        projects: enrichedProjects,
        orphanProjectIds,
      };

      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to get attachment stats');
      reply
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
    }
  });

  /**
   * GET /agent/attachments/:projectId/:filename
   * Serve an attachment file.
   */
  fastify.get(
    '/agent/attachments/:projectId/:filename',
    async (
      request: FastifyRequest<{ Params: { projectId: string; filename: string } }>,
      reply: FastifyReply,
    ) => {
      const { projectId, filename } = request.params;

      try {
        const buffer = await attachmentService.readAttachment(projectId, filename);

        const ext = filename.split('.').pop() ?? '';
        const contentType = extToMimeType(ext) ?? 'application/octet-stream';

        reply
          .header('Content-Type', contentType)
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          .send(buffer);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('Invalid') || message.includes('traversal')) {
          reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
          return;
        }

        // File not found or read error
        reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Attachment not found' });
      }
    },
  );

  /**
   * DELETE /agent/attachments/:projectId
   * Clean up attachments for a specific project.
   */
  fastify.delete(
    '/agent/attachments/:projectId',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const { projectId } = request.params;

      try {
        const result = await attachmentService.cleanupAttachments({ projectIds: [projectId] });

        const response: AttachmentCleanupResponse = {
          success: true,
          scope: 'project',
          removedFiles: result.removedFiles,
          removedBytes: result.removedBytes,
          results: result.results,
        };

        reply.status(HTTP_STATUS.OK).send(response);
      } catch (error) {
        fastify.log.error({ err: error }, 'Failed to cleanup project attachments');
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    },
  );

  /**
   * DELETE /agent/attachments
   * Clean up attachments for all or selected projects.
   */
  fastify.delete(
    '/agent/attachments',
    async (request: FastifyRequest<{ Body?: AttachmentCleanupRequest }>, reply: FastifyReply) => {
      try {
        const body = request.body;
        const projectIds = body?.projectIds;

        const result = await attachmentService.cleanupAttachments(
          projectIds ? { projectIds } : undefined,
        );

        const scope = projectIds && projectIds.length > 0 ? 'selected' : 'all';

        const response: AttachmentCleanupResponse = {
          success: true,
          scope,
          removedFiles: result.removedFiles,
          removedBytes: result.removedBytes,
          results: result.results,
        };

        reply.status(HTTP_STATUS.OK).send(response);
      } catch (error) {
        fastify.log.error({ err: error }, 'Failed to cleanup attachments');
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    },
  );
}

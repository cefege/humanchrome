/**
 * Agent project routes — CRUD + filesystem helpers.
 *
 * Surface: 8 endpoints under `/agent/projects`:
 *   - GET    /agent/projects                       — list
 *   - POST   /agent/projects                       — upsert (create or update by name)
 *   - DELETE /agent/projects/:id                   — delete by id
 *   - POST   /agent/projects/validate-path         — check whether a rootPath is usable
 *   - POST   /agent/projects/create-directory      — mkdir at an absolute path
 *   - GET    /agent/projects/default-workspace     — bridge's default workspace dir
 *   - POST   /agent/projects/default-root          — derive a default rootPath for a project name
 *   - POST   /agent/projects/pick-directory        — show OS directory picker
 *
 * Stateless — depends on `project-service`, `storage`, and the OS
 * directory picker. No shared in-memory state with other agent routes.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HTTP_STATUS, ERROR_MESSAGES } from '../../../constant';
import type { CreateOrUpdateProjectInput } from '../../../agent/project-types';
import {
  createProjectDirectory,
  deleteProject,
  listProjects,
  upsertProject,
  validateRootPath,
} from '../../../agent/project-service';
import { getDefaultWorkspaceDir, getDefaultProjectRoot } from '../../../agent/storage';
import { openDirectoryPicker } from '../../../agent/directory-picker';

export function registerProjectRoutes(fastify: FastifyInstance): void {
  fastify.get('/agent/projects', async (_request, reply) => {
    try {
      const projects = await listProjects();
      reply.status(HTTP_STATUS.OK).send({ projects });
    } catch (error) {
      if (!reply.sent) {
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    }
  });

  fastify.post(
    '/agent/projects',
    async (request: FastifyRequest<{ Body: CreateOrUpdateProjectInput }>, reply: FastifyReply) => {
      try {
        const body = request.body;
        if (!body || !body.name || !body.rootPath) {
          reply
            .status(HTTP_STATUS.BAD_REQUEST)
            .send({ error: 'name and rootPath are required to create a project' });
          return;
        }
        const project = await upsertProject(body);
        reply.status(HTTP_STATUS.OK).send({ project });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    },
  );

  fastify.delete(
    '/agent/projects/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      if (!id) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'project id is required' });
        return;
      }
      try {
        await deleteProject(id);
        reply.status(HTTP_STATUS.NO_CONTENT).send();
      } catch (error) {
        if (!reply.sent) {
          reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
        }
      }
    },
  );

  // Path validation API
  fastify.post(
    '/agent/projects/validate-path',
    async (request: FastifyRequest<{ Body: { rootPath: string } }>, reply: FastifyReply) => {
      const { rootPath } = request.body || {};
      if (!rootPath || typeof rootPath !== 'string') {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'rootPath is required' });
      }
      try {
        const result = await validateRootPath(rootPath);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({ error: message });
      }
    },
  );

  // Create directory API
  fastify.post(
    '/agent/projects/create-directory',
    async (request: FastifyRequest<{ Body: { absolutePath: string } }>, reply: FastifyReply) => {
      const { absolutePath } = request.body || {};
      if (!absolutePath || typeof absolutePath !== 'string') {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'absolutePath is required' });
      }
      try {
        await createProjectDirectory(absolutePath);
        return reply.send({ success: true, path: absolutePath });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
      }
    },
  );

  // Get default workspace directory
  fastify.get('/agent/projects/default-workspace', async (_request, reply) => {
    try {
      const workspaceDir = getDefaultWorkspaceDir();
      return reply.send({ success: true, path: workspaceDir });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({ error: message });
    }
  });

  // Get default project root for a given project name
  fastify.post(
    '/agent/projects/default-root',
    async (request: FastifyRequest<{ Body: { projectName: string } }>, reply: FastifyReply) => {
      const { projectName } = request.body || {};
      if (!projectName || typeof projectName !== 'string') {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectName is required' });
      }
      try {
        const rootPath = getDefaultProjectRoot(projectName);
        return reply.send({ success: true, path: rootPath });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({ error: message });
      }
    },
  );

  // Open directory picker dialog
  fastify.post('/agent/projects/pick-directory', async (_request, reply) => {
    try {
      const result = await openDirectoryPicker('Select Project Directory');
      if (result.success && result.path) {
        return reply.send({ success: true, path: result.path });
      } else if (result.cancelled) {
        return reply.send({ success: false, cancelled: true });
      } else {
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: result.error || 'Failed to open directory picker',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({ error: message });
    }
  });
}

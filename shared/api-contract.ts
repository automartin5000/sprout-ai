import { z } from 'zod';

export const HarnessIdSchema = z.enum(['copilot', 'claude', 'openai', 'mock']);
export type HarnessId = z.infer<typeof HarnessIdSchema>;

export const ProjectSchema = z.object({
  projectId: z.string().min(1),
  ownerSub: z.string().min(1),
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120),
  createdAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime().optional(),
  harnessId: HarnessIdSchema.default('copilot'),
  modelId: z.string().optional(),
  pluginOverrides: z.array(z.string()).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectInput = ProjectSchema.pick({
  name: true,
  slug: true,
}).extend({
  harnessId: HarnessIdSchema.optional(),
  modelId: z.string().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const UpdateProjectStateInput = z.object({
  lastOpenedAt: z.string().datetime().optional(),
  harnessId: HarnessIdSchema.optional(),
  modelId: z.string().optional(),
  pluginOverrides: z.array(z.string()).optional(),
});
export type UpdateProjectStateInput = z.infer<typeof UpdateProjectStateInput>;

export const ChatRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export const ChatTurnSchema = z.object({
  turnId: z.string().min(1),
  projectId: z.string().min(1),
  role: ChatRoleSchema,
  content: z.string(),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    output: z.unknown().optional(),
    isError: z.boolean().optional(),
  })).default([]),
  selfHealing: z.boolean().optional(),
  ts: z.string().datetime(),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export const AppendChatTurnInput = ChatTurnSchema.omit({
  turnId: true,
  projectId: true,
  ts: true,
}).extend({
  turnId: z.string().min(1).optional(),
});
export type AppendChatTurnInput = z.infer<typeof AppendChatTurnInput>;

export const ChatPageSchema = z.object({
  turns: z.array(ChatTurnSchema),
  nextCursor: z.string().optional(),
});
export type ChatPage = z.infer<typeof ChatPageSchema>;

export const ShareGrantsSchema = z.enum(['view', 'edit']);
export type ShareGrants = z.infer<typeof ShareGrantsSchema>;

export const ShareSchema = z.object({
  /** Canonical short code used for /share/:code routes. */
  code: z.string().min(1),
  /** @deprecated retained for backward compatibility with v1 callers; mirrors `code`. */
  token: z.string().min(1).optional(),
  projectId: z.string().min(1),
  ownerSub: z.string().min(1),
  grants: ShareGrantsSchema.default('edit'),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});
export type Share = z.infer<typeof ShareSchema>;

export const CreateShareInput = z.object({
  projectId: z.string().min(1),
  ttlSeconds: z.number().int().positive().max(60 * 60 * 24 * 30).optional(),
});
export type CreateShareInput = z.infer<typeof CreateShareInput>;

/**
 * Input for the per-project share mint route — POST /projects/:id/share.
 * Distinct from the legacy `CreateShareInput` (which takes `projectId` in body).
 */
export const CreateProjectShareInputSchema = z.object({
  grants: ShareGrantsSchema.optional(),
  expiresAt: z.string().datetime().optional(),
});
export type CreateProjectShareInput = z.infer<typeof CreateProjectShareInputSchema>;

// --- Publish / jobs ---

export const JobStatusSchema = z.enum([
  'awaiting_source',
  'building',
  'live',
  'failed',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  jobId: z.string().min(1),
  projectId: z.string().min(1),
  ownerSub: z.string().min(1),
  status: JobStatusSchema,
  createdAt: z.string().datetime(),
  publishedUrl: z.string().url().optional(),
  errorMessage: z.string().optional(),
  logUrl: z.string().url().optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const PublishStartResponseSchema = z.object({
  jobId: z.string().min(1),
  uploadUrl: z.string().url(),
});
export type PublishStartResponse = z.infer<typeof PublishStartResponseSchema>;

// --- Phase 3 publish (shared-runtime model) ---
//
// New publish flow:
//   1. POST /projects/:id/publish      → returns two presigned PUTs + a version
//   2. desktop uploads static.tar.gz + server.zip via the URLs
//   3. POST /projects/:id/publish/complete  → extracts static → assets bucket,
//      copies server bundle → code bucket at /<id>/v<n>/server.zip, bumps the
//      PROJECT#<id> version in DDB so the runtime Lambda picks it up.

export const PublishStartV3ResponseSchema = z.object({
  projectId: z.string().min(1),
  version: z.number().int().nonnegative(),
  /** Presigned PUT for the static tarball (.tar.gz). */
  staticUploadUrl: z.string().url(),
  /** Presigned PUT for the server zip bundle. Absent if the project is static-only. */
  serverUploadUrl: z.string().url().optional(),
  /** Where the published app lives on the public URL. */
  publishedUrl: z.string().url(),
});
export type PublishStartV3Response = z.infer<typeof PublishStartV3ResponseSchema>;

export const PublishCompleteInputSchema = z.object({
  version: z.number().int().nonnegative(),
  /** Did the client upload server.zip too, or is this a static-only publish? */
  hasServer: z.boolean().default(true),
});
export type PublishCompleteInput = z.infer<typeof PublishCompleteInputSchema>;

export const PublishCompleteResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  publishedUrl: z.string().url(),
});
export type PublishCompleteResponse = z.infer<typeof PublishCompleteResponseSchema>;

export const JoinByCodeResponseSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  ownerSub: z.string().min(1),
  grants: ShareGrantsSchema,
  publishedUrl: z.string().url().optional(),
  sourceUrl: z.string().url().optional(),
});
export type JoinByCodeResponse = z.infer<typeof JoinByCodeResponseSchema>;

export const ErrorBodySchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

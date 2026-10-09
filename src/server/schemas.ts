import { z } from 'zod'

export const CreateFileSchema = z.object({ path: z.string().min(1), content: z.string() })
export const UpdateFileSchema = z.object({ content: z.string() })
export const RenameSchema = z.object({ new_path: z.string().min(1) })
export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1),
  parent_path: z.string().optional(),
  init_git: z.boolean().optional(),
})
export const LinkWorkspaceSchema = z.object({ path: z.string().min(1) })
export const GitInitSchema = z.object({ path: z.string().optional() })
export const ProfileUpsertSchema = z.object({ key: z.string().min(1), name: z.string().min(1) })
export const ProfileRenameSchema = z.object({ name: z.string().min(1) })
export const MediaFromUrlSchema = z.object({ url: z.string().url(), filename: z.string().optional() })
export const GenerateImageSchema = z.object({
  prompt: z.string().min(1),
  style: z.string().optional(),
  reference_path: z.string().optional(),
})
export const ComfyAnalyzeSchema = z.object({
  workflow: z.unknown(),
  kind: z.enum(['text', 'edit']).optional(),
})
export const TestEndpointSchema = z.object({
  base_url: z.string().min(1),
  api_key: z.string().optional(),
  model: z.string().optional(),
})
export const TestImageProviderSchema = z.object({
  provider: z.string().min(1),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  model: z.string().optional(),
})
export const PromptSaveSchema = z.object({ content: z.string() })
export const SettingsUpdateSchema = z.record(z.string(), z.unknown())

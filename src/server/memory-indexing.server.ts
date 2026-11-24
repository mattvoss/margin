import { readWorkspaceFile, listMarkdownFiles } from './storage.server'
import {
  archiveMemoriesBySource,
  listMemories,
  saveMemory,
  type MemoryConfig,
  type MemoryEmbedder,
  type MemoryStore,
} from './memory.server'
import { extractFileMemories, type MemoryCandidate } from './memory-extraction.server'
import { sourceReferenceFor } from './memory-references.server'
import type { LlmSettingsLike } from './llm.server'

export interface WorkspaceMemoryIndexResult {
  filesDiscovered: number
  filesIndexed: number
  memoriesSaved: number
  filesSkipped: number
  failures: Array<{ path: string; reason: string }>
}

export interface IndexWorkspaceMarkdownInput {
  workspaceDir: string
  workspaceKey: string
  store: MemoryStore
  config: MemoryConfig
  settings?: LlmSettingsLike | null
  embed: MemoryEmbedder
  extract?: typeof extractFileMemories
}

/** Index Markdown documents one at a time so provider load stays bounded. */
export async function indexWorkspaceMarkdown(
  input: IndexWorkspaceMarkdownInput,
): Promise<WorkspaceMemoryIndexResult> {
  const paths = await listMarkdownFiles(input.workspaceDir)
  const result: WorkspaceMemoryIndexResult = {
    filesDiscovered: paths.length,
    filesIndexed: 0,
    memoriesSaved: 0,
    filesSkipped: 0,
    failures: [],
  }
  const extract = input.extract ?? extractFileMemories

  for (const path of paths) {
    try {
      const content = await readWorkspaceFile(path, input.workspaceDir)
      if (!content.trim()) {
        result.filesSkipped += 1
        continue
      }
      const candidates = await extract({ path, content, settings: input.settings })
      const embedded: Array<{ candidate: MemoryCandidate; vector: number[] }> = []
      for (const candidate of candidates) {
        embedded.push({ candidate, vector: await input.embed(candidate.content) })
      }

      const sourceMessage = `file:${path}`
      const previousMentions = (await listMemories(input.store, { workspaceKey: input.workspaceKey }))
        .filter(memory => memory.source?.path === path || memory.content === sourceMessage)
        .flatMap(memory => memory.mentions)
      const preservedMentions = Array.from(new Map(previousMentions.map(mention => [mention.path, mention])).values())
      await archiveMemoriesBySource(input.store, {
        workspaceKey: input.workspaceKey,
        sourceMessage,
      })
      for (const { candidate, vector } of embedded) {
        await saveMemory(input.store, {
          workspaceKey: input.workspaceKey,
          kind: candidate.kind,
          content: candidate.content,
           embedding: vector,
           sourceMessage,
           source: sourceReferenceFor(path, content, candidate.content),
           mentions: preservedMentions,
         })
      }
      result.filesIndexed += 1
      result.memoriesSaved += embedded.length
    } catch (error) {
      result.failures.push({
        path,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

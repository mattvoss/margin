import { isReferenceablePath, type ReferenceFile } from './fileMentions'

export interface PlannerMentionAction {
  kind: 'action'
  id: string
  label: string
  description: string
  prompt?: string
}

export interface PlannerMentionFile extends ReferenceFile {
  kind: 'file'
}

export type PlannerMentionOption = PlannerMentionAction | PlannerMentionFile

export const PLANNER_MENTION_ACTIONS: PlannerMentionAction[] = [
  {
    kind: 'action',
    id: 'plan-next-scene',
    label: 'Plan the next scene',
    description: 'Ask the planner for a complete scene plan.',
    prompt: 'What should happen next?',
  },
  {
    kind: 'action',
    id: 'outline-beats',
    label: 'Outline three beats',
    description: 'Ask for three concrete scene beats.',
    prompt: 'Outline three beats for the next scene.',
  },
  {
    kind: 'action',
    id: 'raise-stakes',
    label: 'Raise the stakes',
    description: 'Ask for a stronger source of conflict.',
    prompt: 'What conflict would raise the stakes?',
  },
  {
    kind: 'action',
    id: 'draft-scene',
    label: 'Draft this scene',
    description: 'Switch to the drafter for the approved or current plan.',
    prompt: 'Draft the next scene from the current plan.',
  },
  {
    kind: 'action',
    id: 'characters',
    label: 'Open characters',
    description: 'Open the character reference dialog.',
  },
]

export function plannerMentionOptions(
  files: ReferenceFile[],
  query: string,
  _currentPath?: string | null,
): PlannerMentionOption[] {
  void _currentPath
  const q = query.trim().toLowerCase()
  const uniqueFiles = new Map<string, PlannerMentionFile>()
  for (const file of files) {
    if (isReferenceablePath(file.path) && !uniqueFiles.has(file.path)) {
      uniqueFiles.set(file.path, { ...file, kind: 'file' })
    }
  }
  const fileOptions = [...uniqueFiles.values()]
    .filter(file => file.path.toLowerCase().endsWith('.md'))
    .filter(file => !q || `${file.name} ${file.path}`.toLowerCase().includes(q))
    .sort((a, b) => a.path.localeCompare(b.path))
  const actionOptions = PLANNER_MENTION_ACTIONS.filter(action =>
    !q || `${action.label} ${action.description} ${action.id}`.toLowerCase().includes(q),
  )
  return [...actionOptions, ...fileOptions]
}

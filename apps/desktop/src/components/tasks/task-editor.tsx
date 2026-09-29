import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactElement,
  type RefObject,
} from 'react'
import { Priority, getIsComposing, type EditorExtension } from '@meowdown/core'
import { useEditor, useKeymap } from '@meowdown/react'
import type { TaskListItem } from '@reflect/core'
import { markModeFromSyntax } from '@/editor/mark-mode.ts'
import { NoteEditor } from '@/editor/note-editor.tsx'
import { registerEditFinalizer } from '@/editor/open-documents.ts'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete.ts'
import { useTagNavigation } from '@/editor/use-tag-navigation.ts'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import { useTaskActions, type TaskActions } from '@/lib/tasks/use-task-actions.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'

/** A keyboard move between task rows: −1 up, +1 down; `span` extends the range (Shift). */
export type TaskNavigate = (direction: -1 | 1, options: { span: boolean }) => void

/** What the editor's keys ask the screen to do. The task controller already holds the draft. */
export interface TaskEditHandlers {
  /** Enter: add the next task below this one (V1 continuous entry). */
  onContinue: () => void
  /** Escape: leave edit mode. */
  onCancel: () => void
  /** ⌘↵: complete the task. */
  onComplete: () => void
  /** ⌘⇧K: turn the task into a plain bullet. */
  onConvertToBullet: () => void
  /** ⌘⌫: delete the task. */
  onDelete: () => void
  /** Backspace on an empty row: delete it and select the previous task (V1). */
  onDeleteEmpty: () => void
  /** ↑/↓ at the editor's visual edge (Shift to extend): move the selection. */
  onNavigate: TaskNavigate
}

interface TaskEditorProps extends TaskEditHandlers {
  task: TaskListItem
}

/**
 * The inline editor of the sole-selected task row: the task's first paragraph
 * without its checkbox marker. Keystrokes only update the editor and the task
 * controller's draft. The draft is saved when the edit ends: on Enter, on any
 * action taken on the task, when the row leaves edit mode, or on an
 * application flush.
 */
export function TaskEditor({ task, ...handlers }: TaskEditorProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const navigate = useWikiLinkNavigation(graph?.generation ?? null)
  const onTagClick = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()
  const actions = useTaskActions()

  const latest = useRef({ task, actions })
  useLayoutEffect(() => {
    latest.current = { task, actions }
  })
  useEffect(() => {
    const commit = () => latest.current.actions.commitDraft(latest.current.task)
    const unregister = registerEditFinalizer(commit)
    return () => {
      unregister()
      commit()
    }
  }, [])

  return (
    <div data-task-editor className="min-w-0 flex-1">
      <NoteEditor
        initialContent={task.text}
        singleParagraph
        onChange={(markdown) => actions.draft(task, markdown)}
        markMode={markModeFromSyntax(settings.editorMarkdownSyntax)}
        spellCheck={settings.editorSpellCheck}
        smoothCaretAnimation={settings.editorSmoothCaretAnimation}
        timeFormat={settings.timeFormat}
        blockHandle={false}
        onWikiLinkClick={navigate}
        onTagClick={onTagClick}
        onWikilinkSearch={onWikilinkSearch}
        onTagSearch={onTagSearch}
        className="reflect-task-editor text-sm"
      >
        <TaskKeymap task={task} actions={actions} {...handlers} />
      </NoteEditor>
    </div>
  )
}

type TaskEditorInstance = ReturnType<typeof useEditor<EditorExtension>>

/**
 * The editor's key bindings. Built outside the component so the React
 * Compiler does not read `editor.view` (which throws before mount) while
 * checking memoized dependencies during render.
 */
function createTaskKeymap(
  editor: TaskEditorInstance,
  latest: RefObject<TaskEditorProps & { actions: TaskActions }>,
) {
  const atEdge = (direction: 'up' | 'down') =>
    editor.mounted && editor.view.endOfTextblock(direction)
  const move = (direction: -1 | 1, span: boolean) => () => {
    if (!atEdge(direction < 0 ? 'up' : 'down')) return false
    latest.current.onNavigate(direction, { span })
    return true
  }
  return {
    Enter: () => {
      if (getIsComposing()) return false
      latest.current.onContinue()
      return true
    },
    'Mod-Enter': () => {
      latest.current.onComplete()
      return true
    },
    'Mod-Shift-k': () => {
      latest.current.onConvertToBullet()
      return true
    },
    Escape: () => {
      const { actions, task, onCancel } = latest.current
      actions.discardDraft(task)
      onCancel()
      return true
    },
    'Mod-Backspace': () => {
      latest.current.onDelete()
      return true
    },
    Backspace: () => {
      if (editor.state.doc.textContent.trim() !== '') return false
      latest.current.onDeleteEmpty()
      return true
    },
    ArrowUp: move(-1, false),
    ArrowDown: move(1, false),
    'Shift-ArrowUp': move(-1, true),
    'Shift-ArrowDown': move(1, true),
  }
}

/**
 * The editor's keys, bound inside its ProseKit context. The autocomplete menus
 * take their keys first while open. Enter never inserts a block: a task is one
 * paragraph, and Shift+Enter inserts a soft break.
 */
function TaskKeymap(props: TaskEditorProps & { actions: TaskActions }): null {
  const editor = useEditor<EditorExtension>()
  useEffect(() => {
    editor.focus()
  }, [editor])
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const keymap = useMemo(() => createTaskKeymap(editor, latest), [editor])
  useKeymap(keymap, { priority: Priority.high })
  return null
}

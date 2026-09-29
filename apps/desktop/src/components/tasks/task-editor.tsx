import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type MutableRefObject,
  type ReactElement,
} from 'react'
import { Priority, getIsComposing } from '@meowdown/core'
import { useKeymap } from '@meowdown/react'
import type { TaskListItem as OpenTask } from '@reflect/core'
import { markModeFromSyntax } from '@/editor/mark-mode.ts'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor.tsx'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete.ts'
import { useTagNavigation } from '@/editor/use-tag-navigation.ts'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import {
  useTaskEditorFinalizer,
  type TaskEditorApi,
} from '@/lib/tasks/use-task-editor-finalizer.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * Edits the complete first paragraph without exposing its checkbox marker.
 * The uncontrolled editor keeps its initial content; callbacks resolve the stable
 * task identity against the controller when editing finishes.
 */
/** A keyboard move between task rows: −1 up, +1 down; `span` extends the range (Shift). */
export type TaskNavigate = (direction: -1 | 1, options: { span: boolean }) => void

interface TaskEditorProps {
  task: OpenTask
  /** Persist the new content (non-empty, changed) and exit edit mode. */
  onCommit: (content: string) => void
  /**
   * Enter (V1 continuous entry): persist the current edit then add the next task.
   * `content` is the new text, `''` (emptied), or `null` (unchanged → don't rewrite).
   */
  onContinue: (content: string | null) => void
  /** Delete the task (emptied via ⌘↵, or ⌘⌫) and exit edit mode. */
  onDelete: () => void
  /** Backspace on an empty row: delete it and select the previous task (V1). */
  onDeleteEmpty: () => void
  /** Exit edit mode without writing (Escape / unchanged). */
  onCancel: () => void
  /** ⌘↵: complete the task (saving the edit first when `content` isn't null). */
  onComplete: (content: string | null) => void
  /** Checkbox click: save any change, then toggle the checked state. */
  onCheckboxToggle: (content: string | null) => void
  /** ⌘⇧K: convert the task to a plain bullet (saving the edit first when changed). */
  onConvertToBullet: (content: string | null) => void
  /** Persist a changed edit when the row unmounts (selection moved), without exiting. */
  onFlush: (content: string) => void
  /** ↑/↓ (Shift to extend): move the selection between rows while editing (V1). */
  onNavigate: TaskNavigate
  /** Lets the row checkbox toggle through the editor finalizer while editing. */
  checkboxToggleControllerRef?: MutableRefObject<(() => void) | null>
  /**
   * Lets the toolbar's "Convert to bullet" button drive the same flush-then-convert
   * the ⌘⇧K keymap does. While this row is the sole selection it holds a trigger
   * that commits the live draft and converts; it clears on unmount so the screen
   * falls back to a plain (no-edit) convert when no row is being edited.
   */
  convertControllerRef?: MutableRefObject<(() => void) | null>
}

/**
 * Binds the editor's keys inside its ProseKit context (meowdown renders children
 * there). Autocomplete handles its keys first. Enter creates the next task;
 * Shift+Enter inserts a paragraph newline. Arrows leave the editor only at its
 * visual boundary. Completion, deletion and conversion use the same finalizer.
 */
function TaskCommitKeymap({
  apiRef,
  onNavigate,
  editorRef,
}: {
  editorRef: MutableRefObject<NoteEditorHandle | null>
  apiRef: MutableRefObject<TaskEditorApi>
  onNavigate: TaskNavigate
}): null {
  const keymap = useMemo(
    () => ({
      // Enter adds the next task (V1 continuous entry), never a new block.
      Enter: () => {
        if (getIsComposing()) return false
        apiRef.current.commitAndContinue()
        return true
      },
      'Mod-Enter': () => {
        apiRef.current.complete()
        return true
      },
      'Mod-Shift-k': () => {
        apiRef.current.convertToBullet()
        return true
      },
      Escape: () => {
        apiRef.current.cancel()
        return true
      },
      'Mod-Backspace': () => {
        apiRef.current.delete()
        return true
      },
      Backspace: () => {
        if (apiRef.current.isEmpty()) {
          apiRef.current.deleteEmpty()
          return true
        }
        return false
      },
      // Leave only at the visual boundary; otherwise move within the paragraph.
      ArrowUp: () => {
        if (!editorRef.current?.isAtTextblockBoundary('up')) return false
        onNavigate(-1, { span: false })
        return true
      },
      ArrowDown: () => {
        if (!editorRef.current?.isAtTextblockBoundary('down')) return false
        onNavigate(1, { span: false })
        return true
      },
      'Shift-ArrowUp': () => {
        if (!editorRef.current?.isAtTextblockBoundary('up')) return false
        onNavigate(-1, { span: true })
        return true
      },
      'Shift-ArrowDown': () => {
        if (!editorRef.current?.isAtTextblockBoundary('down')) return false
        onNavigate(1, { span: true })
        return true
      },
    }),
    [apiRef, onNavigate, editorRef],
  )
  useKeymap(keymap, { priority: Priority.high })
  return null
}

export function TaskEditor({
  task,
  onCommit,
  onContinue,
  onDelete,
  onDeleteEmpty,
  onCancel,
  onComplete,
  onCheckboxToggle,
  onConvertToBullet,
  onFlush,
  onNavigate,
  checkboxToggleControllerRef,
  convertControllerRef,
}: TaskEditorProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const generation = graph?.generation ?? null
  const navigate = useWikiLinkNavigation(generation)
  const onTagClick = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()

  // Frozen at mount: the editor is seeded once (uncontrolled), so the commit
  // baseline must stay the seed even if `task.text` is re-derived mid-edit.
  const [initial] = useState(() => task.text)
  const writeCallbacks = {
    onCommit,
    onContinue,
    onDelete,
    onDeleteEmpty,
    onComplete,
    onCheckboxToggle,
    onConvertToBullet,
    onFlush,
  }
  const { apiRef, onChange } = useTaskEditorFinalizer({
    ...writeCallbacks,
    initial,
    onCancel,
  })

  useEffect(() => {
    if (checkboxToggleControllerRef === undefined) {
      return
    }
    checkboxToggleControllerRef.current = () => apiRef.current.checkboxToggle()
    return () => {
      checkboxToggleControllerRef.current = null
    }
  }, [checkboxToggleControllerRef, apiRef])

  // Expose the flush-then-convert trigger to the screen while this row is edited,
  // so the toolbar button converts through the same path the ⌘⇧K keymap uses —
  // never a stale-content write that drops the unsaved draft. Cleared on unmount.
  useEffect(() => {
    if (convertControllerRef === undefined) {
      return
    }
    convertControllerRef.current = () => apiRef.current.convertToBullet()
    return () => {
      convertControllerRef.current = null
    }
  }, [convertControllerRef, apiRef])

  const editorRef = useRef<NoteEditorHandle | null>(null)
  const handleRef = useCallback((handle: NoteEditorHandle | null) => {
    editorRef.current = handle
    handle?.focus()
  }, [])

  return (
    <div
      data-task-editor
      className="min-w-0 flex-1"
      onCompositionEnd={(event) => {
        const root = event.currentTarget
        setTimeout(() => {
          if (!root.contains(document.activeElement)) apiRef.current.commit()
        }, 0)
      }}
      onBlur={(event) => {
        const root = event.currentTarget
        const next = event.relatedTarget
        if (
          next instanceof Node &&
          (root.closest('[data-task-key]')?.contains(next) ||
            (next instanceof Element &&
              next.closest('[role="dialog"], [role="listbox"], [role="menu"]')))
        )
          return
        setTimeout(() => {
          if (!root.contains(document.activeElement) && !getIsComposing()) apiRef.current.commit()
        }, 0)
      }}
    >
      <NoteEditor
        initialContent={initial}
        singleParagraph
        onChange={onChange}
        markMode={markModeFromSyntax(settings.editorMarkdownSyntax)}
        spellCheck={settings.editorSpellCheck}
        smoothCaretAnimation={settings.editorSmoothCaretAnimation}
        timeFormat={settings.timeFormat}
        // One paragraph has no sibling blocks to reorder.
        blockHandle={false}
        onWikiLinkClick={navigate}
        onTagClick={onTagClick}
        onWikilinkSearch={onWikilinkSearch}
        onTagSearch={onTagSearch}
        className="reflect-task-editor text-sm"
        handleRef={handleRef}
      >
        <TaskCommitKeymap editorRef={editorRef} apiRef={apiRef} onNavigate={onNavigate} />
      </NoteEditor>
    </div>
  )
}

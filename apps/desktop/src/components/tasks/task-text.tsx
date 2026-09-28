import { useMemo, type ReactElement } from 'react'
import { collectReferenceDefinitions, markdownToDoc } from '@meowdown/core'
import { MarkdownInlineView } from '@meowdown/react'
import type { OpenTask } from '@reflect/core'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'

/** Render the first paragraph with the containing note's link definitions. */
export function TaskText({ task }: { task: OpenTask }): ReactElement {
  const referenceDefinitions = useMemo(
    () => collectReferenceDefinitions(markdownToDoc(task.referenceMarkdown)).definitions,
    [task.referenceMarkdown],
  )
  return (
    <MarkdownInlineView
      markdown={task.firstParagraphMarkdown}
      referenceDefinitions={referenceDefinitions}
      resolveWikilink={resolveWikilink}
      markMode="hide"
      interactive={false}
      className="reflect-editor reflect-task-preview pointer-events-none text-sm"
    />
  )
}

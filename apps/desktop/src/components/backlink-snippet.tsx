import { useXPostResolver, X_MEDIA_URL_PROTOCOLS } from '@/editor/use-x-post-resolver.ts'
import { resolveYouTubeVideo } from '@/editor/youtube-video-resolver.ts'
import { useState, type ReactElement } from 'react'
import { toggleTask } from '@/lib/note-task.ts'
import { startOperation } from '@/lib/operations.ts'
import { errorMessage } from '@reflect/core'
import { MarkdownView } from '@meowdown/react'
import type { WikilinkClickHandler } from '@meowdown/core'
import type { SnippetTask } from '@reflect/core'
import { useOpenExternalLink } from '@/editor/open-external-link.ts'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'
import { useNoteAttachments } from '@/editor/use-note-attachments.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

interface BacklinkSnippetProps {
  /** The referencing block context's Markdown source (may span several lines). */
  text: string
  /** Graph-relative path of the source note the snippet was read from. */
  notePath: string
  /** The snippet's checkbox tasks anchored to the source note (query-provided). */
  tasks: SnippetTask[]
  /** Navigate a clicked `[[wiki link]]` to its target. Pass a stable function. */
  onWikilinkClick: WikilinkClickHandler
}

/**
 * One reference in the incoming-backlinks panel, rendered as rich text through
 * meowdown's editor-free `MarkdownView`: wiki links become the editor's
 * clickable chips and inline marks render instead of raw `[[…]]` / `**…**`
 * source. The context is a whole block (old Reflect's rules — a paragraph, the
 * containing list item with its children, or a heading's section), so it
 * renders unclamped: truncating would cut the nested structure the context
 * exists to show. The source's fold state must not hide it either:
 * `expandCollapsed` renders `+` collapsed items expanded at every depth.
 * Checkboxes are read-only. Images and
 * `![[embeds]]` resolve from the source note's folder, as in its editor. The
 * `reflect-editor` class shares the editor's chip styling; the
 * `reflect-backlink-snippet` wrapper keeps it in the panel's compact line box.
 */
export function BacklinkSnippet({
  text,
  notePath,
  onWikilinkClick,
  tasks,
}: BacklinkSnippetProps): ReactElement {
  const [pending, setPending] = useState(false)
  const generation = useGraph({ optional: true })?.graph?.generation ?? null
  const { resolveImageUrl, resolveWikiEmbed } = useNoteAttachments(generation, notePath)
  const resolveXPost = useXPostResolver()
  const openExternalLink = useOpenExternalLink()
  return (
    <div className="reflect-backlink-snippet select-text text-xs text-text">
      <MarkdownView
        resolveXPost={resolveXPost}
        resolveYouTubeVideo={resolveYouTubeVideo}
        mediaUrlProtocols={X_MEDIA_URL_PROTOCOLS}
        className="reflect-editor"
        markdown={text}
        onTaskClick={async ({ index }) => {
          const task = tasks[index]
          if (!task?.address || !task.round || generation === null || pending) return
          setPending(true)
          try {
            await toggleTask({ ...task.address, checked: task.checked }, generation)
          } catch (cause) {
            startOperation('Updating task').fail(errorMessage(cause))
          } finally {
            setPending(false)
          }
        }}
        expandCollapsed
        resolveWikilink={resolveWikilink}
        onWikilinkClick={onWikilinkClick}
        onLinkClick={openExternalLink}
        resolveImageUrl={resolveImageUrl}
        resolveWikiEmbed={resolveWikiEmbed}
      />
    </div>
  )
}

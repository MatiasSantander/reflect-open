import { gfmParser, parseInline, type InlineElement } from '@meowdown/markdown'
import type { Span } from './model.ts'

/**
 * Plain-text rendering (Plan 03): turn a slice of markdown body into the text a
 * reader sees — emphasis/marker syntax dropped, wiki brackets/pipes flattened,
 * backslash escapes resolved, code spans kept literal. A display projection
 * and only that: it feeds the UI slots that render a plain string rather than
 * Markdown (the All Notes row preview, task rows and their breadcrumbs).
 *
 * The walk in `extract.ts` supplies two span sets in body coordinates: `cuts`
 * (syntax ranges to drop — `*emphasis*` marks, the `[ ]` TaskMarker, URLs) and
 * `literalRanges` (code regions whose backslashes stay verbatim). This module is
 * pure string surgery over those spans; it does no parsing of its own.
 */

// Inner of a wiki link, for plain-text rendering.
const WIKI_INNER_RE = /\[\[([^\]\n]*)\]\]/g
// CommonMark backslash escapes are visible in source, but not rendered text.
const MARKDOWN_ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g

/** Resolve CommonMark backslash escapes (`\*` → `*`). */
export function unescapeMarkdownText(text: string): string {
  return text.replaceAll(MARKDOWN_ESCAPE_RE, '$1')
}

function renderMarkdownText(text: string): string {
  return text
    .replaceAll(WIKI_INNER_RE, (_, inner: string) => inner.replaceAll('|', ' '))
    .replaceAll(MARKDOWN_ESCAPE_RE, '$1')
}

function appendPlainTextChunk(
  body: string,
  from: number,
  to: number,
  literalRanges: Span[],
): string {
  let kept = ''
  let cursor = from
  for (const literalRange of literalRanges) {
    if (literalRange.to <= cursor) {
      continue
    }
    if (literalRange.from >= to) {
      break
    }

    const literalFrom = Math.max(cursor, literalRange.from)
    const literalTo = Math.min(to, literalRange.to)
    if (cursor < literalFrom) {
      kept += renderMarkdownText(body.slice(cursor, literalFrom))
    }
    kept += body.slice(literalFrom, literalTo)
    cursor = literalTo
  }
  if (cursor < to) {
    kept += renderMarkdownText(body.slice(cursor, to))
  }
  return kept
}

/**
 * Plain text of `[start, end)` minus the cut (syntax) ranges, with wiki
 * brackets/pipes flattened. Shared by the whole-body plain text and per-task
 * text so a task renders exactly as the note's body does (emphasis marks and
 * the `[ ]` TaskMarker dropped, code kept literal).
 */
export function plainTextOfRange( // FIXME: plainTextOfRange should not exported. No one outside of this module is using it.
  body: string,
  start: number,
  end: number,
  cuts: Span[],
  literalRanges: Span[],
): string {
  return createPlainTextReader(body, cuts, literalRanges)(start, end)
}

/** Sort spans once for all projections of one parsed note. */
export function createPlainTextReader(body: string, cuts: Span[], literalRanges: Span[]) {
  const sorted = [...cuts].sort((a, b) => a.from - b.from)
  const sortedLiteralRanges = [...literalRanges].sort((a, b) => a.from - b.from)
  return (start: number, end: number): string => {
    let kept = ''
    let pos = start
    for (const cut of sorted) {
      if (cut.to <= start) {
        continue
      }
      if (cut.from >= end) {
        break
      }
      const cutFrom = Math.max(start, cut.from)
      if (cutFrom > pos) {
        kept += appendPlainTextChunk(body, pos, cutFrom, sortedLiteralRanges)
      }
      pos = Math.max(pos, Math.min(end, cut.to))
    }
    if (pos < end) {
      kept += appendPlainTextChunk(body, pos, end, sortedLiteralRanges)
    }
    return kept.replaceAll(/\s+/g, ' ').trim()
  }
}

/** Body text minus the cut (syntax) ranges, with wiki brackets/pipes flattened. */
export function buildPlainText(body: string, cuts: Span[], literalRanges: Span[]): string {
  return plainTextOfRange(body, 0, body.length, cuts, literalRanges)
}

 // FIXME: "without storing a second task content field." is bad comment;
 // FIXME:
/** Derive display text without storing a second task content field. */
export function markdownPlainText(markdown: string): string {
  const cuts: Span[] = []
  const literals: Span[] = []
  function visit(nodes: readonly InlineElement[]): void {
    for (const node of nodes) {
      const name = gfmParser.nodeSet.types[node.type]?.name ?? ''
      if (name === 'Wikilink' || name === 'WikiEmbed') continue
      if (name.endsWith('Mark') || name === 'URL') cuts.push(node)
      if (name === 'InlineCode') literals.push(node)
      visit(node.children)
    }
  }
  visit(parseInline(markdown))
  return buildPlainText(markdown, cuts, literals)
}

/** The three GFM checkbox markers a task line can carry (`[X]` is GitHub-valid). */
const TASK_MARKERS = new Set(['[ ]', '[x]', '[X]'])

/** Read a three-character GFM checkbox marker; other strings return null. */
export function parseTaskMarker(marker: string): { checked: boolean } | null {
  if (!TASK_MARKERS.has(marker)) {
    return null
  }
  return { checked: marker !== '[ ]' }
}

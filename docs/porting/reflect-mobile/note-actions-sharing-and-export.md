# Porting note actions, sharing, and export

**v2 status: v1 for pin / share / trash (the 2026-06-12 product call —
implemented in `apps/desktop/src/mobile/note-actions-menu.tsx`);
publishing deferred product-wide; JSON export superseded.**

## What V1 mobile does

### Note actions

Each note has an options popover (the mobile stand-in for desktop V1's
context sidebar, reduced to actions only — there is no
suggested-backlinks / similar-notes / contacts intelligence on mobile):

- **Pin / Unpin** — sets `pinnedIndex`; pinned notes sort first in All
  Notes and are a search filter.
- **Share** — native iOS share sheet (`@capacitor/share`) with the note's
  **markdown** content and title.
- **Publish / Copy public URL / Unpublish** — toggles the note's public
  flag, producing a shareable web URL (paid-gated in V1).
- **Move to trash** — soft delete.

### Export

From the profile modal: **Export notes** generates a JSON export of the
whole graph
(`mobile-reflect-<graphname>-<timestamp>.json`), writes it to the cache
directory, and hands it to the iOS share sheet
(`client/screens/profile/export-item.tsx`). There is no per-note markdown
export on mobile.

## What changes in v2, and why

- **Pin** is the frontmatter `isPinned` flag (same as desktop), written
  through the session-or-disk channel — no separate mobile pin store.
- **Share** uses the Web Share API — `navigator.share` is verified
  working in the Tauri iOS WKWebView, so no native plugin is needed. The
  payload is the note's markdown, which in v2 is simply the file content.
- **Trash** goes to graph-local `.reflect/trash/` (recoverable,
  sync-ignored) instead of V1's soft-delete flag or desktop's OS trash
  (`NoteActionsService.trash` in `packages/core/src/documents/note-actions-service.ts`).
- **Publish is not ported** — publishing conflicts with local-first file
  assumptions and is deferred product-wide (see the desktop
  [product vision](../../reflect-v2-product-vision.md)).
- **JSON export is superseded**, not ported: the workspace is plain
  markdown in `Documents/`, visible in the iOS Files app — the user can
  copy or back up their notes with no export step. (Whole-graph export
  formats remain a desktop concern under the portability plan.)

## V1 → v2 mapping

| V1                                      | v2                                                          |
| --------------------------------------- | ------------------------------------------------------------ |
| Pin/unpin (`pinnedIndex`)               | Frontmatter `isPinned` via the shared note-flag path         |
| Share sheet with markdown               | `navigator.share` with the file's markdown                   |
| Publish / public URL / unpublish        | Not ported (publishing deferred product-wide)                |
| Move to trash (soft delete)             | Move to `.reflect/trash/`                                    |
| Whole-graph JSON export via share sheet | Superseded: Files-app-visible markdown workspace             |
| Options popover per note                | `note-actions-menu.tsx` (pin, share, trash)                  |

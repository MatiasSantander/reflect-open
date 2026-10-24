# The file contract

The recorder writes **a meeting note and its transcript** into the graph and
touches nothing else. That sentence is the entire interface between this
program and Reflect, and everything below exists to keep it true.

Reflect must stay byte-identical to upstream. The moment the recorder needs a
change inside `apps/` or `packages/`, the arrangement has failed and the cost
returns on every merge.

### Two files, not one

The transcript is the longest thing a meeting produces and the least often
read: the points and the decisions are what gets opened, and the transcript is
what they are checked against when one of them looks wrong. Keeping it beside
the meeting rather than inside it leaves the note that matters short enough to
read in one screen — and keeps it searchable, which it would not be if it
lived out beside the audio.

```
meetings/2026-10-24-1113-slack.md
meetings/2026-10-24-1113-slack-transcript.md
```

The same stem with one more segment, so the pair sorts together and either one
names the other. They cross-link, and the transcript carries the same
`- Type: #meeting` tag.

## Where the note goes

```
<graph>/meetings/2026-10-24-1113-slack.md
```

A top-level `meetings/` directory. Reflect indexes any `.md` outside the two
reserved trees (`assets/`, `audio-memos/`) as an ordinary note, at the root or
at any depth, so a directory of our own needs no permission from anybody — and
can be deleted whole without taking a graph with it.

**`audio-memos/` is specifically forbidden.** Reflect runs a reconcile pass
that adopts audio with no note of its own and transcribes it; a `.wav` left
there would earn a second, duplicate note for the same meeting.

### The filename

`YYYY-MM-DD-HHMM-<source>.md`, lowercase, from the meeting's **start**.

It sorts chronologically, it cannot collide inside a minute, and it says what
it is without being opened.

**It never changes.** Not when the model renames the meeting at the end, not
when the user retitles it by hand. The title lives in the `# ` heading; the
filename is an address, and an address that moves breaks every link into it.

## What the file contains

```markdown
---
id: 9f2c1a7e-4b33-4a10-9d55-0c8e7b21aa10
aliases: [2026-10-24-1113-slack]
---

# 11:13 · Slack · Precios por colegio

- Type: #meeting
- [[2026-10-24]]

## Puntos clave

## Decisiones

## Tareas
```

| Field | Why |
| --- | --- |
| `id` | A stable identity the index keeps across renames and moves. Minted once, never rewritten. |
| `aliases` | The filename stem, so `[[2026-10-24-1113-slack]]` keeps resolving after the title changes. |
| `# ` heading | Reflect derives the note's title from the first H1. Renaming the meeting edits **this line only**. |
| `- Type: #meeting` | An ordinary body line that indexes as a tag, filing the note beside meetings added from the calendar rather than in a category of its own. |
| `- [[YYYY-MM-DD]]` | The link to the day — see below. |

The gap between the link lines and `## Puntos clave` is where the user types
during the call. It is left empty on purpose: the first thing they should see
is their own cursor, not a template to delete.

## The daily note is never written to

Reflect's own audio-memo pass appends an entry into the daily note. The
recorder does not, because the daily note is the file the user is most likely
to be typing in, and two writers on one file is a conflict waiting for the
worst possible moment.

Instead the meeting note links **to** the day. The day's backlinks panel then
lists the meeting with no write at all.

One writer per file. The rule has no exceptions.

## The audio stays out of the graph

```
~/Library/Application Support/reflect-recorder/sessions/<session>/
```

Three reasons, in order of how much they matter:

1. **Reflect would adopt it.** See above.
2. **It is gigabytes**, and the graph syncs through iCloud beside notes that
   are kilobytes.
3. **It belongs to the recorder.** Swap the recorder and the audio leaves with
   it; the notes stay, because they were always just markdown.

The note records where its audio is, on one line, so the recording is
findable:

```markdown
- Audio: `~/Library/Application Support/reflect-recorder/sessions/2026-10-24-1113-slack/`
```

A path in a code span, not a link: Reflect would try to resolve a link into
the graph and find nothing.

## Writing while the meeting runs

The note is created in the first second and appended to as segments close, so
it fills during the call instead of appearing after it. Reflect sees a file
changing on disk and reindexes — it never learns the recorder exists.

Two rules make that safe:

- **Append only, never rewrite.** Read the file, append under a heading, write
  it back. The user may have typed in it since the last segment, and their
  words are not ours to drop.
- **A deleted note stays deleted.** If the file is gone when a segment lands,
  that is a decision, not a glitch. Do not recreate it.

## Discarding

A meeting nobody else spoke in — the system track silent across the whole
session — takes its note and its audio back out. This is what lets detection
stay loose: a wrong guess costs a minute of disk and nothing else.

The note is deleted outright. Nothing else references it, because nothing was
ever written into the daily note.

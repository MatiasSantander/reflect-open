-- `text` is the source note's raw first-paragraph Markdown, without `[ ]` or `[x]`.
-- `breadcrumbs` remains the outermost-first ancestor list labels used for task grouping.
ALTER TABLE tasks RENAME COLUMN first_paragraph_markdown TO text;
ALTER TABLE notes DROP COLUMN reference_markdown;
DELETE FROM index_meta WHERE key = 'projection_version';

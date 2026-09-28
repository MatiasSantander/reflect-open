-- Old rows only contain the first physical line. Reprojection must read source.
DELETE FROM tasks;
ALTER TABLE tasks ADD COLUMN first_paragraph_markdown TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN plain_text TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN marker_text TEXT NOT NULL DEFAULT '[ ]';
ALTER TABLE notes ADD COLUMN reference_markdown TEXT NOT NULL DEFAULT '';

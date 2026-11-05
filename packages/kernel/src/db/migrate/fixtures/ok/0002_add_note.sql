-- migration-class: expand
ALTER TABLE fixture.widget ADD COLUMN note text NOT NULL DEFAULT '';

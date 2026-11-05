-- migration-class: expand
ALTER TABLE fixture.widget ADD COLUMN flag boolean NOT NULL DEFAULT false;

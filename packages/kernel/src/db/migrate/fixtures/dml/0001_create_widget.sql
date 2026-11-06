-- migration-class: expand
CREATE SCHEMA fixture;
CREATE TABLE fixture.widget (id uuid PRIMARY KEY, label text NOT NULL);

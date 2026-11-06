-- migration-class: expand
CREATE SCHEMA fixture;
CREATE TABLE fixture.widget (id uuid PRIMARY KEY, label text NOT NULL);
CREATE INDEX fixture_widget_label_idx ON fixture.widget (label);
-- A function body may contain DML: it is a definition, not data (ARCHITECTURE 21.7 point 1).
CREATE FUNCTION fixture.touch(p uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE fixture.widget SET label = 'x' WHERE id = p;
  INSERT INTO fixture.widget (id, label) VALUES (p, 'INSERT; DELETE');
END $$;

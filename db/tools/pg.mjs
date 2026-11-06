// Connection helper shared by the db tools. `pg` is not yet a workspace dependency (see db/README.md,
// "Requests to the Orchestrator"); until the lockfile owner adds it, these tools stop with a clear message.
export async function connect(connectionString, application = 'db-tools') {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    throw new Error(
      'The "pg" package is not installed. It must be added to the workspace by the lockfile owner (db/README.md).',
    );
  }
  const client = new pg.Client({ connectionString, application_name: application });
  await client.connect();
  return client;
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

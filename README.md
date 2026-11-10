# enterprise-app

Enterprise application delivered through the InvoZone agentic SDLC

## Developer setup

Requires Node 24.22.2 (`.nvmrc`) and Corepack (pnpm 12.16.1 is pinned in `package.json`).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test:boundary
```

Layout: `apps/{api,worker,site,cms,patient,staff}`, `packages/{contracts,kernel,ui,app-shell}`, `db/migrations`, `infra`, `docs`. Dependencies and their licences: `docs/DEPENDENCIES.md`. Only the root lockfile is committed; add dependencies inside the app or package that needs them.

## Run it locally

The complete local workflow (prerequisites, environment variable names, database, starting api, worker, site, patient, staff and cms, synthetic sign-in, unit, database and browser checks, and what refuses locally by design) is in [docs/RUN-GUIDE.md](docs/RUN-GUIDE.md).

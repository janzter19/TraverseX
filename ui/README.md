# TraverseX Admin UI

The TraverseX admin dashboard is a React + TypeScript interface built with Vite, Tailwind CSS, and shadcn/ui primitives.

## Development and deployment

From the TraverseX root, install the UI dependencies and build:

```bash
npm --prefix ui ci
npm run build
```

The production bundle is written to `public/dashboard/` and is served by the
Express `/admin` route. The generated hashed assets are committed so a fresh
checkout can run the server with `npm ci --omit=dev`; rebuild them only after
changing `ui/src`.

The dashboard keeps the existing same-origin Admin API and authentication
flow. It does not expose database passwords or Firebase credentials in the
browser. Long dialogs use a fixed header/footer and one scrollable content
area; metric cards use a consistent wide modal layout.

## UI conventions

- shadcn/ui primitives live in `src/components/ui/`.
- Shared class composition lives in `src/lib/utils.ts`.
- Semantic tokens are defined in `src/index.css` and mapped in
  `tailwind.config.cjs`.
- Dialogs use a fixed header/body/footer structure, with scrollable bodies for
  long content and actions aligned in the footer.
- The dashboard is responsive and uses an 8/4 collection-monitor/service-control
  split on wide screens.
- Pending, read, processed, retry, and error cards call purpose-specific
  MySQL-backed report endpoints; opening a report does not perform a new
  Firebase read.

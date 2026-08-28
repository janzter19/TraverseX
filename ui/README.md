# TraverseX Admin UI

The TraverseX admin dashboard is a React + TypeScript interface built with Vite, Tailwind CSS, and shadcn/ui primitives.

## Development

From the TraverseX root:

```bash
npm install
npm run build
```

The production bundle is written to `public/dashboard/` and is served by the
Express `/admin` route. The dashboard keeps the existing same-origin admin API
and authentication flow; it does not expose database passwords or Firebase
credentials in the browser.

## UI conventions

- shadcn/ui primitives live in `src/components/ui/`.
- Shared class composition lives in `src/lib/utils.ts`.
- Semantic tokens are defined in `src/index.css` and mapped in
  `tailwind.config.cjs`.
- Dialogs use a fixed header/body/footer structure, with scrollable bodies for
  long content and actions aligned in the footer.
- The dashboard is responsive and uses an 8/4 collection-monitor/service-control
  split on wide screens.

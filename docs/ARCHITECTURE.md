# TraverseX architecture and data flow

## System map

```text
Browser
  └─ Express Admin/API (/admin, /admin/api/*)
       └─ TraverseX control DB (registry, auth, runtime, reports)

systemd worker instance
  └─ Firebase Admin SDK
       └─ PENDING-only Firestore listeners
            └─ registered target MySQL projection
                 └─ exact row read-back
                      └─ Firebase status = SYNCED
```

The browser never connects directly to Firebase or a target MySQL database.
Opening dashboard reports reads the TraverseX control database. This keeps
Admin reporting separate from application data and avoids extra Firebase reads
when opening pending or activity views.

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Express server | `src/server.mjs` | Admin login/session, APIs, static UI, health check, project/collection CRUD. |
| Worker | `src/worker.mjs` | One isolated Firebase listener set and projection lifecycle per instance. |
| Configuration | `src/config.mjs` | Validates process environment and worker scope. |
| Firebase adapter | `src/firebase.mjs` | Creates a separate Firebase Admin app for each registered project. |
| Control DB adapter | `src/db.mjs` | Reads/writes the `traversex` control database and target connection settings. |
| Projection/schema logic | `src/projection-schema.mjs` | Creates, evolves, backs up, and records target projection schema changes. |
| Admin UI | `ui/src/` → `public/dashboard/` | React/Vite dashboard served by Express. |
| Services | `systemd/` | Web service and templated isolated worker service. |

## Control database tables

- `traversex_admin_user`: Admin credentials and password-change state.
- `traversex_project`: registered Firebase projects and encrypted target DB
  configuration.
- `traversex_collection`: monitored collection registry and last-event cache.
- `traversex_runtime`: service state and current runtime counters.
- `traversex_collection_event`: recorded projection events and outcomes.
- `traversex_pending_queue`: MySQL-only snapshot of pending projection work.
- `traversex_event`: broader operational event history.
- `traversex_schema_change`: automatic target-schema healing audit.

Projection tables are not control tables. They are created in each registered
target database using fields from the Firebase document.

## Worker lifecycle

1. The instance reads `TRAVERSEX_INSTANCE_ID` and loads the matching ACTIVE
   project registry row.
2. It validates the Firebase credential reference and target MySQL settings.
3. It registers the built-in `project_test` listener and each ACTIVE collection
   listener.
4. Each listener queries only `mysql_sync_status == PENDING`.
5. A non-removed document change increments the current-run Firebase read
   counter and is written to the pending queue report.
6. The worker projects the document to target MySQL, reads the exact row back,
   records SUCCESS, and updates Firebase to `SYNCED`.
7. A failure records RETRY or DEAD_LETTER and retains pending evidence for
   diagnosis.
8. Runtime heartbeat and counters are written to `traversex_runtime`.

`TRAVERSEX_SOURCE_PROJECT_KEY=*` accepts all document `project_key` values in
the registered Firebase project. An exact value restricts the source scope.

## Dashboard metric meaning

All metric cards are current-worker-run reports unless the card says otherwise:

- **Status**: worker service status from runtime.
- **Listeners**: active listener count versus configured listener documents.
- **Last event**: latest recorded event in the current run.
- **Pending**: documents currently waiting for successful MySQL projection;
  the modal shows only pending records and why each is pending.
- **Reads**: actual Firebase document-change notifications received by the
  current worker run; the modal shows the recorded read rows available in the
  control DB.
- **Processed**: SUCCESS projection events in the current run.
- **Retries**: RETRY events with attempts greater than zero.
- **Errors**: ERROR or DEAD_LETTER events in the current run.

Firebase read notifications and MySQL projection-event rows can differ:
acknowledgement/removal notifications do not create projection-event rows, and
multiple listener notifications can be recorded separately. The UI labels
these counts so a read count is not mistaken for a row count.

## Clear logs behavior

The Admin Clear Logs action requires confirmation. It clears the control DB's
`traversex_collection` last-event fields and deletes
`traversex_collection_event` rows. It also resets current-run runtime counters
and error/last-event fields to zero/empty. It does **not** delete Firebase
documents, target MySQL projection rows, pending documents, or the project and
collection registry. New worker events after the reset start new counters.

## Authentication and boundaries

Admin APIs require the signed session created by `/admin/login`. `/healthz` is
the intentionally unauthenticated process check. Firebase remains the
application source of truth; MySQL is a projection and TraverseX's control DB
is an operations/reporting store.

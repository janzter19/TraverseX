# TraverseX

TraverseX is a standalone control plane that listens for `PENDING` Firebase
document changes and projects them into a registered MySQL database. It runs
as a Node.js service; Apache, PHP, and a separate frontend server are not
required.

## Quick start

For a fresh Ubuntu/Debian installation, follow the complete
[installation guide](docs/INSTALL.md). In outline:

```bash
git clone https://github.com/janzter19/TraverseX.git
cd TraverseX
npm ci --omit=dev
cp .env.example .env
# edit .env, provision the Firebase service-account file, and create the DB
sudo mariadb < database/schema.sql
set -a; . ./.env; set +a
npm run bootstrap-admin
npm start
```

Open `http://127.0.0.1:8085/admin/login`. Production-like installations
should use the systemd units documented in the installation and operations
guides.

## What is included

- **Admin dashboard**: Firebase project and collection registry, target MySQL
  configuration, runtime metrics, pending records, and activity.
- **Worker**: one isolated process per registered project instance. Each
  active collection uses `mysql_sync_status == PENDING`; TraverseX does not
  periodically full-scan Firebase.
- **Projection lifecycle**: Firebase PENDING → target MySQL projection → exact
  MySQL read-back → Firebase `mysql_sync_status=SYNCED`.
- **Control database**: authentication, registry, runtime counters, event
  reports, pending-queue snapshots, and schema-healing audit.
- **Portal**: optional `/portal` MySQL-only runtime summary.
- **Portable deployment**: source, schema, UI bundle, scripts, and systemd
  templates. Secrets and runtime files stay local.

## Documentation map

- [Installation](docs/INSTALL.md) — fresh PC setup, database, credentials,
  Admin bootstrap, systemd, and verification.
- [Configuration](docs/CONFIGURATION.md) — environment variables, registry
  fields, target database requirements, and project scope.
- [Architecture](docs/ARCHITECTURE.md) — data flows, tables, worker lifecycle,
  and dashboard metrics.
- [Operations](docs/OPERATIONS.md) — start/stop/restart, logs, updates,
  backups, clear logs, and troubleshooting.
- [Automatic schema healing](docs/AUTO-SCHEMA-HEALING.md) — projection table
  creation, safe schema changes, backups, and rollback evidence.
- [Project test contract](docs/PROJECT-TEST-CONTRACT.md) — Admin test flow
  and its Firebase-first contract.
- [Admin UI development](ui/README.md) — React/Vite source and build process.

## Requirements

- Ubuntu/Debian Linux with `sudo` access; the documented services use systemd.
- Node.js 20 or newer and npm.
- MariaDB/MySQL for the TraverseX control database.
- A separate MySQL/MariaDB target database for each registered Firebase
  project.
- A Firebase service-account JSON file with Firestore access.
- Network access from the worker to Firebase and the target MySQL server.

## Security and portability boundary

The repository intentionally contains no passwords, `.env` files, Firebase
service-account keys, `node_modules`, runtime logs, or operational logs that
could contain document IDs. Create those on each PC using `.env.example` and
the installation guide. Do not commit production credentials.

Firebase is the application source of truth; registered target databases are
projections. The TraverseX control database is not a projection fallback.

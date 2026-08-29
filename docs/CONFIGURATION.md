# TraverseX configuration

TraverseX has three configuration layers: process environment, the Admin
project registry, and the Firebase/target-MySQL credentials referenced by the
registry. Keep these layers separate so a new PC can be configured without
copying secrets from the old PC.

## Process environment

Copy `.env.example` to `.env` for a temporary run. For systemd, install the
same values as `/etc/traversex/web.env` and one env file per worker instance,
such as `/etc/traversex/rbmsv4-local.env`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV` | No | `development` or `production`; use `production` for services. |
| `HTTP_HOST` | No | Bind address; default is `127.0.0.1`. Use a deliberate firewall/reverse-proxy design before exposing it. |
| `HTTP_PORT` | No | Admin/API port; default is `8085`. |
| `SESSION_SECRET` | Yes | Long random value used to sign Admin sessions. |
| `DATABASE_HOST` | No | TraverseX control DB host; default `127.0.0.1`. |
| `DATABASE_PORT` | No | Control DB port; default `3306`. |
| `DATABASE_NAME` | Yes | Control database, normally `traversex`. |
| `DATABASE_USER` | Yes | Control DB account. |
| `DATABASE_PASSWORD` | Yes | Control DB password. |
| `FIREBASE_PROJECT_ID` | No | Legacy/reference default; registered projects store their own Firebase ID. |
| `FIREBASE_CREDENTIALS_FILE` | No | Legacy/reference default; registered projects store their own credential path. |
| `TRAVERSEX_INSTANCE_ID` | No | Worker instance/project key; default `project-a`. Must match an ACTIVE registry key. |
| `TRAVERSEX_SOURCE_PROJECT_KEY` | No | Source document scope. `*` accepts all document project keys; an exact value restricts the worker. |

For the current RBMSv4 setup, use:

```text
TRAVERSEX_INSTANCE_ID=rbmsv4-local
TRAVERSEX_SOURCE_PROJECT_KEY=*
```

The wildcard is intentional when TraverseX must process all RBMSv4
transactions in the registered Firebase project. It does not combine data
from a different Firebase project; each registered project still has its own
Firebase project ID and credential reference.

## Admin project registry

Each active registered project needs:

- `project_key`: stable worker instance key, for example `rbmsv4-local`;
- `firebase_project_id`: Firebase/Firestore project ID;
- `credential_ref`: absolute path readable by the `traversex` OS user;
- target MySQL host and port;
- target database name, username, and password; and
- active collection rows.

The seed command creates the RBMSv4 project and collection registry. It does
not guess target MySQL credentials. Enter those through Admin or the approved
database provisioning workflow.

## Firebase requirements

The service account JSON must be stored outside the repository, normally
under `/etc/traversex/firebase/`, owned by `root:traversex` with mode `0640`.
It must have permission to read the monitored Firestore collections and update
the synchronization fields used by the worker.

The worker listens only for documents where:

```text
mysql_sync_status == PENDING
```

The listener receives a document change, projects it, verifies the target row,
then marks the Firebase document `SYNCED`. Removed/acknowledgement
notifications do not create projection-event rows.

## Target MySQL requirements

The target account must be able to read and write projection rows and evolve
projection tables as Firebase document fields change. Grant only the target
database, with the effective privileges needed by the configured schema
healing policy: `SELECT`, `INSERT`, `UPDATE`, `CREATE`, `ALTER`, `RENAME`, and
`DROP`.

The control account only needs the `traversex` database. TraverseX stores the
target password encrypted in the control database; it is never returned to
the browser.

## Files that must be recreated on another PC

Create or securely transfer these local-only files:

```text
/var/www/html/traverseX/.env
/etc/traversex/web.env
/etc/traversex/<worker-instance>.env
/etc/traversex/firebase/<project>.json
```

Do not copy `node_modules`; run `npm ci --omit=dev`. Do not copy runtime logs
or operational reports containing document IDs. See [Installation](INSTALL.md)
for the complete sequence.

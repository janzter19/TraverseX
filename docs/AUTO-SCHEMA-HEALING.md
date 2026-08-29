# TraverseX automatic schema healing

## Purpose

TraverseX treats Firebase as the source of truth for every collection marked
`ACTIVE` in the Collection Monitor. The worker does not keep a hardcoded list
of projection adapters. When a pending Firebase document arrives, its fields
define the target MySQL table for that collection.

The worker is event-driven. It listens only to documents where
`mysql_sync_status == PENDING`; it does not perform a full Firestore scan every
30 seconds. The registry is loaded at worker startup or after an explicitly
requested reload/recovery.

## Target table contract

For a monitored collection such as `project_task_stage_response`, TraverseX
uses the same table name in the registered project's MySQL database:

```text
Firebase: project_task_stage_response/{Firestore document ID}
MySQL:   project_task_stage_response
```

The generated table starts with these two engine columns, in this order:

1. `xId INT(10) NOT NULL AUTO_INCREMENT PRIMARY KEY`
2. `firebase_document_id VARCHAR(255) NOT NULL UNIQUE`

`firebase_document_id` is required so an update can upsert the exact Firestore
document without guessing a business key. Its value is always the real
Firestore document ID. Every remaining column is taken from the current
Firebase document, in the document field order observed by the worker. No
manual business column such as `created_at`, `updated_at`, `group_key`, or
`position_key` is invented by the worker.

Firestore values are mapped conservatively: strings to `VARCHAR(255)` or
`TEXT`, integers to `BIGINT`, non-integer numbers to `DOUBLE`, booleans to
`TINYINT(1)`, timestamps/date-shaped values to `DATETIME(6)`, and arrays or
objects to `JSON`. Firebase date fields should be real Firestore timestamps;
SQL-shaped strings are accepted only when they parse unambiguously. Credential,
password, token, private-key, and secret-like fields are rejected and are never
projected.

The registered Firebase project ID and its credential reference define the
source boundary. RBMSv4's `project_key` is an application-level scope and may
vary across transaction documents. Set `TRAVERSEX_SOURCE_PROJECT_KEY` to one
specific key to enforce a single-project scope, or set it to `*` to project all
document project keys from the registered Firebase project. If a document
contains `firebase_collection`, it must still match the monitored collection;
a mismatch is reported as a failed event and is not acknowledged.

## Create, update, and schema change

1. The listener receives a `PENDING` document.
2. TraverseX reads that document once from the listener event and infers the
   expected target schema.
3. If the target table does not exist, TraverseX creates it automatically.
4. If the existing schema is exactly the current Firebase schema, TraverseX
   performs an idempotent upsert by `firebase_document_id`.
5. If fields were added, removed, reordered, or changed type/nullability,
   TraverseX first renames the old table to a timestamped backup, then creates
   a fresh table from the current document schema.
6. Only compatible, same-named fields are copied from the backup. The previous
   document identity is copied into `firebase_document_id` when a matching
   identity field is present, such as `project_task_stage_response_key`.
   `xId` is never copied because it is a new auto-increment engine key.
7. The current Firebase document is upserted into the fresh table.
8. TraverseX reads the row back from MySQL and compares the document ID and
   every projected field.
9. Only after the exact read-back succeeds does it write
   `mysql_sync_status = SYNCED` and `mysql_synced_at = serverTimestamp()` to
   Firebase, then update the corresponding MySQL sync metadata when those
   fields exist.

## Backup naming and rollback

Backups use the requested format:

```text
project_task_stage_response_YYYY_MM_DD_HH_SS
```

Example:

```text
project_task_stage_response_2026_08_28_13_35
```

If the name already exists, TraverseX adds `_2`, `_3`, and so on. The backup is
not deleted automatically. Every create/rebuild is recorded in the control
database table `traversex_schema_change`, including the previous schema, new
schema, backup table, reason, and copied columns. If rebuild or copy fails,
TraverseX drops the incomplete new table and renames the backup back to the
original name. A retained backup is also the manual rollback source for an
operator.

The worker never drops a Firebase collection or silently drops an existing
MySQL table. Rebuild is a rename-to-backup followed by a fresh table create.
Collections longer than the MySQL-safe backup-name limit are rejected with
`projection_table_name_too_long` so a backup can always be made.

## Failure and evidence

Failures remain in `traversex_collection_event` with the collection, document
ID, change type, attempt count, safe error code, and technical description.
Typical codes include `schema_rebuild_failed`,
`firebase_readback_mismatch`, `firebase_project_mismatch`,
`firebase_sensitive_field_blocked`, and `timestamp_invalid`. A failure never
gets a false `SYNCED` acknowledgement. After the retry limit, the event is
marked `DEAD_LETTER`.

The admin report reads only TraverseX MySQL control tables, so opening the
report does not consume Firestore reads. The only Firestore reads used by this
path are the PENDING listener delivery and the listener's event changes; no
periodic full collection rescan is used.

## Required setup

For a fresh installation, use the complete `database/schema.sql`; it already
contains `traversex_schema_change`. For an older installation, back up and
inspect the control database, then apply only the missing numbered migrations
in order. In particular, `database/migrations/004-schema-healing-audit.sql`
must be run with the control database selected because it does not contain a
`USE` statement:

```bash
sudo mariadb traversex < database/migrations/004-schema-healing-audit.sql
```

The registered project MySQL account must have `CREATE`, `ALTER`/`RENAME`,
`DROP` for incomplete rollback, `INSERT`, `UPDATE`, and `SELECT` privileges on
the registered project database. The worker must not use MySQL root.

The Admin Clear Logs action deletes control-database collection event rows and
resets current-run runtime counters, but it does not delete Firebase
documents, target projection tables, or pending work.

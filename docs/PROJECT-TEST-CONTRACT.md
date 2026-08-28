# `project_test` Firebase-first test contract

The TraverseX Admin test action writes one Firestore document at
`project_test/{auto-generated Firestore document ID}`. The generated document
ID is copied to `test_key`; no UUID or client-generated ID is accepted.

Firebase fields written by the Admin action are `test_key`, `project_key`,
`test_name`, `test_message`, `test_status`, `firebase_created_at`,
`firebase_updated_at`, `firebase_deleted_at`, and the sync-owned `mysql_*`
lifecycle fields. Firebase timestamps use Admin SDK server timestamps. The
browser never writes MySQL directly.

TRAVERSEX listens only to `mysql_sync_status == PENDING` in `project_test`.
For each document it ensures the MySQL `project_test` projection table exists,
upserts the exact document values, reads the row back by `test_key`, and only
then changes the Firebase document to `mysql_sync_status=SYNCED` with
`mysql_synced_at`. Projection errors are logged with a technical code and
description; credentials and payload secrets are not logged.

The Admin modal remains open after submission and reports Firebase acknowledgement,
document ID, and projection state at the bottom. A missing server credential is
reported as `firebase_credentials_missing`; it is not disguised as a restart or
database error.

## Development reset test

The Admin page also exposes `Reset project_test + insert`. This is a deliberate
development-only destructive test action. After browser confirmation, the
server deletes only the Firestore `project_test` documents, drops only the
MySQL `project_test` table, then creates one fresh Firestore document using a
real Firestore auto-ID copied to `test_key`. The new document starts at
`mysql_sync_status=PENDING`; TRAVERSEX recreates the projection table,
projects the row, reads it back, and acknowledges it as `SYNCED`.

The reset result reports the number of deleted Firebase documents, the dropped
table, the new document ID, and the pending projection state. It is not a
general-purpose reset and must never be pointed at another collection or
table.

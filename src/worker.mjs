import { config } from './config.mjs';
import { createProjectPool, query } from './db.mjs';
import { getFirebaseDbForProject } from './firebase.mjs';
import { FieldValue } from 'firebase-admin/firestore';
import { pendingQueueTableSql } from './pending-queue.mjs';
import {
  assertSafeCollectionName,
  backupTableName,
  buildProjectionSchema,
  comparableMysqlValue,
  identityCandidates,
  schemaDiff,
  toMysqlValue
} from './projection-schema.mjs';

const projectRows = await query(`SELECT xId, project_key, firebase_project_id, credential_ref,
  mysql_host, mysql_port, mysql_database, mysql_username, mysql_password_ciphertext
  FROM traversex_project WHERE project_key = ? AND project_status = 'ACTIVE' LIMIT 1`, [config.instanceId]);
const project = projectRows[0];
if (!project) {
  const error = new Error('registered_project_not_found');
  error.code = 'registered_project_not_found';
  throw error;
}

// The queue is a control-database report snapshot. Creating it is idempotent
// and does not read or mutate Firebase data.
await query(pendingQueueTableSql);

let runtimeStatus = 'STARTING';
let firebaseReads = 0;
let pendingQueue = 0;
let processedCount = 0;
let retryCount = 0;
let deadLetterCount = 0;
let activeCollectionCount = 0;
let listenerCount = 0;
let lastEventAt = null;
let lastFailure = null;
let runtimeWrite = Promise.resolve();
const listenerSizes = new Map();
const eventAttempts = new Map();

const safeFailure = (error, fallbackCode = 'projection_failed') => {
  const code = String(error?.code ?? fallbackCode).replace(/[^A-Z0-9_\-]/gi, '').slice(0, 100) || fallbackCode;
  const descriptions = {
    ER_ACCESS_DENIED_ERROR: 'The registered project MySQL target rejected the connection.',
    ER_BAD_DB_ERROR: 'The registered project MySQL database was not found.',
    ECONNREFUSED: 'The registered project MySQL target refused the connection.',
    ETIMEDOUT: 'The registered project MySQL target timed out.',
    registered_project_mysql_configuration_missing: 'The registered project MySQL target is incomplete.',
    firebase_collection_name_invalid: 'The monitored Firebase collection cannot be used safely as a MySQL table name.',
    firebase_field_name_invalid: 'A Firebase field name cannot be represented safely as a MySQL column.',
    firebase_reserved_field: 'A Firebase field conflicts with TraverseX identity metadata.',
    firebase_sensitive_field_blocked: 'A credential or secret-like Firebase field is not projected.',
    projection_table_name_too_long: 'The monitored collection name is too long for a MySQL table and backup name.',
    firebase_document_key_mismatch: 'The Firebase document ID did not match its declared record key.',
    firebase_collection_mismatch: 'The Firebase document collection marker did not match the monitored collection.',
    firebase_project_mismatch: 'The Firebase document belongs to a different registered project.',
    firebase_readback_mismatch: 'The MySQL projection read-back did not match the Firebase document.',
    schema_backup_failed: 'TraverseX could not create the recoverable MySQL schema backup.',
    schema_rebuild_failed: 'TraverseX could not rebuild the MySQL projection from the Firebase fields.',
    firebase_listener_failed: 'The Firebase collection listener stopped with an error.',
    timestamp_invalid: 'A Firebase timestamp could not be converted to the MySQL datetime type.',
    pending_queue_write_failed: 'TraverseX could not update the MySQL pending-queue report.',
    ER_NO_DEFAULT_FOR_FIELD: `The registered MySQL target rejected a required field: ${String(error?.sqlMessage ?? error?.message ?? 'no SQL detail').slice(0, 300)}`
  };
  const description = descriptions[code] ?? `TraverseX could not complete this operation: ${String(error?.sqlMessage ?? error?.message ?? 'no technical detail').slice(0, 300)}`;
  return { code, description };
};

const writeRuntime = (status = runtimeStatus, failure = undefined) => {
  runtimeStatus = status;
  if (failure) lastFailure = failure;
  if (status === 'RUNNING' && pendingQueue === 0) lastFailure = null;
  const reportedFailure = lastFailure;
  const write = runtimeWrite.catch(() => {}).then(() => query(`UPDATE traversex_runtime
    SET service_status = ?, firebase_reads = ?, pending_queue = ?, processed_count = ?,
        retry_count = ?, dead_letter_count = ?, active_collection_count = ?, listener_count = ?,
        last_heartbeat_at = CURRENT_TIMESTAMP(6), last_event_at = ?,
        last_error_code = ?, last_error_description = ?
    WHERE project_xId = ?`, [
    status, firebaseReads, pendingQueue, processedCount, retryCount, deadLetterCount,
    activeCollectionCount, listenerCount, lastEventAt,
    reportedFailure?.code ?? null, reportedFailure?.description ?? null, project.xId
  ]));
  runtimeWrite = write.catch(() => {});
  return write;
};

await query(`INSERT INTO traversex_runtime
  (project_xId, service_status, last_restart_at)
  VALUES (?, 'STARTING', CURRENT_TIMESTAMP(6))
  ON DUPLICATE KEY UPDATE service_status='STARTING', last_restart_at=CURRENT_TIMESTAMP(6)`, [project.xId]);
await writeRuntime('STARTING');

const targetPool = createProjectPool(project);
const targetQuery = async (sql, params = []) => {
  const [rows] = await targetPool.execute(sql, params);
  return rows;
};
const targetConnection = await targetPool.getConnection();
try {
  await targetConnection.query('SELECT 1');
} finally {
  targetConnection.release();
}

const db = getFirebaseDbForProject(project);
const asSqlDate = (value) => {
  if (!value) return null;
  let date;
  if (typeof value.toDate === 'function') date = value.toDate();
  else if (value instanceof Date) date = value;
  else if (typeof value === 'string') {
    // Firebase documents may contain an SQL-shaped value with six fractional
    // digits. Normalize it before handing it to the JavaScript Date parser.
    const sqlValue = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/);
    if (sqlValue) {
      const fraction = (sqlValue[3] ?? '').padEnd(3, '0').slice(0, 3);
      const zone = sqlValue[4] ?? 'Z';
      date = new Date(`${sqlValue[1]}T${sqlValue[2]}.${fraction}${zone}`);
    } else date = new Date(value);
  } else date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error('timestamp_invalid');
    error.code = 'timestamp_invalid';
    throw error;
  }
  return date.toISOString().slice(0, 23).replace('T', ' ');
};
const asEventDate = (change) => {
  try {
    return asSqlDate(change.doc.updateTime ?? change.doc.createTime ?? null);
  } catch {
    return null;
  }
};

// Firestore reports every document already matching a query as `added` when a
// listener first attaches. That is a listener-delivery detail, not proof of a
// new insert. Use the Firebase lifecycle timestamps already present in the
// document to keep the MySQL activity report honest without another read:
// an existing document whose updated timestamp differs from its created
// timestamp is reported as `modified`.
const reportedChangeType = (change) => {
  if (change.type !== 'added') return change.type;
  const data = change.doc.data() ?? {};
  if (!data.firebase_created_at || !data.firebase_updated_at) return 'added';
  try {
    return asSqlDate(data.firebase_created_at) !== asSqlDate(data.firebase_updated_at)
      ? 'modified'
      : 'added';
  } catch {
    return 'added';
  }
};

const quoteIdentifier = (name) => `\`${String(name).replaceAll('`', '``')}\``;

const targetTableColumns = async (table) => {
  const rows = await targetQuery(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS sqlType,
      IS_NULLABLE AS nullable, EXTRA AS extra, COLUMN_KEY AS columnKey, ORDINAL_POSITION AS ordinal
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    ORDER BY ORDINAL_POSITION`, [table]);
  return rows.map((row) => ({
    name: row.name,
    sqlType: row.sqlType,
    nullable: String(row.nullable).toUpperCase() === 'YES',
    autoIncrement: String(row.extra ?? '').toLowerCase().includes('auto_increment'),
    identity: row.name === 'firebase_document_id',
    ordinal: Number(row.ordinal)
  }));
};

const targetTableExists = async (table) => (await targetQuery(`SELECT 1 AS present
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`, [table])).length > 0;

const sqlTypeFamily = (sqlType) => {
  const type = String(sqlType ?? '').toLowerCase();
  if (type.includes('char') || type.includes('text')) return 'string';
  if (type.includes('int')) return 'integer';
  if (type.includes('decimal') || type.includes('double') || type.includes('float')) return 'number';
  if (type.includes('date') || type.includes('time')) return 'datetime';
  if (type.includes('json')) return 'json';
  return type.split(/[ (]/)[0];
};

const compatibleCopyColumns = (actual, expected, collection) => {
  const oldByName = new Map(actual.map((column) => [column.name, column]));
  const newByName = new Map(expected.map((column) => [column.name, column]));
  const copied = [];
  const pairs = [];
  const identitySource = identityCandidates(collection)
    .map((name) => oldByName.get(name))
    .find((column) => column && !oldByName.has('firebase_document_id')
      && sqlTypeFamily(column.sqlType) === 'string');
  if (oldByName.has('firebase_document_id')) {
    pairs.push({ from: 'firebase_document_id', to: 'firebase_document_id' });
    copied.push('firebase_document_id');
  } else if (identitySource) {
    pairs.push({ from: identitySource.name, to: 'firebase_document_id' });
    copied.push(`${identitySource.name}->firebase_document_id`);
  }
  for (const wanted of expected) {
    if (wanted.system || wanted.identity || !oldByName.has(wanted.name)) continue;
    const previous = oldByName.get(wanted.name);
    if (sqlTypeFamily(previous.sqlType) !== sqlTypeFamily(wanted.sqlType)) continue;
    pairs.push({ from: previous.name, to: wanted.name });
    copied.push(wanted.name);
  }
  return { pairs, copied };
};

const createProjectionTable = async (table, schema) => {
  const definitions = schema.map((column) => {
    const nullability = column.nullable ? 'NULL' : 'NOT NULL';
    const autoIncrement = column.autoIncrement ? ' AUTO_INCREMENT' : '';
    return `${quoteIdentifier(column.name)} ${column.sqlType} ${nullability}${autoIncrement}`;
  });
  const indexes = [
    'PRIMARY KEY (`xId`)',
    'UNIQUE KEY `uq_firebase_document_id` (`firebase_document_id`)'
  ];
  if (schema.some((column) => column.name === 'mysql_sync_status')) {
    indexes.push('KEY `ix_mysql_sync_status` (`mysql_sync_status`)');
  }
  if (schema.some((column) => column.name === 'project_key')) {
    indexes.push('KEY `ix_project_key` (`project_key`)');
  }
  await targetQuery(`CREATE TABLE ${quoteIdentifier(table)} (
    ${definitions.concat(indexes).join(',\n    ')}
  ) ENGINE=InnoDB`);
};

const recordSchemaChange = async (registry, table, backupTable, reason, previous, current, copied) => {
  await query(`INSERT INTO traversex_schema_change
    (project_xId, collection_xId, firebase_collection, target_table, backup_table,
     change_reason, previous_schema, current_schema, copied_columns)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    project.xId, registry.xId ?? null, registry.firebase_collection, table, backupTable,
    reason, JSON.stringify(previous ?? []), JSON.stringify(current ?? []), JSON.stringify(copied ?? [])
  ]);
};

const rebuildProjectionTable = async (registry, table, schema, actual, reason) => {
  const backupTable = backupTableName(table);
  let candidate = backupTable;
  let suffix = 2;
  while (await targetTableExists(candidate)) {
    candidate = backupTableName(table, new Date(), `_${suffix}`);
    suffix += 1;
  }
  const { pairs, copied } = compatibleCopyColumns(actual, schema, registry.firebase_collection);
  try {
    await targetQuery(`RENAME TABLE ${quoteIdentifier(table)} TO ${quoteIdentifier(candidate)}`);
    await createProjectionTable(table, schema);
    if (pairs.length > 0) {
      const destinations = pairs.map((pair) => quoteIdentifier(pair.to)).join(', ');
      const sources = pairs.map((pair) => quoteIdentifier(pair.from)).join(', ');
      const identityPair = pairs.find((pair) => pair.to === 'firebase_document_id');
      if (identityPair) {
        await targetQuery(`INSERT IGNORE INTO ${quoteIdentifier(table)} (${destinations})
          SELECT ${sources} FROM ${quoteIdentifier(candidate)}
          WHERE ${quoteIdentifier(identityPair.from)} IS NOT NULL`);
      }
    }
    await recordSchemaChange(registry, table, candidate, reason, actual, schema, copied);
  } catch (error) {
    try {
      if (await targetTableExists(table)) await targetQuery(`DROP TABLE ${quoteIdentifier(table)}`);
      if (await targetTableExists(candidate)) await targetQuery(`RENAME TABLE ${quoteIdentifier(candidate)} TO ${quoteIdentifier(table)}`);
    } catch (rollbackError) {
      error.rollback_error = rollbackError?.message ?? String(rollbackError);
    }
    error.code = error.code === 'ER_DUP_ENTRY' ? error.code : 'schema_rebuild_failed';
    throw error;
  }
};

const ensureProjectionTable = async (registry, table, schema) => {
  const actual = await targetTableColumns(table);
  if (actual.length === 0) {
    try {
      await createProjectionTable(table, schema);
      await recordSchemaChange(registry, table, null, 'CREATE', [], schema, []);
    } catch (error) {
      error.code = error.code ?? 'schema_backup_failed';
      throw error;
    }
    return;
  }
  const diff = schemaDiff(actual, schema);
  if (diff.changed) await rebuildProjectionTable(registry, table, schema, actual, 'REBUILD');
};

const readbackValue = (value, sqlType) => {
  if (value === null || value === undefined) return null;
  if (String(sqlType).toLowerCase().includes('json')) {
    try { return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value); } catch { return String(value); }
  }
  return comparableMysqlValue(value, sqlType, asSqlDate);
};

const projectDynamicProjection = async (registry, change) => {
  const collection = assertSafeCollectionName(registry.firebase_collection);
  if (collection.length > 47) {
    const error = new Error('projection_table_name_too_long');
    error.code = 'projection_table_name_too_long';
    throw error;
  }
  const data = change.doc.data() ?? {};
  if (data.firebase_collection !== undefined && data.firebase_collection !== collection) {
    const error = new Error('firebase_collection_mismatch');
    error.code = 'firebase_collection_mismatch';
    throw error;
  }
  if (data.project_key !== undefined && data.project_key !== project.project_key) {
    const error = new Error('firebase_project_mismatch');
    error.code = 'firebase_project_mismatch';
    throw error;
  }
  const schema = buildProjectionSchema(collection, data, asSqlDate);
  await ensureProjectionTable(registry, collection, schema);
  // The identity column is engine-owned but must still be written from the
  // Firestore document ID. Only xId is generated by MySQL.
  const projected = schema.filter((column) => !column.system || column.identity);
  const columnNames = projected.map((column) => column.name);
  const values = projected.map((column) => column.identity
    ? change.doc.id
    : toMysqlValue(data[column.name], column.sqlType, asSqlDate));
  const assignments = projected.filter((column) => !column.identity)
    .map((column) => `${quoteIdentifier(column.name)}=VALUES(${quoteIdentifier(column.name)})`);
  if (assignments.length === 0) assignments.push('`firebase_document_id`=VALUES(`firebase_document_id`)');
  await targetQuery(`INSERT INTO ${quoteIdentifier(collection)} (${columnNames.map(quoteIdentifier).join(', ')})
    VALUES (${columnNames.map(() => '?').join(', ')})
    ON DUPLICATE KEY UPDATE ${assignments.join(', ')}`, values);

  // Read DATETIME values as raw MySQL strings. mysql2 otherwise converts a
  // DATETIME into a JavaScript Date using the connection timezone, which can
  // create a false read-back mismatch against the Firebase server timestamp.
  const readbackColumns = projected.map((column) => String(column.sqlType).toLowerCase().startsWith('datetime')
    ? `DATE_FORMAT(${quoteIdentifier(column.name)}, '%Y-%m-%d %H:%i:%s.%f') AS ${quoteIdentifier(column.name)}`
    : quoteIdentifier(column.name));
  const rows = await targetQuery(`SELECT ${readbackColumns.join(', ')}
    FROM ${quoteIdentifier(collection)} WHERE \`firebase_document_id\` = ? LIMIT 1`, [change.doc.id]);
  const row = rows[0];
  const matches = Boolean(row) && projected.every((column, index) => {
    const expected = values[index];
    const actual = readbackValue(row[column.name], column.sqlType);
    if (expected === null || expected === undefined) return actual === null;
    return actual === readbackValue(expected, column.sqlType);
  });
  if (!matches) {
    const error = new Error('firebase_readback_mismatch');
    error.code = 'firebase_readback_mismatch';
    throw error;
  }
  await change.doc.ref.update({ mysql_sync_status: 'SYNCED', mysql_synced_at: FieldValue.serverTimestamp() });
  const targetColumns = new Set((await targetTableColumns(collection)).map((column) => column.name));
  const syncUpdates = [];
  const syncValues = [];
  if (targetColumns.has('mysql_sync_status')) {
    syncUpdates.push('`mysql_sync_status`=?');
    syncValues.push('SYNCED');
  }
  if (targetColumns.has('mysql_synced_at')) syncUpdates.push('`mysql_synced_at`=CURRENT_TIMESTAMP(6)');
  if (syncUpdates.length > 0) {
    await targetQuery(`UPDATE ${quoteIdentifier(collection)} SET ${syncUpdates.join(', ')}
      WHERE \`firebase_document_id\` = ?`, [...syncValues, change.doc.id]);
  }
};

const insertCollectionEvent = async (registry, change, status, failure = null, attemptCount = 1, changeType = reportedChangeType(change)) => {
  const result = await query(`INSERT INTO traversex_collection_event
    (project_xId, collection_xId, firebase_collection, firebase_document_id, firebase_change_type,
     event_status, attempt_count, error_code, error_description, firebase_event_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    project.xId, registry.xId ?? null, registry.firebase_collection, change.doc.id, changeType,
    status, attemptCount, failure?.code ?? null, failure?.description ?? null, asEventDate(change)
  ]);
  if (registry.xId && result?.insertId) {
    await query(`UPDATE traversex_collection c
      JOIN traversex_collection_event e ON e.xId = ?
      SET c.last_event_xId = e.xId,
          c.last_event_change_type = e.firebase_change_type,
          c.last_event_document_id = e.firebase_document_id,
          c.last_event_status = e.event_status,
          c.last_event_attempt_count = e.attempt_count,
          c.last_event_recorded_at = e.traverse_recorded_at
      WHERE c.xId = ? AND (
        c.last_event_recorded_at IS NULL
        OR c.last_event_recorded_at < e.traverse_recorded_at
        OR (c.last_event_recorded_at = e.traverse_recorded_at AND c.last_event_xId < e.xId)
      )`, [
      result.insertId, registry.xId
    ]);
  }
};

const upsertPendingQueue = async (registry, documentId, attemptCount = 0, failure = null) => {
  await query(`INSERT INTO traversex_pending_queue
    (project_xId, collection_xId, firebase_collection, firebase_document_id,
     pending_state, attempt_count, error_code, error_description)
    VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      collection_xId = VALUES(collection_xId),
      pending_state = 'PENDING',
      attempt_count = GREATEST(attempt_count, VALUES(attempt_count)),
      error_code = VALUES(error_code),
      error_description = VALUES(error_description),
      updated_at = CURRENT_TIMESTAMP(6)`, [
    project.xId, registry.xId ?? null, registry.firebase_collection, documentId,
    attemptCount, failure?.code ?? null, failure?.description ?? null
  ]);
};

const removePendingQueue = async (registry, documentId) => {
  await query(`DELETE FROM traversex_pending_queue
    WHERE project_xId = ? AND firebase_collection = ? AND firebase_document_id = ?`, [
    project.xId, registry.firebase_collection, documentId
  ]);
};

const syncPendingSnapshot = async (registry, snapshot) => {
  const documentIds = snapshot.docs.map((document) => document.id);
  for (const documentId of documentIds) {
    const attemptKey = `${registry.firebase_collection}:${documentId}`;
    await upsertPendingQueue(registry, documentId, eventAttempts.get(attemptKey) ?? 0);
  }
  if (documentIds.length === 0) {
    await query(`DELETE FROM traversex_pending_queue
      WHERE project_xId = ? AND firebase_collection = ?`, [project.xId, registry.firebase_collection]);
    return;
  }
  const placeholders = documentIds.map(() => '?').join(',');
  await query(`DELETE FROM traversex_pending_queue
    WHERE project_xId = ? AND firebase_collection = ?
      AND firebase_document_id NOT IN (${placeholders})`, [
    project.xId, registry.firebase_collection, ...documentIds
  ]);
};

const forgetPending = async (registry, documentId) => {
  try {
    await removePendingQueue(registry, documentId);
    pendingQueue = Math.max(0, pendingQueue - 1);
  } catch (error) {
    const failure = safeFailure(error, 'pending_queue_write_failed');
    console.error(JSON.stringify({
      event: 'pending_queue_cleanup_failed', project_key: project.project_key,
      collection: registry.firebase_collection, document: documentId,
      error_code: failure.code, error_description: failure.description
    }));
  }
};

const handleChange = async (registry, change) => {
  const attemptKey = `${registry.firebase_collection}:${change.doc.id}`;
  const attemptCount = (eventAttempts.get(attemptKey) ?? 0) + 1;
  eventAttempts.set(attemptKey, attemptCount);
  const changeType = reportedChangeType(change);
  try {
    // A successful Firebase acknowledgement removes the document from the
    // PENDING-only listener. That removal is not a delete and must not be
    // projected as one or retried as a new event.
    if (change.type === 'removed') {
      await forgetPending(registry, change.doc.id);
      await writeRuntime('RUNNING');
      return;
    }
    await projectDynamicProjection(registry, change);
    await insertCollectionEvent(registry, change, 'SUCCESS', null, attemptCount, changeType);
    await forgetPending(registry, change.doc.id);
    processedCount += 1;
    lastEventAt = new Date().toISOString().slice(0, 23).replace('T', ' ');
    await writeRuntime('RUNNING');
  } catch (error) {
    const failure = safeFailure(error);
    const status = attemptCount >= 12 ? 'DEAD_LETTER' : 'RETRY';
    if (status === 'DEAD_LETTER') deadLetterCount += 1;
    else retryCount += 1;
    try {
      await insertCollectionEvent(registry, change, status, failure, attemptCount, changeType);
    } catch {
      // Keep the worker alive if the control/report database itself is unavailable.
    }
    try {
      await upsertPendingQueue(registry, change.doc.id, attemptCount, failure);
    } catch {
      // The event error remains visible even if the pending report table is unavailable.
    }
    await writeRuntime('ERROR', failure);
    console.error(JSON.stringify({
      event: 'collection_change_failed', project_key: project.project_key,
      collection: registry.firebase_collection, document: change.doc.id,
      change_type: change.type, error_code: failure.code, error_description: failure.description
    }));
  }
};

const listenerRegistries = await query(`SELECT xId, project_xId, firebase_collection, traverse_status
  FROM traversex_collection
  WHERE project_xId = ? AND traverse_status = 'ACTIVE'
  ORDER BY xId`, [project.xId]);
const registeredCollections = listenerRegistries.some((row) => row.firebase_collection === 'project_test')
  ? listenerRegistries
  : [...listenerRegistries, { xId: null, project_xId: project.xId, firebase_collection: 'project_test', traverse_status: 'ACTIVE' }];
activeCollectionCount = registeredCollections.length;

const listeners = registeredCollections.map((registry) => {
  const listener = db.collection(registry.firebase_collection)
    .where('mysql_sync_status', '==', 'PENDING')
    .onSnapshot(async (snapshot) => {
      const changes = snapshot.docChanges();
      // A removed notification only means that an already-read document left
      // the PENDING query after acknowledgement; it is not another document
      // read. Count only document deliveries from the pending-only query.
      firebaseReads += changes.filter((change) => change.type !== 'removed').length;
      listenerSizes.set(registry.firebase_collection, snapshot.size);
      pendingQueue = [...listenerSizes.values()].reduce((total, size) => total + size, 0);
      try {
        await syncPendingSnapshot(registry, snapshot);
      } catch (error) {
        const failure = safeFailure(error, 'pending_queue_write_failed');
        console.error(JSON.stringify({
          event: 'pending_queue_snapshot_failed', project_key: project.project_key,
          collection: registry.firebase_collection, error_code: failure.code,
          error_description: failure.description
        }));
      }
      await writeRuntime('RUNNING');
      for (const change of changes) await handleChange(registry, change);
    }, async (error) => {
      const failure = safeFailure(error, 'firebase_listener_failed');
      await writeRuntime('ERROR', failure);
      console.error(JSON.stringify({
        event: 'firebase_listener_failed', project_key: project.project_key,
        collection: registry.firebase_collection, error_code: failure.code,
        error_description: failure.description
      }));
    });
  return listener;
});
listenerCount = listeners.length;
await writeRuntime('RUNNING');

const heartbeatTimer = setInterval(() => {
  void writeRuntime(runtimeStatus).catch((error) => {
    const failure = safeFailure(error, 'runtime_write_failed');
    console.error(JSON.stringify({
      event: 'runtime_heartbeat_failed', project_key: project.project_key,
      error_code: failure.code, error_description: failure.description
    }));
  });
}, 10000);
heartbeatTimer.unref();

console.log(`TraverseX worker ${config.instanceId} ready for registered project ${project.project_key}`);
console.log(`Listeners active: ${listenerCount} PENDING-only collection listeners; no periodic full rescan.`);
console.log(`Collections configured: ${listenerRegistries.map((row) => row.firebase_collection).join(', ') || 'none'}; project_test is the built-in diagnostics listener.`);
void listeners;
await new Promise(() => {});

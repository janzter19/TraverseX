const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATE_FIELD = /(?:^|_)(?:created|updated|deleted|synced|login|logout|activated|disabled|locked|at)$/i;
const SENSITIVE_FIELD = /(?:^|_)(?:password_hash|password_plaintext|secret|access_token|refresh_token|id_token|private_key|credential_json)(?:_|$)/i;

export const isSafeIdentifier = (value) => typeof value === 'string' && IDENTIFIER.test(value);

export const assertSafeIdentifier = (value, errorCode = 'firebase_field_name_invalid') => {
  if (!isSafeIdentifier(value)) {
    const error = new Error(errorCode);
    error.code = errorCode;
    throw error;
  }
  return value;
};

export const assertSafeCollectionName = (value) => assertSafeIdentifier(value, 'firebase_collection_name_invalid');

export const assertAllowedField = (field) => {
  assertSafeIdentifier(field);
  if (field === 'xId' || field === 'firebase_document_id') {
    const error = new Error('firebase_reserved_field');
    error.code = 'firebase_reserved_field';
    throw error;
  }
  if (SENSITIVE_FIELD.test(field)) {
    const error = new Error('firebase_sensitive_field_blocked');
    error.code = 'firebase_sensitive_field_blocked';
    throw error;
  }
  return field;
};

const isTimestamp = (value) => Boolean(value && typeof value.toDate === 'function');

const looksLikeDate = (field, value, asSqlDate) => {
  if (!DATE_FIELD.test(field) || typeof value !== 'string') return false;
  try {
    return Boolean(asSqlDate(value));
  } catch {
    return false;
  }
};

export const inferSqlType = (field, value, asSqlDate) => {
  if (isTimestamp(value) || value instanceof Date || looksLikeDate(field, value, asSqlDate)) return 'DATETIME(6)';
  if (typeof value === 'boolean') return 'TINYINT(1)';
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) return 'BIGINT';
  if (typeof value === 'number') return 'DOUBLE';
  if (Array.isArray(value) || (value && typeof value === 'object')) return 'JSON';
  if (typeof value === 'string') return value.length > 255 ? 'TEXT' : 'VARCHAR(255)';
  return DATE_FIELD.test(field) ? 'DATETIME(6)' : 'JSON';
};

export const buildProjectionSchema = (collection, data, asSqlDate) => {
  assertSafeCollectionName(collection);
  const fields = Object.keys(data ?? {});
  fields.forEach(assertAllowedField);
  return [
    { name: 'xId', sqlType: 'INT(10)', nullable: false, system: true, autoIncrement: true },
    { name: 'firebase_document_id', sqlType: 'VARCHAR(255)', nullable: false, system: true, identity: true },
    ...fields.map((name) => ({ name, sqlType: inferSqlType(name, data[name], asSqlDate), nullable: true }))
  ];
};

export const schemaFingerprint = (columns) => columns.map((column) => [
  column.name,
  String(column.sqlType).toLowerCase(),
  Boolean(column.nullable),
  Boolean(column.autoIncrement),
  Boolean(column.identity)
]);

const normalizedType = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// MariaDB exposes a JSON column as LONGTEXT through information_schema. Keep
// that storage representation compatible with the JSON contract so a healthy
// projection is not rebuilt on every PENDING delivery.
const schemaTypesMatch = (actual, expected) => {
  const left = normalizedType(actual);
  const right = normalizedType(expected);
  if (left === right) return true;
  // MariaDB/MySQL may report integer display widths (for example BIGINT(20))
  // through information_schema even when the logical type is BIGINT.
  const integerType = /^(tinyint|smallint|mediumint|int|bigint)(?:\(\d+\))?(?: unsigned)?$/;
  if (integerType.test(left) && integerType.test(right)) {
    return left.replace(/\(\d+\)/, '') === right.replace(/\(\d+\)/, '');
  }
  return right === 'json' && (left === 'longtext' || left === 'text');
};

export const schemaDiff = (actualColumns, expectedColumns) => {
  const actual = (actualColumns ?? []).map((column) => ({
    ...column,
    name: String(column.name),
    sqlType: normalizedType(column.sqlType),
    nullable: String(column.nullable).toUpperCase() === 'YES' || column.nullable === true,
    autoIncrement: Boolean(column.autoIncrement),
    identity: column.name === 'firebase_document_id'
  }));
  const expected = (expectedColumns ?? []).map((column) => ({
    ...column,
    sqlType: normalizedType(column.sqlType)
  }));
  const actualByName = new Map(actual.map((column) => [column.name, column]));
  const same = actual.length === expected.length && expected.every((wanted) => {
    const column = actualByName.get(wanted.name);
    return column
      && schemaTypesMatch(column.sqlType, wanted.sqlType)
      && column.nullable === Boolean(wanted.nullable)
      && column.autoIncrement === Boolean(wanted.autoIncrement)
      && column.identity === Boolean(wanted.identity);
  });
  if (same) return { changed: false, added: [], removed: [], typeChanged: [], actual, expected };
  const expectedByName = new Map(expected.map((column) => [column.name, column]));
  return {
    changed: true,
    added: expected.filter((column) => !actualByName.has(column.name)).map((column) => column.name),
    removed: actual.filter((column) => !expectedByName.has(column.name)).map((column) => column.name),
    typeChanged: expected.filter((column) => actualByName.has(column.name)
      && (!schemaTypesMatch(actualByName.get(column.name).sqlType, column.sqlType)
        || actualByName.get(column.name).nullable !== Boolean(column.nullable))).map((column) => column.name),
    actual,
    expected
  };
};

export const toMysqlValue = (value, sqlType, asSqlDate) => {
  if (value === undefined || value === null) return null;
  const type = normalizedType(sqlType);
  if (type === 'datetime(6)') return asSqlDate(value);
  if (type === 'tinyint(1)') return value ? 1 : 0;
  if (type === 'bigint') return typeof value === 'bigint' ? value.toString() : Number(value);
  if (type === 'double') return Number(value);
  if (type === 'json') return JSON.stringify(value);
  return String(value);
};

export const comparableMysqlValue = (value, sqlType, asSqlDate) => {
  if (value === undefined || value === null) return null;
  const type = normalizedType(sqlType);
  if (type === 'datetime(6)') {
    const normalized = asSqlDate(value);
    return normalized ? `${normalized.slice(0, 19)}.${normalized.slice(20, 23).padEnd(3, '0')}000` : null;
  }
  if (type === 'json') return JSON.stringify(value);
  if (type === 'tinyint(1)') return value ? '1' : '0';
  return String(value);
};

export const backupTableName = (collection, date = new Date(), suffix = '') => {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}_${pad(date.getMonth() + 1)}_${pad(date.getDate())}_${pad(date.getHours())}_${pad(date.getSeconds())}`;
  return `${collection}_${stamp}${suffix}`;
};

export const identityCandidates = (collection) => {
  const withoutProject = collection.startsWith('project_') ? collection.slice('project_'.length) : collection;
  return [
    'firebase_document_id',
    `${collection}_key`,
    `${withoutProject}_key`,
    'document_key'
  ];
};

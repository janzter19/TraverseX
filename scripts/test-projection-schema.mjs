import assert from 'node:assert/strict';
import {
  assertAllowedField,
  backupTableName,
  buildProjectionSchema,
  schemaDiff
} from '../src/projection-schema.mjs';

const asSqlDate = (value) => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('invalid date');
  return parsed.toISOString().slice(0, 23).replace('T', ' ');
};

const schema = buildProjectionSchema('project_test', {
  project_key: 'rbmsv4-local',
  test_name: 'Schema test',
  created_at: new Date('2026-08-28T01:02:03.000Z'),
  enabled: true,
  metadata: { source: 'test' }
}, asSqlDate);

assert.deepEqual(schema.slice(0, 2).map((field) => field.name), ['xId', 'firebase_document_id']);
assert.equal(schema.find((field) => field.name === 'created_at').sqlType, 'DATETIME(6)');
assert.equal(schema.find((field) => field.name === 'enabled').sqlType, 'TINYINT(1)');
assert.equal(schema.find((field) => field.name === 'metadata').sqlType, 'JSON');
assert.equal(backupTableName('project_test', new Date(2026, 7, 28, 13, 35, 42)), 'project_test_2026_08_28_13_42');

assert.equal(schemaDiff(schema, schema).changed, false);
const changed = schemaDiff(schema, [...schema, { name: 'new_field', sqlType: 'varchar(255)', nullable: true }]);
assert.equal(changed.changed, true);
assert.deepEqual(changed.added, ['new_field']);
assert.throws(() => assertAllowedField('password_hash'), /firebase_sensitive_field_blocked/);
assert.throws(() => assertAllowedField('firebase_document_id'), /firebase_reserved_field/);

console.log('projection schema checks passed');

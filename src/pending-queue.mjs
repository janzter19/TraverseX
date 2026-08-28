// Control-database snapshot of documents currently matching the worker's
// PENDING-only Firebase listeners. It is used for zero-Firebase-read reports.
export const pendingQueueTableSql = `CREATE TABLE IF NOT EXISTS \`traversex_pending_queue\` (
  \`xId\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`project_xId\` INT(10) UNSIGNED NOT NULL,
  \`collection_xId\` INT(10) UNSIGNED NULL,
  \`firebase_collection\` VARCHAR(150) NOT NULL,
  \`firebase_document_id\` VARCHAR(255) NOT NULL,
  \`pending_state\` ENUM('PENDING') NOT NULL DEFAULT 'PENDING',
  \`attempt_count\` INT(10) UNSIGNED NOT NULL DEFAULT 0,
  \`error_code\` VARCHAR(100) NULL,
  \`error_description\` TEXT NULL,
  \`first_seen_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  \`updated_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (\`xId\`),
  UNIQUE KEY \`uq_traversex_pending_document\` (\`project_xId\`,\`firebase_collection\`,\`firebase_document_id\`),
  KEY \`ix_traversex_pending_project_state\` (\`project_xId\`,\`pending_state\`,\`updated_at\`),
  KEY \`ix_traversex_pending_collection_state\` (\`collection_xId\`,\`pending_state\`,\`updated_at\`),
  CONSTRAINT \`fk_traversex_pending_project\` FOREIGN KEY (\`project_xId\`) REFERENCES \`traversex_project\` (\`xId\`),
  CONSTRAINT \`fk_traversex_pending_collection\` FOREIGN KEY (\`collection_xId\`) REFERENCES \`traversex_collection\` (\`xId\`) ON DELETE SET NULL
) ENGINE=InnoDB`;

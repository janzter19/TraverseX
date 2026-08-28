CREATE DATABASE IF NOT EXISTS `traversex`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `traversex`;

CREATE TABLE IF NOT EXISTS `traversex_admin_user` (
  `xId` INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `must_change_password` TINYINT(1) NOT NULL DEFAULT 1,
  `user_status` ENUM('ACTIVE','INACTIVE','LOCKED') NOT NULL DEFAULT 'ACTIVE',
  `failed_attempts` INT(10) UNSIGNED NOT NULL DEFAULT 0,
  `locked_at` DATETIME(6) NULL,
  `last_login_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`xId`), UNIQUE KEY `uq_traversex_admin_username` (`username`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `traversex_project` (
  `xId` INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `project_key` VARCHAR(255) NOT NULL,
  `project_name` VARCHAR(150) NOT NULL,
  `firebase_project_id` VARCHAR(150) NOT NULL,
  `credential_ref` VARCHAR(255) NOT NULL,
  `mysql_host` VARCHAR(255) NULL,
  `mysql_port` SMALLINT UNSIGNED NULL,
  `mysql_database` VARCHAR(128) NULL,
  `mysql_username` VARCHAR(128) NULL,
  `mysql_password_ciphertext` TEXT NULL,
  `project_status` ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`xId`), UNIQUE KEY `uq_traversex_project_key` (`project_key`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `traversex_collection` (
  `xId` INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `project_xId` INT(10) UNSIGNED NOT NULL,
  `firebase_collection` VARCHAR(150) NOT NULL,
  `traverse_status` ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `contract_version` VARCHAR(32) NOT NULL DEFAULT '1',
  `last_event_xId` BIGINT UNSIGNED NULL,
  `last_event_change_type` ENUM('added','modified','removed') NULL,
  `last_event_document_id` VARCHAR(255) NULL,
  `last_event_status` ENUM('SUCCESS','RETRY','DEAD_LETTER','NOT_CONFIGURED') NULL,
  `last_event_attempt_count` INT(10) UNSIGNED NULL,
  `last_event_recorded_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`xId`), UNIQUE KEY `uq_traversex_collection` (`project_xId`,`firebase_collection`),
  KEY `ix_traversex_collection_status` (`traverse_status`),
  KEY `ix_traversex_collection_last_event` (`last_event_recorded_at`),
  CONSTRAINT `fk_traversex_collection_project` FOREIGN KEY (`project_xId`) REFERENCES `traversex_project` (`xId`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `traversex_runtime` (
  `xId` INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `project_xId` INT(10) UNSIGNED NOT NULL,
  `service_status` ENUM('STARTING','RUNNING','STOPPED','ERROR','NOT_READY') NOT NULL DEFAULT 'NOT_READY',
  `firebase_reads` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `pending_queue` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `processed_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `retry_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `dead_letter_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `active_collection_count` INT(10) UNSIGNED NOT NULL DEFAULT 0,
  `listener_count` INT(10) UNSIGNED NOT NULL DEFAULT 0,
  `last_heartbeat_at` DATETIME(6) NULL,
  `last_restart_at` DATETIME(6) NULL,
  `last_event_at` DATETIME(6) NULL,
  `last_error_code` VARCHAR(100) NULL,
  `last_error_description` TEXT NULL,
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`xId`), UNIQUE KEY `uq_traversex_runtime_project` (`project_xId`),
  CONSTRAINT `fk_traversex_runtime_project` FOREIGN KEY (`project_xId`) REFERENCES `traversex_project` (`xId`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `traversex_collection_event` (
  `xId` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `project_xId` INT(10) UNSIGNED NOT NULL,
  `collection_xId` INT(10) UNSIGNED NULL,
  `firebase_collection` VARCHAR(150) NOT NULL,
  `firebase_document_id` VARCHAR(255) NOT NULL,
  `firebase_change_type` ENUM('added','modified','removed') NOT NULL,
  `event_status` ENUM('SUCCESS','RETRY','DEAD_LETTER','NOT_CONFIGURED') NOT NULL DEFAULT 'SUCCESS',
  `attempt_count` INT(10) UNSIGNED NOT NULL DEFAULT 1,
  `error_code` VARCHAR(100) NULL,
  `error_description` TEXT NULL,
  `firebase_event_at` DATETIME(6) NULL,
  `traverse_recorded_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`xId`),
  KEY `ix_traversex_event_collection_time` (`collection_xId`,`traverse_recorded_at`),
  KEY `ix_traversex_event_project_time` (`project_xId`,`traverse_recorded_at`),
  KEY `ix_traversex_event_status` (`event_status`,`traverse_recorded_at`),
  KEY `ix_traversex_event_document` (`firebase_collection`,`firebase_document_id`),
  CONSTRAINT `fk_traversex_collection_event_project` FOREIGN KEY (`project_xId`) REFERENCES `traversex_project` (`xId`),
  CONSTRAINT `fk_traversex_collection_event_collection` FOREIGN KEY (`collection_xId`) REFERENCES `traversex_collection` (`xId`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `traversex_pending_queue` (
  `xId` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `project_xId` INT(10) UNSIGNED NOT NULL,
  `collection_xId` INT(10) UNSIGNED NULL,
  `firebase_collection` VARCHAR(150) NOT NULL,
  `firebase_document_id` VARCHAR(255) NOT NULL,
  `pending_state` ENUM('PENDING') NOT NULL DEFAULT 'PENDING',
  `attempt_count` INT(10) UNSIGNED NOT NULL DEFAULT 0,
  `error_code` VARCHAR(100) NULL,
  `error_description` TEXT NULL,
  `first_seen_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`xId`),
  UNIQUE KEY `uq_traversex_pending_document` (`project_xId`,`firebase_collection`,`firebase_document_id`),
  KEY `ix_traversex_pending_project_state` (`project_xId`,`pending_state`,`updated_at`),
  KEY `ix_traversex_pending_collection_state` (`collection_xId`,`pending_state`,`updated_at`),
  CONSTRAINT `fk_traversex_pending_project` FOREIGN KEY (`project_xId`) REFERENCES `traversex_project` (`xId`),
  CONSTRAINT `fk_traversex_pending_collection` FOREIGN KEY (`collection_xId`) REFERENCES `traversex_collection` (`xId`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `traversex_event` (
  `xId` INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `project_xId` INT(10) UNSIGNED NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `severity` ENUM('INFO','WARN','ERROR') NOT NULL DEFAULT 'INFO',
  `error_code` VARCHAR(100) NULL,
  `description` TEXT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`xId`), KEY `ix_traversex_event_created` (`created_at`), KEY `ix_traversex_event_project` (`project_xId`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `traversex_schema_change` (
  `xId` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `project_xId` INT(10) UNSIGNED NOT NULL,
  `collection_xId` INT(10) UNSIGNED NULL,
  `firebase_collection` VARCHAR(150) NOT NULL,
  `target_table` VARCHAR(64) NOT NULL,
  `backup_table` VARCHAR(64) NULL,
  `change_reason` ENUM('CREATE','REBUILD') NOT NULL,
  `previous_schema` JSON NOT NULL,
  `current_schema` JSON NOT NULL,
  `copied_columns` JSON NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`xId`),
  KEY `ix_traversex_schema_collection_time` (`collection_xId`,`created_at`),
  KEY `ix_traversex_schema_project_time` (`project_xId`,`created_at`),
  CONSTRAINT `fk_traversex_schema_project` FOREIGN KEY (`project_xId`) REFERENCES `traversex_project` (`xId`),
  CONSTRAINT `fk_traversex_schema_collection` FOREIGN KEY (`collection_xId`) REFERENCES `traversex_collection` (`xId`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Projection tables, including project_test, are created in the registered
-- project's MySQL database by TraverseX from the current Firebase document.
-- They are intentionally not created in the TraverseX control database.

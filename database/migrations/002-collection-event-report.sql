USE `traversex`;

-- Additive only. Existing project, collection, runtime, and event rows are preserved.
ALTER TABLE `traversex_runtime`
  ADD COLUMN IF NOT EXISTS `active_collection_count` INT(10) UNSIGNED NOT NULL DEFAULT 0 AFTER `dead_letter_count`,
  ADD COLUMN IF NOT EXISTS `listener_count` INT(10) UNSIGNED NOT NULL DEFAULT 0 AFTER `active_collection_count`,
  ADD COLUMN IF NOT EXISTS `last_restart_at` DATETIME(6) NULL AFTER `last_heartbeat_at`,
  ADD COLUMN IF NOT EXISTS `last_event_at` DATETIME(6) NULL AFTER `last_restart_at`;

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

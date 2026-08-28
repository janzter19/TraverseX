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

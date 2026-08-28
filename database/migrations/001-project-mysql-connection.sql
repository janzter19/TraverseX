USE `traversex`;

ALTER TABLE `traversex_project`
  ADD COLUMN `mysql_host` VARCHAR(255) NULL AFTER `credential_ref`,
  ADD COLUMN `mysql_port` SMALLINT UNSIGNED NULL AFTER `mysql_host`,
  ADD COLUMN `mysql_database` VARCHAR(128) NULL AFTER `mysql_port`,
  ADD COLUMN `mysql_username` VARCHAR(128) NULL AFTER `mysql_database`,
  ADD COLUMN `mysql_password_ciphertext` TEXT NULL AFTER `mysql_username`;

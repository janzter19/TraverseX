USE `traversex`;

-- Additive only. The full event history remains in traversex_collection_event;
-- these fields cache the newest event for a zero-extra-query dashboard view.
ALTER TABLE `traversex_collection`
  ADD COLUMN IF NOT EXISTS `last_event_xId` BIGINT UNSIGNED NULL AFTER `contract_version`,
  ADD COLUMN IF NOT EXISTS `last_event_change_type` ENUM('added','modified','removed') NULL AFTER `last_event_xId`,
  ADD COLUMN IF NOT EXISTS `last_event_document_id` VARCHAR(255) NULL AFTER `last_event_change_type`,
  ADD COLUMN IF NOT EXISTS `last_event_status` ENUM('SUCCESS','RETRY','DEAD_LETTER','NOT_CONFIGURED') NULL AFTER `last_event_document_id`,
  ADD COLUMN IF NOT EXISTS `last_event_attempt_count` INT(10) UNSIGNED NULL AFTER `last_event_status`,
  ADD COLUMN IF NOT EXISTS `last_event_recorded_at` DATETIME(6) NULL AFTER `last_event_attempt_count`,
  ADD INDEX IF NOT EXISTS `ix_traversex_collection_last_event` (`last_event_recorded_at`);

-- Backfill the cache from the latest recorded event without deleting or
-- rewriting any history. xId is the stable insertion order tie-breaker.
UPDATE `traversex_collection` c
JOIN `traversex_collection_event` e ON e.collection_xId = c.xId
LEFT JOIN `traversex_collection_event` newer
  ON newer.collection_xId = e.collection_xId
 AND (
   newer.traverse_recorded_at > e.traverse_recorded_at
   OR (newer.traverse_recorded_at = e.traverse_recorded_at AND newer.xId > e.xId)
 )
SET c.last_event_xId = e.xId,
    c.last_event_change_type = e.firebase_change_type,
    c.last_event_document_id = e.firebase_document_id,
    c.last_event_status = e.event_status,
    c.last_event_attempt_count = e.attempt_count,
    c.last_event_recorded_at = e.traverse_recorded_at
WHERE newer.xId IS NULL;

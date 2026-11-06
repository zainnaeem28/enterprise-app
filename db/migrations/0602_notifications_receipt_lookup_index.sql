-- migration-class: expand
-- transaction: none
-- BE06-F2: receipts look a notification up by the provider's message ID; without this every receipt scans the table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS notification_provider_message_idx
  ON notifications.notification (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

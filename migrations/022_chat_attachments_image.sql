-- Extend chat_attachments to support image uploads (waybill / document photos).
--
-- The chat already accepts payroll spreadsheets and stores the parsed rows in
-- `parsed_data`. Images follow the SAME pattern: when a user drops a waybill
-- (ზედნადები) photo, the upload route runs a vision extraction and stores the
-- extracted waybill fields in `parsed_data`, so the chat turn can build a
-- preview → confirm "send to rs.ge" card without re-reading the image.
--
-- `status='sent'` is added so a confirmed-and-sent waybill image is marked
-- terminal, making the confirm endpoint idempotent (a second click can't file
-- the same waybill twice on rs.ge).
--
-- Re-runnable: migrate.js applies every file from 001 on each run, so we DROP
-- the auto-named inline CHECK constraints first, then re-add the widened ones.

ALTER TABLE chat_attachments
  DROP CONSTRAINT IF EXISTS chat_attachments_kind_check;
ALTER TABLE chat_attachments
  ADD CONSTRAINT chat_attachments_kind_check
  CHECK (kind IN ('payroll_spreadsheet', 'image'));

ALTER TABLE chat_attachments
  DROP CONSTRAINT IF EXISTS chat_attachments_status_check;
ALTER TABLE chat_attachments
  ADD CONSTRAINT chat_attachments_status_check
  CHECK (status IN ('parsed', 'rejected', 'sent'));

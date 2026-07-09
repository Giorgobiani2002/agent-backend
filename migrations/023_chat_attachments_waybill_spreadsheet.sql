-- Extend chat_attachments to support waybill spreadsheets parsed by chat.
--
-- The file is read and stored as parsed JSON first; rs.ge submission happens
-- later through an explicit preview -> confirm action.

ALTER TABLE chat_attachments
  DROP CONSTRAINT IF EXISTS chat_attachments_kind_check;
ALTER TABLE chat_attachments
  ADD CONSTRAINT chat_attachments_kind_check
  CHECK (kind IN ('payroll_spreadsheet', 'image', 'waybill_spreadsheet'));

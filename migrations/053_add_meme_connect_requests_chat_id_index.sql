-- meme_connect_requests.chat_id has a FK to chats.id but Postgres never
-- auto-indexes FK columns. isMemeConnectChat(chatId) (memeConnect.service.ts)
-- runs `WHERE chat_id = $1` on EVERY chat message send (not just
-- meme-connect ones, called twice per send), so this was a full table scan
-- on the hot path of ordinary 1:1 messaging that only gets worse as the
-- table grows.
--
-- Not CREATE INDEX CONCURRENTLY: this project's migration runner
-- (scripts/run-migrations.js) always wraps each file in BEGIN/COMMIT, and
-- Postgres refuses CONCURRENTLY inside a transaction block. A plain
-- CREATE INDEX takes a brief SHARE lock (blocks writes, not reads) only on
-- this specific table -- meme_connect_requests is small (one row per
-- meme-connect request ever created, a niche feature), not the
-- high-volume messages/message_receipts tables, so this is safe.
create index if not exists idx_meme_connect_requests_chat_id
  on meme_connect_requests (chat_id);

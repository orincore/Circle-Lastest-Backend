-- Fixes push_tokens accumulating duplicate rows per physical device: the
-- previous dedup key was (user_id, token), but the raw push token itself
-- rotates on reinstall/cache-clear/FCM refresh, so every rotation inserted a
-- brand-new row instead of updating the existing one for that device.
--
-- device_id is a stable UUID the client generates once per install and
-- persists locally (see CircleReact's src/services/deviceId.js), sent on
-- every register/unregister call going forward. It's nullable so app builds
-- that predate this column keep working unchanged under the old
-- (user_id, token) upsert path -- see notifications.routes.ts.
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS device_id text;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS ip_address inet;

-- Partial: Postgres never treats NULLs as equal in a unique index, so this
-- only dedupes rows that DO have a device_id -- rows from not-yet-updated
-- clients (device_id IS NULL) never collide here and keep relying on the
-- pre-existing idx_push_tokens_user_token index as their fallback.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_user_device
    ON push_tokens (user_id, device_id) WHERE device_id IS NOT NULL;

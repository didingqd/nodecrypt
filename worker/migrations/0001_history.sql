-- ============================================================
-- [新增-消息留存] 消息留存所需的表结构
-- Message retention schema
--
-- 仅存储密文：服务器无法解密任何内容。
-- Only ciphertext is stored; the server cannot decrypt anything.
--
-- room_id = sha256(房间名) 的十六进制串，与客户端 NodeCrypt.setCredentials 中的
-- credentials.channel 完全一致，服务器在加入房间时即可得到该值。
-- ============================================================

-- 房间留存策略，一个房间一行
-- Per-room retention policy, one row per room
CREATE TABLE IF NOT EXISTS rooms (
	room_id       TEXT    PRIMARY KEY,           -- sha256(房间名)
	retention_sec INTEGER NOT NULL DEFAULT 0,    -- 0 = 不存储（保持现状）
	owner_hash    TEXT,                          -- 房主验证值 = sha256(房主密钥)，无房主时为 NULL
	kdf_version   INTEGER NOT NULL DEFAULT 1,    -- 历史密钥派生版本，便于将来提升迭代次数
	last_seq      INTEGER NOT NULL DEFAULT 0,    -- 已分配的最大消息序号
	stored_bytes  INTEGER NOT NULL DEFAULT 0,    -- 当前占用字节数，用于单房间配额
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL
);

-- 消息记录（仅密文）
-- Message records (ciphertext only)
CREATE TABLE IF NOT EXISTS messages (
	room_id    TEXT    NOT NULL,
	seq        INTEGER NOT NULL,                 -- 房间内单调递增，由服务器分配
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,                 -- created_at + retention_sec
	kind       INTEGER NOT NULL,                 -- 1=文本 2=图片
	bytes      INTEGER NOT NULL,                 -- 该条记录密文长度，用于配额统计
	nonce      TEXT    NOT NULL,                 -- base64(12 字节 AES-GCM IV)
	ct         TEXT,                             -- base64(AES-GCM 密文)，小记录直接存这里
	object_key TEXT,                             -- 大记录存 R2，这里只放对象键
	PRIMARY KEY (room_id, seq)
);

-- 清理扫描依据过期时间
-- Cleanup scans by expiry
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages (expires_at);

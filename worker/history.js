// ============================================================
// [新增-消息留存] 留存存储层：D1（索引与小记录）+ R2（大记录）
// [Retention] Storage layer: D1 (index + small records) + R2 (large records)
//
// 设计约束：
// 1. 本模块只接触密文，永远不做任何解密；
// 2. D1 不可用时（未绑定）整个留存功能静默降级为「不存储」，
//    原有的实时聊天功能完全不受影响。
// ============================================================

import { logEvent } from './utils.js';

// 单条记录内联存 D1 的上限（base64 字符数，约 150KB 原始数据）
// Inline threshold for D1 (base64 chars)
export const HISTORY_INLINE_MAX = 200 * 1024;

// 单条记录走 R2 的上限（base64 字符数）；超过则本条不入历史
// Hard cap for R2-backed records (base64 chars)
//
// 取值需要为传输层留出余量：客户端把这条记录塞进 {a:'hs'} 后还要经一次
// AES-256-CBC + base64，体积会再放大约 4/3。Cloudflare 对单条 WebSocket
// 消息的大小有上限（保守按 1MiB 计），因此这里取 512KB：512KB 密文经传输层
// 后约 700KB，仍有余量。若确认账户的上限更大，可以按比例调大此处与 HISTORY_PAGE_BYTES。
export const HISTORY_BLOB_MAX = 512 * 1024;

// 一次下发历史的条数上限与字节上限（分页）
// Page limits for history delivery
// 同样受上面那条传输层放大效应约束，这里取 512KB 以保证单页消息不超限。
export const HISTORY_PAGE_RECORDS = 200;
export const HISTORY_PAGE_BYTES = 512 * 1024;

// 留存时长上限（分钟）= 24 小时
// Maximum retention (minutes)
export const HISTORY_MAX_MINUTES = 1440;

// 单房间占用上限，防止刷爆存储
// Per-room storage quota
export const HISTORY_MAX_BYTES_PER_ROOM = 32 * 1024 * 1024;

// 房间空闲多久后回收策略行（0 留存的房间借此回到「首个加入者重新决定」）
// Idle TTL for room policy rows
export const HISTORY_ROOM_IDLE_MS = 24 * 60 * 60 * 1000;

// 单房间写入限流（条/分钟）
// Per-room write rate limit
export const HISTORY_RATE_PER_MINUTE = 60;

// 内存缓冲上限：房间内最后一个人退出前，记录都暂存在 DO 内存里
// In-memory buffer caps before the room empties
export const HISTORY_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
export const HISTORY_BUFFER_MAX_ITEMS = 5000;

// 记录类型
// Record kinds
export const HISTORY_KIND_TEXT = 1;
export const HISTORY_KIND_IMAGE = 2;

// 清理时每轮处理的批量
const SWEEP_BATCH = 200;

// 写入限流计时器（按 worker 实例内存计数，实例回收后重置，可接受）
// In-memory rate counters (reset when the isolate is recycled)
//
// 注意：限流由调用方在「写入内存缓冲」时判定，而不是在这里判定。
// 因为落库是房间清空时批量进行的，如果在 appendMessage 里限流，
// 一次批量落库会被自己的限流卡掉绝大部分记录。
const rateCounters = new Map();

/**
 * 判断某个房间在当前这一分钟是否还能写入
 * @param {string} roomId
 * @returns {boolean}
 */
export function allowWrite(roomId) {
	const now = Date.now();
	const bucket = Math.floor(now / 60000);
	const entry = rateCounters.get(roomId);
	if (!entry || entry.bucket !== bucket) {
		rateCounters.set(roomId, { bucket, count: 1 });
		return true;
	}
	if (entry.count >= HISTORY_RATE_PER_MINUTE) {
		return false;
	}
	entry.count += 1;
	return true;
}

/**
 * 校验并归一化一条待留存的记录，供「写入缓冲」与「落库」两处共用
 * @returns {{kind:number, ts:number, nonce:string, ct:string}|null}
 */
export function validateRecord(params) {
	if (!params || typeof params !== 'object') return null;
	const kind = params.kind;
	// 只接受已知类型
	if (kind !== HISTORY_KIND_TEXT && kind !== HISTORY_KIND_IMAGE) return null;
	const nonce = params.nonce;
	const ct = params.ct;
	if (typeof nonce !== 'string' || typeof ct !== 'string' || !nonce || !ct) return null;
	// 单条上限
	if (ct.length > HISTORY_BLOB_MAX) return null;
	const now = Date.now();
	// 客户端时间戳需要落在合理区间内，避免被用来构造超长/已过期的记录
	const ts = Number.isFinite(Number(params.ts))
		? Math.min(Math.max(Number(params.ts), now - HISTORY_ROOM_IDLE_MS), now + 60000)
		: now;
	return { kind, ts, nonce, ct };
}

/**
 * 读取房间策略
 * @returns {Promise<{retention_sec:number, owner_hash:string|null, last_seq:number, stored_bytes:number}|null>}
 */
export async function getRoom(db, roomId) {
	if (!db) return null;
	try {
		return await db
			.prepare('SELECT retention_sec, owner_hash, last_seq, stored_bytes, updated_at FROM rooms WHERE room_id = ?')
			.bind(roomId)
			.first();
	} catch (error) {
		logEvent('history-getRoom', error, 'error');
		return null;
	}
}

/**
 * 判断本次连接是否为房主
 * 两边都必须有值且相等。直接字符串比较即可：这个值本身是密钥派生物，
 * 且只在已建立加密通道的连接内传输，不存在实际可用的时序侧信道。
 */
function isOwner(row, ownerVerifier) {
	return !!(row && row.owner_hash && ownerVerifier && row.owner_hash === ownerVerifier);
}

/**
 * 确保房间策略存在，并判定本次连接是否为房主
 *
 * 策略只在「房间首次被创建」时写入首个加入者的请求值。
 * 之后房主想改必须走 applyRetention()：否则房主每次加入时表单里带的
 * 本地偏好值会被误当成「修改指令」，可能直接把历史清空。
 *
 * @param {number} requestedMinutes 首次创建时的留存分钟数
 * @param {string|null} ownerVerifier 房主验证值，没有则传 null
 * @returns {Promise<{minutes:number, owned:boolean, created:boolean}>}
 */
export async function ensureRoom(db, roomId, requestedMinutes, ownerVerifier) {
	const empty = { minutes: 0, owned: false, created: false };
	if (!db) return empty;
	const now = Date.now();
	try {
		const existing = await getRoom(db, roomId);
		if (existing) {
			// 已存在：只刷新活跃时间，策略保持不变
			await db
				.prepare('UPDATE rooms SET updated_at = ? WHERE room_id = ?')
				.bind(now, roomId)
				.run();
			return {
				minutes: Math.floor(existing.retention_sec / 60),
				owned: isOwner(existing, ownerVerifier),
				created: false
			};
		}
		const minutes = normalizeMinutes(requestedMinutes);
		await db
			.prepare(
				'INSERT INTO rooms (room_id, retention_sec, owner_hash, kdf_version, last_seq, stored_bytes, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, ?, ?)'
			)
			.bind(roomId, minutes * 60, ownerVerifier || null, now, now)
			.run();
		// 房间由本次连接创建，因此本次连接就是房主
		return { minutes, owned: true, created: true };
	} catch (error) {
		logEvent('history-ensureRoom', error, 'error');
		// 并发插入撞主键等情况：按已存在的策略处理
		const fallback = await getRoom(db, roomId);
		if (!fallback) return empty;
		return {
			minutes: Math.floor(fallback.retention_sec / 60),
			owned: isOwner(fallback, ownerVerifier),
			created: false
		};
	}
}

/**
 * 归一化留存分钟数：0 或 1..1440 的整数
 */
export function normalizeMinutes(value) {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(n, HISTORY_MAX_MINUTES);
}

/**
 * 写入一条密文记录
 *
 * 注意：本函数在「房间清空、批量落库」时被逐条调用，因此内部**不做限流**，
 * 限流由调用方在写入内存缓冲时判定（见 allowWrite）。
 * @param {object} params
 * @param {string} params.roomId
 * @param {number} params.kind 1=文本 2=图片
 * @param {number} params.ts 客户端给出的消息时间戳
 * @param {string} params.nonce base64
 * @param {string} params.ct base64 密文
 * @returns {Promise<number|null>} 分配到的 seq，null 表示未存储
 */
export async function appendMessage(db, blob, params) {
	const { roomId } = params;
	if (!db) return null;

	const record = validateRecord(params);
	if (!record) return null;
	const { kind, ts, nonce, ct } = record;

	const room = await getRoom(db, roomId);
	// 留存为 0 或房间策略已被回收 → 不存储
	if (!room || room.retention_sec <= 0) return null;

	// 单房间配额（此时 stored_bytes 只包含已经落库的部分）
	if (room.stored_bytes + ct.length > HISTORY_MAX_BYTES_PER_ROOM) {
		logEvent('history-quota-exceeded', roomId, 'error');
		return null;
	}

	const now = Date.now();
	const expiresAt = ts + room.retention_sec * 1000;

	// 超过内联阈值 → 落 R2，D1 只留对象键
	// Oversized records go to R2, D1 keeps only the object key
	let ctValue = ct;
	let objectKey = null;
	if (ct.length > HISTORY_INLINE_MAX) {
		if (!blob) return null;
		objectKey = `history/${roomId}/${ts}-${nonce.slice(0, 8)}`;
		try {
			await blob.put(objectKey, ct, { httpMetadata: { contentType: 'application/octet-stream' } });
			ctValue = null;
		} catch (error) {
			logEvent('history-blob-put', error, 'error');
			return null;
		}
	}

	try {
		// 先自增序号再插入，两条语句放在同一个 batch 里保证原子性；
		// 插入语句用子查询取回刚自增的 last_seq。
		await db.batch([
			db
				.prepare('UPDATE rooms SET last_seq = last_seq + 1, stored_bytes = stored_bytes + ?, updated_at = ? WHERE room_id = ?')
				.bind(ct.length, now, roomId),
			db
				.prepare(
					'INSERT INTO messages (room_id, seq, created_at, expires_at, kind, bytes, nonce, ct, object_key) VALUES (?, (SELECT last_seq FROM rooms WHERE room_id = ?), ?, ?, ?, ?, ?, ?, ?)'
				)
				.bind(roomId, roomId, ts, expiresAt, kind, ct.length, nonce, ctValue, objectKey)
		]);
		const updated = await getRoom(db, roomId);
		return updated ? updated.last_seq : null;
	} catch (error) {
		logEvent('history-append', error, 'error');
		// 插入失败时回收已写入的 R2 对象，避免产生孤儿对象
		if (objectKey && blob) {
			try {
				await blob.delete(objectKey);
			} catch (e) {
				logEvent('history-blob-rollback', e, 'error');
			}
		}
		return null;
	}
}

/**
 * 按序拉取历史，按条数与字节数双上限分页
 * @returns {Promise<{records:Array, lastSeq:number, more:boolean}>}
 */
export async function fetchHistory(db, blob, roomId, sinceSeq, retentionSec) {
	const empty = { records: [], lastSeq: sinceSeq, more: false };
	if (!db) return empty;
	try {
		const rows = await db
			.prepare(
				'SELECT seq, created_at, kind, nonce, ct, object_key, bytes FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
			)
			.bind(roomId, sinceSeq, HISTORY_PAGE_RECORDS)
			.all();
		const list = (rows && rows.results) || [];
		const records = [];
		let bytes = 0;
		let more = false;

		for (const row of list) {
			// 字节数超过本页上限就停止，剩下的留给下一页
			if (bytes > 0 && bytes + row.bytes > HISTORY_PAGE_BYTES) {
				more = true;
				break;
			}
			let ct = row.ct;
			if (row.object_key) {
				if (!blob) continue;
				try {
					const object = await blob.get(row.object_key);
					ct = object ? await object.text() : null;
				} catch (error) {
					logEvent('history-blob-get', error, 'error');
					ct = null;
				}
				// 对象缺失（例如已被清理）则跳过该条
				if (!ct) continue;
			}
			records.push({
				seq: row.seq,
				ts: row.created_at,
				k: row.kind,
				n: row.nonce,
				c: ct
			});
			bytes += row.bytes;
		}

		// 本页取满且还有剩余行 → 还有下一页
		if (!more && list.length === HISTORY_PAGE_RECORDS) more = true;

		// 游标取「本页检查过的最后一行」而不是「最后一条返回的记录」：
		// 当某条记录引用的 R2 对象缺失而被跳过时，游标仍必须前进，
		// 否则客户端会反复请求同一页，形成死循环。
		const lastSeq = list.length > 0 ? list[list.length - 1].seq : sinceSeq;
		return { records, lastSeq, more };
	} catch (error) {
		logEvent('history-fetch', error, 'error');
		return empty;
	}
}

/**
 * 先把待删记录引用的 R2 对象删掉，并把 object_key 置空。
 * 置空是为了让「object_key IS NOT NULL」这个条件能持续推进，
 * 从而一批批删除全部对象而不遗留孤儿对象。
 * @param {string} scopeWhere 附加的过滤条件（不含 WHERE 关键字）
 * @param {Array} scopeParams 对应的绑定参数
 * @returns {Promise<number>} 删除的对象数
 */
async function dropObjects(db, blob, scopeWhere, scopeParams) {
	let removed = 0;
	// 最多循环 50 批，避免单次调用时间过长；剩余部分留到下一次清理
	for (let i = 0; i < 50; i++) {
		const rows = await db
			.prepare(
				`SELECT room_id, seq, object_key FROM messages WHERE ${scopeWhere} AND object_key IS NOT NULL LIMIT ${SWEEP_BATCH}`
			)
			.bind(...scopeParams)
			.all();
		const list = (rows && rows.results) || [];
		if (list.length === 0) break;

		if (blob) {
			for (const row of list) {
				try {
					await blob.delete(row.object_key);
					removed += 1;
				} catch (error) {
					logEvent('history-blob-delete', error, 'error');
				}
			}
		}

		// 逐条置空（复合主键，按 room_id + seq 精确定位）
		await db.batch(
			list.map((row) =>
				db
					.prepare('UPDATE messages SET object_key = NULL WHERE room_id = ? AND seq = ?')
					.bind(row.room_id, row.seq)
			)
		);
	}
	return removed;
}

/**
 * 立即清除某房间的全部历史（房主把留存设为 0 时使用）
 * @returns {Promise<boolean>}
 */
export async function purgeRoom(db, blob, roomId) {
	if (!db) return false;
	try {
		// 先删 R2 对象（dropObjects 会分批推进并置空 object_key），再删行
		await dropObjects(db, blob, 'room_id = ?', [roomId]);
		await db.prepare('DELETE FROM messages WHERE room_id = ?').bind(roomId).run();
		await db.prepare('UPDATE rooms SET stored_bytes = 0 WHERE room_id = ?').bind(roomId).run();
		return true;
	} catch (error) {
		logEvent('history-purge', error, 'error');
		return false;
	}
}

/**
 * 房主修改留存时长
 *
 * - 设为 0：不保存任何消息，因此连同已落库的历史一起清除
 * - 调大或调小：顺带调整已存在记录的有效期（expires_at = created_at + 新时长），
 *   否则「把 60 分钟改成 24 小时」对旧消息不生效，与用户预期不符
 *
 * @returns {Promise<{ok:boolean, purged:boolean}>}
 */
export async function applyRetention(db, blob, roomId, minutes) {
	if (!db) return { ok: false, purged: false };
	try {
		const next = normalizeMinutes(minutes);
		await db
			.prepare('UPDATE rooms SET retention_sec = ?, updated_at = ? WHERE room_id = ?')
			.bind(next * 60, Date.now(), roomId)
			.run();

		if (next === 0) {
			const purged = await purgeRoom(db, blob, roomId);
			return { ok: true, purged };
		}

		await db
			.prepare('UPDATE messages SET expires_at = created_at + ? WHERE room_id = ?')
			.bind(next * 60 * 1000, roomId)
			.run();
		return { ok: true, purged: false };
	} catch (error) {
		logEvent('history-apply-retention', error, 'error');
		return { ok: false, purged: false };
	}
}

/**
 * 定时清理：删除过期消息与其 R2 对象，回收空闲房间策略行
 * 由 Worker 的 scheduled 处理器每分钟调用一次
 * @returns {Promise<{messages:number, objects:number, rooms:number}>}
 */
export async function sweep(db, blob) {
	const result = { messages: 0, objects: 0, rooms: 0 };
	if (!db) return result;
	const now = Date.now();

	try {
		// 1) 先删除过期记录引用的 R2 对象并置空 object_key，再删行，避免留下孤儿对象
		result.objects = await dropObjects(db, blob, 'expires_at <= ?', [now]);

		// 2) 记录受影响的房间，删除后需要重算它们的占用字节数
		const affected = await db
			.prepare('SELECT DISTINCT room_id FROM messages WHERE expires_at <= ? LIMIT 50')
			.bind(now)
			.all();

		// 3) 分批删除过期消息（用 rowid 限定批量，避免一次删除过多）
		for (let i = 0; i < 20; i++) {
			const deleted = await db
				.prepare(
					'DELETE FROM messages WHERE rowid IN (SELECT rowid FROM messages WHERE expires_at <= ? LIMIT 500)'
				)
				.bind(now)
				.run();
			const changes = (deleted && deleted.meta && deleted.meta.changes) || 0;
			result.messages += changes;
			if (changes === 0) break;
		}

		// 4) 重算占用字节数
		for (const row of (affected && affected.results) || []) {
			await db
				.prepare(
					'UPDATE rooms SET stored_bytes = COALESCE((SELECT SUM(bytes) FROM messages WHERE room_id = ?), 0) WHERE room_id = ?'
				)
				.bind(row.room_id, row.room_id)
				.run();
		}

		// 5) 回收空闲房间策略行：
		//    - 0 留存的房间超过空闲期即删除（下次进入重新由首个加入者决定）
		//    - 有留存但已无任何消息的房间同样回收
		const idleBefore = now - HISTORY_ROOM_IDLE_MS;
		const purged = await db
			.prepare(
				`DELETE FROM rooms
				 WHERE updated_at < ?
				   AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.room_id = rooms.room_id)`
			)
			.bind(idleBefore)
			.run();
		result.rooms = (purged && purged.meta && purged.meta.changes) || 0;
	} catch (error) {
		logEvent('history-sweep', error, 'error');
	}

	return result;
}

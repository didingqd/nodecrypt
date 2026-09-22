'use strict';

// ============================================================
// [新增-消息留存] 独立 Node 服务器的内存版留存实现
//
// 与 worker/history.js 保持同一套语义（相同的动作、相同的字段），
// 这样客户端代码在两种部署下走的是同一条路径，便于本地开发验证。
//
// 与 Worker 版本的差异：数据只存在进程内存里，进程重启即清空。
// 自托管场景通常规模很小，且原项目本就以「无持久化」为设计前提，
// 因此不为此引入额外数据库依赖。
//
// 本模块只接触密文，不做任何加解密。
// ============================================================

// 与 worker/history.js 及客户端 util.history.js 保持一致
const HISTORY_MAX_MINUTES = 1440;
const HISTORY_PAGE_RECORDS = 200;
const HISTORY_PAGE_BYTES = 512 * 1024;
const HISTORY_MAX_BYTES_PER_ROOM = 32 * 1024 * 1024;
const HISTORY_RATE_PER_MINUTE = 60;
const HISTORY_ROOM_IDLE_MS = 24 * 60 * 60 * 1000;
// 内存缓冲上限：房间清空之前记录都暂存在内存里
const HISTORY_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
const HISTORY_BUFFER_MAX_ITEMS = 5000;
const HISTORY_KIND_TEXT = 1;
const HISTORY_KIND_IMAGE = 2;

// roomId -> { retentionSec, ownerHash, lastSeq, storedBytes, updatedAt }
const rooms = new Map();
// roomId -> [{ seq, createdAt, expiresAt, kind, bytes, nonce, ct }]
const messages = new Map();
// roomId -> { bucket, count }
const rateCounters = new Map();

const getTime = () => new Date().getTime();

// 归一化留存分钟数：0 或 1..1440 的整数
function normalizeMinutes(value) {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(n, HISTORY_MAX_MINUTES);
}

// 单房间写入限流
// 注意：限流由调用方在「写入内存缓冲」时判定，而不是在 appendMessage 里判定。
// 因为落库是房间清空时批量进行的，如果在 appendMessage 里限流，
// 一次批量落库会被自己的限流卡掉绝大部分记录。
function allowWrite(roomId) {
	const bucket = Math.floor(getTime() / 60000);
	const entry = rateCounters.get(roomId);
	if (!entry || entry.bucket !== bucket) {
		rateCounters.set(roomId, { bucket, count: 1 });
		return true;
	}
	if (entry.count >= HISTORY_RATE_PER_MINUTE) return false;
	entry.count += 1;
	return true;
}

// 校验并归一化一条待留存的记录，供「写入缓冲」与「落库」两处共用
function validateRecord(params) {
	if (!params || typeof params !== 'object') return null;
	const kind = params.kind;
	if (kind !== HISTORY_KIND_TEXT && kind !== HISTORY_KIND_IMAGE) return null;
	const nonce = params.nonce;
	const ct = params.ct;
	if (typeof nonce !== 'string' || typeof ct !== 'string' || !nonce || !ct) return null;

	const now = getTime();
	const ts = Number.isFinite(Number(params.ts))
		? Math.min(Math.max(Number(params.ts), now - HISTORY_ROOM_IDLE_MS), now + 60000)
		: now;
	return { kind: kind, ts: ts, nonce: nonce, ct: ct };
}

// 判断本次连接是否为房主
// 两边都必须有值且相等
function isOwner(room, ownerVerifier) {
	return !!(room && room.ownerHash && ownerVerifier && room.ownerHash === ownerVerifier);
}

// 确保房间策略存在，并判定本次连接是否为房主
//
// 策略只在「房间首次被创建」时写入请求值；之后房主想改必须走 applyRetention()：
// 否则房主每次加入时带的本地偏好值会被误当成「修改指令」，可能直接清空历史。
function ensureRoom(roomId, requestedMinutes, ownerVerifier) {
	const now = getTime();
	const existing = rooms.get(roomId);
	if (existing) {
		existing.updatedAt = now;
		return {
			minutes: Math.floor(existing.retentionSec / 60),
			owned: isOwner(existing, ownerVerifier),
			created: false
		};
	}
	const minutes = normalizeMinutes(requestedMinutes);
	rooms.set(roomId, {
		retentionSec: minutes * 60,
		ownerHash: ownerVerifier || null,
		lastSeq: 0,
		storedBytes: 0,
		updatedAt: now
	});
	// 消息列表始终存在，避免策略由 0 改回非 0 后无处可写
	messages.set(roomId, messages.get(roomId) || []);
	return { minutes: minutes, owned: true, created: true };
}

// 读取房间策略
function getRoomPolicy(roomId) {
	return rooms.get(roomId) || null;
}

// 立即清除某房间的全部历史（房主把留存设为 0 时使用）
function purgeRoom(roomId) {
	messages.set(roomId, []);
	const room = rooms.get(roomId);
	if (room) room.storedBytes = 0;
	return true;
}

// 房主修改留存时长
// - 设为 0：连同已存在的历史一起清除
// - 改为其他值：顺带调整已存在记录的有效期，使「延长留存」对旧消息同样生效
function applyRetention(roomId, minutes) {
	const room = rooms.get(roomId);
	if (!room) return { ok: false, purged: false };

	const next = normalizeMinutes(minutes);
	room.retentionSec = next * 60;
	room.updatedAt = getTime();

	if (next === 0) {
		purgeRoom(roomId);
		return { ok: true, purged: true };
	}

	const list = messages.get(roomId) || [];
	const ttl = next * 60 * 1000;
	for (const row of list) {
		row.expiresAt = row.createdAt + ttl;
	}
	return { ok: true, purged: false };
}

// 写入一条密文记录
//
// 注意：本函数在「房间清空、批量落库」时被逐条调用，因此内部**不做限流**，
// 限流由调用方在写入内存缓冲时判定（见 allowWrite）。
function appendMessage(params) {
	const { roomId } = params;

	const record = validateRecord(params);
	if (!record) return null;
	const { kind, ts, nonce, ct } = record;

	const room = rooms.get(roomId);
	// 留存为 0 或房间尚未建立策略 → 不存储
	if (!room || room.retentionSec <= 0) return null;
	if (room.storedBytes + ct.length > HISTORY_MAX_BYTES_PER_ROOM) return null;

	const list = messages.get(roomId);
	if (!list) return null;

	const now = getTime();

	room.lastSeq += 1;
	room.storedBytes += ct.length;
	room.updatedAt = now;

	list.push({
		seq: room.lastSeq,
		createdAt: ts,
		expiresAt: ts + room.retentionSec * 1000,
		kind: kind,
		bytes: ct.length,
		nonce: nonce,
		ct: ct
	});

	return room.lastSeq;
}

// 按 seq 拉取一页历史，按条数与字节数双上限分页
function fetchHistory(roomId, sinceSeq) {
	const list = messages.get(roomId) || [];
	const records = [];
	let bytes = 0;
	let more = false;

	for (const row of list) {
		if (row.seq <= sinceSeq) continue;
		// 字节数超过本页上限就停止，剩下的留给下一页
		if (bytes > 0 && bytes + row.bytes > HISTORY_PAGE_BYTES) {
			more = true;
			break;
		}
		records.push({
			seq: row.seq,
			ts: row.createdAt,
			k: row.kind,
			n: row.nonce,
			c: row.ct
		});
		bytes += row.bytes;
		if (records.length >= HISTORY_PAGE_RECORDS) {
			more = true;
			break;
		}
	}

	const lastSeq = records.length > 0 ? records[records.length - 1].seq : sinceSeq;
	return { records: records, lastSeq: lastSeq, more: more };
}

// 清理过期消息并回收空闲房间
function sweep() {
	const now = getTime();
	const result = { messages: 0, rooms: 0 };

	for (const [roomId, list] of messages) {
		if (list.length === 0) continue;
		const kept = list.filter((row) => row.expiresAt > now);
		result.messages += list.length - kept.length;
		if (kept.length === list.length) continue;
		messages.set(roomId, kept);

		const room = rooms.get(roomId);
		if (room) {
			room.storedBytes = kept.reduce((sum, row) => sum + row.bytes, 0);
		}
	}

	// 回收空闲且已无消息的房间策略
	const idleBefore = now - HISTORY_ROOM_IDLE_MS;
	for (const [roomId, room] of rooms) {
		const list = messages.get(roomId);
		if (room.updatedAt < idleBefore && (!list || list.length === 0)) {
			rooms.delete(roomId);
			messages.delete(roomId);
			rateCounters.delete(roomId);
			result.rooms += 1;
		}
	}

	return result;
}

// 每分钟清理一次（与 Worker 的 cron 触发保持一致的分辨率）
function startSweeper() {
	const timer = setInterval(sweep, 60000);
	// 不要因为这个定时器而阻止进程退出
	if (timer && typeof timer.unref === 'function') timer.unref();
	return timer;
}

module.exports = {
	HISTORY_MAX_MINUTES: HISTORY_MAX_MINUTES,
	HISTORY_KIND_TEXT: HISTORY_KIND_TEXT,
	HISTORY_KIND_IMAGE: HISTORY_KIND_IMAGE,
	HISTORY_BUFFER_MAX_BYTES: HISTORY_BUFFER_MAX_BYTES,
	HISTORY_BUFFER_MAX_ITEMS: HISTORY_BUFFER_MAX_ITEMS,
	normalizeMinutes: normalizeMinutes,
	allowWrite: allowWrite,
	validateRecord: validateRecord,
	ensureRoom: ensureRoom,
	getRoomPolicy: getRoomPolicy,
	applyRetention: applyRetention,
	purgeRoom: purgeRoom,
	appendMessage: appendMessage,
	fetchHistory: fetchHistory,
	sweep: sweep,
	startSweeper: startSweeper
};

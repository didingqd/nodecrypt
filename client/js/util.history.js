// ============================================================
// [新增-消息留存] 客户端历史留存模块
// [Retention] Client-side message history module
//
// 职责：
// 1. 从「房间密码」派生历史密钥（服务器不知道密码，因此无法解密历史）；
// 2. 用 AES-GCM 加密/解密待留存的记录（带认证，比现有的 ChaCha20 更适合静态数据）；
// 3. 读写「留存时长偏好」（localStorage，作为新建房间时的默认值）。
//
// 说明：直播消息的加密逻辑完全不在这里，这里只管「存起来的那一份」。
// ============================================================

import {
	sha256
} from 'js-sha256';
// 留存时长的可读文案需要多语言支持
import { t } from './util.i18n.js';

// 留存时长上限：24 小时（分钟）
// Maximum retention: 24 hours in minutes
export const HISTORY_MAX_MINUTES = 1440;

// 服务器端允许内联存储的上限（base64 字符数），与 worker/history.js 保持一致
// Must match HISTORY_INLINE_MAX / HISTORY_BLOB_MAX in worker/history.js
export const HISTORY_INLINE_MAX = 200 * 1024;
// 单条记录上限。取 512KB 是为了给传输层留余量：这条记录还要经一次
// AES-256-CBC + base64，体积会再放大约 4/3，而 WebSocket 单条消息有大小上限。
export const HISTORY_BLOB_MAX = 512 * 1024;

// 记录类型，与 worker/history.js 的 HISTORY_KIND_* 对应
// Record kinds, must match worker/history.js
export const HISTORY_KIND_TEXT = 1;
export const HISTORY_KIND_IMAGE = 2;

// PBKDF2 迭代次数。历史密文会落到服务器上，必须用慢 KDF 抵抗离线爆破。
// PBKDF2 iterations; the ciphertext is stored server-side, so a slow KDF is required.
export const HISTORY_KDF_ITERATIONS = 310000;

// AAD 版本号。改动它会令旧记录无法解密；由于留存窗口最长 24 小时，可以接受。
// AAD version; bumping it invalidates old records (acceptable with a <=24h window).
const HISTORY_AAD_VERSION = 1;

// localStorage 中「留存时长偏好」的键名
const RETENTION_STORAGE_KEY = 'retention';

// ------------------------------------------------------------
// base64 辅助（分块处理，避免大图片触发调用栈溢出）
// base64 helpers (chunked to avoid call-stack overflow on large images)
// ------------------------------------------------------------

function bytesToBase64(bytes) {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function base64ToBytes(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

// ------------------------------------------------------------
// 密钥派生
// ------------------------------------------------------------

// 房间标识，与 NodeCrypt.setCredentials 中的 credentials.channel 完全一致
// Room id, identical to credentials.channel in NodeCrypt.setCredentials
export function roomIdOf(roomName) {
	return sha256(String(roomName));
}

// 房间密码哈希，与 NodeCrypt.setCredentials 中的 credentials.password 完全一致
// Password hash, identical to credentials.password in NodeCrypt.setCredentials
export function passwordHashOf(password) {
	return sha256(String(password === undefined || password === null ? '' : password));
}

// 留存必须要有房间密码：无密码时没有服务器不知道的熵源
// Retention requires a room password: without one there is no server-unknown entropy
export function canEnableRetention(password) {
	return !!(password && String(password).trim().length > 0);
}

// PBKDF2 输出（256 位），历史密钥与房主密钥共用同一条派生路径
async function derivePbkdf2Bits(passwordHash, roomIdHash) {
	const encoder = new TextEncoder();
	const material = await crypto.subtle.importKey(
		'raw',
		encoder.encode(passwordHash),
		'PBKDF2',
		false,
		['deriveBits']
	);
	return await crypto.subtle.deriveBits({
		name: 'PBKDF2',
		salt: encoder.encode(roomIdHash),
		iterations: HISTORY_KDF_ITERATIONS,
		hash: 'SHA-256'
	}, material, 256);
}

/**
 * 从房间名与房间密码派生历史密钥
 * 历史密钥 = PBKDF2-SHA256(密码哈希, salt=房间哈希, 310000 次, 256 位)
 * @returns {Promise<CryptoKey|null>} 无密码时返回 null（留存不可用）
 */
export async function deriveHistoryKey(roomName, password) {
	if (!canEnableRetention(password)) return null;
	try {
		const bits = await derivePbkdf2Bits(passwordHashOf(password), roomIdOf(roomName));
		return await crypto.subtle.importKey('raw', bits, {
			name: 'AES-GCM'
		}, false, ['encrypt', 'decrypt']);
	} catch (error) {
		console.error('deriveHistoryKey failed', error);
		return null;
	}
}

/**
 * 派生房主验证值（用于「谁可以修改留存时长」）
 *
 * 房主密钥 = PBKDF2-SHA256(管理密码哈希, salt=房间哈希, 310000 次, 256 位)
 * 提交给服务器的是它的 SHA-256，服务器只存这个值：
 * - 服务器无法反推管理密码（要反推得对每个候选密码付一次 PBKDF2 的代价）
 * - 服务器也拿不到任何可用于解密历史的材料
 * 因为盐是房间名，所以同一个人在不同房间、或换设备重新输入同一个管理密码，
 * 都会得到同一个验证值 —— 这就是「退出重进 / 换设备仍被认作房主」的原理。
 *
 * @returns {Promise<string|null>} 十六进制验证值；未填管理密码时返回 null
 */
export async function deriveOwnerVerifier(roomName, ownerPassword) {
	if (!ownerPassword || !String(ownerPassword).trim()) return null;
	try {
		const bits = await derivePbkdf2Bits(passwordHashOf(ownerPassword), roomIdOf(roomName));
		return sha256(new Uint8Array(bits));
	} catch (error) {
		console.error('deriveOwnerVerifier failed', error);
		return null;
	}
}

// ------------------------------------------------------------
// 记录加解密
// ------------------------------------------------------------

function buildAad(roomId, ts, kind) {
	return new TextEncoder().encode(`${roomId}|${ts}|${kind}|v${HISTORY_AAD_VERSION}`);
}

/**
 * 加密一条待留存的记录
 * @param {CryptoKey} historyKey
 * @param {string} roomId 房间哈希（sha256(房间名)）
 * @param {number} ts 消息时间戳
 * @param {number} kind 1=文本 2=图片
 * @param {object} payload 明文负载，形如 {u: 用户名, t: 消息类型, d: 内容}
 * @returns {Promise<{n:string, c:string}|null>} base64 的 IV 与密文
 */
export async function encryptRecord(historyKey, roomId, ts, kind, payload) {
	if (!historyKey) return null;
	try {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const cipher = await crypto.subtle.encrypt({
			name: 'AES-GCM',
			iv: iv,
			additionalData: buildAad(roomId, ts, kind)
		}, historyKey, new TextEncoder().encode(JSON.stringify(payload)));
		return {
			n: bytesToBase64(iv),
			c: bytesToBase64(new Uint8Array(cipher))
		};
	} catch (error) {
		console.error('encryptRecord failed', error);
		return null;
	}
}

/**
 * 解密一条历史记录
 * 密码不符或记录被篡改时返回 null，由调用方静默跳过
 * @returns {Promise<object|null>}
 */
export async function decryptRecord(historyKey, roomId, record) {
	if (!historyKey || !record) return null;
	try {
		const plain = await crypto.subtle.decrypt({
			name: 'AES-GCM',
			iv: base64ToBytes(record.n),
			additionalData: buildAad(roomId, record.ts, record.k)
		}, historyKey, base64ToBytes(record.c));
		return JSON.parse(new TextDecoder().decode(plain));
	} catch (error) {
		// 密码不同、房间不同或数据被篡改都会走到这里，属于预期情况
		return null;
	}
}

/**
 * 判断某条直播消息是否需要留存，以及对应的记录类型
 * @returns {number|null} 1=文本 2=图片 null=不留存
 */
export function kindOfMessage(msgType) {
	if (msgType === 'text') return HISTORY_KIND_TEXT;
	if (msgType === 'image') return HISTORY_KIND_IMAGE;
	// 文件分卷体积大且需要清单，暂不纳入留存范围
	return null;
}

/**
 * 估算加密后的记录是否超出服务器允许的上限
 * @param {object} record encryptRecord 的返回值
 * @returns {boolean}
 */
export function isRecordTooLarge(record) {
	return !record || !record.c || record.c.length > HISTORY_BLOB_MAX;
}

// ------------------------------------------------------------
// 留存时长偏好（localStorage）
// ------------------------------------------------------------

/**
 * 归一化留存分钟数：0 或 1..1440 的整数
 */
export function normalizeMinutes(value) {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(n, HISTORY_MAX_MINUTES);
}

/**
 * 读取「留存时长偏好」：新建房间时提交给服务器的默认值
 * @returns {number} 分钟，0 表示不存储
 */
export function getRetentionPreference() {
	try {
		const settings = JSON.parse(localStorage.getItem('settings') || '{}');
		return normalizeMinutes(settings[RETENTION_STORAGE_KEY]);
	} catch (error) {
		return 0;
	}
}

/**
 * 保存「留存时长偏好」，读取-合并-写回以免覆盖其他设置项
 */
export function setRetentionPreference(minutes) {
	try {
		const settings = JSON.parse(localStorage.getItem('settings') || '{}');
		settings[RETENTION_STORAGE_KEY] = normalizeMinutes(minutes);
		localStorage.setItem('settings', JSON.stringify(settings));
	} catch (error) {
		console.error('setRetentionPreference failed', error);
	}
}

/**
 * 留存时长的可读文案，例如「不保存」「60 分钟」「2 小时」「1 小时 30 分钟」
 * t() 在缺键时返回 fallback，因此文案即使漏配也能正常显示
 */
export function formatRetention(minutes) {
	const n = normalizeMinutes(minutes);
	if (n <= 0) {
		return t('retention.off', 'Not stored')
	}
	if (n % 60 === 0) {
		return t('retention.hours', '{n} hours').replace('{n}', String(n / 60))
	}
	if (n > 60) {
		return t('retention.hours_minutes', '{h} h {m} min')
			.replace('{h}', String(Math.floor(n / 60)))
			.replace('{m}', String(n % 60))
	}
	return t('retention.minutes', '{n} minutes').replace('{n}', String(n))
}

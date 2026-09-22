#!/usr/bin/env nodejs

'use strict';

const crypto = require('crypto');
const ws = require('ws');
// [新增-消息留存] 内存版留存存储（与 worker/history.js 语义一致）
const history = require('./history.js');

// Generate a new RSA key pair
// 生成一个新的 RSA 密钥对
const generateRSAKeyPair = () => {
	try {
		console.log('Generating new RSA keypair...');
		const {
			publicKey,
			privateKey
		} = crypto.generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: {
				type: 'spki',
				format: 'der'
			},
			privateKeyEncoding: {
				type: 'pkcs8',
				format: 'der'
			}
		});

		return {
			rsaPublic: Buffer.from(publicKey).toString('base64'),
			rsaPrivate: crypto.createPrivateKey({
				key: privateKey,
				format: 'der',
				type: 'pkcs8'
			})
		};
	} catch (error) {
		console.error('Error generating RSA key pair:', error);
		process.exit(1);
	}
};

const keyPair = generateRSAKeyPair();
console.log('RSA key pair generated successfully');

const config = {
	rsaPrivate: keyPair.rsaPrivate,
	rsaPublic: keyPair.rsaPublic,
	wsHost: '127.0.0.1',
	wsPort: 8088,
	seenTimeout: 60000,
	debug: false
};


const wss = new ws.Server({
	host: config.wsHost,
	port: config.wsPort,
	perMessageDeflate: false
});

console.log('server started', config.wsHost, config.wsPort);

// [新增-消息留存] 启动每分钟一次的过期历史清理（与 Worker 的 cron 分辨率一致）
history.startSweeper();


var clients = {};
var channels = {};
// [新增-消息留存] 待落库记录的缓冲：房间清空之前只暂存在内存里，
// 房间内最后一个人退出时才写入存储（与 Worker 版行为保持一致）
var buffers = {};
// [新增-消息留存] 各房间生效的留存时长（分钟），由 setupHistory 填充
var roomPolicy = {};
// [新增-消息留存] 各房间房主验证值，用于房间被回收后重建时保留房主
var roomOwner = {};

// WebSocket server connection event handler
// WebSocket 服务器连接事件处理程序
wss.on('connection', (connection) => {

	if (
		!connection
	) {
		return;
	}


	const seenThreshold = (getTime() - config.seenTimeout);

	for (
		const clientId in clients
	) {
		if (
			clients[clientId].seen < seenThreshold
		) {
			try {
				logEvent('connection-seen', clientId, 'debug');
				clients[clientId].connection.terminate();
			} catch (error) {
				logEvent('connection-seen', error, 'error');
			}
		}
	}


	const clientId = generateClientId();

	if (
		!clientId ||
		clients[clientId]
	) {
		closeConnection(connection);
		return;
	}

	logEvent('connection', clientId, 'debug');


	clients[clientId] = {
		connection: connection,
		seen: getTime(),
		key: null,
		channel: null,
		// [新增-消息留存] 历史拉取限流计数
		historyReqs: 0,
		historyReqBucket: 0
	};

	try {
		logEvent('sending-public-key', clientId, 'debug');
		sendMessage(connection, JSON.stringify({
			type: 'server-key',
			key: config.rsaPublic
		}));
	} catch (error) {
		logEvent('sending-public-key', error, 'error');
	}



	connection.on('message', (message) => {

		if (
			!isString(message) ||
			!clients[clientId]
		) {
			return;
		}

		clients[clientId].seen = getTime();

		if (
			message === 'ping'
		) {
			sendMessage(connection, 'pong');
			return;
		}

		logEvent('message', [clientId, message], 'debug');

		if (
			!clients[clientId].shared &&
			message.length < 2048
		) {


			try {

				const keys = crypto.createECDH('secp384r1');

				keys.generateKeys();

				const publicKey = keys.getPublicKey();
				const signature = crypto.sign('sha256', publicKey, {
					key: config.rsaPrivate,
					padding: crypto.constants.RSA_PKCS1_PADDING,
					dsaEncoding: 'ieee-p1363'
				});

				clients[clientId].shared = keys.computeSecret(message, 'hex', null).slice(8, 40);

				sendMessage(connection, publicKey.toString('hex') + '|' + signature.toString('base64'));

			} catch (error) {
				logEvent('message-key', [clientId, error], 'error');
				closeConnection(connection);
			}

			return;

		}

		if (
			clients[clientId].shared &&
			message.length <= (8 * 1024 * 1024)
		) {

			processEncryptedMessage(clientId, message);

		}

	});



	connection.on('close', (event) => {

		logEvent('close', [clientId, event], 'debug');


		const leaving = clients[clientId];
		const channel = leaving ? leaving.channel : null;

		// [新增-消息留存] 统一处理离房：移出成员列表、必要时批量落库、通知剩余成员
		removeFromChannel(clientId, channel);


		if (
			clients[clientId]
		) {
			delete(clients[clientId]);
		}

	});

});

// Process encrypted messages
// 处理加密消息
const processEncryptedMessage = (clientId, message) => {
	let decrypted = null;

	try {
		decrypted = decryptMessage(message, clients[clientId].shared);

		logEvent('message-decrypted', [clientId, decrypted], 'debug');

		if (
			!isObject(decrypted) ||
			!isString(decrypted.a)
		) {
			return;
		}

		const action = decrypted.a;

		if (action === 'j') {
			handleJoinChannel(clientId, decrypted);
		} else if (action === 'c') {
			handleClientMessage(clientId, decrypted);
		} else if (action === 'w') {
			handleChannelMessage(clientId, decrypted);
		} else if (action === 'hs') {
			// [新增-消息留存] 客户端提交一条待留存的密文记录
			handleStore(clientId, decrypted);
		} else if (action === 'h') {
			// [新增-消息留存] 客户端请求下一页历史
			handleHistoryRequest(clientId, decrypted);
		} else if (action === 'rs') {
			// [新增-消息留存] 房主修改留存时长
			handleRetentionSet(clientId, decrypted);
		}

	} catch (error) {
		logEvent('process-encrypted-message', [clientId, error], 'error');
	} finally {
		decrypted = null;
	}
};

// Handle channel join requests
// 处理加入频道请求
const handleJoinChannel = (clientId, decrypted) => {
	if (
		!isString(decrypted.p) ||
		clients[clientId].channel
	) {
		return;
	}

	try {
		const channel = decrypted.p;

		clients[clientId].channel = channel;

		if (!channels[channel]) {
			channels[channel] = [clientId];
		} else {
			channels[channel].push(clientId);
		}

		broadcastMemberList(channel);

		// [新增-消息留存] 确定房间留存策略并下发历史
		// decrypted.r 是请求的留存分钟数（仅房间首次创建时生效）
		// decrypted.o 是房主验证值（没有管理密码时为 undefined）
		setupHistory(clientId, channel, decrypted.r, decrypted.o);

	} catch (error) {
		logEvent('message-join', [clientId, error], 'error');
	}
};

// ============================================================
// [新增-消息留存] 历史相关处理
// 服务器全程只接触密文，不参与任何加解密
// ============================================================

// 确定留存策略（房间首次创建时写入，之后仅房主可改）并把历史下发给刚加入的客户端
const setupHistory = (clientId, channel, requestedMinutes, ownerVerifier) => {
	const client = clients[clientId];
	if (!client) return;

	try {
		const result = history.ensureRoom(channel, history.normalizeMinutes(requestedMinutes), ownerVerifier || null);

		// [新增-消息留存] 缓存生效策略与房主验证值
		roomPolicy[channel] = result.minutes;
		if (ownerVerifier) roomOwner[channel] = ownerVerifier;
		// 本次连接是否被认定为房主（决定客户端能否修改留存时长）
		client.owned = result.owned;

		// 期间可能已断开或切换房间
		if (!client.shared || client.channel !== channel || !clients[clientId]) return;

		// 无论是否存储都要把生效策略告知客户端，
		// 客户端据此决定是否提交 hs 记录（也用于界面展示与房主控制权）
		sendMessage(client.connection, encryptMessage({
			a: 'r',
			p: { m: result.minutes, owned: result.owned }
		}, client.shared));

		if (result.minutes <= 0) return;
		pushHistory(clientId, channel, 0);

	} catch (error) {
		logEvent('history-setup', [clientId, error], 'error');
	}
};

// [新增-消息留存] 房主修改留存时长（a:'rs'）
// 只有在本连接加入时被验证为房主的客户端才能调用
const handleRetentionSet = (clientId, decrypted) => {
	const client = clients[clientId];
	if (!client || !client.channel) return;

	const channel = client.channel;
	if (!client.owned) {
		logEvent('history-set-denied', clientId, 'error');
		return;
	}

	const payload = isObject(decrypted.p) ? decrypted.p : {};
	const minutes = history.normalizeMinutes(payload.m);

	try {
		const result = history.applyRetention(channel, minutes);
		if (!result.ok) return;

		roomPolicy[channel] = minutes;
		if (minutes === 0) {
			// 设为 0 表示不再保存：未落库的缓冲也要一起丢弃
			delete buffers[channel];
		}

		// 广播给房间内所有成员（不带 owned 字段，各成员保留自己的房主状态）
		broadcastRetention(channel, minutes);
	} catch (error) {
		logEvent('history-set', [clientId, error], 'error');
	}
};

// 把生效的留存策略广播给房间内所有成员
const broadcastRetention = (channel, minutes) => {
	const members = channels[channel];
	if (!members) return;
	for (const member of members) {
		const memberClient = clients[member];
		if (isClientInChannel(memberClient, channel)) {
			try {
				sendMessage(memberClient.connection, encryptMessage({
					a: 'r',
					p: { m: minutes }
				}, memberClient.shared));
			} catch (error) {
				logEvent('history-broadcast-retention', [member, error], 'error');
			}
		}
	}
};

// 按 seq 拉取一页历史并下发
const pushHistory = (clientId, channel, sinceSeq) => {
	const client = clients[clientId];
	if (!client) return;

	try {
		const room = history.getRoomPolicy(channel);
		if (!room || room.retentionSec <= 0) return;

		const page = history.fetchHistory(channel, sinceSeq);

		if (!client.shared || client.channel !== channel || !clients[clientId]) return;

		sendMessage(client.connection, encryptMessage({
			a: 'h',
			p: {
				records: page.records,
				lastSeq: page.lastSeq,
				more: page.more
			}
		}, client.shared));

	} catch (error) {
		logEvent('history-push', [clientId, error], 'error');
	}
};

// 客户端请求下一页历史（带每分钟次数限流）
const handleHistoryRequest = (clientId, decrypted) => {
	const client = clients[clientId];
	if (!client || !client.channel) return;

	const bucket = Math.floor(getTime() / 60000);
	if (client.historyReqBucket !== bucket) {
		client.historyReqBucket = bucket;
		client.historyReqs = 0;
	}
	// 分页上限较小（512KB/页），留出足够页数避免大量图片时回放被限流打断
	if (client.historyReqs >= 60) {
		logEvent('history-request-limited', clientId, 'error');
		return;
	}
	client.historyReqs += 1;

	let since = 0;
	if (isObject(decrypted.p) && Number.isFinite(Number(decrypted.p.since))) {
		since = Math.max(0, Math.floor(Number(decrypted.p.since)));
	}
	pushHistory(clientId, client.channel, since);
};

// 客户端提交一条待留存的密文记录
// [新增-消息留存] 这里只写入内存缓冲；真正落库由「房间内最后一个人退出」触发
// （见 flushBuffer），因此其他人退出都不会产生写入
const handleStore = (clientId, decrypted) => {
	const client = clients[clientId];
	if (!client || !client.channel) return;

	const channel = client.channel;

	// 留存未开启的房间不缓冲
	if (!(roomPolicy[channel] > 0)) return;

	const record = history.validateRecord(decrypted.p);
	if (!record) return;

	// 限流放在缓冲入口：批量落库时不能再限流，否则大部分记录会被丢弃
	if (!history.allowWrite(channel)) {
		logEvent('history-rate-limited', channel, 'error');
		return;
	}

	let buffer = buffers[channel];
	if (!buffer) {
		buffer = { items: [], bytes: 0 };
		buffers[channel] = buffer;
	}

	// 缓冲上限，防止长时间会话把内存撑大
	if (
		buffer.items.length >= history.HISTORY_BUFFER_MAX_ITEMS ||
		buffer.bytes + record.ct.length > history.HISTORY_BUFFER_MAX_BYTES
	) {
		logEvent('history-buffer-full', [channel, buffer.items.length, buffer.bytes], 'error');
		return;
	}

	buffer.items.push(record);
	buffer.bytes += record.ct.length;
};

// [新增-消息留存] 把客户端移出所在房间；房间因此变空时把缓冲的记录一次性写入
const removeFromChannel = (clientId, channel) => {
	if (!channel || !channels[channel]) return;

	const members = channels[channel];
	const index = members.indexOf(clientId);
	// 已被移除时直接返回：原始的 splice(-1, 1) 会误删数组末尾的成员
	if (index < 0) return;
	members.splice(index, 1);

	if (members.length === 0) {
		delete(channels[channel]);
		// [新增-消息留存] 房间内最后一个人退出 → 此时才真正落库。
		// 必须在清掉策略缓存之前落库，flushBuffer 需要用到它们
		flushBuffer(channel);
		// 落库若为异步实现，期间可能有新会话加入并重新建好缓存；这里同样判空
		if (!channels[channel]) {
			delete(roomPolicy[channel]);
			delete(roomOwner[channel]);
		}
		return;
	}

	try {
		for (const member of members) {
			const memberClient = clients[member];
			if (isClientInChannel(memberClient, channel)) {
				sendMessage(memberClient.connection, encryptMessage({
					a: 'l',
					p: members.filter((value) => value !== member)
				}, memberClient.shared));
			}
		}
	} catch (error) {
		logEvent('close-list', [clientId, error], 'error');
	}
};

// [新增-消息留存] 把某个房间缓冲的记录批量写入存储
// 只有「房间内最后一个人退出」会触发它
const flushBuffer = (channel) => {
	const buffer = buffers[channel];
	if (!buffer) return 0;
	// 先摘除缓冲，避免写入过程中被再次触发导致同一批写两遍
	delete buffers[channel];
	if (buffer.items.length === 0) return 0;

	// [新增-消息留存] 房间可能已被 sweep 回收（例如一次会话持续超过 24 小时），
	// 此时按缓存的策略与房主重建它，避免这整批缓冲因为查不到策略而被丢弃
	const cachedMinutes = roomPolicy[channel] || 0;
	if (cachedMinutes > 0) {
		try {
			history.ensureRoom(channel, cachedMinutes, roomOwner[channel] || null);
		} catch (error) {
			logEvent('history-flush-ensure-room', error, 'error');
		}
	}

	let written = 0;
	for (const item of buffer.items) {
		try {
			const seq = history.appendMessage({
				roomId: channel,
				kind: item.kind,
				ts: item.ts,
				nonce: item.nonce,
				ct: item.ct
			});
			if (seq) written += 1;
		} catch (error) {
			logEvent('history-flush', error, 'error');
		}
	}
	logEvent('history-flushed', [channel, written, buffer.items.length], 'debug');
	return written;
};

// Handle client messages
// 处理客户端消息
const handleClientMessage = (clientId, decrypted) => {
	if (
		!isString(decrypted.p) ||
		!isString(decrypted.c) ||
		!clients[clientId].channel
	) {
		return;
	}

	try {
		const channel = clients[clientId].channel;
		const targetClient = clients[decrypted.c];

		if (isClientInChannel(targetClient, channel)) {
			const messageObj = {
				a: 'c',
				p: decrypted.p,
				c: clientId
			};

			const encrypted = encryptMessage(messageObj, targetClient.shared);
			sendMessage(targetClient.connection, encrypted);

			messageObj.p = null;
		}

	} catch (error) {
		logEvent('message-client', [clientId, error], 'error');
	}
};

// Handle channel messages
// 处理频道消息
const handleChannelMessage = (clientId, decrypted) => {
	if (
		!isObject(decrypted.p) ||
		!clients[clientId].channel
	) {
		return;
	}

	try {
		const channel = clients[clientId].channel;

		for (const member in decrypted.p) {
			const targetClient = clients[member];

			if (
				isString(decrypted.p[member]) &&
				isClientInChannel(targetClient, channel)
			) {
				const messageObj = {
					a: 'c',
					p: decrypted.p[member],
					c: clientId
				};

				const encrypted = encryptMessage(messageObj, targetClient.shared);
				sendMessage(targetClient.connection, encrypted);

				messageObj.p = null;
			}
		}

	} catch (error) {
		logEvent('message-channel', [clientId, error], 'error');
	}
};

// Broadcast member list to channel
// 向频道广播成员列表
const broadcastMemberList = (channel) => {
	try {
		const members = channels[channel];

		for (const member of members) {
			const client = clients[member];

			if (isClientInChannel(client, channel)) {
				const filteredMembers = members.filter(value => value !== member);

				const listObj = {
					a: 'l',
					p: filteredMembers
				};

				const encrypted = encryptMessage(listObj, client.shared);
				sendMessage(client.connection, encrypted);

				listObj.p = null;
			}
		}
	} catch (error) {
		logEvent('broadcast-member-list', error, 'error');
	}
};



// Log events with timestamps and levels
// 记录带时间戳和级别的事件
const logEvent = (source, message, level) => {
	if (
		level !== 'debug' ||
		config.debug
	) {

		const date = new Date(),
			dateString = date.getFullYear() + '-' +
			('0' + (date.getMonth() + 1)).slice(-2) + '-' +
			('0' + date.getDate()).slice(-2) + ' ' +
			('0' + date.getHours()).slice(-2) + ':' +
			('0' + date.getMinutes()).slice(-2) + ':' +
			('0' + date.getSeconds()).slice(-2);

		console.log('[' + dateString + ']', (level ? level.toUpperCase() : 'INFO'), source + (message ? ':' : ''), (message ? message : ''));

	}
};


const generateClientId = () => {
	try {
		return (crypto.randomBytes(8).toString('hex'));
	} catch (error) {
		logEvent('generateClientId', error, 'error');
		return (null);
	}
};


const closeConnection = (connection) => {
	try {
		connection.close();
	} catch (error) {
		logEvent('closeConnection', error, 'error');
	}
};


const isClientInChannel = (client, channel) => {
	return (
		client &&
		client.connection &&
		client.shared &&
		client.channel &&
		client.channel === channel ?
		true :
		false
	);
};


const sendMessage = (connection, message) => {
	try {
		if (
			connection.readyState &&
			connection.readyState === ws.OPEN
		) {
			connection.send(message);
		}
	} catch (error) {
		logEvent('sendMessage', error, 'error');
	}
};


const encryptMessage = (message, key) => {

	let encrypted = '';

	try {

		const messageBuffer = Buffer.from(JSON.stringify(message), 'utf8');

		const paddedBuffer = (messageBuffer.length % 16) !== 0 ?
			Buffer.concat([messageBuffer, Buffer.alloc(16 - (messageBuffer.length % 16))]) :
			messageBuffer;

		const iv = crypto.randomBytes(16);
		const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
		cipher.setAutoPadding(false);

		encrypted = iv.toString('base64') + '|' + cipher.update(paddedBuffer, '', 'base64') + cipher.final('base64');

	} catch (error) {
		logEvent('encryptMessage', error, 'error');
	}

	return (encrypted);

};


const decryptMessage = (message, key) => {

	let decrypted = {};

	try {

		const parts = message.split('|');
		const decipher = crypto.createDecipheriv(
			'aes-256-cbc',
			key,
			Buffer.from(parts[0], 'base64')
		);

		decipher.setAutoPadding(false);

		const decryptedText = decipher.update(parts[1], 'base64', 'utf8') + decipher.final('utf8');
		decrypted = JSON.parse(decryptedText.replace(/\0+$/, ''));

	} catch (error) {
		logEvent('decryptMessage', error, 'error');
	}

	return (decrypted);

};


const getTime = () => {
	return (new Date().getTime());
};


const isString = (value) => {
	return (
		value &&
		Object.prototype.toString.call(value) === '[object String]' ?
		true :
		false
	);
};


const isArray = (value) => {
	return (
		value &&
		Object.prototype.toString.call(value) === '[object Array]' ?
		true :
		false
	);
};


const isObject = (value) => {
	return (
		value &&
		Object.prototype.toString.call(value) === '[object Object]' ?
		true :
		false
	);
};

setInterval(() => {
	if (global.gc) {
		global.gc();
	}
}, 30000);
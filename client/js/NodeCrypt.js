// NodeCrypt core cryptographic client for secure chat
// NodeCrypt 安全聊天的核心加密客户端

import {
	sha256
} from 'js-sha256';
import {
	ec as elliptic
} from 'elliptic';
import {
	ModeOfOperation
} from 'aes-js';
import chacha from 'js-chacha20';
import {
	Buffer
} from 'buffer';
// [新增-消息留存] 历史密钥派生与记录加解密
import {
	deriveHistoryKey,
	deriveOwnerVerifier,
	encryptRecord,
	decryptRecord,
	kindOfMessage,
	isRecordTooLarge,
	normalizeMinutes
} from './util.history.js';
window.Buffer = Buffer;

// Main NodeCrypt class for secure communication
// 用于安全通信的 NodeCrypt 主类
class NodeCrypt {
	// Initialize NodeCrypt instance
	// 初始化 NodeCrypt 实例
	constructor(config = {}, callbacks = {}) {
		this.config = {
			rsaPublic: config.rsaPublic || '',
			wsAddress: config.wsAddress || '',
			reconnectDelay: config.reconnectDelay || 3000,
			pingInterval: config.pingInterval || 20000,
			debug: config.debug || false,
		};
		this.callbacks = {
			onServerClosed: callbacks.onServerClosed || null,
			onServerSecured: callbacks.onServerSecured || null,
			onClientSecured: callbacks.onClientSecured || null,
			onClientList: callbacks.onClientList || null,
			onClientMessage: callbacks.onClientMessage || null,
			// [新增-消息留存] 历史记录与生效的留存策略
			onHistory: callbacks.onHistory || null,
			onRetention: callbacks.onRetention || null,
		};
		this.SERVER_KEY_STORAGE = 'nodecrypt_server_key';
		try {
			this.clientEc = new elliptic('curve25519')
		} catch (error) {
			this.logEvent('constructor', error, 'error')
		}
		this.serverKeys = null;
		this.serverShared = null;
		this.credentials = null;
		this.connection = null;
		this.reconnect = null;
		this.ping = null;
		this.channel = {};
		// [新增-消息留存] 留存状态
		// retentionRequest: 本地请求的时长（仅房间首次创建时有效，随 j 提交）
		// retentionMinutes: 服务器确认的生效时长，0 表示不存储
		// retentionOwned: 本次连接是否被服务器认定为房主（可修改留存时长）
		// historyKey: 由房间密码派生的历史密钥，无密码时为 null
		// ownerVerifier: 由管理密码派生的房主验证值，未填管理密码时为 null
		this.retentionRequest = 0;
		this.retentionMinutes = 0;
		this.retentionOwned = false;
		this.historyKey = null;
		this.historyKeyPromise = null;
		this.ownerVerifierPromise = null;
		this.setCredentials = this.setCredentials.bind(this);
		this.connect = this.connect.bind(this);
		this.destruct = this.destruct.bind(this);
		this.onOpen = this.onOpen.bind(this);
		this.onMessage = this.onMessage.bind(this);
		this.onError = this.onError.bind(this);
		this.onClose = this.onClose.bind(this);
		this.logEvent = this.logEvent.bind(this);
		this.isOpen = this.isOpen.bind(this);
		this.isClosed = this.isClosed.bind(this);
		this.startReconnect = this.startReconnect.bind(this);
		this.stopReconnect = this.stopReconnect.bind(this);
		this.startPing = this.startPing.bind(this);
		this.stopPing = this.stopPing.bind(this);
		this.disconnect = this.disconnect.bind(this);
		this.sendMessage = this.sendMessage.bind(this);
		this.sendChannelMessage = this.sendChannelMessage.bind(this);
		this.encryptServerMessage = this.encryptServerMessage.bind(this);
		this.decryptServerMessage = this.decryptServerMessage.bind(this);
		this.encryptClientMessage = this.encryptClientMessage.bind(this);
		this.decryptClientMessage = this.decryptClientMessage.bind(this);
		// [新增-消息留存]
		this.getHistoryKey = this.getHistoryKey.bind(this);
		this.getOwnerVerifier = this.getOwnerVerifier.bind(this);
		this.storeChannelMessage = this.storeChannelMessage.bind(this);
		this.decryptHistoryRecord = this.decryptHistoryRecord.bind(this);
		this.requestHistory = this.requestHistory.bind(this);
		this.setRetention = this.setRetention.bind(this)
	}

	// Set user credentials (username, channel, password)
	// 设置用户凭证（用户名、频道、密码）
	// [新增-消息留存] 增加 retentionMinutes（请求的留存时长）与 ownerPassword（房主管理密码）
	setCredentials(username, channel, password, retentionMinutes, ownerPassword) {
		this.logEvent('setCredentials');
		try {
			this.credentials = {
				username: username,
				channel: sha256(channel),
				password: sha256(password)
			};
			// [新增-消息留存] 记录请求的时长并立即开始派生密钥（无密码时结果为 null）
			this.retentionRequest = normalizeMinutes(retentionMinutes);
			this.retentionMinutes = 0;
			this.retentionOwned = false;
			this.historyKey = null;
			this.historyKeyPromise = deriveHistoryKey(channel, password);
			this.ownerVerifierPromise = deriveOwnerVerifier(channel, ownerPassword)
		} catch (error) {
			this.logEvent('setCredentials', error, 'error');
			return (false)
		}
		return (true)
	}

	// Connect to the server
	// 连接到服务器
	connect() {
		if (!this.credentials) {
			return (false)
		}
		this.logEvent('connect', this.config.wsAddress);
		this.stopReconnect();
		this.stopPing();
		this.serverKeys = null;
		this.serverShared = null;
		this.channel = {};
		// [新增-消息留存] 重连后需要由服务器重新确认生效策略与房主身份
		this.retentionMinutes = 0;
		this.retentionOwned = false;
		try {
			this.connection = new WebSocket(this.config.wsAddress);
			this.connection.onopen = this.onOpen;
			this.connection.onmessage = this.onMessage;
			this.connection.onerror = this.onError;
			this.connection.onclose = this.onClose
		} catch (error) {
			this.logEvent('connect', error, 'error');
			return (false)
		}
		return (true)
	}

	// Clean up and disconnect
	// 清理并断开连接
	destruct() {
		this.logEvent('destruct');
		this.stopReconnect();
		this.stopPing();
		this.reconnect = null;
		this.ping = null;
		this.config = {
			rsaPublic: '',
			wsAddress: '',
			reconnectDelay: 3000,
			pingInterval: 15000,
			debug: false,
		};
		this.callbacks.onServerClosed = null;
		this.callbacks.onServerSecured = null;
		this.callbacks.onClientSecured = null;
		this.callbacks.onClientList = null;
		this.callbacks.onClientMessage = null;
		// [新增-消息留存] 清理历史留存状态
		this.callbacks.onHistory = null;
		this.callbacks.onRetention = null;
		this.historyKey = null;
		this.historyKeyPromise = null;
		this.ownerVerifierPromise = null;
		this.retentionRequest = 0;
		this.retentionMinutes = 0;
		this.retentionOwned = false;
		this.clientEc = null;
		this.serverKeys = null;
		this.serverShared = null;
		this.credentials = null;
		this.connection.onopen = null;
		this.connection.onmessage = null;
		this.connection.onerror = null;
		this.connection.onclose = null;
		try {
			this.connection.removeAllListeners()
		} catch (error) {
			this.logEvent('destruct', error, 'error')
		}
		try {
			this.connection.close()
		} catch (error) {
			this.logEvent('destruct', error, 'error')
		}
		this.connection = null;
		this.channel = {};
		return (true)
	}

	// WebSocket open event handler
	// WebSocket 连接打开事件处理
	async onOpen() {
		this.logEvent('onOpen');
		this.startPing();
		try {
			this.serverKeys = await crypto.subtle.generateKey({
				name: 'ECDH',
				namedCurve: 'P-384'
			}, false, ['deriveKey', 'deriveBits']);
			this.serverShared = null;
			this.sendMessage(Buffer.from(await crypto.subtle.exportKey('raw', this.serverKeys.publicKey)).toString('hex'))
		} catch (error) {
			this.logEvent('onOpen', error, 'error')
		}
	}

	// WebSocket message event handler
	// WebSocket 消息事件处理
	async onMessage(event) {
		if (!event || !this.isString(event.data)) {
			return
		}
		if (event.data === 'pong') {
			return
		}
		this.logEvent('onMessage', event.data);
		try {
			const data = JSON.parse(event.data);
			if (data.type === 'server-key') {
				const result = await this.handleServerKey(data.key);
				if (!result) {
					return
				}
			}
		} catch (e) {}
		if (!this.serverShared) {
			const parts = event.data.split('|');
			if (!parts[0] || !parts[1]) {
				return
			}
			try {
				if (await crypto.subtle.verify({
						name: 'RSASSA-PKCS1-v1_5'
					}, await crypto.subtle.importKey('spki', Buffer.from(this.config.rsaPublic, 'base64'), {
						name: 'RSASSA-PKCS1-v1_5',
						hash: {
							name: 'SHA-256'
						}
					}, false, ['verify']), Buffer.from(parts[1], 'base64'), Buffer.from(parts[0], 'hex')) === true) {
					this.serverShared = Buffer.from(await crypto.subtle.deriveBits({
						name: 'ECDH',
						namedCurve: 'P-384',
						public: await crypto.subtle.importKey('raw', Buffer.from(parts[0], 'hex'), {
							name: 'ECDH',
							namedCurve: 'P-384'
						}, true, [])
					}, this.serverKeys.privateKey, 384)).slice(8, 40);
					// [新增-消息留存] 首个进入房间时用它决定留存时长（之后只有房主能改）
					// o 为房主验证值，由管理密码派生；未填管理密码时为 null
					this.sendMessage(this.encryptServerMessage({
						a: 'j',
						p: this.credentials.channel,
						r: this.retentionRequest,
						o: await this.getOwnerVerifier()
					}, this.serverShared));
					if (this.callbacks.onServerSecured) {
						try {
							this.callbacks.onServerSecured()
						} catch (error) {
							this.logEvent('onMessage-server-secured-callback', error, 'error')
						}
					}
				}
			} catch (error) {
				this.logEvent('onMessage', error, 'error')
			}
			return
		}
		const serverDecrypted = this.decryptServerMessage(event.data, this.serverShared);
		this.logEvent('onMessage-server-decrypted', serverDecrypted);
		if (!this.isObject(serverDecrypted) || !this.isString(serverDecrypted.a)) {
			return
		}
		if (serverDecrypted.a === 'l' && this.isArray(serverDecrypted.p)) {
			try {
				for (const clientId in this.channel) {
					if (serverDecrypted.p.indexOf(clientId) < 0) {
						delete(this.channel[clientId])
					}
				}
				let payloads = {};
				for (const clientId of serverDecrypted.p) {
					if (!this.channel[clientId]) {
						this.channel[clientId] = {
							username: null,
							keys: this.clientEc.genKeyPair(),
							shared: null,
						};
						payloads[clientId] = this.channel[clientId].keys.getPublic('hex')
					}
				}
				if (Object.keys(payloads).length > 0) {
					this.sendMessage(this.encryptServerMessage({
						a: 'w',
						p: payloads,
					}, this.serverShared))
				}
			} catch (error) {
				this.logEvent('onMessage-list', error, 'error')
			}
			if (this.callbacks.onClientList) {
				let clients = [];
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						clients.push({
							clientId: clientId,
							username: this.channel[clientId].username
						})
					}
				}
				try {
					this.callbacks.onClientList(clients)
				} catch (error) {
					this.logEvent('onMessage-client-list-callback', error, 'error')
				}
			}
			return
		}
		// [新增-消息留存] 生效的留存策略（0 表示不存储）与房主身份
		if (serverDecrypted.a === 'r' && this.isObject(serverDecrypted.p)) {
			this.retentionMinutes = normalizeMinutes(serverDecrypted.p.m);
			// owned 只在加入房间时下发；房主改策略后的广播不带该字段，
			// 此时保留本连接原有的房主状态
			if (typeof serverDecrypted.p.owned === 'boolean') {
				this.retentionOwned = serverDecrypted.p.owned
			}
			this.logEvent('onMessage-retention', [this.retentionMinutes, this.retentionOwned]);
			if (this.callbacks.onRetention) {
				try {
					this.callbacks.onRetention(this.retentionMinutes, this.retentionOwned)
				} catch (error) {
					this.logEvent('onMessage-retention-callback', error, 'error')
				}
			}
			return
		}
		// [新增-消息留存] 一页历史记录（密文，由调用方用历史密钥解密）
		if (serverDecrypted.a === 'h' && this.isObject(serverDecrypted.p)) {
			this.logEvent('onMessage-history', this.isArray(serverDecrypted.p.records) ? serverDecrypted.p.records.length : 0);
			if (this.callbacks.onHistory) {
				try {
					this.callbacks.onHistory(serverDecrypted.p)
				} catch (error) {
					this.logEvent('onMessage-history-callback', error, 'error')
				}
			}
			return
		}
		if (!this.isString(serverDecrypted.p) || !this.isString(serverDecrypted.c)) {
			return
		}
		if (serverDecrypted.a === 'c' && (!this.channel[serverDecrypted.c] || !this.channel[serverDecrypted.c].shared)) {
			try {
				if (!this.channel[serverDecrypted.c]) {
					this.channel[serverDecrypted.c] = {
						username: null,
						keys: this.clientEc.genKeyPair(),
						shared: null,
					};
					this.sendMessage(this.encryptServerMessage({
						a: 'c',
						p: this.channel[serverDecrypted.c].keys.getPublic('hex'),
						c: serverDecrypted.c
					}, this.serverShared))
				}
				this.channel[serverDecrypted.c].shared = Buffer.from(this.xorHex(this.channel[serverDecrypted.c].keys.derive(this.clientEc.keyFromPublic(serverDecrypted.p, 'hex').getPublic()).toString('hex').padEnd(64, '8').substr(0, 64), this.credentials.password), 'hex');
				this.sendMessage(this.encryptServerMessage({
					a: 'c',
					p: this.encryptClientMessage({
						a: 'u',
						p: this.credentials.username
					}, this.channel[serverDecrypted.c].shared),
					c: serverDecrypted.c
				}, this.serverShared))
			} catch (error) {
				this.logEvent('onMessage-client', error, 'error')
			}
			return
		}
		if (serverDecrypted.a === 'c' && this.channel[serverDecrypted.c] && this.channel[serverDecrypted.c].shared) {
			const clientDecrypted = this.decryptClientMessage(serverDecrypted.p, this.channel[serverDecrypted.c].shared);
			this.logEvent('onMessage-client-decrypted', clientDecrypted);
			if (!this.isObject(clientDecrypted) || !this.isString(clientDecrypted.a)) {
				return
			}
			if (clientDecrypted.a === 'u' && this.isString(clientDecrypted.p) && clientDecrypted.p.match(/\S+/) && !this.channel[serverDecrypted.c].username) {
				this.channel[serverDecrypted.c].username = clientDecrypted.p.replace(/^\s+/, '').replace(/\s+$/, '');
				if (this.callbacks.onClientSecured) {
					try {
						this.callbacks.onClientSecured({
							clientId: serverDecrypted.c,
							username: this.channel[serverDecrypted.c].username
						})
					} catch (error) {
						this.logEvent('onMessage-client-secured-callback', error, 'error')
					}
				}
				return
			}			if (!this.channel[serverDecrypted.c].username) {
				return
			}
			if (clientDecrypted.a === 'm' && this.isString(clientDecrypted.t) && (this.isString(clientDecrypted.d) || this.isObject(clientDecrypted.d))) {
				if (this.callbacks.onClientMessage) {
					try {
						this.callbacks.onClientMessage({
							clientId: serverDecrypted.c,
							username: this.channel[serverDecrypted.c].username,
							type: clientDecrypted.t,
							data: clientDecrypted.d
						})
					} catch (error) {
						this.logEvent('onMessage-client-message-callback', error, 'error')
					}
				}
				return
			}
		}
	}

	// WebSocket error event handler
	// WebSocket 错误事件处理
	async onError(event) {
		this.logEvent('onError', event, 'error');
		this.disconnect();
		if (this.credentials) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onError-server-closed-callback', error, 'error')
			}
		}
	}

	// WebSocket close event handler
	// WebSocket 关闭事件处理
	async onClose(event) {
		this.logEvent('onClose', event);
		this.disconnect();
		if (this.credentials) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onClose-server-closed-callback', error, 'error')
			}
		}
	}

	// Log events for debugging
	// 记录事件日志用于调试
	logEvent(source, message, level) {
		if (this.config.debug) {
			const date = new Date(),
				dateString = date.getFullYear() + '-' + ('0' + (date.getMonth() + 1)).slice(-2) + '-' + ('0' + date.getDate()).slice(-2) + ' ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2) + ':' + ('0' + date.getSeconds()).slice(-2);
			console.log('[' + dateString + ']', (level ? level.toUpperCase() : 'INFO'), source + (message ? ':' : ''), (message ? message : ''))
		}
	}

	// Check if connection is open
	// 检查连接是否已打开
	isOpen() {
		return (this.connection && this.connection.readyState && this.connection.readyState === WebSocket.OPEN ? true : false)
	}

	// Check if connection is closed
	// 检查连接是否已关闭
	isClosed() {
		return (!this.connection || !this.connection.readyState || this.connection.readyState === WebSocket.CLOSED ? true : false)
	}

	// Start reconnect timer
	// 启动重连定时器
	startReconnect() {
		this.stopReconnect();
		this.logEvent('startReconnect');
		this.reconnect = setTimeout(() => {
			this.reconnect = null;
			this.connect()
		}, this.config.reconnectDelay)
	}

	// Stop reconnect timer
	// 停止重连定时器
	stopReconnect() {
		if (this.reconnect) {
			this.logEvent('stopReconnect');
			clearTimeout(this.reconnect);
			this.reconnect = null
		}
	}

	// Start ping timer
	// 启动心跳定时器
	startPing() {
		this.stopPing();
		this.logEvent('startPing');
		this.ping = setInterval(() => {
			this.sendMessage('ping')
		}, this.config.pingInterval)
	}

	// Stop ping timer
	// 停止心跳定时器
	stopPing() {
		if (this.ping) {
			this.logEvent('stopPing');
			clearInterval(this.ping);
			this.ping = null
		}
	}

	// Disconnect from server
	// 从服务器断开连接
	disconnect() {
		this.stopReconnect();
		this.stopPing();
		if (!this.isClosed()) {
			try {
				this.logEvent('disconnect');
				this.connection.close()
			} catch (error) {
				this.logEvent('disconnect', error, 'error')
			}
		}
	}

	// Send a message to the server
	// 向服务器发送消息
	sendMessage(message) {
		try {
			if (this.isOpen()) {
				this.connection.send(message);
				return (true)
			}
		} catch (error) {
			this.logEvent('sendMessage', error, 'error')
		}
		return (false)
	}

	// Send a message to all channels
	// 向所有频道发送消息
	sendChannelMessage(type, data) {
		if (this.serverShared) {
			try {
				let payloads = {};
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						payloads[clientId] = this.encryptClientMessage({
							a: 'm',
							t: type,
							d: data
						}, this.channel[clientId].shared);
						if (payloads[clientId].length === 0) {
							return (false)
						}
					}
				}
				if (Object.keys(payloads).length > 0) {
					const payload = this.encryptServerMessage({
						a: 'w',
						p: payloads,
					}, this.serverShared);
					if (!this.isOpen() || payload.length === 0 || payload.length > (8 * 1024 * 1024)) {
						return (false)
					}
					this.connection.send(payload)
				}
				// [新增-消息留存] 额外提交一份给服务器留存。
				// 独立异步执行且不 await：留存失败绝不影响实时投递，
				// 未开启留存（retentionMinutes=0）时会立即返回。
				this.storeChannelMessage(type, data);
				return (true)
			} catch (error) {
				this.logEvent('sendChannelMessage', error, 'error')
			}
		}
		return (false)
	}

	// [新增-消息留存] 取得历史密钥（惰性等待 PBKDF2 派生结果）
	// 无房间密码或派生失败时返回 null，此时留存自动不可用
	async getHistoryKey() {
		if (this.historyKey) {
			return (this.historyKey)
		}
		if (!this.historyKeyPromise) {
			return (null)
		}
		try {
			this.historyKey = await this.historyKeyPromise
		} catch (error) {
			this.logEvent('getHistoryKey', error, 'error');
			this.historyKey = null
		}
		return (this.historyKey)
	}

	// [新增-消息留存] 把一条公共频道消息额外加密一份提交给服务器留存。
	// 仅覆盖文本与图片；文件分卷体积过大，不在留存范围内。
	async storeChannelMessage(type, data) {
		try {
			// 服务器尚未确认策略（或策略为 0）时不落库
			if (!this.retentionMinutes || this.retentionMinutes <= 0) {
				return (false)
			}
			const kind = kindOfMessage(type);
			if (!kind) {
				return (false)
			}
			const historyKey = await this.getHistoryKey();
			if (!historyKey) {
				return (false)
			}
			const ts = Date.now();
			const record = await encryptRecord(historyKey, this.credentials.channel, ts, kind, {
				u: this.credentials.username,
				t: type,
				d: data
			});
			if (!record || !this.serverShared || !this.isOpen()) {
				return (false)
			}
			// 超过服务器允许的单条上限则不留存，内容依旧已正常实时送达
			if (isRecordTooLarge(record)) {
				this.logEvent('storeChannelMessage', 'record too large, skipped');
				return (false)
			}
			this.sendMessage(this.encryptServerMessage({
				a: 'hs',
				p: {
					k: kind,
					ts: ts,
					n: record.n,
					c: record.c
				}
			}, this.serverShared));
			return (true)
		} catch (error) {
			this.logEvent('storeChannelMessage', error, 'error');
			return (false)
		}
	}

	// [新增-消息留存] 解密一条历史记录（供 room.js 回放历史使用）
	// 密码不符或记录被篡改时返回 null
	async decryptHistoryRecord(record) {
		if (!record) {
			return (null)
		}
		const historyKey = await this.getHistoryKey();
		if (!historyKey) {
			return (null)
		}
		return (await decryptRecord(historyKey, this.credentials.channel, record))
	}

	// [新增-消息留存] 请求下一页历史（分页拉取）
	requestHistory(since) {
		if (!this.serverShared || !this.isOpen()) {
			return (false)
		}
		try {
			return (this.sendMessage(this.encryptServerMessage({
				a: 'h',
				p: {
					since: Number(since) || 0
				}
			}, this.serverShared)))
		} catch (error) {
			this.logEvent('requestHistory', error, 'error');
			return (false)
		}
	}

	// [新增-消息留存] 取得房主验证值（惰性等待 PBKDF2 派生结果）
	// 未填管理密码时返回 null，此时本连接不会被认定为房主
	async getOwnerVerifier() {
		if (!this.ownerVerifierPromise) {
			return (null)
		}
		try {
			return (await this.ownerVerifierPromise)
		} catch (error) {
			this.logEvent('getOwnerVerifier', error, 'error');
			return (null)
		}
	}

	// [新增-消息留存] 房主修改本房间留存时长
	// 0 表示不再保存，服务器会同时清除该房间已保存的全部历史
	// 服务端会再次校验房主身份，这里的前置判断只是为了少发一次无效请求
	setRetention(minutes) {
		if (!this.retentionOwned) {
			return (false)
		}
		if (!this.serverShared || !this.isOpen()) {
			return (false)
		}
		try {
			return (this.sendMessage(this.encryptServerMessage({
				a: 'rs',
				p: {
					m: normalizeMinutes(minutes)
				}
			}, this.serverShared)))
		} catch (error) {
			this.logEvent('setRetention', error, 'error');
			return (false)
		}
	}

	// Encrypt a message for the server
	// 加密发送给服务器的消息
	encryptServerMessage(message, key) {
		let encrypted = '';
		try {
			message = Buffer.from(JSON.stringify(message), 'utf8');
			if ((message.length % 16) !== 0) {
				message = Buffer.from([...message, ...Buffer.alloc(16 - (message.length % 16))])
			}
			const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
			const cipher = new ModeOfOperation.cbc(key, iv);
			encrypted = iv.toString('base64') + '|' + Buffer.from(cipher.encrypt(message)).toString('base64')
		} catch (error) {
			this.logEvent('encryptServerMessage', error, 'error')
		}
		return (encrypted)
	}

	// Decrypt a message from the server
	// 解密来自服务器的消息
	decryptServerMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			const decipher = new ModeOfOperation.cbc(key, Buffer.from(parts[0], 'base64'));
			decrypted = JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[1], 'base64'))).toString('utf8').replace(/\0+$/, ''))
		} catch (error) {
			this.logEvent('decryptServerMessage', error, 'error')
		}
		return (decrypted)
	}

	// Encrypt a message for a client
	// 加密发送给客户端的消息
	encryptClientMessage(message, key) {
		let encrypted = '';
		try {
			message = Buffer.from(JSON.stringify(message), 'utf8');
			if ((message.length % 16) !== 0) {
				message = Buffer.from([...message, ...Buffer.alloc(16 - (message.length % 16))])
			}
			const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
			const counter = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
			const cipher = new chacha(key, iv, counter.reduce((a, b) => a * b));
			encrypted = iv.toString('base64') + '|' + counter.toString('base64') + '|' + Buffer.from(cipher.encrypt(message)).toString('base64')
		} catch (error) {
			this.logEvent('encryptClientMessage', error, 'error')
		}
		return (encrypted)
	}

	// Decrypt a message from a client
	// 解密来自客户端的消息
	decryptClientMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			const decipher = new chacha(key, Buffer.from(parts[0], 'base64'), Buffer.from(parts[1], 'base64').reduce((a, b) => a * b));
			decrypted = JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[2], 'base64'))).toString('utf8').replace(/\0+$/, ''))
		} catch (error) {
			this.logEvent('decryptClientMessage', error, 'error')
		}
		return (decrypted)
	}

	// XOR two hex strings
	// 对两个十六进制字符串进行异或
	xorHex(a, b) {
		let result = '',
			hexLength = Math.min(a.length, b.length);
		for (let i = 0; i < hexLength; ++i) {
			result += (parseInt(a.charAt(i), 16) ^ parseInt(b.charAt(i), 16)).toString(16)
		}
		return (result)
	}

	// Check if value is a string
	// 检查值是否为字符串
	isString(value) {
		return (value && Object.prototype.toString.call(value) === '[object String]' ? true : false)
	}

	// Check if value is an array
	// 检查值是否为数组
	isArray(value) {
		return (value && Object.prototype.toString.call(value) === '[object Array]' ? true : false)
	}

	// Check if value is an object
	// 检查值是否为对象
	isObject(value) {
		return (value && Object.prototype.toString.call(value) === '[object Object]' ? true : false)
	}

	// Handle server public key
	// 处理服务器公钥
	async handleServerKey(serverKey) {
		this.logEvent('handleServerKey', 'Received server key');
		localStorage.removeItem(this.SERVER_KEY_STORAGE);
		localStorage.setItem(this.SERVER_KEY_STORAGE, serverKey);
		this.config.rsaPublic = serverKey;
		return true
	}
};

if (typeof window !== 'undefined') {
	window.NodeCrypt = NodeCrypt
}
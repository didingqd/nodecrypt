import { generateClientId, encryptMessage, decryptMessage, logEvent, isString, isObject, getTime } from './utils.js';
// [新增-消息留存] 留存存储层（D1 + R2）
import {
  ensureRoom,
  getRoom,
  normalizeMinutes,
  validateRecord,
  allowWrite,
  appendMessage,
  fetchHistory,
  applyRetention,
  sweep,
  HISTORY_BUFFER_MAX_BYTES,
  HISTORY_BUFFER_MAX_ITEMS
} from './history.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理WebSocket请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader === 'websocket') {
      const id = env.CHAT_ROOM.idFromName('chat-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 处理API请求
    if (url.pathname.startsWith('/api/')) {
      // ...API 逻辑...
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    // 其余全部交给 ASSETS 处理（自动支持 hash 文件名和 SPA fallback）
    return env.ASSETS.fetch(request);
  },

  // [新增-消息留存] 定时清理过期历史消息与 R2 对象
  // 由 wrangler.toml 中的 [triggers] crons 每分钟触发一次
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const result = await sweep(env.DB, env.HISTORY_BLOB);
        logEvent('history-sweep', result, 'debug');
      } catch (error) {
        logEvent('history-sweep', error, 'error');
      }
    })());
  }
};

export class ChatRoom {  constructor(state, env) {
    this.state = state;
    // [新增-消息留存] 保存 env 以便访问 D1 与 R2 绑定
    this.env = env;
    this.db = env && env.DB ? env.DB : null;
    this.blob = env && env.HISTORY_BLOB ? env.HISTORY_BLOB : null;

    // Use objects like original server.js instead of Maps
    this.clients = {};
    this.channels = {};

    // [新增-消息留存] 待落库记录的缓冲：房间清空之前只暂存在内存里，
    // 房间内最后一个人退出时才批量写入 D1/R2
    this.buffers = {};
    // [新增-消息留存] 各房间生效的留存时长（分钟），由 setupHistory 填充
    this.roomPolicy = {};
    // [新增-消息留存] 各房间房主验证值，用于房间行被回收后重建时保留房主
    this.roomOwner = {};
    // [新增-消息留存] 同一房间落库的串行化队列（房间 id → Promise）
    this.flushChains = {};

    this.config = {
      seenTimeout: 60000,
      debug: false
    };

    // Initialize RSA key pair
    this.initRSAKeyPair();
  }

  async initRSAKeyPair() {
    try {
      let stored = await this.state.storage.get('rsaKeyPair');
      if (!stored) {
        console.log('Generating new RSA keypair...');
          const keyPair = await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256'
          },
          true,
          ['sign', 'verify']
        );

        // 并行导出公钥和私钥以提高性能
        const [publicKeyBuffer, privateKeyBuffer] = await Promise.all([
          crypto.subtle.exportKey('spki', keyPair.publicKey),
          crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
        ]);
        
        stored = {
          rsaPublic: btoa(String.fromCharCode(...new Uint8Array(publicKeyBuffer))),
          rsaPrivateData: Array.from(new Uint8Array(privateKeyBuffer)),
          createdAt: Date.now() // 记录密钥创建时间，用于后续判断是否需要轮换
        };
        
        await this.state.storage.put('rsaKeyPair', stored);
        console.log('RSA key pair generated and stored');
      }
      
      // Reconstruct the private key
      if (stored.rsaPrivateData) {
        const privateKeyBuffer = new Uint8Array(stored.rsaPrivateData);
        
        stored.rsaPrivate = await crypto.subtle.importKey(
          'pkcs8',
          privateKeyBuffer,
          {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256'
          },
          false,
          ['sign']
        );      }
        this.keyPair = stored;
      
      // 检查密钥是否需要轮换（如果已创建超过24小时）
      if (stored.createdAt && (Date.now() - stored.createdAt > 24 * 60 * 60 * 1000)) {
        // 如果没有任何客户端，则执行密钥轮换
        if (Object.keys(this.clients).length === 0) {
          console.log('密钥已使用24小时，进行轮换...');
          await this.state.storage.delete('rsaKeyPair');
          this.keyPair = null;
          await this.initRSAKeyPair();
        } else {
          // 否则标记需要在客户端全部断开后进行轮换
          await this.state.storage.put('pendingKeyRotation', true);
        }
      }
    } catch (error) {
      console.error('Error initializing RSA key pair:', error);
      throw error;
    }
  }

  async fetch(request) {
    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', { status: 426 });
    }

    // Ensure RSA keys are initialized
    if (!this.keyPair) {
      await this.initRSAKeyPair();
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept the WebSocket connection
    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }  // WebSocket connection event handler
  async handleSession(connection) {    connection.accept();

    // 清理旧连接
    await this.cleanupOldConnections();

    const clientId = generateClientId();

    if (!clientId || this.clients[clientId]) {
      this.closeConnection(connection);
      return;
    }

    logEvent('connection', clientId, 'debug');    // Store client information
    this.clients[clientId] = {
      connection: connection,
      seen: getTime(),
      key: null,
      shared: null,
      channel: null,
      // [新增-消息留存] 历史拉取限流计数
      historyReqs: 0,
      historyReqBucket: 0
    };

    // Send RSA public key
    try {
      logEvent('sending-public-key', clientId, 'debug');
      this.sendMessage(connection, JSON.stringify({
        type: 'server-key',
        key: this.keyPair.rsaPublic
      }));
    } catch (error) {
      logEvent('sending-public-key', error, 'error');
    }    // Handle messages
    connection.addEventListener('message', async (event) => {
      const message = event.data;

      if (!isString(message) || !this.clients[clientId]) {
        return;
      }

      this.clients[clientId].seen = getTime();

      if (message === 'ping') {
        this.sendMessage(connection, 'pong');
        return;
      }

      logEvent('message', [clientId, message], 'debug');      // Handle key exchange
      if (!this.clients[clientId].shared && message.length < 2048) {
        try {
          // Generate ECDH key pair using P-384 curve (equivalent to secp384r1)
          const keys = await crypto.subtle.generateKey(
            {
              name: 'ECDH',
              namedCurve: 'P-384'
            },
            true,
            ['deriveBits', 'deriveKey']
          );

          const publicKeyBuffer = await crypto.subtle.exportKey('raw', keys.publicKey);
          
          // Sign the public key using PKCS1 padding (compatible with original)
          const signature = await crypto.subtle.sign(
            {
              name: 'RSASSA-PKCS1-v1_5'
            },
            this.keyPair.rsaPrivate,
            publicKeyBuffer
          );

          // Convert hex string to Uint8Array for client public key
          const clientPublicKeyHex = message;
          const clientPublicKeyBytes = new Uint8Array(clientPublicKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
          
          // Import client's public key
          const clientPublicKey = await crypto.subtle.importKey(
            'raw',
            clientPublicKeyBytes,
            { name: 'ECDH', namedCurve: 'P-384' },
            false,
            []
          );

          // Derive shared secret bits (equivalent to computeSecret in Node.js)
          const sharedSecretBits = await crypto.subtle.deriveBits(
            {
              name: 'ECDH',
              public: clientPublicKey
            },
            keys.privateKey,
            384 // P-384 produces 48 bytes (384 bits)
          );          // Take bytes 8-40 (32 bytes) for AES-256 key
          this.clients[clientId].shared = new Uint8Array(sharedSecretBits).slice(8, 40);

          const response = Array.from(new Uint8Array(publicKeyBuffer))
            .map(b => b.toString(16).padStart(2, '0')).join('') + 
            '|' + btoa(String.fromCharCode(...new Uint8Array(signature)));
          
          this.sendMessage(connection, response);

        } catch (error) {
          logEvent('message-key', [clientId, error], 'error');
          this.closeConnection(connection);
        }

        return;
      }

      // Handle encrypted messages
      if (this.clients[clientId].shared && message.length <= (8 * 1024 * 1024)) {
        // [新增-消息留存] 处理器改为异步（加入房间要读策略、拉历史），
        // 兜底捕获异常避免出现未处理的 Promise 拒绝
        this.processEncryptedMessage(clientId, message).catch((error) => {
          logEvent('process-encrypted-message-unhandled', [clientId, error], 'error');
        });
      }
    });    // Handle connection close
    connection.addEventListener('close', async (event) => {
      logEvent('close', [clientId, event], 'debug');

      // [新增-消息留存] 显式判空：cleanupOldConnections 可能已经删除过该客户端，
      // 原来直接取 this.clients[clientId].channel 会在这种情况下抛错，
      // 从而连带跳过成员列表清理与落库
      const leaving = this.clients[clientId];
      const channel = leaving ? leaving.channel : null;

      // [新增-消息留存] 统一处理离开房间：移出成员列表、必要时批量落库、通知剩余成员
      try {
        await this.removeFromChannel(clientId, channel);
      } catch (error) {
        logEvent('close-leave', [clientId, error], 'error');
      }

      if (this.clients[clientId]) {
        delete(this.clients[clientId]);
      }
    });
  }

  // ============================================================
  // [新增-消息留存] 离开房间与批量落库
  // ============================================================

  // 把客户端移出所在房间；房间因此变空时把缓冲的记录一次性写入数据库
  async removeFromChannel(clientId, channel) {
    if (!channel || !this.channels[channel]) {
      return;
    }
    const members = this.channels[channel];
    const index = members.indexOf(clientId);
    // 已被移除时直接返回：原始的 splice(-1, 1) 会误删数组末尾的成员
    if (index < 0) {
      return;
    }
    members.splice(index, 1);

    if (members.length === 0) {
      delete(this.channels[channel]);
      // [新增-消息留存] 房间内最后一个人退出 → 此时才真正写库。
      // 必须在清掉策略缓存之前落库，flushBuffer 需要用到它们
      await this.flushBuffer(channel);
      // 落库是异步的，期间可能有新会话加入并重新建好缓存；
      // 那种情况下不能清掉，否则新会话的消息会因为查不到策略而不入缓冲
      if (!this.channels[channel]) {
        delete(this.roomPolicy[channel]);
        delete(this.roomOwner[channel]);
      }
      return;
    }

    try {
      for (const member of members) {
        const client = this.clients[member];
        if (this.isClientInChannel(client, channel)) {
          this.sendMessage(client.connection, encryptMessage({
            a: 'l',
            p: members.filter((value) => {
              return (value !== member ? true : false);
            })
          }, client.shared));
        }
      }
    } catch (error) {
      logEvent('close-list', [clientId, error], 'error');
    }
  }

  // [新增-消息留存] 把某个房间缓冲的记录批量写入 D1/R2
  // 只有「房间内最后一个人退出」会触发它
  async flushBuffer(channel) {
    const buffer = this.buffers[channel];
    if (!buffer) {
      return 0;
    }
    // 先摘除缓冲，避免写入过程中被再次触发导致同一批写两遍
    delete this.buffers[channel];

    if (!this.db || buffer.items.length === 0) {
      return 0;
    }

    // [新增-消息留存] 房间策略行可能已被 sweep 回收（例如一次会话持续超过 24 小时），
    // 此时按缓存的策略与房主重建它，避免这整批缓冲因为查不到策略而被丢弃
    const cachedMinutes = this.roomPolicy[channel] || 0;
    if (cachedMinutes > 0) {
      try {
        await ensureRoom(this.db, channel, cachedMinutes, this.roomOwner[channel] || null);
      } catch (error) {
        logEvent('history-flush-ensure-room', error, 'error');
      }
    }

    // 序号在写入时才分配，因此同一房间的落库必须串行：
    // 若一个会话刚清空、新会话的缓冲又在旧缓冲写完之前落库，两次写入会交错，
    // 历史顺序就被打乱了。这里用一条按房间的 Promise 链把它们排队。
    const previous = this.flushChains[channel] || Promise.resolve();
    const task = previous
      .catch(() => 0)
      .then(() => this.writeBuffer(channel, buffer));
    this.flushChains[channel] = task;
    // 链尾结束后清理记录，避免无限增长
    task.then(() => {
      if (this.flushChains[channel] === task) {
        delete this.flushChains[channel];
      }
    }).catch(() => {});
    return await task;
  }

  // 真正逐条写入的部分（由 flushBuffer 串行调度）
  async writeBuffer(channel, buffer) {
    let written = 0;
    for (const item of buffer.items) {
      try {
        const seq = await appendMessage(this.db, this.blob, {
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
  }
  // Process encrypted messages
  async processEncryptedMessage(clientId, message) {
    let decrypted = null;

    try {
      decrypted = decryptMessage(message, this.clients[clientId].shared);

      logEvent('message-decrypted', [clientId, decrypted], 'debug');

      if (!isObject(decrypted) || !isString(decrypted.a)) {
        return;
      }

      const action = decrypted.a;

      if (action === 'j') {
        await this.handleJoinChannel(clientId, decrypted);
      } else if (action === 'c') {
        this.handleClientMessage(clientId, decrypted);
      } else if (action === 'w') {
        this.handleChannelMessage(clientId, decrypted);
      } else if (action === 'hs') {
        // [新增-消息留存] 客户端提交一条待留存的密文记录
        this.handleStore(clientId, decrypted);
      } else if (action === 'h') {
        // [新增-消息留存] 客户端请求下一页历史
        await this.handleHistoryRequest(clientId, decrypted);
      } else if (action === 'rs') {
        // [新增-消息留存] 房主修改留存时长
        await this.handleRetentionSet(clientId, decrypted);
      }

    } catch (error) {
      logEvent('process-encrypted-message', [clientId, error], 'error');
    } finally {
      decrypted = null;
    }
  }
  // Handle channel join requests
  async handleJoinChannel(clientId, decrypted) {
    if (!isString(decrypted.p) || this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = decrypted.p;

      this.clients[clientId].channel = channel;

      if (!this.channels[channel]) {
        this.channels[channel] = [clientId];
      } else {
        this.channels[channel].push(clientId);
      }

      this.broadcastMemberList(channel);

      // [新增-消息留存] 确定房间留存策略并下发历史
      // decrypted.r 是请求的留存分钟数（仅房间首次创建时生效）
      // decrypted.o 是房主验证值（没有管理密码时为 undefined）
      await this.setupHistory(clientId, channel, decrypted.r, decrypted.o);

    } catch (error) {
      logEvent('message-join', [clientId, error], 'error');
    }
  }

  // ============================================================
  // [新增-消息留存] 历史相关处理
  // 服务器全程只接触密文，不参与任何加解密
  // ============================================================

  // 确定留存策略（房间首次创建时写入，之后仅房主可改）并把历史下发给刚加入的客户端
  async setupHistory(clientId, channel, requestedMinutes, ownerVerifier) {
    const client = this.clients[clientId];
    if (!client || !this.db) return;

    try {
      const result = await ensureRoom(this.db, channel, normalizeMinutes(requestedMinutes), ownerVerifier || null);

      // [新增-消息留存] 缓存生效策略与房主验证值，
      // 供 handleStore 判断是否缓冲、以及房间行被回收后重建时保留房主
      this.roomPolicy[channel] = result.minutes;
      if (ownerVerifier) this.roomOwner[channel] = ownerVerifier;
      // 本次连接是否被认定为房主（决定客户端能否修改留存时长）
      client.owned = result.owned;

      // 期间可能已断开或切换房间
      if (!client.shared || client.channel !== channel || !this.clients[clientId]) return;

      // 无论是否存储都要把生效策略告知客户端，
      // 客户端据此决定是否提交 hs 记录（也用于界面展示与房主控制权）
      this.sendMessage(client.connection, encryptMessage({
        a: 'r',
        p: { m: result.minutes, owned: result.owned }
      }, client.shared));

      if (result.minutes <= 0) return;
      await this.pushHistory(clientId, channel, 0);
    } catch (error) {
      logEvent('history-setup', [clientId, error], 'error');
    }
  }

  // [新增-消息留存] 房主修改留存时长（a:'rs'）
  // 只有在本连接加入时被验证为房主的客户端才能调用
  async handleRetentionSet(clientId, decrypted) {
    const client = this.clients[clientId];
    if (!client || !client.channel || !this.db) return;

    const channel = client.channel;
    if (!client.owned) {
      logEvent('history-set-denied', clientId, 'error');
      return;
    }

    const payload = isObject(decrypted.p) ? decrypted.p : {};
    const minutes = normalizeMinutes(payload.m);

    try {
      const result = await applyRetention(this.db, this.blob, channel, minutes);
      if (!result.ok) return;

      this.roomPolicy[channel] = minutes;
      if (minutes === 0) {
        // 设为 0 表示不再保存：未落库的缓冲也要一起丢弃
        delete this.buffers[channel];
      }

      // 广播给房间内所有成员（不带 owned 字段，各成员保留自己的房主状态）
      this.broadcastRetention(channel, minutes);
    } catch (error) {
      logEvent('history-set', [clientId, error], 'error');
    }
  }

  // 把生效的留存策略广播给房间内所有成员
  broadcastRetention(channel, minutes) {
    const members = this.channels[channel];
    if (!members) return;
    for (const member of members) {
      const memberClient = this.clients[member];
      if (this.isClientInChannel(memberClient, channel)) {
        try {
          this.sendMessage(memberClient.connection, encryptMessage({
            a: 'r',
            p: { m: minutes }
          }, memberClient.shared));
        } catch (error) {
          logEvent('history-broadcast-retention', [member, error], 'error');
        }
      }
    }
  }

  // 按 seq 拉取一页历史并下发
  async pushHistory(clientId, channel, sinceSeq) {
    const client = this.clients[clientId];
    if (!client || !this.db) return;

    try {
      const room = await getRoom(this.db, channel);
      if (!room || room.retention_sec <= 0) return;

      const page = await fetchHistory(this.db, this.blob, channel, sinceSeq, room.retention_sec);

      if (!client.shared || client.channel !== channel || !this.clients[clientId]) return;

      this.sendMessage(client.connection, encryptMessage({
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
  }

  // 客户端请求下一页历史（带每分钟次数限流，防止被用来刷 R2 读取）
  async handleHistoryRequest(clientId, decrypted) {
    const client = this.clients[clientId];
    if (!client || !client.channel || !this.db) return;

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
    await this.pushHistory(clientId, client.channel, since);
  }

  // 客户端提交一条待留存的密文记录
  // [新增-消息留存] 这里只写入内存缓冲；真正落库由「房间内最后一个人退出」触发
  // （见 flushBuffer），因此其他人退出都不会产生数据库写入
  handleStore(clientId, decrypted) {
    const client = this.clients[clientId];
    if (!client || !client.channel || !this.db) return;

    const channel = client.channel;

    // 留存未开启的房间不缓冲
    if (!(this.roomPolicy[channel] > 0)) return;

    const record = validateRecord(decrypted.p);
    if (!record) return;

    // 限流放在缓冲入口：批量落库时不能再限流，否则大部分记录会被丢弃
    if (!allowWrite(channel)) {
      logEvent('history-rate-limited', channel, 'error');
      return;
    }

    let buffer = this.buffers[channel];
    if (!buffer) {
      buffer = { items: [], bytes: 0 };
      this.buffers[channel] = buffer;
    }

    // 缓冲上限，防止长时间会话把 DO 内存撑大
    if (buffer.items.length >= HISTORY_BUFFER_MAX_ITEMS ||
      buffer.bytes + record.ct.length > HISTORY_BUFFER_MAX_BYTES) {
      logEvent('history-buffer-full', [channel, buffer.items.length, buffer.bytes], 'error');
      return;
    }

    buffer.items.push(record);
    buffer.bytes += record.ct.length;
  }
  // Handle client messages
  handleClientMessage(clientId, decrypted) {
    if (!isString(decrypted.p) || !isString(decrypted.c) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;
      const targetClient = this.clients[decrypted.c];

      if (this.isClientInChannel(targetClient, channel)) {
        const messageObj = {
          a: 'c',
          p: decrypted.p,
          c: clientId
        };

        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        messageObj.p = null;
      }

    } catch (error) {
      logEvent('message-client', [clientId, error], 'error');
    }
  }  // Handle channel messages
  handleChannelMessage(clientId, decrypted) {
    if (!isObject(decrypted.p) || !this.clients[clientId].channel) {
      return;
    }
    
    try {
      const channel = this.clients[clientId].channel;
      // 过滤有效的目标成员
      const validMembers = Object.keys(decrypted.p).filter(member => {
        const targetClient = this.clients[member];
        return isString(decrypted.p[member]) && this.isClientInChannel(targetClient, channel);
      });

      // 处理所有有效的目标成员
      for (const member of validMembers) {
        const targetClient = this.clients[member];
        const messageObj = {
          a: 'c',
          p: decrypted.p[member],
          c: clientId
        };        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        messageObj.p = null;
      }

    } catch (error) {
      logEvent('message-channel', [clientId, error], 'error');
    }
  }
  // Broadcast member list to channel
  broadcastMemberList(channel) {
    try {
      const members = this.channels[channel];

      for (const member of members) {
        const client = this.clients[member];

        if (this.isClientInChannel(client, channel)) {
          const messageObj = {
            a: 'l',
            p: members.filter((value) => {
              return (value !== member ? true : false);
            })
          };

          const encrypted = encryptMessage(messageObj, client.shared);
          this.sendMessage(client.connection, encrypted);

          messageObj.p = null;
        }
      }
    } catch (error) {
      logEvent('broadcast-member-list', error, 'error');
    }
  }  // Check if client is in channel
  isClientInChannel(client, channel) {
    return (
      client &&
      client.connection &&
      client.shared &&
      client.channel &&
      client.channel === channel ?
      true :
      false
    );
  }
  // Send message helper
  sendMessage(connection, message) {
    try {
      // In Cloudflare Workers, WebSocket.READY_STATE_OPEN is 1
      if (connection.readyState === 1) {
        connection.send(message);
      }
    } catch (error) {
      logEvent('sendMessage', error, 'error');
    }
  }  // Close connection helper
  closeConnection(connection) {
    try {
      connection.close();    } catch (error) {
      logEvent('closeConnection', error, 'error');
    }
  }
  
  // 连接清理方法
  async cleanupOldConnections() {
    const seenThreshold = getTime() - this.config.seenTimeout;
    const clientsToRemove = [];

    // 先收集需要移除的客户端，避免在迭代时修改对象
    for (const clientId in this.clients) {
      if (this.clients[clientId].seen < seenThreshold) {
        clientsToRemove.push(clientId);
      }
    }

    // 然后一次性移除所有过期客户端
    for (const clientId of clientsToRemove) {
      try {
        logEvent('connection-seen', clientId, 'debug');
        const stale = this.clients[clientId];
        // [新增-消息留存] 这条连接已经失效，close 事件不一定会再触发，
        // 所以主动走一次离房流程，保证成员列表清理与「最后一个离开时落库」都能执行
        await this.removeFromChannel(clientId, stale ? stale.channel : null);
        stale.connection.close();
        delete this.clients[clientId];
      } catch (error) {
        logEvent('connection-seen', error, 'error');      }
    }
    
    // 如果没有任何客户端和房间，检查是否需要轮换密钥
    if (Object.keys(this.clients).length === 0 && Object.keys(this.channels).length === 0) {
      const pendingRotation = await this.state.storage.get('pendingKeyRotation');
      if (pendingRotation) {
        console.log('没有活跃客户端或房间，执行密钥轮换...');
        await this.state.storage.delete('rsaKeyPair');        await this.state.storage.delete('pendingKeyRotation');
        this.keyPair = null;
        await this.initRSAKeyPair();
      }
    }
    
    return clientsToRemove.length; // 返回清理的连接数量
  }
}

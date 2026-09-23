# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

NodeCrypt 是一个零知识端到端加密聊天系统。服务器只做密文盲转发，所有加解密都在客户端完成，无数据库、无历史消息持久化。

同一套协议有两个可互换的服务端实现（**修改协议时两边都要改**）：

- `worker/index.js` — Cloudflare Workers + Durable Objects（`ChatRoom` 类），生产默认部署方式
- `server/server.js` — 独立 Node.js `ws` 服务器，供 Docker / 自托管使用，监听 127.0.0.1:8088
- `worker/utils.js` 是 `server.js` 加密辅助函数的 Workers 移植版（AES-256-CBC、JSON 消息封装）

## 常用命令

```bash
npm install                 # 根目录依赖（前端 + wrangler）
cd server && npm install     # 仅在使用 server/server.js 时需要

npm run build               # vite build → dist/（root 为 client/）
npm run deploy              # wrangler deploy 到 Cloudflare Workers
npm run dev                 # wrangler dev（带 Durable Objects + WebSocket 的本地运行）
npm run build:docker        # Dockerfile 中前端构建阶段调用的别名

npx vite                    # 仅调试前端时用：直接以 client/ 为根启动，带 HMR

# 消息留存所需的 D1 / R2（详见下文「消息留存」一节，不用该功能可跳过）
# D1 库不需要 `wrangler d1 create`：由部署时的自动资源供给创建，见下文「部署前置」
npx wrangler r2 bucket create nodecrypt-history-blobs
```

**注意构建顺序**：`wrangler.toml` 把静态资源指向 `./dist`（`run_worker_first = true`，SPA fallback，绑定 `ASSETS`），所以 `npm run dev` 服务的是**已构建产物**。改完 `client/` 代码要先 `npm run build` 才能在 wrangler 里看到效果；只想快速调 UI/样式时用 `npx vite`。

仓库当前**没有** ESLint / Prettier / 测试框架（无 jest、vitest、任何 test 脚本）。不要臆造 `npm test` 之类的命令。

## 代码风格约定

- 注释成对出现：英文一行 + 中文一行，放在对应语句上方。新增代码沿用这个格式。
- 前端是原生 ES6 模块，无框架、无构建期转译之外的依赖。
- 代码里大量使用紧凑写法（无分号结尾、单行 `if`），改动时跟随所在文件既有风格。

## 客户端架构（`client/js/`）

入口是 `client/js/main.js`（`index.html` 里 `<script type="module">`），它负责：装配全局 `window.config`（ws 地址按当前页面协议推导）、在 `DOMContentLoaded` 里绑定所有 UI 事件、把一批函数挂到 `window` 上供其他模块调用（`window.addSystemMsg`、`window.addOtherMsg`、`window.joinRoom`、`window.notifyMessage`、`window.handleFileMessage`、`window.downloadFile`、`window.setupEmojiPicker`）。

模块职责与**隐含耦合**（重要）：

- `NodeCrypt.js` — 加密核心类。既被 `main.js` 以 `import './NodeCrypt.js'` 副作用方式加载，又通过 `window.NodeCrypt` 在 `room.js` 里 `new` 出来。它以 `window.NodeCrypt` 暴露自身，不是常规具名导出。
- `room.js` — 模块级可变状态所在地：`roomsData`（数组，每个房间的数据对象）与 `activeRoomIndex`。被 `chat.js`、`ui.js`、`main.js` 直接 import，且 `chat.js` 与 `room.js` 之间存在循环引用。跨模块共享状态要改在 `room.js`，不要另建全局。
- `chat.js` — 消息渲染（`addMsg` / `addOtherMsg` / `addSystemMsg`）与历史回放 `renderChatArea()`。每加一条消息都会同时写 `roomsData[idx].messages` 和 DOM。
- `ui.js` — 成员列表、主标题栏、登录表单、分享链接生成/解析（`?r=` / `?p=`，`simpleEncrypt` 只是 base64 + 字符偏移的混淆，不是加密）。
- `util.*.js` — 无状态工具：`dom`（`$`/`$id`/`createElement`/`on`）、`string`（`escapeHTML` + DOMPurify）、`avatar`（dicebear 生成 SVG）、`file`/`fileUpload`/`image`/`emoji`/`settings`/`theme`/`i18n`。
- `util.history.js` — 留存专用：历史密钥派生、记录加解密、留存时长的读写与文案。直播加密不在其中。

每个房间的数据对象结构见 `room.js:getNewRoomData()`：`chat`（NodeCrypt 实例）、`messages`、`userList` / `userMap`、`myId`、`privateChatTargetId`、`unreadCount`。消息记录仅存在于内存，页面刷新即丢失——这是设计意图，不要"顺手"加持久化。

### 国际化

`util.i18n.js` 内联了全部 `en` / `zh` 词条。页面静态文案用 `data-i18n` / `data-i18n-title` 属性，`updateStaticTexts()` 统一替换；动态文案用 `t(key, fallback)`。**新增一个键必须同时补 `en` 和 `zh` 两份**，否则会回退到 fallback。

### 主题与设置

`util.theme.js` 的 `THEMES` 数组内是大段 base64 PNG 背景；当前设置持久化在 `localStorage` 的 `settings` 键（`notify` / `sound` / `theme` / `language`）。

## 加密协议（改协议前必读）

消息体是短字段名的 JSON：`a` 动作、`p` 载荷、`c` 目标 clientId、`t` 类型、`d` 数据。动作取值：`j` 加入房间、`w` 批量转发（`p` 是 `clientId → 密文` 的映射）、`c` 点对点转发、`l` 成员列表、`u` 用户名协商、`m` 业务消息。

三层结构：

1. **RSA-2048 服务器身份**：`ChatRoom` 生成密钥对，客户端首次连上时收到明文 JSON `{type:'server-key', key}`。服务器用私钥对 P-384 公钥原始字节签名，客户端用 `RSASSA-PKCS1-v1_5` 验签（注意是直接对 raw 公钥字节验签，没有先做哈希摘要）。密钥保存在 DO 存储中，超过 24 小时且无在线客户端时轮换，否则置 `pendingKeyRotation` 待下次清理时轮换。
2. **P-384 ECDH（客户端↔服务器）**：客户端连上后发的**第一条消息是明文 hex 的 P-384 公钥**（客户端靠 `!this.serverShared` 判断处于握手期）；服务器回 `公钥hex | base64(签名)`。双方取 `deriveBits(..., 384).slice(8, 40)` 作为 32 字节 AES-256 传输密钥。
3. **Curve25519 ECDH（客户端↔客户端）+ 房间密码**：`共享密钥 = ECDH_Curve25519(私钥, 对方公钥) XOR SHA256(房间密码)`。房间名同样经 `sha256(roomName)` 作为频道 ID。密码不同 → 无法解密 → 逻辑上是两个独立房间。

传输层线格式（两端必须严格一致）：

- AES-256-CBC：`base64(iv)|base64(密文)`，明文手动补零到 16 字节整数倍，双方都关闭自动填充。
- ChaCha20：`base64(iv)|base64(counter)|base64(密文)`；客户端把 4 字节 counter 通过 `reduce((a,b)=>a*b)` 折成一个数值传给 `js-chacha20`，改动此处必须同时改加密与解密两侧。

其他约束：单条消息上限 8MB（worker 与客户端两侧都有判断）；客户端每 20s 发 `ping`、服务器回 `pong`；服务器在每次新连接时清理 60s 未活动的客户端。

## 消息留存（可选功能）

默认关闭（留存时长 0），行为与「无历史」完全一致。开启后服务器把**密文**存进 D1，大记录存 R2。**这是本项目唯一一处持久化，任何改动都必须保持服务器无法解密。**

### 密钥模型（改动前必读）

直播消息用的是每次会话现生成的临时 Curve25519 密钥，**无法**用于历史回放。因此留存另有一把房间级密钥：

```
历史密钥 = PBKDF2-SHA256(SHA256(房间密码), salt=SHA256(房间名), 310000 次, 256 位)
```

- 房间名与密码的哈希与 `NodeCrypt.setCredentials` 中的 `credentials.channel` / `credentials.password` 必须逐字节一致；
- 用慢 KDF 而非 HKDF 是刻意的：密文存在服务器上，持有数据库的人可以离线爆破密码；
- **无密码房间不能开启留存**（`sha256('')` 是常量，会导致服务器可解密），客户端 UI 会禁用并强制为 0；
- 记录用 **AES-256-GCM**，`AAD = roomId|ts|kind|v1`。AAD 里不含 `seq`（`seq` 由服务器分配，客户端在加密时尚不知道），因此恶意服务器能重排/删除记录——但它本来就能丢弃消息，这不是新增的保证损失。

### 写入时机：房间清空时批量落库

**不是每条消息即时写库。** 记录先进入 DO 的内存缓冲 `this.buffers[roomId]`，只有当「房间内最后一个人退出」（`this.channels[channel]` 变空）时才由 `flushBuffer()` 批量写入。其他人退出不触发写入。

- 客户端协议不受影响：发送方仍按条提交 `hs`，只是服务器改为缓冲。
- 缓冲上限 `HISTORY_BUFFER_MAX_BYTES`（32MB）/`HISTORY_BUFFER_MAX_ITEMS`（5000），超限丢弃并记日志。
- **限流必须放在缓冲入口**（`handleStore` 里调用 `allowWrite`），不能放在 `appendMessage` 里：批量落库时若逐条限流，一次 60 条以上的缓冲会被自己的限流丢掉绝大部分。
- 落库按房间串行（`this.flushChains`）：`seq` 是写入时才分配的，若「旧缓冲还没写完、新会话的缓冲又开始落库」，两次写入会交错打乱历史顺序。
- 「最后一人退出」的两个入口都要走 `removeFromChannel()`：WebSocket 的 `close` 事件，以及 `cleanupOldConnections()` 里主动清理的超时连接（后者连接已失效，`close` 不一定再触发）。注意要先落库再清 `roomPolicy`/`roomOwner` 缓存，`flushBuffer` 依赖它们。
- 若房间策略行已被 `sweep()` 回收（例如一次会话持续超过 24 小时），`flushBuffer` 会先用缓存的策略与房主重建它，避免整批缓冲因查不到策略而被丢弃。

### 房主与策略修改

- 策略只在**房间首次创建**时写入首个加入者表单里的值；之后 `ensureRoom()` 只刷新 `updated_at`，不会用加入者提交的 `r` 覆盖它——否则房主每次加入时带的本地偏好会被误当成修改指令，可能直接把历史清空。
- 房主凭据：客户端用**房主管理密码**派生 `房主密钥 = PBKDF2-SHA256(SHA256(管理密码), salt=SHA256(房间名), 310000 次)`，提交的是它的 `SHA-256`（`deriveOwnerVerifier()`）；服务器只存这个验证值 `rooms.owner_hash`，既无法反推管理密码，也拿不到任何解密材料。盐是房间名，因此**同一管理密码在任何设备上都会得到同一验证值**——这就是「退出重进 / 换设备仍是房主」的实现方式。
- 房主改策略走独立动作 `{a:'rs'}`（`setRetention()`），不复用 `j` 里的 `r`。服务端在 `client.owned` 上记住本次连接的房主判定，`rs` 不再重复校验。
- 改成 0 → `applyRetention()` 调 `purgeRoom()` 删掉 D1 全部行与 R2 全部对象，并丢弃未落库的缓冲。改成其他值 → 顺带 `UPDATE messages SET expires_at = created_at + 新时长`，让「延长留存」对旧消息也生效。
- 不填管理密码也能开留存，但那之后**谁都无法再改**（客户端会在表单上给出提示）。

#### 分享链接的边界（不要破坏）

分享链接（`ui.js:handleShareAction()`）**只能**携带房间名与房间密码，即 `?r=`/`?p=`。**房主管理密码绝不能放进链接**：它是「谁能修改或清空留存」的唯一凭据，一旦随链接流出，任何拿到链接的人都会成为房主。`autofillRoomPwd()` 也只读这四个参数（`r`/`p`/旧格式 `node`/`pwd`），因此通过分享链接进来的人管理密码框为空、不会被判为房主。

由此产生的三个后果，都是该设计的既定语义而非缺陷：

1. 想改或想清空留存，只有创建者（持管理密码的人）能做；普通成员即使担心隐私也无权关闭留存，只能自己离开房间或另开房间。
2. 管理密码丢失 = 留存设置被永久冻结（房间行只要还有未过期消息就不会被回收，`sweep()` 不会清掉它）。
3. 想让别人也拥有房主权限，只需另行告知管理密码，不需要改代码。

### 存储与清理

- 表结构见 `worker/migrations/0001_history.sql`：`rooms`（一房一行的策略 + `owner_hash` + `last_seq` + `stored_bytes`）与 `messages`（`(room_id, seq)` 主键）。迁移文件尚未在任何环境执行过，改结构时直接改 0001 即可。
- `seq` 的分配与插入放在同一个 `db.batch()` 里，插入语句用子查询取回刚自增的 `last_seq`。
- 单条记录超过 `HISTORY_INLINE_MAX`（200KB）落 R2，`messages.object_key` 只留对象键；超过 `HISTORY_BLOB_MAX`（512KB）则放弃留存（实时投递照常）。这两个值都要给传输层留余量：记录还要经一次 AES-256-CBC + base64，体积放大约 4/3，而单条 WebSocket 消息有大小上限。
- 配额与限流：单房间 32MB、每分钟 60 条；每连接每分钟最多 60 次历史拉取（分页 512KB/页，页数要够）。
- 清理由 Worker 的 `scheduled()`（`wrangler.toml` 中 `crons = ["* * * * *"]`，1 分钟分辨率）驱动。**R2 没有对象级 TTL**，必须靠这个定时任务删除，顺序是先删对象并置空 `object_key`（`dropObjects()` 靠这个条件分批推进），再删行，否则会留下孤儿对象。
- 房间策略由首个加入者创建、之后只有房主能改（见上一节）；连续 24 小时无人且无留存消息时策略行会被回收，下次进入重新由首个加入者决定。

### 协议扩展

沿用短字段风格，新增五个动作（均在传输层加密内）：

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `{a:'j', p: channelHash, r: minutes, o: ownerVerifier}` | `r` 请求的留存时长（仅房间首次创建时生效）；`o` 房主验证值（未填管理密码时为 null） |
| S→C | `{a:'r', p:{m: minutes, owned: bool}}` | 生效策略与「本连接是否房主」；`owned` 只在加入时下发，广播不带该字段 |
| C→S | `{a:'hs', p:{k, ts, n, c}}` | 待留存的密文记录（`k` 1=文本 2=图片），服务器只入内存缓冲 |
| C→S | `{a:'rs', p:{m: minutes}}` | 房主修改留存时长；0 表示改回不保存并清除已有历史 |
| S→C | `{a:'h', p:{records, lastSeq, more}}` | 一页历史；客户端用 `more` 决定是否再发 `{a:'h', p:{since}}` |

- 落库是**发送方**驱动的（`NodeCrypt.storeChannelMessage()`，在 `sendChannelMessage` 末尾 fire-and-forget），不是服务器从转发内容里挑一份——转发用的是每接收者一份的临时密钥密文，服务器拿它没法还原，必须另附一份用历史密钥加密的副本。
- 因此**留存失败绝不影响实时投递**：两者是独立的消息。
- 只覆盖公共频道的文本与图片。**私聊不参与留存**（临时密钥无法跨会话解密；若改用房间密钥加密，等于向全房间公开私聊）。
- 客户端处理重连：服务器每次 `j` 都会重发全部历史，客户端用 `roomsData[idx].lastSeq` 去重；无论能否解密都推进游标，避免无法解密的记录导致分页死循环。
- 因为写入发生在房间清空时，**正在聊天的人看不到上一次会话的历史**；历史只在房间空掉之后、且仍在留存窗口内时，对重新进入的人可见。这是该设计的固有语义，不是缺陷。
- 客户端侧的回放、房主控制 UI 分别在 `room.js:handleHistory/handleRetention/appendHistoryMessage`、`util.settings.js`（依赖 `roomsData[i].retentionOwned`）与 `ui.js:setupRetentionField`。

### 双实现同步

`server/history.js`（Node）是 `worker/history.js` 的**内存版**，接口语义相同、动作与字段完全一致，只是没有持久化（进程重启即清空）。改协议时两边都要改。Dockerfile 用 `COPY server/*.js` 带上新文件。

### 部署前置

**D1 库不需要手动创建。** `wrangler.toml` 里刻意不写 `database_id`，部署时由 wrangler 的「自动资源供给」(automatic resource provisioning) 自动建库并绑定（需 wrangler ≥ 4.45.0，`package.json` 已锁 `^4.136.3`；低于该版本会以 `code 10021 must have a valid database_id` 直接失败）。删掉 D1 / R2 绑定即可让功能自动降级为不存储。

首次部署成功后还有两件事，各做一次：

1. **建 R2 桶**：面板 → Storage & Databases → R2 → Create bucket，名字 `nodecrypt-history-blobs`。R2 **不会**被自动供给创建——配置里给了 `bucket_name`，wrangler 视作「资源已指定」，既不创建也不校验存在性，桶缺失只在运行时访问大记录时才报错。想让它也自动创建，就把 `bucket_name` 那行删掉（桶名会由 wrangler 生成）。
2. **建表**：面板 → Storage & Databases → D1 → `nodecrypt-history` → Console，粘贴 `worker/migrations/0001_history.sql` 执行（语句均为 `IF NOT EXISTS`，可重复执行）。beta 阶段 wrangler 只把自动生成的库 ID 回写到 JSON 配置，`.toml` 的回写被静默忽略（workers-sdk#13632），因此 `wrangler d1 migrations apply` 在 CI 里用不了。

若改为在面板手动建 D1 库，就把它的 UUID 填回 `wrangler.toml` 的 `database_id`，`wrangler d1 migrations apply <name> --remote` 随之恢复可用。

## 文件传输

`util.file.js` 是自研分卷协议，不走 HTTP：`fflate` deflate（level 6）压缩 → 按 `DEFAULT_VOLUME_SIZE`（256KB）切片 → base64 → 每批 5 卷、间隔 100ms 通过 WebSocket 发送，消息类型为 `file_start` / `file_volume` / `file_complete`。接收端按 `volumeIndex` 归位，收齐后校验 SHA-256 再重组。多文件上传会打包成自定义归档格式（`name_length` + `name` + `size` + `data`，附带 manifest）一并传输。

传输状态在 `window.fileTransfers`（`Map`，键为 `fileId`），`chat.js:renderFileMessage()` 会读它来决定进度条与下载按钮的显隐。私聊文件的消息类型带 `_private` 后缀。

## 部署

- **Cloudflare Workers**：`wrangler.toml`（`main = worker/index.js`，`nodejs_compat`，DO 绑定 `CHAT_ROOM` → `ChatRoom`，迁移 tag `v1` 使用 `new_sqlite_classes`）。
- **Docker**：`Dockerfile` 多阶段构建，前端 `vite build` 产物放进 nginx 静态目录，nginx 把 WebSocket 升级请求反代到 8088 上的 `server/server.js`，对外暴露 80 端口。
- **CI**：`.github/workflows/docker-image.yml` 在 main 分支推送时构建并推送到 ghcr.io（仅在 `shuaiplus/nodecrypt` 仓库生效）；`sync-upstream.yml` 每天 02:00 UTC 把 `upstream/main` 合并进 main 并推送——fork 后会自动同步，本地改动要留意这个自动合并。

# Surf Grid — 合约网格交易总控台

基于 Extended (x10) DEX 官方 API 的合约网格交易总控台。支持测试网 / 主网切换、数据隔离、访问验证、动态虚拟网格策略、AI 巡检，以及可选的 API 网络代理（绕过主网下单地区限制 HTTP 451）。

## 技术栈

- 前端：Vite + React + TailwindCSS + TanStack Query
- 后端：Express + Drizzle (Postgres) + Surf SDK
- 交易所：Extended (x10) StarkNet DEX，Stark 签名下单

## 敏感信息说明

- **不提交任何真实密钥。** 交易所 API Key / Stark 私钥 / 访问密码等全部保存在数据库中，不落盘到代码仓库。
- `.env` 文件被 `.gitignore` 排除，仓库内只保留 `.env.example` 模板。
- 首次访问会要求设置访问密码（`AuthGate`），部署到公网后未登录无法查看数据。

## 本地 / VPS 部署

### 1. 环境要求
- Node.js 20+（或 Bun）
- 一个 PostgreSQL 数据库
- Surf SDK 的 `SURF_API_KEY`

### 2. 安装依赖
```bash
cd backend && bun install    # 或 npm install
cd ../frontend && bun install
```

### 3. 配置环境变量
复制模板并填写：
```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```
- `backend/.env`：`BACKEND_PORT`、`SURF_API_KEY`，以及数据库连接串（Surf SDK 需要）。
- `frontend/.env`：`PORT`、`BACKEND_PORT`、`BASE_PATH`。

### 4. 构建 & 启动
```bash
# 后端
cd backend && node server.js

# 前端（生产构建后用静态服务或 vite preview）
cd frontend && bun run build && bun run preview
```

### 5. 首次使用
1. 打开页面 → 设置访问密码（用于公网访问控制）。
2. 进入「配置」→ 填写 Extended API 凭证（测试网 / 主网各自独立）。
3. 如主网下单返回 HTTP 451（地区限制），在「配置 · 网络代理」填入允许区域的 http/https 代理，所有交易所请求即走代理。

## 主要功能

- **测试网 / 主网数据隔离**：日志、AI 报告、凭证、订单按环境完全隔离。
- **访问验证**：scrypt 密码 + 无状态 HMAC Token（7 天有效）。
- **动态虚拟网格**：以订单簿盘口中价为基准挂 post-only 单，自动跳过会穿价的档位。
- **API 网络代理**：设置后所有 Extended 请求走代理，留空则直连。
- **AI 巡检**：成交/补撤/净仓分析与哨兵告警。

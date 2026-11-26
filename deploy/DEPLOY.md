# Broker King 离线 Docker 部署包 (Offline Deployment)

本目录包含 **Broker King** 完整统一应用（**Connector** + **MSE6-C2M** + **Smartenance** + **Debug Agent** + Python 分析环境）以及 **PostgreSQL 17** 的 `linux/amd64` 离线镜像包，目标电脑无需联网拉取镜像即可直接部署。

## 包含文件

- `broker-king-images.tar`：Docker 离线镜像包（内含 `broker-king:1.0` 和 `postgres:17-alpine`）
- `docker-compose.yml`：一键编排启动文件（已设置 `pull_policy: never` 离线模式）
- `.env` / `.env.example`：端口、数据库密码及可选的 Debug Agent 默认模型配置

## 部署步骤

1. 将整个 `deploy` 文件夹拷贝到目标电脑并进入目录：

   ```sh
   cd deploy
   ```

2. 导入离线 Docker 镜像（无需联网）：

   ```sh
   docker load -i broker-king-images.tar
   ```

3. （可选）检查并修改 `.env` 文件：
   - 修改 `POSTGRES_PASSWORD` 为目标环境所需密码；
   - `HERMES_API_KEY` / `HERMES_MODEL` 可留空，部署后不同客户可直接在浏览器打开 **Debug Agent → 模型配置** 在线填写自己的模型与 API Key（保存到数据库，即时生效）。

4. 启动服务：

   ```sh
   docker compose up -d
   ```

5. 浏览器访问：**http://localhost:3000**

## 数据持久化说明

- PostgreSQL 数据保存在名为 `postgres_data` 的 Docker Volume 中。
- `docker compose down` 会保留所有数据库记录与配置；
- `docker compose down -v` 会清空数据库卷。

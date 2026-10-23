# 升级、备份与回滚

适用于单实例部署。升级与恢复都必须先停止所有写者，不能用 `cp` 覆盖带 WAL 的生产库。

## 1. 升级前

1. 阅读目标版本 Release / 提交记录，确认来源版本可升级；
2. 记录当前镜像 digest、`.env`、迁移头和软件版本；
3. 确认 `TOTP_ENC_KEY` 单独保管且可用；
4. 停止 app、maintenance、cron/timer 与所有手动写入者；
5. 用**旧版本**工具做一次离线整站备份并验证 COMPLETE 与哈希。

```bash
# 容器部署：停写后用一次性工具容器，不要对已停止的服务 exec
docker compose stop app maintenance
docker compose run --rm --no-deps app node scripts/backup-site.mjs
```

备份批次包含数据库、全部媒体对象、manifest（软件版本、Commit、迁移列表与业务计数）。
它不包含 `TOTP_ENC_KEY`。

## 2. 升级

1. 在隔离副本上先用目标版本启动一次，核对迁移、内容与媒体；
2. 正式启动目标 app，检查健康、品牌、登录、媒体、草稿与发布；
3. 通过后再启动 maintenance。

```bash
docker compose pull            # 使用固定镜像时
docker compose up -d
curl -fsS http://127.0.0.1:4321/api/health/ | grep '"db":"ok"'
```

应用会在迁移前拒绝当前程序不认识的 schema；不要用旧工具打开新库，也不要让新工具先升级
旧备份再交给旧程序。

### 静态截图与默认镜像

默认镜像只包含许可明确的 `gimp.png` 与 `libreoffice-interface.png`；Zotero、OBS、VLC 三张旧截图及
派生图被排除。升级旧站前先检查数据库中的 `/images/...` 引用：

- 已替换为许可明确素材：直接用默认镜像；
- 仍需旧 URL：确认权利后使用 `INCLUDE_LEGACY_ASSETS=1` 显式构建兼容镜像，或先在后台替换图片；
- 不要批量删除数据库 `image` 字段来掩盖缺图；默认构建会显示“图片已下架或不可用”占位。

整站备份只包含 DB+媒体对象，不包含 `public/images` 构建期截图；兼容静态素材不能靠媒体恢复工具找回。

## 3. 回滚

先区分两件事：

- **程序回退**：只把镜像/二进制换回旧版本，数据保持升级后的格式。只有 Release 明确声明数据格式双向兼容时才允许；本项目的常规发行为单向迁移，不承诺这种回退。旧版本可能不认识新迁移（更早的版本甚至可能直接启动并忽略新表），因此不能把“服务能起来”当成回滚成功。
- **数据恢复**：停写后，用升级前版本的工具恢复升级前 DB+媒体同批备份，再启动旧程序。这是默认、受支持的回滚方式，会丢失备份后的写入。

- 只有 Release 明确声明数据格式双向兼容时，才允许只回退镜像；
- 否则：停写、保存故障现场、用**升级前版本**的恢复工具恢复升级前 DB+媒体同批备份，再启动旧程序；
- 恢复会丢失备份后的写入，并清空会话/挑战/恢复码、递增 `auth_version`；用户需重新登录并生成新恢复码；
- 必须保留原 `TOTP_ENC_KEY`；站点备份不代替密钥备份。

```bash
docker compose stop app maintenance
docker compose run --rm --no-deps app node scripts/restore-site.mjs \
  --backup /app/backups/site-<stamp>-<rand> --yes
docker compose up -d
```

不要使用 `docker compose down -v`；不要删除数据卷来"重装"。

## 4. 硬中断恢复

如果恢复或升级进程被强制终止，先读 `site-restore-*.log.json` 的 phases 与 preserved 路径，
按 [运维手册](operations.md) 的"硬中断恢复"步骤处理：对象已切换但数据库未切换时恢复旧媒体目录；
进入 `db-swap-started` 或 `swap` 后，删除目标 sidecar，把 `preserved.database` 这个独立
一致性快照写回主库，再恢复媒体。不要复用旧 WAL/SHM，也不要把快照与旧 sidecar 拼接。
恢复后重新备份并启动一个实例验证。

## 5. 实例隔离

每个实例必须使用独立的数据库、媒体、备份与 Compose project 名称/数据卷。不要共享数据卷或
`TOTP_ENC_KEY`；相同用户名在不同实例中是不同账户。升级与恢复都只作用于当前实例。

## 6. 已执行演练

完整记录与结果见 [升级回滚演练](upgrade-rehearsal.md)。脚本：

~~~bash
npm run rehearsal:upgrade
~~~

覆盖旧版本（010）→ 候选（012）→ 恢复升级前批次 → 旧版本（010），包括旧管理员登录、候选新增数据、
旧工具恢复、会话撤销、旧版本重新登录，以及候选镜像在 `--network none` 下的健康/首页读取。

演练结论：

- 回滚采用数据恢复，不是仅换镜像；
- 升级后新增数据在恢复后丢失，符合停写备份边界；
- 旧版本没有未知迁移保护，不能直接把升级后的库交给旧程序；
- 发行物离线可运行；外部链接检查不在离线结论内。

## 7. 自动备份与维护政策

- maintenance 定时生成的**在线数据库快照是诊断资料**，不保证 DB 与媒体二进制同批；不能当作灾备。
- 完整备份必须停写，由宿主机维护流程协调停服务、运行 `site:backup`、验证 `COMPLETE`/哈希、再启动；
  可配 systemd timer 或宿主机 cron 做编排，但不要由应用容器持有 Docker socket。
- 容器/应用不实现“无停机一致性快照协议”；需要零停机备份时另立任务并单独验证。
- 备份目录必须在数据卷之外，保留异机副本；恢复演练至少每次升级前做一次。
- 维护窗口内不要同时运行 app、maintenance、手动媒体任务或其他写者。

# 会话删除范围与平台兼容

核对日期：2026-10-20。实现固定适配本机 DeepSeek Harness **0.2.1-rc.2**；以随附包的 README 和 `lib/index.js` 为准，同时核对下列官方文档。公共仓库 master 会变化，不代表对其他版本的兼容承诺。

## 清理清单

`storages` 是共享存储目录，不能整体删除。路径来自实际挂载的 JSON 后端及存储域，支持自定义根目录和按域路由；不通过会话目录拼出假定的 `~/.dsh/storages`。

| 数据                                   | 处理                                                                 | 对应路径或记录           |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------ |
| 会话目录                               | 删除整个已选目录，含当前和历史日志代次、锁文件和该目录内的文件       | 目录和每个文件的绝对路径 |
| `session_projcache/sessions/<id>.json` | 通过存储域删除记录，并处理被域忽略的过期或损坏文档                   | 独立文件路径             |
| `<id>.json.bak.<YYYYMMDDHHmm>`         | 删除宿主生成的损坏缓存备份                                           | 每个实际备份路径         |
| 旧 `session_projcache.json`            | 仅移除 `tables.sessions` 中的已选会话键，保留其他记录与未知字段      | 文件路径和记录键         |
| 旧 `message_feedback`                  | 对已识别的 `sessions` 表移除对应键及独立文档、备份；未知布局拒绝清理 | 文件路径和记录键         |
| `workspace.json`                       | 移除会话成员、归档、置顶引用；保留工作区及其他会话                   | 文件路径和记录键         |
| `schedule.json`                        | 移除绑定的提醒和随该记录保存的投递历史，遵守原生调度写队列           | 文件路径和任务键         |
| 当前消息反馈                           | 已属于规范会话日志，随日志目录删除                                   | 会话日志路径             |

旧缓存的整体 JSON 在迁移后仍可能留存。原生 JSON 后端会在空的新缓存树上重新导入它，所以删除时必须同时清理旧文件中的相应记录，避免已删缓存重新出现。

原生全局存储可能由多个会话共用一个文件。因此“修改共享文件”不等于“删除整个文件”。文件变化后保留完整 JSON 结构，不进行全文 session ID 替换。

## 已删除会话的残留

“工作区”标题行最右侧的垃圾桶打开残留扫描预览，不直接执行清理。候选来自已识别的缓存、备份、旧记录、工作区关联和提醒绑定。删除现有会话时也会清理该会话的已识别元数据。

当前宿主没有标题栏 action 插槽。插件通过 React portal 挂载至该行原生操作区之后，直接复用原生图标按钮类和 Tooltip；不注入 CSS，不修改宿主文件。侧栏收起时隐藏，展开后恢复，卸载时移除。此兼容适配同样受宿主版本限制。

候选必须同时满足：持久化会话列表没有该 ID、当前宿主没有对应会话或 Agent、任何项目目录下都不存在其编码后的会话目录。后一个条件用于保护因损坏或未知格式而未被 `list()` 返回的日志。预览后会话重新出现、文件范围改变或记录变化时拒绝提交。没有候选时禁止继续。

## 展示与提交

弹窗仅展示将删除的文件/目录绝对路径，默认折叠，不提供复制按钮。共享记录和保留内容不在界面中单独展示；内部清单及事务校验仍保持完整。Web 显示并操作服务端路径。释放会话时可能产生的最终缓存和 POSIX 锁文件也提前列为条件清理项。

清单使用 Harness 原生 Modal、DisclosureRow 和 Checkbox 展示，复用宿主确认框的尺寸及滚动样式，摘要、路径与确认选项使用同一内容边距。用户核对后勾选确认并提交。令牌有效五分钟、单次使用；提交前重新检查路径清单和日志修订。成功后显示已清理的会话数量。

## 保留边界

- **工作区源码和用户文件**：删除对话不删除项目文件。
- **附件及请求图片缓存**：附件按内容去重，可能被多个会话、分叉或未提交草稿使用。宿主没有引用计数或垃圾回收 API，不能根据删除一个会话推断附件可以擦除。保留实际附件/缓存目录，不在删除路径中列出。
- **历史恢复目录**：此前事务的恢复数据不自动清除；其中可能仍含旧副本。不在删除路径中列出；出错时不要手动清空。
- **其他副本**：导出文件、外部备份、浏览器数据、已上传日志和第三方插件的未知私有数据不在此适配器的清理范围。此功能不承诺安全擦除所有副本。
- **多宿主共享存储**：原生 JSON 域只保证当前进程的写队列，没有跨进程缓存同步。共用同一存储时，应先关闭其他 Harness 实例，避免其他进程将旧记录写回。会话日志仍使用原生跨进程写锁；这不等于所有元数据都具有跨进程事务。

## 平台

- 路径使用 Node 的本机路径 API。Windows 比较处理盘符大小写、UNC 和长路径前缀，POSIX 保留大小写语义。
- 拒绝路径越界、符号链接和 Windows junction。会话 ID 拒绝设备名、ADS、非法字符及尾随点/空格等跨平台歧义。
- 使用宿主本身的写锁：POSIX 为 `flock`；Windows 为原生命名信号量。关闭写句柄后才物理清空暂存文件。
- Windows 的共享/杀毒短暂占用进行有界重试；权限错误持续存在时保留恢复目录。不同卷之间不进行“复制后删除”的降级，元数据在各自存储根目录下暂存。
- 失败时还原已移动文件、域记录、共享 JSON 及关联；发现其他写入占用恢复位置时保留现场并报错。
- 适配本地文件系统，不承诺网络文件系统的锁和持久化语义。

## 验证状态

本机 macOS 已执行单元测试与真实 Harness 集成测试，覆盖普通/压缩日志、路由到独立根目录的元数据、缓存备份、旧 JSON 记录保留、清单漂移拒绝、孤立缓存、损坏日志保护、提醒删除和失败回滚。

Windows 盘符/UNC/设备名/占用重试及 POSIX 语义已有自动测试；`.github/workflows/verify.yml` 提供 Windows、Linux、macOS 和 Node 22/24 矩阵。此任务没有远程运行该矩阵，不能将其描述为三平台实机全部验证完成。

## 官方依据

- [存储域与路由](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/storage.md)
- [JSON 存储布局、旧缓存导入](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/storage/storage-json/README.md)
- [会话投影缓存及损坏记录备份](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-projection-cache/README.md)
- [JSONL 日志、历史代次与平台写锁](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md)
- [消息反馈的日志归属及旧 sidecar 限制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/feedback/message-feedback/README.md)
- [共享附件和缓存](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment-local/README.md)

# 开发规范

## 工具链

使用 Node.js ≥ 22.18、pnpm 11.5.0。提交 `pnpm-lock.yaml`，不提交其他包管理器的锁文件。项目级 pnpm 配置集中在 `pnpm-workspace.yaml`，开发依赖固定精确版本。安装依赖使用 `pnpm install --frozen-lockfile`；依赖更新通过 pnpm 完成。

## 目录

- `src/host/`：删除事务、文件保护、恢复日志和宿主接口适配。
- `src/client/`：TSX 界面、RPC 调用、语言资源和原生组件接口。
- `src/shared/`：客户端与宿主共用的请求、结果和错误类型。
- `src/types/`：宿主运行时模块的最小类型声明。
- `test/`：TypeScript 单元测试、隔离宿主集成测试和测试专用接口。
- `scripts/`：TypeScript 构建脚本。
- `dist/`：可直接安装的构建产物，禁止手动编辑。

## 代码

- 使用 TypeScript 严格模式；界面使用 TSX。禁止显式 `any`，外部未知值使用 `unknown` 并收窄。
- 2 空格缩进、LF 换行、单引号、分号、尾逗号；Prettier 目标行宽为 100。
- `.gitattributes` 固定文本检出为 LF，避免 Windows 的 `core.autocrlf` 导致格式检查失败。
- 一行一条语句，变量分别声明，条件和循环必须有花括号。
- 使用 `import type` 引入类型；接口边界、请求及结果必须有类型。内部兼容声明集中在适配层，保持版本限制。
- 按功能拆分文件；副作用和清理放在对应生命周期中。注释说明兼容原因、事务边界和恢复约束。
- UI 直接使用 Harness 原生组件，不添加自定义 CSS。
- 构建产物不压缩，保留声明和 source map，便于定位问题。

## 提交前

```sh
pnpm format
pnpm verify
```

涉及宿主兼容声明、删除、归档或存储逻辑时，再执行普通日志与 Zstandard 集成测试。测试仅使用隔离临时会话，`DSH_RUNTIME` 指向受支持版本（0.2.1-rc.2 / rc.3）运行时中包含 `node_modules` 的目录；rc.3 同时验证宿主版本准入检查：

```sh
DSH_RUNTIME=/absolute/path/to/runtime pnpm test:integration
DSH_RUNTIME=/absolute/path/to/runtime TEST_COMPRESSION=zstd pnpm test:integration
```

## 发布

使用 `pnpm release --dry-run` 校验并检查包内容；正式发布使用 `pnpm release`，每次均要求 npm 浏览器登录并验证身份，然后由 npm 的 `prepack` 执行完整校验与构建。请勿将登录写入 `prepack`，普通打包不应触发认证。发布脚本使用 TypeScript，支持 macOS、Linux 和 Windows 的 npm 启动方式。

`dist/`、`*.tgz`、`*.tsbuildinfo` 和 `coverage/` 由 `.gitignore` 排除；`dist/` 仍是 npm 分发所需内容，由 `package.json.files` 显式包含。

npm 和 GitHub 安装包只包含编译后的 `.js`、`.d.ts`、插件配置、语言资源、图标、README、许可证和清理范围说明及其引用的图片。源码、测试、开发脚本、开发配置和 source map 不进入安装包；source map 仅保留在本地构建目录。发布前用 `pnpm release --dry-run` 检查文件清单。

GitHub Actions 在 Windows、macOS、Linux 的 Node.js 22、24 检查全部通过后，执行 `pnpm pack` 并上传 `dsh-session-delete-local` 构建产物。下载后解压 ZIP，使用其中的 `.tgz` 安装；该流程不发布到 npm。

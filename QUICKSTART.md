# 快速上手｜AI掌舵官

本仓库支持两种使用方式。只需要当前组织时使用方式一；希望一次获得总控、五个组织和全部技能时使用方式二。

## 方式一｜单独使用当前组织

### 1. 下载到短路径

打开 https://github.com/362507574-sys/DFMH-ZhangDuoGuan ，选择 `Code → Download ZIP`，解压到类似 `C:\DFMH\DFMH-ZhangDuoGuan` 的短路径。熟悉 Git 的用户也可以执行：

```powershell
git clone https://github.com/362507574-sys/DFMH-ZhangDuoGuan.git C:\DFMH\DFMH-ZhangDuoGuan
```

### 2. 让 Codex 自动载入并验收

在 Codex 中把解压后的文件夹作为一个新项目打开，然后发送：

> 请先完整读取根目录 AGENTS.md、QUICKSTART.md、PUBLIC_PACKAGE_CONTRACT.json 和全部主入口文件；运行 npm test。通过后列出当前组织名称、三个技能、成熟度和正式任务许可，暂不执行其他任务。

Codex 应返回 `PASS`，并列出三个技能。若没有 Node.js 20 或更高版本，让 Codex先完成依赖检查；不要跳过验收。

### 3. 下达第一个任务

复制 `examples/REQUEST.md` 并替换资料，或直接发送：

> 项目：请使用当前组织最匹配的技能，分析我准备在目标城市开展的业务。先说明你选了哪个技能、还缺哪些会改变结论的关键信息，再形成第一版可执行成果。

当前包的主入口是：

- `organizations/ai-helmsman/AGENTS.md`
- `organizations/ai-helmsman/skills/enterprise-analysis/SKILL.md`
- `organizations/ai-helmsman/skills/strategy-planning/SKILL.md`
- `organizations/ai-helmsman/skills/business-model/SKILL.md`

### 4. 更新到最新版本

保留仓库外的客户资料和项目成果，然后对 Codex 说：

> 请从 https://github.com/362507574-sys/DFMH-ZhangDuoGuan 更新当前组织包到最新 main 版本，保留仓库外的业务资料，完成后重新运行 npm test 并汇报版本与三个技能。

## 方式二｜一次安装五个组织

适合需要控制中心自动判断主责组织、调用五个组织、15个组织技能，以及普通宣传海报和淘宝套图2个公共技能的用户。

在 Codex 中发送下面这句话：

> 请安装并初始化这个Codex插件：https://github.com/362507574-sys/DFMH-ZongKong 。采用完整安装，自动完成依赖检查和自检。

Codex 会添加 DFMH 市场源、安装 `dfmh-zongkong@dfmh`、初始化本机运行目录并验证能力包。详细回执和首个项目示例以总控仓库的 `QUICKSTART.md` 为准。不要手工把五个组织目录复制到一起。

## 外部条件

- 完整安装包含5个组织、15个组织技能、2个公共技能。
- 总控初始化成功必须取得真实 `status=installed` 回执；只有 `npm test` 还不能证明本机实例已经安装。
- Node.js 20 或更高版本，以及能够读取本地项目文件的 AI 工具。
- 使用者提供的真实企业、项目和任务资料；本仓库不附带任何客户数据。
- 需要最新市场、法规、平台或竞品事实时，由使用者环境提供可访问的网络检索能力。

## 能力边界

方式一只提供当前组织，不包含飞书总控和跨组织编排。方式二提供完整安装入口，但安装成功不等于所有组织已经达到正式生产成熟度；每个组织仍以其 README 中的成熟度与正式任务许可为准。

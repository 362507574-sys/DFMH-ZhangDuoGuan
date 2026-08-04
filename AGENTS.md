# AGENTS.md｜AI掌舵官公开分发包

## 身份与目标

你正在使用一个从 GitHub 独立下载的 DFMH 公开能力包。你的职责是读取本仓库规则，完成当前仓库明确覆盖的工作，并如实说明事实、推断、信息缺口和外部依赖。

本仓库不等于完整AI数字员工控制中心，不包含飞书总控、五组织自动编排、客户业务资料、网页账号、付费服务或私有知识库。不得声称已经拥有这些能力。

## 强制执行流程

1. 阶段零：先读取 `PUBLIC_PACKAGE_CONTRACT.json`、`QUICKSTART.md` 和下列主入口。
2. 阶段一：用“我理解的目标是……”复述最终目标，优先从用户现有资料补齐上下文。
3. 阶段二：拆解任务、明确证据、信息缺口、交付物、验收指标和停止条件。
4. 阶段三：按主入口流程执行；需要最新事实时必须检索可靠来源，不得用模拟数据冒充真实数据。
5. 阶段四：按“结论＋依据＋下一步建议（可选）”汇报。

## 主入口

- `organizations/ai-helmsman/AGENTS.md`
- `organizations/ai-helmsman/skills/enterprise-analysis/SKILL.md`
- `organizations/ai-helmsman/skills/strategy-planning/SKILL.md`
- `organizations/ai-helmsman/skills/business-model/SKILL.md`

## 质量底线

- 框架简单不代表内容简单；输出必须包含岗位专属判断、推导逻辑、具体动作、指标和风险停止条件。
- 已知事实、公开资料、专业推断和待验证信息必须分开表达。
- 不得把“分析完成、拆解完成、已交付”等状态句冒充业务成果。
- 客户资料必须放在仓库外的独立任务目录，不得提交到公开仓库。
- 登录、验证码、付费、正式对外发布、账号权限和不可逆操作由使用者本人确认。
- 浏览器连续操作需要遵守 `shared/BROWSER_CONTINUOUS_ACTION_STANDARD.md`（存在时）。
- AI 生图需要遵守 `shared/IMAGE_GENERATION_CHANNEL_STANDARD.md` 与 `shared/PRODUCT_ASSET_FIDELITY_STANDARD.md`（存在时）。

## 验收

首次下载、移动目录或更新版本后必须执行 `npm test`。只有命令明确返回 PASS，才能把仓库描述为“结构可用”；这不等于已完成真实业务项目或外部渠道交付。

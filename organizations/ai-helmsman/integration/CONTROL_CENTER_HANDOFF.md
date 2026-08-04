# 控制中心交接说明

控制中心登记AI掌舵官为`designing`，三个根级技能状态保持`designing`，`acceptsFormalTasks=false`，执行模式为`fallback_existing`。

组织内部企业分析、战略规划和商业模式均已具备本地`pilot`实现，但不能据此把根级组织或技能标记为正式可接单。

跨组织请求使用组织侧协作契约，最大深度为1；根级路由、公共技能登记和飞书生产运行时仍由控制中心维护。

## 项目隔离舱正式发布边界

旧版企业档案、候选和内部试运行资产保留在 `organizations/ai-helmsman/`，不自动搬迁。新业务项目的草稿、候选、执行计划、调试报告和恢复检查点写入当前项目的 `organizations/ai-helmsman/tasks/<taskId>/`。

只有已经通过组织门禁、带有 `approval.decision=approve`，并生成组织侧发布请求的企业分析候选，才允许由控制中心发布到对应业务项目的 `shared-artifacts/enterprise-analysis/`。

发布时固定企业、项目、来源任务、版本、候选 SHA-256 和精确依赖。AI掌舵官不得直接写入项目共享区，也不得把未验收候选交给其他组织。后续修改产生新版本，禁止覆盖历史版本；下游只读取精确 `artifactId@version + SHA-256`。

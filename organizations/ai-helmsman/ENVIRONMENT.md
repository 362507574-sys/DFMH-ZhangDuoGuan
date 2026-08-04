# AI掌舵官运行环境

- 运行时：根项目Node.js ESM；
- 测试：`node:test`；
- 数据：UTF-8无BOM严格JSON；
- 写入：复用根级原子JSON存储；
- 知识：复用根级飞书知识前置，只读；
- 工作区：同项目组织模块，不建立独立`package.json`；
- 一键自检：`node organizations/ai-helmsman/scripts/organization_self_check.mjs`。

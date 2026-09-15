# AGENTS.md

给 agent 看的入口。

这个仓库的完整说明在 `README.md` —— 很长，但里面那些「踩过的坑」段落是**改代码之前
必须先看的**：白板、编辑区、启停脚本、手写识别各有一节，全是"看起来能跑、实际不行"
的类型。别跳。

## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues（`AK47n/studyhelper`）。See `docs/agents/issue-tracker.md`.

### Triage labels

默认的五个标准角色，标签字符串就等于角色名。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文（single-context）：仓库根的 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.

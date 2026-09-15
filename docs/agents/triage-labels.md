# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## 这个仓库里实际建了哪些标签（2026-09-15）

状态映射表只是"角色 → 标签字符串"的对照，**不代表标签已经建出来了**。
`gh` 在标签不存在时会直接失败，所以这里记一下现状：

| 标签 | 仓库里有吗 |
| --- | --- |
| `ready-for-agent` | ✅ **已建**（`#0E8A16`）。`to-spec` / `to-tickets` 生成的结果都标它，这是唯一必需的 |
| `wontfix` | ✅ 有（GitHub 默认标签，含义正好对得上） |
| `needs-triage` | ❌ 没建。`triage` 这个技能暂时没在用（自用仓库，没人提 issue） |
| `needs-info` | ❌ 没建。同上 |
| `ready-for-human` | ❌ 没建。同上 |

要在用 `triage` 之前把缺的补上：

```bash
gh label create needs-triage    --repo AK47n/studyhelper --description "Maintainer needs to evaluate this issue" --color "FBCA04"
gh label create needs-info      --repo AK47n/studyhelper --description "Waiting on reporter for more information" --color "D4C5F9"
gh label create ready-for-human --repo AK47n/studyhelper --description "Requires human implementation" --color "1D76DB"
```


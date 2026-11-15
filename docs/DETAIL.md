# Superagent

Long-horizon autonomous runs: give it one goal and it plans parallel subtasks, runs them in workers, and merges the outcome into one report. A restart does not throw the work away.

## What it solves

- **A goal that does not fit one step.** The goal is planned into dependent subtasks and advanced step by step instead of being crammed into one conversation.
- **Work that runs too slowly in sequence.** Independent subtasks run in parallel, each in its own worktree, without overwriting one another.
- **Runs that get interrupted.** The plan, progress, and produced files are durable; a host restart or a closed conversation does not reset the run.
- **Results that need checking.** Every subtask keeps its status, usage, and cost, and the merged report states failures and gaps instead of hiding them.

## Install

The desktop app's Add plugin dialog accepts any of these three inputs:

1. **Package name**: `@xiangyixie/dsh-superagent@0.14.1`
2. **GitHub repository**: `https://github.com/LittleChenLiya/dsh-superagent`
3. **Local directory**: `file:` followed by the absolute path of the checkout

You can also add the plugin index on the Discover page and install from there:

```
https://raw.githubusercontent.com/LittleChenLiya/dsh-superagent/main/plugin-index.json
```

Upgrading is **remove-then-add**. Any other plugin in the same profile must also be removed before its new version is added; do not expect the dialog to replace it in place.

## When commands are needed

Workers plan and read/write files by default. Enable `commandWorkerPermission` when they must run commands, builds, or tests. Without it the plugin still works, but command steps are refused.

## Safety and cost

- Irreversible actions, uploads, and network destinations are policed, and a run can be stopped.
- Cost is estimated from the configured price table. A model without a price is reported as `unpriced`, never as zero, and currencies are totalled separately rather than added together.

The full commands, configuration, and design notes are in the [README](https://github.com/LittleChenLiya/dsh-superagent#readme).

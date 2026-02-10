# Agent Framework

This directory hosts specialized agents for the 2-Biz app. Each agent gets its own subfolder with:

- `SKILL.md`: the agent's mission, voice, tools, and process
- Optional helper scripts/assets

## Planned Agents

- Motion PA (main orchestrator – lives outside this repo, but this folder references available specialists)
- Design Explorer
- Sales Representative
- Coding Force
- Backend Dev #1 (rapid delivery)
- Backend Dev #2 (production-grade)
- AI Lead
- Frontend Specialist (ShadCN/Tailwind expert)

## Workflow

1. Motion PA triages work.
2. If a specialist is needed, Motion PA spawns the agent (e.g., via `sessions_spawn`) and provides repo context from this project.
3. Agent returns findings/code; Motion PA reviews before merging or communicating back to Niels.


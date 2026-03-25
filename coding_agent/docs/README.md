# Coding Agent Documentation

This directory contains the documentation for the `coding_agent` project. The `coding_agent` is an interactive terminal coding assistant built on top of the ADK-JS library. It offers human-in-the-loop (HITL) style interactions, supports multiple AI models, and provides clean separation between logic, model interactions, and UI rendering (TUI, Web, VSCode).

## Features & Documentation

- [**Core Architecture**](./architecture.md)
  - Modular design, separation of UI and Logic.
- [**Multi-Model Strategy**](./models.md)
  - Parallel execution of Pro models for reasoning and Fast models for summary/compaction.
- [**Operational Modes**](./modes.md)
  - Planning Mode and Coding Mode.
- [**System Tools**](./tools_git_file_sh.md)
  - Git, File system manipulation, Shell command execution.

#!/usr/bin/env bash
# Contextify hook — SessionStart.
# Pipes the Claude Code hook stdin into `contextify hooks session-start`.
# Silent on success, never blocks.
exec contextify hooks session-start

#!/usr/bin/env bash
# Contextify hook — SessionEnd.
# Pipes the Claude Code hook stdin into `contextify hooks session-end`.
# Silent on success, never blocks.
exec contextify hooks session-end

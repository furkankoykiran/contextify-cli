#!/usr/bin/env bash
# Contextify hook — Stop.
# Pipes the Claude Code hook stdin into `contextify hooks stop`.
# Silent on success, never blocks.
exec contextify hooks stop

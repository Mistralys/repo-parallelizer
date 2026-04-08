#!/usr/bin/env bash
# repo-parallelizer — Unix launcher script
# Launches the interactive CLI menu.
# Usage: ./menu.sh [command] [options]
cd "$(dirname "$0")"
node dist/index.js menu "$@"

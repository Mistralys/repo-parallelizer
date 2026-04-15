#!/usr/bin/env bash
# repo-parallelizer — Unix launcher script
# Launches the interactive CLI menu.
# Usage: ./menu.sh [command] [options]
cd "$(dirname "$0")"

# Auto-setup: install dependencies and build if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install || { echo "npm install failed."; exit 1; }
fi

if [ ! -f "dist/index.js" ]; then
    echo "Building project..."
    npm run build || { echo "Build failed."; exit 1; }
fi

node dist/index.js menu "$@"

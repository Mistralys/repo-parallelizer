@echo off
REM repo-parallelizer — Windows launcher script
REM Launches the interactive CLI menu.
REM Usage: menu.cmd [command] [options]
cd /d "%~dp0"

REM Auto-setup: install dependencies and build if needed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        exit /b 1
    )
)

if not exist "dist\index.js" (
    echo Building project...
    call npm run build
    if errorlevel 1 (
        echo Build failed.
        exit /b 1
    )
)

node dist\index.js menu %*

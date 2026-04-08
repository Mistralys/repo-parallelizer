@echo off
REM repo-parallelizer — Windows launcher script
REM Launches the interactive CLI menu.
REM Usage: menu.cmd [command] [options]
cd /d "%~dp0"
node dist\index.js menu %*

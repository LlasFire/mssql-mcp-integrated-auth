@echo off
rem Starts Claude Code. Run this from a session logged in (or /netonly'd,
rem see Start-With-Alternate-Account.cmd) as the account that has SQL
rem Server access, since this MCP server inherits that identity.
cd /d "%USERPROFILE%"
claude

@echo off
rem Use this only if the account you're normally logged in as does NOT
rem have SQL Server access, but a different Windows/AD account does.
rem Edit DOMAIN\username below, then run this file directly (don't run
rem it from inside another shell) so the "runas" password prompt has
rem somewhere to attach.
echo Launching Claude Code under an alternate account's network credentials.
echo Windows will prompt for that account's password next.
runas /netonly /user:DOMAIN\username "cmd.exe /k %~dp0Launch-Claude.cmd"

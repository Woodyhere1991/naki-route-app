@echo off
cd /d "%~dp0"
pwsh.exe -NoProfile -STA -File "%~dp0private-records.ps1" %*

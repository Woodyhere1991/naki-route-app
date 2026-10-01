@echo off
cd /d "%~dp0"
set "NAKI_RECORDS_PWSH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if exist "%NAKI_RECORDS_PWSH%" (
  "%NAKI_RECORDS_PWSH%" -NoProfile -STA -File "%~dp0private-records.ps1" %*
) else (
  pwsh.exe -NoProfile -STA -File "%~dp0private-records.ps1" %*
)

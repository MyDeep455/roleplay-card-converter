@echo off
REM ==========================================================================
REM  Roleplay Card Converter - stop running at Windows login
REM ==========================================================================
REM  Removes the Startup shortcut created by install-autostart.cmd.
REM  The tool itself is untouched - you can still start it by double-clicking
REM  "Start Card Converter.vbs" or by opening the folder in VS Code.
REM ==========================================================================

setlocal

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$startup = [Environment]::GetFolderPath('Startup');" ^
  "$link = Join-Path $startup 'Roleplay Card Converter.lnk';" ^
  "if (Test-Path $link) {" ^
  "  Remove-Item $link -Force;" ^
  "  Write-Host '';" ^
  "  Write-Host '  Removed:' -ForegroundColor Green;" ^
  "  Write-Host ('  ' + $link);" ^
  "  Write-Host '';" ^
  "  Write-Host '  It will no longer start with Windows.';" ^
  "  Write-Host '  Any server already running stays up until you reboot or close it.';" ^
  "} else {" ^
  "  Write-Host '';" ^
  "  Write-Host '  Nothing to remove - autostart was not installed.' -ForegroundColor Yellow;" ^
  "}" ^
  "Write-Host '';"

pause
endlocal

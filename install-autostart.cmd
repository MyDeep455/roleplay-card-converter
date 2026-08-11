@echo off
REM ==========================================================================
REM  Roleplay Card Converter - run at Windows login (optional)
REM ==========================================================================
REM  Puts a shortcut in your Startup folder so the converter's local server
REM  starts with Windows, hidden and silently (no browser tab, no console).
REM
REM  Only touches your own Startup folder - no admin rights, no registry, no
REM  services. Undo it any time with uninstall-autostart.cmd.
REM ==========================================================================

setlocal
set "VBS=%~dp0Start Card Converter.vbs"

if not exist "%VBS%" (
    echo ERROR: "Start Card Converter.vbs" was not found next to this script.
    echo Keep these files together in the tool folder.
    echo.
    pause
    exit /b 1
)

if not exist "%ProgramFiles%\nodejs\node.exe" (
    where node >nul 2>&1
    if errorlevel 1 (
        echo WARNING: Node.js was not found on this machine.
        echo The shortcut will still be created, but nothing will start until
        echo you install Node.js from https://nodejs.org
        echo.
    )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$startup = [Environment]::GetFolderPath('Startup');" ^
  "$link = Join-Path $startup 'Roleplay Card Converter.lnk';" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($link);" ^
  "$s.TargetPath = (Join-Path $env:SystemRoot 'System32\wscript.exe');" ^
  "$s.Arguments = '\"%VBS%\" /silent';" ^
  "$s.WorkingDirectory = '%~dp0'.TrimEnd('\');" ^
  "$s.Description = 'Starts the Roleplay Card Converter local server';" ^
  "$s.WindowStyle = 7;" ^
  "$s.Save();" ^
  "Write-Host '';" ^
  "Write-Host '  Done. Autostart installed:' -ForegroundColor Green;" ^
  "Write-Host ('  ' + $link);" ^
  "Write-Host '';" ^
  "Write-Host '  The server now starts with Windows, silently in the background.';" ^
  "Write-Host '  Open the tool any time at http://127.0.0.1:8787/';" ^
  "Write-Host '';" ^
  "Write-Host '  To undo: run uninstall-autostart.cmd';" ^
  "Write-Host '';"

pause
endlocal

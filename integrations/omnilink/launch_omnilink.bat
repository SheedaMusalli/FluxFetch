@echo off
title OmniLink Launcher
echo ===================================================
echo   OmniLink: Multi-NIC Download Accelerator
echo ===================================================
echo.

:: Check for Administrative Privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator Privileges...
    powershell -Command "Start-Process cmd.exe -ArgumentList '/c \"\"%~dp0launch_omnilink.bat\"\"' -Verb RunAs"
    exit /b
)

:: Terminate any running instances of OmniLink
echo Stopping any running OmniLink instances...
taskkill /F /IM omnilink-tray.exe >nul 2>&1

:: Clean up old binary if present
if exist "%~dp0target\release\omnilink-tray.exe.old" (
    del /f /q "%~dp0target\release\omnilink-tray.exe.old" >nul 2>&1
)

:: Launch the updated release binary
echo Starting OmniLink background tray engine...
start "" "%~dp0target\release\omnilink-tray.exe"

echo.
echo ===================================================
echo   OmniLink is now active and running!
echo   - Desktop HUD Overlay is displayed on screen
echo   - Tray icon is in 'Show Hidden Icons' (^)
echo ===================================================
echo.
timeout /t 3 >nul
exit

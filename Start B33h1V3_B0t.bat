@echo off
title B33h1V3_B0t
cd /d "%~dp0"

REM ============================================================
REM   B33h1V3_B0t  -  double-click this file to run the bot.
REM
REM   Opens the control window. Click "Start Bot" to begin and
REM   "Stop Bot" to stop (it safely returns all SOL to your main
REM   wallet before stopping). "Recover Funds" cleans up if a run
REM   was ever interrupted.
REM ============================================================

echo.
echo   Starting B33h1V3_B0t...
echo.

REM Node.js runs the bot itself.
where node >nul 2>nul
if not %errorlevel%==0 (
    echo   ERROR: Node.js was not found.
    echo   Install the LTS version from https://nodejs.org/  then double-click this file again.
    echo.
    pause
    goto :eof
)

REM First run: install the bot's packages (exact versions from package-lock.json).
if not exist "node_modules\" (
    echo   First run: installing packages, this takes a minute...
    call npm ci --no-audit --no-fund
    if not %errorlevel%==0 (
        echo   npm ci failed, trying npm install...
        call npm install --no-audit --no-fund
    )
    echo.
)

REM Prefer "python", fall back to the "py" launcher.
where python >nul 2>nul
if %errorlevel%==0 (
    python gui.py
    goto :done
)
where py >nul 2>nul
if %errorlevel%==0 (
    py gui.py
    goto :done
)

echo   ERROR: Python was not found.
echo   Install Python 3 from https://www.python.org/  (check "Add python.exe to PATH")
echo   then double-click this file again.
echo.
pause
goto :eof

:done
if %errorlevel% neq 0 (
    echo.
    echo   B33h1V3_B0t closed with an error - see the messages above.
    pause
)

@echo off
curl -s -X POST http://localhost:8000/start >nul
echo Aparat Stream Started ..
timeout /t 2 >nul

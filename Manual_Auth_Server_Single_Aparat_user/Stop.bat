@echo off
curl -s -X POST http://localhost:8000/stop >nul
echo Aparat Stream Stoped ..
timeout /t 2 >nul

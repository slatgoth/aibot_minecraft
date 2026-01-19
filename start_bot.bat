@echo off
echo Starting Minecraft LLM Bot...
echo 1) Start Ollama: ollama serve
echo 2) Start ViaProxy if your server is newer than 1.21.4
echo    Edit tools\\viaproxy\\viaproxy.yml (target-address, bind-address)
echo.
cd /d "%~dp0"
node src/index.js
pause

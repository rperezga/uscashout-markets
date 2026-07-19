@echo off
:: Corre los tests y deja el resultado en docs\test-output.txt (para revisarlo sin consola)
cd /d %~dp0
echo ===== node --version ===== > docs\test-output.txt
node --version >> docs\test-output.txt 2>&1
echo ===== motor de BD disponible ===== >> docs\test-output.txt
node --experimental-sqlite -e "try{require('node:sqlite');console.log('node:sqlite disponible (con flag)')}catch(e){console.log('node:sqlite NO disponible con flag')}" >> docs\test-output.txt 2>&1
node -e "try{require('node:sqlite');console.log('node:sqlite disponible SIN flag')}catch(e){console.log('node:sqlite NO disponible sin flag -> fallback JSON si el flag tampoco funciona')}" >> docs\test-output.txt 2>&1
echo ===== npm test ===== >> docs\test-output.txt
call npm test >> docs\test-output.txt 2>&1
exit

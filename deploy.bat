@echo off
cd /d "D:\Projects\Claude Projects\Personal Finance Tracker"

echo === Deploying Cloud Function ===
call npx firebase deploy --only functions > deploy_log.txt 2>&1
echo --- >> deploy_log.txt
echo Deploy finished at %date% %time% >> deploy_log.txt
type deploy_log.txt
pause

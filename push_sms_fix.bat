@echo off
cd /d "D:\Projects\Claude Projects\Personal Finance Tracker"

if exist .git\index.lock del .git\index.lock

echo === Committing SMS BroadcastReceiver fix ===
git add -A
git status
git commit -m "Add SMS BroadcastReceiver — bypasses Truecaller & sensitive notification redaction"
echo === Pushing to GitHub ===
git push
echo === Done ===
pause

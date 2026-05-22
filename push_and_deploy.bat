@echo off
cd /d "D:\Projects\Claude Projects\Personal Finance Tracker"

if exist .git\index.lock del .git\index.lock

echo === Committing all fixes ===
git add -A
git status
git commit -m "Fix: dismiss persistent, show-more phantom, CUB SIP dedup, triggering txn saved, dismissed accounts blocklist"
echo === Pushing to GitHub ===
git push
echo === Deploying Cloud Function ===
call npx firebase deploy --only functions > deploy_log.txt 2>&1
type deploy_log.txt
echo === All done ===
pause

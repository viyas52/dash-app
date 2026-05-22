@echo off
cd /d "D:\Projects\Claude Projects\Personal Finance Tracker"

if exist .git\index.lock del .git\index.lock

echo === Committing all fixes ===
git add -A
git status
git commit -m "UX batch: dismiss persist, show-more fix, CUB SIP dedup, triggering txn, dismissed blocklist, dwell auto-select, FAB home-only, heatmap/chart timezone fix, reimbursement net, uncat date labels"
echo === Pushing to GitHub ===
git push
echo === Deploying Cloud Function ===
call npx firebase deploy --only functions > deploy_log.txt 2>&1
type deploy_log.txt
echo === All done ===
pause

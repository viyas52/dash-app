@echo off
cd /d "D:\Projects\Claude Projects\Personal Finance Tracker"

echo === Removing old .git if broken ===
rmdir /s /q .git 2>nul

echo === Initializing git ===
git init -b main

echo === Creating GitHub repo (private) ===
gh repo create dash-app --private --source=. --remote=origin

echo === Initial commit ===
git add -A
git commit -m "v1.0: Personal finance tracker — dashboard, dual pie charts, categorization queue"

echo === Pushing ===
git push -u origin main > push_log.txt 2>&1
echo --- >> push_log.txt
git log --oneline -3 >> push_log.txt 2>&1

echo === Done! Check push_log.txt ===
type push_log.txt
pause

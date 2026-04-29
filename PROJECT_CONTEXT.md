# Personal Finance Tracker — Project Context

**Owner:** Veda Viyas P (Viyas)
**Created:** 2026-04-29
**Status:** Planning phase — architecture drafted, no code yet

---

## The Idea

A personal finance tracker that auto-captures UPI transactions from bank SMSes instead of manual entry. Built to replace Viyas's current workflow of manually copying transactions from GPay history into the Money Manager app.

### Core Flow
1. Bank SMS arrives after a UPI transaction
2. App parses it automatically (amount, date, merchant/recipient)
3. User gets a notification → one-tap category assignment
4. Dashboard shows spending vs investments with separate pie charts

---

## Key Decisions Made

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Scope | Personal tool first, product later | Build for self, validate, then consider scaling |
| Bank | ICICI (account XX472) | Primary salary account |
| SMS format | Regex-parseable, consistent | No AI needed for parsing |
| Framework Phase 1 | Tasker + Firebase + PWA | Quick prototype, no mobile dev needed |
| Framework Phase 2 | React Native | Viyas knows JS, lowest learning curve |
| Frontend | New separate PWA | Don't touch the Home Expense Tracker (that's for Amma) |
| Tracking | Income + Expenses + Investments | Full financial picture, not just expenses |

---

## SMS Formats (ICICI)

### Credit (salary, refunds)
```
ICICI Bank Account XX472 credited:Rs. 51,764.00 on 28-Apr-26. Info NEFT-HDFCH00958770854-BA CON. Available Balance is Rs. 1,28,055.18.
```
**Fields:** amount, date, source (Info field), available balance

### Debit (UPI)
```
ICICI Bank Acct XX472 debited for Rs 260.00 on 26-Apr-26; MR KATHIRAVAN R credited. UPI:648210939989. Call 18002662 for dispute. SMS BLOCK 472 to 9215676766.
```
**Fields:** amount, date, recipient name, UPI reference

---

## Categories

### Spending Categories
| Category | Emoji | Examples |
|----------|-------|----------|
| Food | 🍔 | Swiggy, Zomato, restaurants, Wow China |
| Bill | 📱 | Phone recharge, electricity, subscriptions |
| Transport | 🚗 | Fuel, Ola/Uber, metro |
| Health | 🏥 | Pharmacy, doctor visits |
| Apparel | 👕 | Clothing, shoes |
| Hair Cut | 💇 | Salon, grooming |
| Culture | 🎬 | Movies, entertainment, books |
| Household | 🏠 | Home supplies |
| Gaming | 🎮 | Games, in-app purchases |
| Gift | 🎁 | Gifts to friends/family |
| Miscellaneous | 📦 | Uncategorized |

### Investment Categories
| Category | Emoji | Examples |
|----------|-------|----------|
| Mutual Fund | 📈 | SIP, lump sum MF purchases |
| PPF | 🏛️ | Modi scheme / Public Provident Fund |
| SIP Transfer | 🔄 | Self transfers to HDFC, CUB for SIP |
| Fixed Deposit | 🏦 | FD, RD |
| Stocks | 📊 | Direct equity (if any) |

### Income Categories
| Category | Emoji | Examples |
|----------|-------|----------|
| Salary | 💰 | Bank of America monthly (~₹51k typical) |
| Refund | ↩️ | Returns, cashbacks |
| Other Income | 💵 | Freelance, interest, etc. |

---

## Monthly Financial Profile (Viyas)

- **Typical salary:** ~₹51,764/month from Bank of America (NEFT credit)
- **Investments:** SIP transfers (₹2k + ₹5k), Mutual Fund (₹7k), PPF (₹7.5k) = ~₹21.5k/month
- **Actual spending:** ~₹15-22k/month across food, bills, transport, etc.
- **Net savings pattern:** Investments are ~40% of income, spending ~35-45%

---

## Architecture

### Phase 1 — Tasker Prototype (No Mobile Dev)

```
[Bank SMS] → [Tasker on Android]
                  ↓
            [HTTP POST to Firebase Cloud Function]
                  ↓
            [Firebase Firestore: transactions collection]
                  ↓
            [PWA Dashboard — categorize + visualize]
```

**Components:**
1. **Tasker automation** — Intercepts SMSes from ICICI (sender filter), extracts text, sends HTTP POST to a webhook
2. **Firebase Cloud Function (or direct Firestore write)** — Receives SMS text, runs regex parser, stores parsed transaction
3. **PWA frontend** — Dashboard with:
   - Uncategorized transactions queue (swipe/tap to categorize)
   - Two pie charts: Spending breakdown + Investment breakdown
   - Top summary cards: Income | Expenses | Investments | Net Savings
   - Monthly history with download/print
   - Dark mode

### Phase 2 — React Native App

- Native SMS reading (no Tasker dependency)
- Push notifications on each transaction for quick categorization
- Background SMS listener service
- Same Firebase backend + PWA dashboard (or embed in-app)
- Offline support + local SQLite cache

---

## Firebase Schema

### Collection: `transactions`
```json
{
  "id": "auto",
  "raw_sms": "ICICI Bank Acct XX472 debited for Rs 260.00...",
  "amount": 260.00,
  "date": "2026-04-26",
  "type": "debit",           // "debit" | "credit"
  "category": "Food",        // null until user categorizes
  "category_type": "spending", // "spending" | "investment" | "income"
  "recipient": "MR KATHIRAVAN R",
  "upi_ref": "648210939989",
  "source": "",              // for credits: NEFT info, etc.
  "balance_after": null,     // if available in SMS
  "categorized": false,
  "created_at": "2026-04-26T14:30:00Z"
}
```

### Collection: `settings`
```json
{
  "monthly_budget": 25000,
  "investment_target": 22000,
  "bank_filter": "ICICI",
  "account_suffix": "472"
}
```

---

## Regex Patterns for ICICI SMS

### Debit
```regex
ICICI Bank Acct XX\d+ debited for Rs ([\d,]+\.?\d*) on (\d{2}-\w{3}-\d{2}); (.+?) credited\. UPI:(\d+)
```
**Captures:** amount, date, recipient, UPI ref

### Credit
```regex
ICICI Bank Account XX\d+ credited:Rs\. ([\d,]+\.\d{2}) on (\d{2}-\w{3}-\d{2})\. Info (.+?)\. Available Balance is Rs\. ([\d,]+\.\d{2})
```
**Captures:** amount, date, info/source, balance

---

## Dashboard Layout (PWA)

```
┌─────────────────────────────────┐
│  Header: "My Finance"    [☰]   │
├─────────────────────────────────┤
│  ◄ April 2026 ►                │
├─────────────────────────────────┤
│  💰 Income    💸 Spent          │
│  ₹51,764     ₹15,420           │
│                                 │
│  📈 Invested  💵 Net Saved      │
│  ₹21,500     ₹14,844           │
├─────────────────────────────────┤
│  ▓▓▓▓▓▓▓▓░░░ 70% budget used  │
├─────────────────────────────────┤
│  [Spending Breakdown 🍕]       │
│      (pie chart)                │
│  Food 35% | Bill 20% | ...     │
├─────────────────────────────────┤
│  [Investment Split 📈]         │
│      (pie chart)                │
│  MF 33% | SIP 33% | PPF 34%   │
├─────────────────────────────────┤
│  ⚡ Uncategorized (3)           │
│  ┌─ ₹260 → Kathiravan R [tap] │
│  ┌─ ₹68  → Vignesh Raja [tap] │
│  ┌─ ₹337 → Wow China    [tap] │
├─────────────────────────────────┤
│  Recent Transactions            │
│  ... (list with categories)     │
├─────────────────────────────────┤
│                          [+]   │
└─────────────────────────────────┘
```

---

## Tech Stack

| Layer | Tech | Notes |
|-------|------|-------|
| SMS Capture (Phase 1) | Tasker | Android automation, filter ICICI sender |
| SMS Capture (Phase 2) | React Native + react-native-get-sms-android | Native SMS permission |
| Backend | Firebase Firestore | Same stack as Home Expense Tracker |
| Auth | Firebase Auth (optional) | Single user for now |
| Frontend | Vanilla JS PWA | Same approach as Home Expense Tracker |
| Hosting | GitHub Pages | Free, same as current setup |
| Charts | Chart.js | Already familiar with it |

---

## Roadmap

### Phase 1 — Tasker Prototype (Target: 2-3 weekends)
- [ ] Set up new Firebase project (or reuse existing, separate collection)
- [ ] Build Tasker profile: intercept ICICI SMS → HTTP POST
- [ ] Build SMS regex parser (Cloud Function or client-side)
- [ ] Build PWA: dashboard with 4 metric cards
- [ ] Build PWA: uncategorized transaction queue with one-tap categorize
- [ ] Build PWA: two pie charts (spending + investments)
- [ ] Build PWA: transaction history list
- [ ] Build PWA: monthly history in menu panel
- [ ] Deploy to GitHub Pages
- [ ] Test with live SMS data for 1 week

### Phase 2 — React Native App (Later)
- [ ] Set up React Native project
- [ ] Implement SMS reader with permissions
- [ ] Background SMS listener service
- [ ] Push notifications for categorization
- [ ] In-app dashboard (or webview to PWA)
- [ ] Auto-categorization based on merchant name patterns
- [ ] Export and analytics features

---

## Related Projects
- **Home Expense Tracker** — `D:\Projects\Claude Projects\Household Expense Tracker\` (for Amma, DO NOT TOUCH)
- Uses same Firebase project: `home-expense-tracker-8a5c9`
- Same GitHub account: `viyas52`

---

## Open Items
- Decide: reuse existing Firebase project with a new collection, or create a separate Firebase project?
- Tasker setup: need to test HTTP POST from Tasker to Firebase
- Consider auto-categorization rules: "Swiggy" → Food, "Jio" → Bill, etc.
- Design the notification UX for Phase 2

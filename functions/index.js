const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();
const adminAuth = getAuth();

// ── Date helpers ──
const MONTHS = {
  Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
  Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12",
  JAN:"01", FEB:"02", MAR:"03", APR:"04", MAY:"05", JUN:"06",
  JUL:"07", AUG:"08", SEP:"09", OCT:"10", NOV:"11", DEC:"12",
};

function parseDateAlpha(raw) {
  const [day, mon, yr] = raw.split("-");
  return `20${yr}-${MONTHS[mon] || "01"}-${day.padStart(2, "0")}`;
}
function parseDateAlphaLong(raw) {
  const [day, mon, yr] = raw.split("-");
  return `${yr}-${MONTHS[mon]}-${day.padStart(2, "0")}`;
}
function parseDateNum(raw) {
  const [day, mon, yr] = raw.split("-");
  return `20${yr}-${mon}-${day}`;
}
function parseDateSlash(raw) {
  const [day, mon, yr] = raw.split("/");
  return `20${yr}-${mon}-${day.padStart(2,"0")}`;
}
function parseDateNumLong(raw) {
  const [day, mon, yr] = raw.split("-");
  return `${yr}-${mon}-${day}`;
}
function todayDate() {
  return new Date().toISOString().split("T")[0];
}

// ── Recipient cleanup for noisy NACH-style strings ──
function cleanRecipient(raw) {
  if (!raw) return raw;
  const cubMatch = raw.match(/BD-([^/]+)/);
  if (cubMatch) return cubMatch[1].trim();
  return raw;
}

// ── Strip UPI ID domain: "baalambigai@okicici" → "baalambigai" ──
function cleanUpiId(raw) {
  if (!raw) return raw;
  const at = raw.indexOf("@");
  if (at > 0) return raw.substring(0, at).trim();
  return raw.trim();
}

// ── Account number → bank id (dynamic, per-user) ──
function acctToBankDynamic(acct, acctBankMap) {
  if (!acct || !acctBankMap) return null;
  for (const [last4, bank] of Object.entries(acctBankMap)) {
    if (acct.endsWith(last4) || last4.endsWith(acct)) return bank;
  }
  return null;
}

// ── SMS Pattern Table ──
// acctToBank is passed as a param now (per-user)
function buildPatterns(acctToBank) {
  return [
    // ── ICICI debit (UPI) ── (forgiving whitespace + optional period after "credited")
    {
      name: "icici_debit_upi",
      rx: /ICICI Bank Acct XX(\d+)\s+debited\s+for\s+Rs\.?\s*([\d,]+\.?\d*)\s+on\s+(\d{1,2}-\w{3}-\d{2})[;,]\s*(.+?)\s+credited\.?\s+UPI:?\s*(\d+)/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "icici", account: m[1],
        amount: parseFloat(m[2].replace(/,/g, "")),
        date: parseDateAlpha(m[3]),
        type: "debit", category: null, category_type: null,
        recipient: m[4].trim(), note: m[4].trim(), upi_ref: m[5],
        source: "", source_account: "", balance_after: null,
        created_at: new Date().toISOString(),
        dedup_key: "icici_d_" + m[5],
      }),
    },
    // ── ICICI credit (NEFT-style) ──
    {
      name: "icici_credit_neft",
      rx: /ICICI Bank Account XX(\d+) credited:Rs\. ([\d,]+\.\d{2}) on (\d{2}-\w{3}-\d{2})\. Info (.+?)\. Available Balance is Rs\. ([\d,]+\.\d{2})/,
      parse: (m, sms) => {
        const amt = parseFloat(m[2].replace(/,/g, ""));
        const dt = parseDateAlpha(m[3]);
        const bal = parseFloat(m[5].replace(/,/g, ""));
        return {
          raw_sms: sms, bank: "icici", account: m[1],
          amount: amt, date: dt,
          type: "credit", category: null, category_type: null,
          recipient: "", source: m[4], source_account: "",
          note: m[4], upi_ref: "", balance_after: bal,
          created_at: new Date().toISOString(),
          dedup_key: "icici_cn_" + dt + "_" + amt + "_" + bal,
        };
      },
    },
    // ── ICICI credit (UPI) ──
    {
      name: "icici_credit_upi",
      rx: /Dear Customer, Acct XX(\d+) is credited with Rs\.?\s*([\d,]+\.?\d*) on (\d{2}-\w{3}-\d{2}) from (.+?)\. UPI:(\d+)/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "icici", account: m[1],
        amount: parseFloat(m[2].replace(/,/g, "")),
        date: parseDateAlpha(m[3]),
        type: "credit", category: null, category_type: null,
        recipient: "", source: cleanUpiId(m[4].trim()), source_account: "",
        note: cleanUpiId(m[4].trim()), upi_ref: m[5], balance_after: null,
        created_at: new Date().toISOString(),
        dedup_key: "icici_cu_" + m[5],
      }),
    },
    // ── HDFC credit ──
    {
      name: "hdfc_credit",
      rx: /Credit Alert[\s\S]*?Rs\.?\s*([\d,]+\.?\d*) credited to HDFC Bank A\/c XX(\d+) on (\d{2}-\d{2}-\d{2}) from (?:VPA )?(.+?) \(UPI (?:Ref )?(\d+)\)/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "hdfc", account: m[2],
        amount: parseFloat(m[1].replace(/,/g, "")),
        date: parseDateNum(m[3]),
        type: "credit", category: null, category_type: null,
        recipient: "", source: cleanUpiId(m[4].trim()), source_account: "",
        note: cleanUpiId(m[4].trim()), upi_ref: m[5], balance_after: null,
        created_at: new Date().toISOString(),
        dedup_key: "hdfc_c_" + m[5],
      }),
    },
    // ── HDFC debit (PAYMENT ALERT — NACH/UMRN) ──
    {
      name: "hdfc_debit_nach",
      rx: /PAYMENT ALERT[\s\S]*?INR\s*([\d,]+\.?\d*) deducted from HDFC Bank A\/C No\.?\s*(\d+) towards (.+?) UMRN:\s*([A-Z0-9]+)/i,
      parse: (m, sms) => {
        const dt = todayDate();
        const amt = parseFloat(m[1].replace(/,/g, ""));
        const umrn = m[4];
        return {
          raw_sms: sms, bank: "hdfc", account: m[2],
          amount: amt, date: dt,
          type: "debit", category: null, category_type: null,
          recipient: m[3].trim(), source: "", source_account: "",
          note: m[3].trim(), upi_ref: "", umrn, balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "hdfc_d_" + umrn + "_" + dt + "_" + amt,
        };
      },
    },
    // ── CUB credit ──
    {
      name: "cub_credit",
      rx: /Your a\/c no\. X+(\d+) is credited for Rs\.?\s*([\d,]+\.?\d*) on (\d{2}-\d{2}-\d{4}) and debited from a\/c no\. X+(\d+) \(UPI Ref no (\d+)\)\s*-CUB/i,
      parse: (m, sms) => {
        const sourceAcct = m[4];
        return {
          raw_sms: sms, bank: "cub", account: m[1],
          amount: parseFloat(m[2].replace(/,/g, "")),
          date: parseDateNumLong(m[3]),
          type: "credit", category: null, category_type: null,
          recipient: "", source: "From XX" + sourceAcct.slice(-4),
          source_account: sourceAcct,
          bank_from: acctToBank(sourceAcct) || null,
          note: "From XX" + sourceAcct.slice(-4),
          upi_ref: m[5], balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "cub_c_" + m[5],
        };
      },
    },
    // ── CUB debit (NACH/auto-debit) ──
    {
      name: "cub_debit",
      rx: /Savings No X+(\d+) debited with INR\s*([\d,]+\.?\d*) towards (.+?) on (\d{2}-\w{3}-\d{4})/i,
      parse: (m, sms) => {
        const recipientRaw = m[3].trim();
        const cleaned = cleanRecipient(recipientRaw);
        const dt = parseDateAlphaLong(m[4]);
        const amt = parseFloat(m[2].replace(/,/g, ""));
        const achMatch = recipientRaw.match(/ACH_DR::(\d+)/);
        const ciubMatch = recipientRaw.match(/CIUB(\d+)/);
        const refTag = achMatch ? achMatch[1]
                     : ciubMatch ? ciubMatch[1]
                     : (dt + "_" + amt + "_" + cleaned.slice(0, 20).replace(/\W/g, ""));
        return {
          raw_sms: sms, bank: "cub", account: m[1],
          amount: amt, date: dt,
          type: "debit", category: null, category_type: null,
          recipient: cleaned, source: "", source_account: "",
          note: cleaned, upi_ref: "", balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "cub_d_" + refTag,
        };
      },
    },
    // ── CUB debit (UPI — to another account) ──
    {
      name: "cub_debit_upi",
      rx: /Your a\/c no\. X+(\d+) is debited for Rs\.?\s*([\d,]+\.?\d*) on (\d{2}-\d{2}-\d{4}) and credited to a\/c no\. X+(\d+) \(UPI Ref no (\d+)\)/i,
      parse: (m, sms) => {
        const destAcct = m[4];
        return {
          raw_sms: sms, bank: "cub", account: m[1],
          amount: parseFloat(m[2].replace(/,/g, "")),
          date: parseDateNumLong(m[3]),
          type: "debit", category: null, category_type: null,
          recipient: "To XX" + destAcct.slice(-4),
          source: "", source_account: destAcct,
          bank_to: acctToBank(destAcct) || null,
          note: "To XX" + destAcct.slice(-4),
          upi_ref: m[5], balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "cub_du_" + m[5],
        };
      },
    },
    // ── HDFC debit (UPI — multiline) ──
    {
      name: "hdfc_debit_upi",
      rx: /Sent Rs\.?\s*([\d,]+\.?\d*)[\s\S]*?From HDFC Bank A\/C \*(\d+)[\s\S]*?To (.+?)\s*On (\d{2}\/\d{2}\/\d{2})\s*Ref (\d+)/i,
      parse: (m, sms) => ({
        raw_sms: sms, bank: "hdfc", account: m[2],
        amount: parseFloat(m[1].replace(/,/g, "")),
        date: parseDateSlash(m[4]),
        type: "debit", category: null, category_type: null,
        recipient: m[3].trim(), source: "", source_account: "",
        note: m[3].trim(), upi_ref: m[5], balance_after: null,
        created_at: new Date().toISOString(),
        dedup_key: "hdfc_du_" + m[5],
      }),
    },
    // ── HDFC debit (IMPS — to an account number, not UPI) ──
    // Example:
    //   IMPS INR 3,000.00
    //   sent from HDFC Bank A/c XX6829 on 13-05-26
    //   To A/c xxxxxxxxxx9367
    //   Ref-613326278727
    {
      name: "hdfc_debit_imps",
      rx: /IMPS\s*INR\s*([\d,]+\.?\d*)[\s\S]*?from\s*HDFC\s*Bank\s*A\/c\s*XX(\d+)\s*on\s*(\d{2}-\d{2}-\d{2})[\s\S]*?To\s*A\/c\s*[xX]+(\d+)[\s\S]*?Ref-?(\d+)/i,
      parse: (m, sms) => {
        const destAcct = m[4];
        return {
          raw_sms: sms, bank: "hdfc", account: m[2],
          amount: parseFloat(m[1].replace(/,/g, "")),
          date: parseDateNum(m[3]),
          type: "debit", category: null, category_type: null,
          recipient: "To XX" + destAcct.slice(-4),
          source: "", source_account: destAcct,
          bank_to: acctToBank(destAcct) || null,
          note: "IMPS to XX" + destAcct.slice(-4),
          upi_ref: m[5], balance_after: null,
          created_at: new Date().toISOString(),
          dedup_key: "hdfc_di_" + m[5],
        };
      },
    },
  ];
}

function parseSms(sms, acctToBank) {
  const patterns = buildPatterns(acctToBank);
  for (const p of patterns) {
    const m = sms.match(p.rx);
    if (m) return p.parse(m, sms);
  }
  return null;
}

// ── Self-transfer detection (dynamic, per-user) ──
function matchesSelfAccount(num, selfAccounts) {
  if (!num || !selfAccounts) return false;
  return selfAccounts.some(a => num.endsWith(a) || a.endsWith(num));
}
function isSelfTransfer(parsed, selfNamesRx, selfAccounts) {
  if (selfNamesRx) {
    if (parsed.recipient && selfNamesRx.test(parsed.recipient)) return true;
    if (parsed.source && selfNamesRx.test(parsed.source)) return true;
  }
  if (parsed.source_account && matchesSelfAccount(parsed.source_account, selfAccounts)) return true;
  return false;
}

// ── SIP / investment auto-tag patterns ──
const SIP_PATTERNS = [
  { match: /SBI\s*FUNDS|SBI\s*MUTUAL|SBI\s*MF/i, category: "Mutual Fund" },
  { match: /TATA\s*MF|TATA\s*MUTUAL|TATA\s*ASSET/i, category: "Mutual Fund" },
  { match: /HDFC\s*AMC|HDFC\s*MUTUAL/i, category: "Mutual Fund" },
  { match: /ICICI\s*PRU|ICICI\s*MUTUAL/i, category: "Mutual Fund" },
  { match: /AXIS\s*MF|AXIS\s*MUTUAL/i, category: "Mutual Fund" },
  { match: /KOTAK\s*MF|KOTAK\s*MUTUAL/i, category: "Mutual Fund" },
  { match: /MIRAE\s*ASSET|NIPPON\s*INDIA\s*MF|UTI\s*MF/i, category: "Mutual Fund" },
  { match: /MUTUAL\s*FUND|FUNDS\s*MANAGEMENT|AMC\s*LIMITED/i, category: "Mutual Fund" },
  { match: /\bPPF\b|PUBLIC\s*PROVIDENT/i, category: "PPF" },
  { match: /NACH_DR|ACH_DR|ECS_DR|UMRN/i, category: "Mutual Fund" },
];
function detectSip(parsed) {
  if (parsed.type !== "debit") return null;
  const text = (parsed.recipient || "") + " " + (parsed.note || "") + " " + (parsed.umrn || "");
  for (const p of SIP_PATTERNS) {
    if (p.match.test(text)) return { category: p.category, category_type: "investment" };
  }
  return null;
}

// ── Built-in regex rules ──
const BUILTIN_RULES = [
  { type: "credit", match: /BA CON|BANK\s*OF\s*AMERICA/i, category: "Salary", category_type: "income" },
];

function normalizeKey(s) {
  return (s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ── Load per-user config from Firestore ──
async function loadUserConfig(userId) {
  const [acctSnap, selfSnap, profileSnap] = await Promise.all([
    db.doc(`users/${userId}/config/accounts`).get(),
    db.doc(`users/${userId}/config/self_transfer`).get(),
    db.doc(`users/${userId}/config/profile`).get(),
  ]);

  const acctData = acctSnap.exists ? acctSnap.data() : {};
  const selfData = selfSnap.exists ? selfSnap.data() : {};
  const profileData = profileSnap.exists ? profileSnap.data() : {};

  const acctBankMap = acctData.acct_bank || {};
  const linkedAccounts = acctData.linked_accounts || [];
  const selfNamesRx = selfData.names_regex ? new RegExp(selfData.names_regex, "i") : null;
  const selfAccounts = selfData.accounts || [];
  const apiKey = profileData.api_key || null;

  return { acctBankMap, linkedAccounts, selfNamesRx, selfAccounts, apiKey };
}

// ── Coarse per-user rate limit (best-effort abuse cap). ──
// Stopgap until Firebase App Check + Play Integrity is wired up. Trailing
// 60s window, max 60 ingest calls/min per user. Fails open if the limiter
// itself errors, so a limiter glitch never blocks legitimate ingestion.
async function checkRateLimit(userId) {
  const rlRef = db.doc(`users/${userId}/config/_rl`);
  const now = Date.now();
  const WINDOW_MS = 60000;
  const MAX = 60;
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(rlRef);
      const data = snap.exists ? snap.data() : {};
      let windowStart = data.windowStart || 0;
      let count = data.count || 0;
      if (now - windowStart >= WINDOW_MS) {
        windowStart = now;
        count = 0;
      }
      count += 1;
      tx.set(rlRef, { windowStart, count }, { merge: true });
      return count <= MAX;
    });
  } catch (_) {
    return true;
  }
}

// ── HTTPS Cloud Function ──
exports.parseSms = onRequest({ cors: ["https://viyas52.github.io"], region: "asia-south1" }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // ── User ID (required for multi-user routing) ──
  const userId = req.body.user || req.body.userId || req.query.user;
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Missing user" });
  }
  const effectiveUser = userId;

  // ── Load per-user config ──
  let userConfig;
  try {
    userConfig = await loadUserConfig(effectiveUser);
  } catch (err) {
    console.error("Failed to load user config:", err);
    return res.status(500).json({ error: "Failed to load user config" });
  }

  // ── API key validation (header only — never via query string) ──
  if (!userConfig.apiKey) return res.status(401).json({ error: "User not provisioned" });
  const key = req.headers["x-api-key"];
  if (key !== userConfig.apiKey) return res.status(401).json({ error: "Invalid API key" });

  // ── Coarse per-user rate limit ──
  if (!(await checkRateLimit(effectiveUser))) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  const sms = req.body.sms || req.body.message || "";
  if (!sms || typeof sms !== "string") return res.status(400).json({ error: "No SMS text provided" });
  if (sms.length > 2048) return res.status(413).json({ error: "SMS too large" });

  // ── Parse SMS with per-user account mapping ──
  const acctToBank = (acct) => acctToBankDynamic(acct, userConfig.acctBankMap);
  const parsed = parseSms(sms, acctToBank);
  if (!parsed) {
    // Privacy: don't persist the unrecognised SMS — just log a short
    // prefix server-side for debugging and return.
    console.warn("SMS not recognized:", sms.substring(0, 120));
    return res.status(200).json({ status: "skipped", reason: "SMS format not recognized" });
  }

  // ── Filter by linked accounts ──
  // If the user has added any Linked Accounts in Settings, only process SMS
  // that match one of those accounts. This way a user can opt in to tracking
  // just specific accounts (e.g. only HDFC, ignore the other banks they get
  // SMS from). If no accounts are linked yet, accept all parsed SMS.
  if (userConfig.linkedAccounts && userConfig.linkedAccounts.length > 0 && parsed.account) {
    const parsedDigits = String(parsed.account).replace(/\D/g, "");
    const parsedTail = parsedDigits.slice(-4);
    const matches = userConfig.linkedAccounts.some(la => {
      if (!la || !la.last4) return false;
      const linkedTail = String(la.last4).replace(/\D/g, "").slice(-4);
      if (!linkedTail || !parsedTail) return false;
      return parsedTail === linkedTail
          || parsedTail.endsWith(linkedTail)
          || linkedTail.endsWith(parsedTail);
    });
    if (!matches) {
      // Save the rejected SMS as a one-tap-link suggestion so the PWA can
      // pop a banner: "ICICI ••489 detected — Tap to link". Deduped by
      // bank+last4 so multiple SMS for the same unlinked account merge.
      try {
        const sugHash = crypto.createHash("sha1")
          .update((parsed.bank || "?") + ":" + parsedTail)
          .digest("hex").substring(0, 16);
        await db.collection(`users/${effectiveUser}/suggested_accounts`).doc(sugHash).set({
          bank: parsed.bank || "?",
          last4: parsedTail,
          first_seen: new Date().toISOString(),
          sample_amount: parsed.amount || 0,
          sample_recipient: parsed.recipient || parsed.source || "",
        }, { merge: true });
      } catch (_) { /* non-critical */ }
      return res.status(200).json({
        status: "skipped",
        reason: "account_not_linked",
        account: "XX" + parsedTail,
      });
    }
  }

  // ── Auto-categorize pipeline ──
  // 1. Self-transfer (highest priority — structural)
  if (isSelfTransfer(parsed, userConfig.selfNamesRx, userConfig.selfAccounts)) {
    parsed.category = "Self Transfer";
    parsed.category_type = "transfer";
    {
      const from = parsed.type === "debit" ? (parsed.bank || "").toUpperCase() : (parsed.bank_from || "").toUpperCase();
      const to   = parsed.type === "debit" ? (parsed.bank_to || "").toUpperCase() : (parsed.bank || "").toUpperCase();
      parsed.note = (from || "?") + " → " + (to || "?");
    }
    parsed.recipient = "";
    parsed.source    = "";
  } else {
    // 2. User-defined rules (per-user subcollection)
    let autoTagged = false;
    if (parsed.type === "debit") {
      const k = normalizeKey(parsed.recipient);
      if (k) {
        const ruleSnap = await db.collection(`users/${effectiveUser}/rules`).doc(k).get();
        if (ruleSnap.exists) {
          const rule = ruleSnap.data();
          // Apply the rule regardless of legacy `contact` flag — the "Person"
          // feature was removed because contact-tagged txns vanished from the UI.
          parsed.category = rule.category;
          parsed.category_type = rule.category_type;
          autoTagged = true;
        }
      }
    }
    // 3. SIP / auto-debit detection
    if (!autoTagged) {
      const sip = detectSip(parsed);
      if (sip) {
        parsed.category = sip.category;
        parsed.category_type = sip.category_type;
        autoTagged = true;
      }
    }
    // 4. Built-in regex fallback
    if (!autoTagged) {
      const text = parsed.type === "credit" ? parsed.source : parsed.recipient;
      for (const rule of BUILTIN_RULES) {
        if (rule.type === parsed.type && rule.match.test(text || "")) {
          parsed.category = rule.category;
          parsed.category_type = rule.category_type;
          break;
        }
      }
    }
  }

  // ── Dedupe + write to per-user subcollection ──
  try {
    const txnCol = `users/${effectiveUser}/transactions`;
    const docRef = db.collection(txnCol).doc(parsed.dedup_key);
    await docRef.create(parsed);

    // ── Auto-create paired leg for self-transfers ──
    // When we see a debit self-transfer with a known destination bank,
    // create the credit leg automatically (the destination bank may not send an SMS)
    let pairedId = null;
    if (parsed.category_type === "transfer" && parsed.category === "Self Transfer") {
      const destBank = parsed.type === "debit" ? parsed.bank_to : null;
      const srcBank  = parsed.type === "credit" ? parsed.bank_from : null;
      const otherBank = destBank || srcBank;

      if (otherBank) {
        const pairedType = parsed.type === "debit" ? "credit" : "debit";

        // Skip the auto-pair if the destination bank's own SMS already arrived
        // and created the real leg (same upi_ref, opposite type).
        let realLegExists = false;
        if (parsed.upi_ref) {
          try {
            const existing = await db.collection(txnCol)
              .where("upi_ref", "==", parsed.upi_ref)
              .where("type", "==", pairedType)
              .limit(1).get();
            realLegExists = !existing.empty;
          } catch (_) { /* index missing — fall through to dedup_key collision */ }
        }
        if (realLegExists) {
          // Real leg present; don't double-count.
          return res.status(200).json({
            status: "saved", id: docRef.id, user: effectiveUser,
            bank: parsed.bank, type: parsed.type,
            amount: parsed.amount, date: parsed.date,
            category: parsed.category, category_type: parsed.category_type,
            recipient: parsed.recipient || parsed.source,
          });
        }
        const pairedKey  = parsed.dedup_key + "_paired";
        const paired = {
          raw_sms: "", bank: otherBank, account: "",
          amount: parsed.amount, date: parsed.date,
          type: pairedType, category: "Self Transfer", category_type: "transfer",
          recipient: "", source: "",
          source_account: "", balance_after: null,
          note: pairedType === "credit"
            ? (parsed.bank || "?").toUpperCase() + " → " + (otherBank || "?").toUpperCase()
            : (otherBank || "?").toUpperCase() + " → " + (parsed.bank || "?").toUpperCase(),
          upi_ref: parsed.upi_ref || "",
          created_at: parsed.created_at,
          dedup_key: pairedKey,
          auto_paired: true, // flag so we know this was auto-generated
        };
        try {
          const pairedRef = db.collection(txnCol).doc(pairedKey);
          await pairedRef.create(paired);
          pairedId = pairedRef.id;
        } catch (pairErr) {
          // Duplicate is fine — the other bank's SMS may have already created it
          if (pairErr.code !== 6 && !/already exists/i.test(pairErr.message || "")) {
            console.error("Failed to create paired leg:", pairErr);
          }
        }
      }
    }

    return res.status(200).json({
      status: "saved", id: docRef.id, user: effectiveUser,
      bank: parsed.bank, type: parsed.type,
      amount: parsed.amount, date: parsed.date,
      category: parsed.category, category_type: parsed.category_type,
      recipient: parsed.recipient || parsed.source,
      paired: pairedId || undefined,
    });
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message || "")) {
      return res.status(200).json({
        status: "duplicate", id: parsed.dedup_key,
        bank: parsed.bank, type: parsed.type,
        amount: parsed.amount, date: parsed.date,
      });
    }
    console.error("Firestore write failed:", err);
    return res.status(500).json({ error: "Firestore write failed" });
  }
});

// ── Admin usage stats (owner-only). ──
// Auth: Firebase ID token in `Authorization: Bearer <token>`; the token's uid
// must equal OWNER_UID (set in functions/.env — gitignored — at cutover).
// No query-string secrets; CORS limited to the PWA origin.
exports.adminStats = onRequest({ cors: ["https://viyas52.github.io"], region: "asia-south1" }, async (req, res) => {
  const OWNER_UID = process.env.OWNER_UID || "";
  if (!OWNER_UID) return res.status(503).json({ error: "Not configured" });

  const authz = req.headers.authorization || "";
  const m = authz.match(/^Bearer (.+)$/i);
  if (!m) return res.status(401).json({ error: "Missing token" });
  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(m[1]);
  } catch (_) {
    return res.status(401).json({ error: "Invalid token" });
  }
  if (decoded.uid !== OWNER_UID) return res.status(403).json({ error: "Forbidden" });

  try {
    const unameSnap = await db.collection("usernames").get();
    const authSnap = await db.collection("auth_users").get();
    const usernames = unameSnap.docs.map(d => d.id);
    const rows = [];
    for (const u of usernames) {
      const [txnAgg, ruleAgg, prof, acct] = await Promise.all([
        db.collection(`users/${u}/transactions`).count().get().catch(() => null),
        db.collection(`users/${u}/rules`).count().get().catch(() => null),
        db.doc(`users/${u}/config/profile`).get().catch(() => null),
        db.doc(`users/${u}/config/accounts`).get().catch(() => null),
      ]);
      const txns = txnAgg ? txnAgg.data().count : 0;
      const rules = ruleAgg ? ruleAgg.data().count : 0;
      const pf = prof && prof.exists ? prof.data() : {};
      const linked = acct && acct.exists ? (acct.data().linked_accounts || []) : [];
      let lastTxn = "-";
      if (txns > 0) {
        const recent = await db.collection(`users/${u}/transactions`).orderBy("created_at", "desc").limit(1).get().catch(() => null);
        if (recent && !recent.empty) lastTxn = String(recent.docs[0].data().created_at || "").substring(0, 10);
      }
      rows.push({
        username: u, name: pf.name || "-", email: pf.email || "-",
        txns, rules, banks: linked.length,
        created: String(pf.created_at || "").substring(0, 10) || "-",
        lastTxn,
      });
    }
    rows.sort((a, b) => b.txns - a.txns);
    res.json({
      usernames: usernames.length,
      authUsers: authSnap.size,
      activeUsers: rows.filter(r => r.txns > 0).length,
      totalTxns: rows.reduce((s, r) => s + r.txns, 0),
      users: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// ── Fallback API key for backward compat (used if no per-user key configured) ──
const DEFAULT_API_KEY = "myfinance_viyas_2026";

// ── Date helpers ──
const MONTHS = {
  Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
  Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12",
  JAN:"01", FEB:"02", MAR:"03", APR:"04", MAY:"05", JUN:"06",
  JUL:"07", AUG:"08", SEP:"09", OCT:"10", NOV:"11", DEC:"12",
};

function parseDateAlpha(raw) {
  const [day, mon, yr] = raw.split("-");
  return `20${yr}-${MONTHS[mon]}-${day.padStart(2, "0")}`;
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
    if (acct.endsWith(last4)) return bank;
  }
  return null;
}

// ── SMS Pattern Table ──
// acctToBank is passed as a param now (per-user)
function buildPatterns(acctToBank) {
  return [
    // ── ICICI debit (UPI) ──
    {
      name: "icici_debit_upi",
      rx: /ICICI Bank Acct XX(\d+) debited for Rs\.? ([\d,]+\.?\d*) on (\d{2}-\w{3}-\d{2}); (.+?) credited\. UPI:(\d+)/,
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
  const selfNamesRx = selfData.names_regex ? new RegExp(selfData.names_regex, "i") : null;
  const selfAccounts = selfData.accounts || [];
  const apiKey = profileData.api_key || DEFAULT_API_KEY;

  return { acctBankMap, selfNamesRx, selfAccounts, apiKey };
}

// ── HTTPS Cloud Function ──
exports.parseSms = onRequest({ cors: true, region: "asia-south1" }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // ── User ID (required for multi-user routing) ──
  const userId = req.body.user || req.body.userId || req.query.user;
  if (!userId) {
    // Backward compat: if no user param, default to "viyas" (original single-user)
    // Remove this fallback once all MacroDroid setups are updated
  }
  const effectiveUser = userId || "viyas";

  // ── Load per-user config ──
  let userConfig;
  try {
    userConfig = await loadUserConfig(effectiveUser);
  } catch (err) {
    console.error("Failed to load user config:", err);
    return res.status(500).json({ error: "Failed to load user config" });
  }

  // ── API key validation ──
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== userConfig.apiKey) return res.status(401).json({ error: "Invalid API key" });

  const sms = req.body.sms || req.body.message || "";
  if (!sms) return res.status(400).json({ error: "No SMS text provided" });

  // ── Parse SMS with per-user account mapping ──
  const acctToBank = (acct) => acctToBankDynamic(acct, userConfig.acctBankMap);
  const parsed = parseSms(sms, acctToBank);
  if (!parsed) return res.status(200).json({ status: "skipped", reason: "SMS format not recognized" });

  // ── Auto-categorize pipeline ──
  // 1. Self-transfer (highest priority — structural)
  if (isSelfTransfer(parsed, userConfig.selfNamesRx, userConfig.selfAccounts)) {
    parsed.category = "Self Transfer";
    parsed.category_type = "transfer";
    parsed.note = parsed.type === "debit"
      ? "(me) → " + (parsed.bank_to ? parsed.bank_to.toUpperCase() : "own account")
      : "(me) ← " + (parsed.bank_from ? parsed.bank_from.toUpperCase() : "own account");
    parsed.recipient = parsed.type === "debit" ? "(me)" : "";
    parsed.source    = parsed.type === "credit" ? "(me)" : "";
  } else {
    // 2. User-defined rules (per-user subcollection)
    let autoTagged = false;
    if (parsed.type === "debit") {
      const k = normalizeKey(parsed.recipient);
      if (k) {
        const ruleSnap = await db.collection(`users/${effectiveUser}/rules`).doc(k).get();
        if (ruleSnap.exists) {
          const rule = ruleSnap.data();
          if (!rule.contact) {
            parsed.category = rule.category;
            parsed.category_type = rule.category_type;
            autoTagged = true;
          }
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
    const docRef = db.collection(`users/${effectiveUser}/transactions`).doc(parsed.dedup_key);
    await docRef.create(parsed);
    return res.status(200).json({
      status: "saved", id: docRef.id, user: effectiveUser,
      bank: parsed.bank, type: parsed.type,
      amount: parsed.amount, date: parsed.date,
      category: parsed.category, category_type: parsed.category_type,
      recipient: parsed.recipient || parsed.source,
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

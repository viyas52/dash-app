/**
 * One-time migration: copies flat collections to per-user subcollections.
 *
 * This is added as a temporary HTTP cloud function. Deploy it, hit the URL once,
 * then remove it.
 *
 * Deploy: firebase deploy --only functions
 * Trigger: curl -X POST "https://asia-south1-home-expense-tracker-8a5c9.cloudfunctions.net/migrateToMultiUser?key=myfinance_viyas_2026"
 * Or just open that URL in your browser.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");

// db is already initialized by index.js (they share the same admin app)

exports.migrateToMultiUser = onRequest({ cors: true, region: "asia-south1" }, async (req, res) => {
  const key = req.query.key;
  if (key !== "myfinance_viyas_2026") return res.status(401).json({ error: "Invalid key" });

  const db = getFirestore();
  const USER_ID = "viyas";
  const results = { transactions: 0, rules: 0, configs: [] };

  try {
    // 1. Copy transactions
    const txnSnap = await db.collection("personal_transactions").get();
    let batch = db.batch();
    let count = 0;
    for (const doc of txnSnap.docs) {
      batch.set(db.doc(`users/${USER_ID}/transactions/${doc.id}`), doc.data());
      count++;
      if (count % 500 === 0) { await batch.commit(); batch = db.batch(); }
    }
    if (count % 500 !== 0) await batch.commit();
    results.transactions = count;

    // 2. Copy rules
    const ruleSnap = await db.collection("personal_rules").get();
    batch = db.batch();
    count = 0;
    for (const doc of ruleSnap.docs) {
      batch.set(db.doc(`users/${USER_ID}/rules/${doc.id}`), doc.data());
      count++;
      if (count % 500 === 0) { await batch.commit(); batch = db.batch(); }
    }
    if (count % 500 !== 0) await batch.commit();
    results.rules = count;

    // 3. Create config docs
    await db.doc(`users/${USER_ID}/config/accounts`).set({
      linked_accounts: [
        { id: "icici", name: "ICICI Bank", last4: "2472", color: "#FF6B00", initials: "IC" },
        { id: "hdfc",  name: "HDFC Bank",  last4: "2065", color: "#004C8F", initials: "HD" },
        { id: "cub",   name: "City Union Bank", last4: "4745", color: "#7B3F9E", initials: "CU" },
      ],
      acct_bank: { "2472": "icici", "2065": "hdfc", "4745": "cub" },
    });
    results.configs.push("accounts");

    await db.doc(`users/${USER_ID}/config/self_transfer`).set({
      names_regex: "VEDA\\s*VIYAS|VEDAVIYAS|VYAS\\.ILLUSIONIST",
      accounts: ["2472", "2065", "4745"],
    });
    results.configs.push("self_transfer");

    await db.doc(`users/${USER_ID}/config/profile`).set({
      name: "Viyas",
      api_key: "myfinance_viyas_2026",
      created_at: new Date().toISOString(),
    });
    results.configs.push("profile");

    return res.status(200).json({
      status: "success",
      user: USER_ID,
      copied_transactions: results.transactions,
      copied_rules: results.rules,
      created_configs: results.configs,
      message: "Migration complete. Old collections kept as backup.",
    });
  } catch (err) {
    console.error("Migration failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

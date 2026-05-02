/**
 * One-time migration script: copies flat collections to per-user subcollections.
 *
 * Run from the functions/ directory:
 *   node migrate.js
 *
 * Prerequisites: GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service
 * account key, or run from a machine already authenticated via `gcloud auth`.
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// Initialize — uses default credentials (works on GCP or with GOOGLE_APPLICATION_CREDENTIALS)
initializeApp();
const db = getFirestore();

const USER_ID = "viyas";

async function batchCopy(srcCol, destCol) {
  const snap = await db.collection(srcCol).get();
  console.log(`  ${srcCol}: ${snap.size} docs`);
  if (snap.size === 0) return;

  // Firestore batch limit is 500
  let batch = db.batch();
  let count = 0;
  for (const doc of snap.docs) {
    batch.set(db.doc(`${destCol}/${doc.id}`), doc.data());
    count++;
    if (count % 500 === 0) {
      await batch.commit();
      console.log(`    committed ${count}/${snap.size}`);
      batch = db.batch();
    }
  }
  if (count % 500 !== 0) {
    await batch.commit();
  }
  console.log(`  ✓ copied ${count} docs to ${destCol}`);
}

async function createConfigs() {
  // Linked accounts
  await db.doc(`users/${USER_ID}/config/accounts`).set({
    linked_accounts: [
      { id: "icici", name: "ICICI Bank", last4: "2472", color: "#FF6B00", initials: "IC" },
      { id: "hdfc",  name: "HDFC Bank",  last4: "2065", color: "#004C8F", initials: "HD" },
      { id: "cub",   name: "City Union Bank", last4: "4745", color: "#7B3F9E", initials: "CU" },
    ],
    acct_bank: { "2472": "icici", "2065": "hdfc", "4745": "cub" },
  });
  console.log("  ✓ users/" + USER_ID + "/config/accounts");

  // Self-transfer detection
  await db.doc(`users/${USER_ID}/config/self_transfer`).set({
    names_regex: "VEDA\\s*VIYAS|VEDAVIYAS|VYAS\\.ILLUSIONIST",
    accounts: ["2472", "2065", "4745"],
  });
  console.log("  ✓ users/" + USER_ID + "/config/self_transfer");

  // User profile
  await db.doc(`users/${USER_ID}/config/profile`).set({
    name: "Viyas",
    api_key: "myfinance_viyas_2026",
    created_at: new Date().toISOString(),
  });
  console.log("  ✓ users/" + USER_ID + "/config/profile");
}

async function main() {
  console.log("=== Migrating to multi-user (user: " + USER_ID + ") ===\n");

  console.log("1. Copying transactions...");
  await batchCopy("personal_transactions", `users/${USER_ID}/transactions`);

  console.log("\n2. Copying rules...");
  await batchCopy("personal_rules", `users/${USER_ID}/rules`);

  console.log("\n3. Creating config documents...");
  await createConfigs();

  console.log("\n=== Migration complete ===");
  console.log("Old collections kept as backup. Delete manually when verified.");
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});

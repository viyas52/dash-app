package com.viyas.finance

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Listens to notifications from messaging apps and bank apps,
 * filters for transactional content, and forwards to the cloud function.
 */
class SmsNotificationListener : NotificationListenerService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val recentHashes = ArrayDeque<Int>()
    private val maxRecent = 60

    // Packages we care about. Messaging apps + major Indian bank/UPI apps.
    private val watchedPackages = setOf(
        // SMS apps
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.android.messaging",
        "com.android.mms",
        // Banks
        "com.snapwork.hdfc", "com.csam.icici.bank.imobile",
        "com.sbi.lotusintouch", "com.sbi.SBIFreedomPlus",
        "com.axis.mobile", "com.msf.kbank.mobile",
        "com.fss.indus", "com.idbibank.go", "com.YesBank",
        // UPI
        "com.google.android.apps.nbu.paisa.user", // GPay
        "com.phonepe.app", "net.one97.paytm",
        "in.org.npci.upiapp", "in.amazon.mShop.android.shopping",
        "com.bhim.app"
    )

    // Quick filter: only forward if the text looks like a bank txn.
    private val txnRegex = Regex(
        """(?i)(debited|credited|debit|credit|spent|received|deducted|withdrawn|paid|sent|txn|transaction|a/c|acct|rs\.?\s*\d|inr\s*\d|₹\s*\d|upi)"""
    )

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            if (sbn.packageName !in watchedPackages) return
            val extras = sbn.notification.extras ?: return
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
            val body = listOf(bigText, text).firstOrNull { it.isNotBlank() } ?: return

            // Compose into something SMS-like. Title is usually the sender ID (HDFCBK, etc.) or app name.
            val composed = if (title.isNotBlank()) "$title: $body" else body
            if (!txnRegex.containsMatchIn(composed)) return

            // De-dupe (notification updates fire repeatedly)
            val h = composed.hashCode()
            synchronized(recentHashes) {
                if (h in recentHashes) return
                recentHashes.addFirst(h)
                while (recentHashes.size > maxRecent) recentHashes.removeLast()
            }

            scope.launch {
                val res = SmsForwarder.post(applicationContext, composed)
                Log.i(TAG, "forwarded [${sbn.packageName}] -> $res")
            }
        } catch (e: Exception) {
            Log.e(TAG, "onNotificationPosted error", e)
        }
    }

    override fun onListenerConnected() {
        Log.i(TAG, "listener connected")
    }

    companion object {
        private const val TAG = "FinanceListener"
    }
}

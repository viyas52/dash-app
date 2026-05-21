package com.viyas.finance

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telephony.SmsMessage
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Primary SMS capture path — receives SMS_RECEIVED broadcast directly from the
 * telephony stack, bypassing notification-layer interception by apps like
 * Truecaller. Works alongside [SmsNotificationListener]; shared dedup via
 * [SmsDedup] ensures a message caught by both is forwarded only once.
 */
class SmsBroadcastReceiver : BroadcastReceiver() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Same regex filters as SmsNotificationListener — keep in sync.
    private val txnRegex = Regex(
        """(?i)(debited|credited|debit|credit|spent|received|deducted|withdrawn|paid|sent|txn|transaction|a/c\s*\w|acct|rs\.?\s*\d|inr\s*\d|₹\s*\d|upi)"""
    )

    private val otpRegex = Regex(
        """(?i)(\botp\b|one[\s-]?time\s?password|verification\s?code|do\s?not\s?share|secure\s?code|auth\s?code|login\s?code|use\s?\d{4,8}\s?(as|to)|is\s?your\s?(otp|code|verification))"""
    )

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "android.provider.Telephony.SMS_RECEIVED") return

        try {
            val pdus = intent.extras?.get("pdus") as? Array<*> ?: return
            val format = intent.extras?.getString("format") // "3gpp" or "3gpp2"

            // Multi-part SMS: each PDU is one segment. Concatenate bodies.
            val parts = pdus.mapNotNull { pdu ->
                val bytes = pdu as? ByteArray ?: return@mapNotNull null
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && format != null) {
                    SmsMessage.createFromPdu(bytes, format)
                } else {
                    @Suppress("DEPRECATION")
                    SmsMessage.createFromPdu(bytes)
                }
            }

            if (parts.isEmpty()) return

            val sender = parts[0].displayOriginatingAddress ?: ""
            val body = parts.joinToString("") { it.messageBody ?: "" }

            if (body.isBlank()) {
                recordEvent(context, PKG_TAG, "", "filtered: empty_body")
                return
            }

            // Primary gate: body must contain transaction keywords.
            if (!txnRegex.containsMatchIn(body)) {
                recordEvent(context, PKG_TAG, body, "filtered: no_txn_keywords")
                return
            }

            // OTP guard
            if (otpRegex.containsMatchIn(body)) {
                recordEvent(context, PKG_TAG, body, "filtered: looks_like_otp")
                return
            }

            // Compose the message with sender header (DLT sender ID).
            val composed = if (sender.isNotBlank()) "$sender: $body" else body

            // Shared dedup — if the notification listener already forwarded this
            // exact text, skip silently (no log noise for dupes).
            if (!SmsDedup.tryAcquire(composed)) return

            scope.launch {
                val result = SmsForwarder.post(context, composed)
                Log.i(TAG, "forwarded [sms_receiver] -> ${result.status}")
                recordEvent(context, PKG_TAG, composed, "forwarded: ${result.status}")
                result.txn?.let { UncatNotifier.maybeShow(context, it) }
            }
        } catch (e: Exception) {
            Log.e(TAG, "onReceive error", e)
            recordEvent(context, PKG_TAG, "", "error: ${e.message}")
        }
    }

    private fun recordEvent(context: Context, pkg: String, body: String, status: String) {
        try {
            val prefs = context.getSharedPreferences(LOG_PREFS, Context.MODE_PRIVATE)
            val raw = prefs.getString(LOG_KEY, "[]") ?: "[]"
            val arr = try { JSONArray(raw) } catch (e: Exception) { JSONArray() }
            val event = JSONObject().apply {
                put("ts", System.currentTimeMillis())
                put("pkg", pkg)
                put("body", body.take(220))
                put("status", status)
            }
            val newArr = JSONArray()
            newArr.put(event)
            for (i in 0 until arr.length()) {
                if (newArr.length() >= 40) break
                newArr.put(arr.get(i))
            }
            prefs.edit().putString(LOG_KEY, newArr.toString()).apply()
        } catch (e: Exception) {
            Log.e(TAG, "recordEvent failed", e)
        }
    }

    companion object {
        private const val TAG = "FinanceSmsReceiver"
        private const val PKG_TAG = "sms_receiver"
        private const val LOG_PREFS = SmsNotificationListener.LOG_PREFS
        private const val LOG_KEY = SmsNotificationListener.LOG_KEY
    }
}

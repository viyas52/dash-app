package com.viyas.finance

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * Shows a phone notification when the cloud function saves an uncategorized
 * transaction. Tapping it opens the PWA so the user can pick a category.
 */
object UncatNotifier {

    private const val CHANNEL_ID = "uncat_txns"
    private const val CHANNEL_NAME = "Uncategorized transactions"

    fun maybeShow(ctx: Context, txn: JSONObject) {
        // Only fire for newly-created, still-uncategorized debits/credits.
        if (txn.optString("status") != "saved") return
        if (!txn.isNull("category")) return

        ensureChannel(ctx)

        val type = txn.optString("type")
        val amount = txn.optDouble("amount", 0.0)
        val bank = txn.optString("bank").uppercase()
        val party = txn.optString("recipient").ifEmpty { txn.optString("source") }
        val arrow = if (type == "debit") "→" else "←"
        val title = "Categorize this ${if (type == "debit") "payment" else "credit"}"
        val text = "₹${fmt(amount)} $arrow ${if (party.isNotBlank()) party else "?"}  ·  $bank"

        // Tapping launches the PWA URL with ?openuncat=1 — Chrome routes this
        // to the user's installed PWA shortcut (added via "Add to Home Screen")
        // so it opens standalone, not in a browser tab. PWA reads the param
        // on load and jumps straight to the Uncategorized screen.
        val openIntent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("https://viyas52.github.io/dash-app/?companion=1&openuncat=1")
        ).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            ctx,
            txn.optString("id").hashCode(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        try {
            NotificationManagerCompat.from(ctx).notify(txn.optString("id").hashCode(), notif)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted on Android 13+. Skip silently;
            // user can grant via Settings → Apps → Finance Companion.
        }
    }

    private fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = ctx.getSystemService(NotificationManager::class.java) ?: return
            if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(
                    CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Pings when a new bank transaction needs a category"
                }
                mgr.createNotificationChannel(ch)
            }
        }
    }

    private fun fmt(n: Double): String =
        if (n == n.toLong().toDouble()) n.toLong().toString() else "%.2f".format(n)
}

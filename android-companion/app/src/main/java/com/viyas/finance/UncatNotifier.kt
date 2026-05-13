package com.viyas.finance

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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

        // Tap routing priority:
        //   1. If Chrome installed our PWA as a real WebAPK (proper standalone
        //      PWA with no URL bar), open that — best UX.
        //   2. Otherwise launch our own TWA wrapper, which loads the PWA and
        //      jumps to the Uncategorized screen via ?openuncat=1.
        val openIntent = buildOpenIntent(ctx)
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

    private const val PWA_URL = "https://viyas52.github.io/dash-app/"

    private fun buildOpenIntent(ctx: Context): Intent {
        val pm = ctx.packageManager
        val targetUrl = "$PWA_URL?companion=1&openuncat=1"

        // 1) Look for a Chrome WebAPK that handles our PWA URL — those are
        //    the no-URL-bar standalone PWAs installed via "Add to Home Screen".
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse(PWA_URL))
        val webapk = try {
            pm.queryIntentActivities(probe, PackageManager.MATCH_DEFAULT_ONLY)
                .firstOrNull { it.activityInfo.packageName.startsWith("org.chromium.webapk.") }
        } catch (_: Exception) { null }

        if (webapk != null) {
            return Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl)).apply {
                setPackage(webapk.activityInfo.packageName)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
        }

        // 2) Fall back to our own TWA wrapper. CompanionLauncherActivity reads
        //    the "openuncat" extra and appends ?openuncat=1 to the launching URL.
        return Intent(ctx, CompanionLauncherActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("openuncat", true)
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

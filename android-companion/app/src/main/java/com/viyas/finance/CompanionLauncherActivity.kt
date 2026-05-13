package com.viyas.finance

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.androidbrowserhelper.trusted.LauncherActivity

/**
 * Launches the PWA inside a Trusted Web Activity (full-screen Chrome).
 * Appends ?companion=1 so the PWA knows it's running inside the wrapper
 * and can auto-sync credentials via the financecompanion:// deep link.
 *
 * Also requests POST_NOTIFICATIONS on Android 13+ so we can fire
 * "categorize this transaction" notifications from the listener.
 */
class CompanionLauncherActivity : LauncherActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        maybeRequestNotificationPermission()
    }

    override fun getLaunchingUrl(): Uri {
        val base = super.getLaunchingUrl()
        val prefs = Prefs(this)
        val hasCreds = prefs.user.isNotBlank() && prefs.apiKey.isNotBlank()
        return base.buildUpon()
            .appendQueryParameter("companion", "1")
            .apply { if (hasCreds) appendQueryParameter("hasCreds", "1") }
            .build()
    }

    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) return
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            REQ_POST_NOTIFICATIONS
        )
    }

    companion object {
        private const val REQ_POST_NOTIFICATIONS = 1001
    }
}

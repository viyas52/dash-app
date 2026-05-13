package com.viyas.finance

import android.net.Uri
import com.google.androidbrowserhelper.trusted.LauncherActivity

/**
 * Launches the PWA inside a Trusted Web Activity (full-screen Chrome).
 * Appends ?companion=1 so the PWA knows it's running inside the wrapper
 * and can auto-sync credentials via the financecompanion:// deep link.
 */
class CompanionLauncherActivity : LauncherActivity() {

    override fun getLaunchingUrl(): Uri {
        val base = super.getLaunchingUrl()
        val prefs = Prefs(this)
        val hasCreds = prefs.user.isNotBlank() && prefs.apiKey.isNotBlank()
        return base.buildUpon()
            .appendQueryParameter("companion", "1")
            .apply { if (hasCreds) appendQueryParameter("hasCreds", "1") }
            .build()
    }
}

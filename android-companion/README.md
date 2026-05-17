# Finance Companion (Android)

Tiny Kotlin app that replaces MacroDroid. Listens to bank/UPI notifications and forwards them to the same `parseSms` Firebase cloud function the PWA already uses.

## Why
- MacroDroid free trial paywall'd us
- Notification Listener Service does NOT need `READ_SMS` (so no Play Store ban risk if we ever want to publish)
- One-time setup: install APK, type username + API key, toggle one switch

## What it does
1. `NotificationListenerService` watches notifications from messaging apps + major Indian bank/UPI apps
2. Filters to ones that look like transactions (regex on body)
3. POSTs `{user, sms}` to the `parseSms` cloud function with the per-user `x-api-key` header. The endpoint is configurable (set automatically by the sign-in deep link, or manually in the app); `SmsForwarder.DEFAULT_ENDPOINT` is only the fallback.
4. Cloud function does the same parsing it did for MacroDroid — no backend changes needed

## Build
Open `android-companion/` in Android Studio (Hedgehog or newer). Sync Gradle, hit Run. Or from CLI:

```
cd android-companion
./gradlew assembleDebug
```

APK lands in `app/build/outputs/apk/debug/app-debug.apk`. Sideload via `adb install` or transfer to phone.

## Setup on device
1. Install APK
2. Open app → enter username (e.g. `viyas`) and API key → Save
3. Tap "Open notification access settings" → enable Finance Companion
4. Tap "Send test transaction" — should return `200: {...}` and create a test txn in Firestore

## Notes
- No foreground service / persistent notification. NotificationListenerService is bound by the OS and survives reboots automatically.
- Dedup is per-process (60 most recent hashes). Cloud function also dedupes by `dedup_key`, so double-fires are safe.
- To add more bank apps, edit `watchedPackages` in `SmsNotificationListener.kt`.
- Logs visible via `adb logcat -s FinanceListener`.

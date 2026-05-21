package com.viyas.finance

/**
 * Shared deduplication state for SMS forwarding.
 * Both [SmsNotificationListener] and [SmsBroadcastReceiver] check against
 * the same hash set so a message caught by both paths is only forwarded once.
 */
object SmsDedup {
    private val recentHashes = ArrayDeque<Int>()
    private const val MAX_RECENT = 60

    /**
     * Returns `true` if this text has NOT been seen recently (i.e. it's new).
     * Adds the hash to the set on first sight.
     * Returns `false` if it's a duplicate.
     */
    fun tryAcquire(text: String): Boolean {
        val h = text.hashCode()
        synchronized(recentHashes) {
            if (h in recentHashes) return false
            recentHashes.addFirst(h)
            while (recentHashes.size > MAX_RECENT) recentHashes.removeLast()
            return true
        }
    }
}

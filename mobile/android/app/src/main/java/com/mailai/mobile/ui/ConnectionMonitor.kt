package com.mailai.mobile.ui

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Availability is a hint, not proof a mail server is reachable. Never initiates a send. */
internal class ConnectionMonitor(context: Context) : AutoCloseable {
    private val manager = context.getSystemService(ConnectivityManager::class.java)

    // Seed from callback delivery, not allNetworks: a network lost between snapshot and
    // registration never generates onLost for this listener and would remain falsely online.
    private val networks = java.util.concurrent.ConcurrentHashMap.newKeySet<Network>()
    private val mutable = MutableStateFlow(false)
    val online = mutable.asStateFlow()
    private val callback =
        object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                networks.add(network)
                mutable.value = true
            }

            override fun onLost(network: Network) {
                networks.remove(network)
                mutable.value = networks.isNotEmpty()
            }

            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities,
            ) {
                networks.add(network)
                mutable.value = true
            }
        }

    init {
        manager.registerNetworkCallback(com.mailai.mobile.mail.MailNetworks.request(), callback)
    }

    override fun close() {
        manager.unregisterNetworkCallback(callback)
    }
}

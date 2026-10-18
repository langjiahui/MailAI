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

    private fun available(): Boolean =
        manager
            .getNetworkCapabilities(manager.activeNetwork)
            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true

    private val mutable = MutableStateFlow(available())
    val online = mutable.asStateFlow()
    @Volatile private var current = manager.activeNetwork
    private val callback =
        object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                current = network
            }

            override fun onLost(network: Network) {
                if (current == network) {
                    current = null
                    mutable.value = false
                }
            }

            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities,
            ) {
                if (current == network)
                    mutable.value =
                        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            }
        }

    init {
        manager.registerDefaultNetworkCallback(callback)
    }

    override fun close() {
        manager.unregisterNetworkCallback(callback)
    }
}

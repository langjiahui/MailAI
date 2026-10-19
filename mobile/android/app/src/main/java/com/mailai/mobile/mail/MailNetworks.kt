package com.mailai.mobile.mail

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.net.InetAddress
import java.net.Socket
import java.net.SocketException

/** One operation uses the same network for DNS and TCP; never changes the process route. */
internal data class MailRoute(val resolve: (String) -> InetAddress, val bind: (Socket) -> Unit)

internal class MailNetworks(context: Context) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)

    fun selected(): Network? {
        val active = manager.activeNetwork
        val networks =
            (listOfNotNull(active) + manager.allNetworks).distinct().mapNotNull { network ->
                manager.getNetworkCapabilities(network)?.let { network to it }
            }
        // Respect an app-visible VPN. For a local-only company Wi-Fi, Android may otherwise
        // choose validated mobile data, including its public DNS, as the default route.
        return networks
            .firstOrNull { it.second.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }
            ?.first
            ?: networks
                .firstOrNull { it.second.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) }
                ?.first
            ?: networks.firstOrNull { it.first == active }?.first
            ?: networks.firstOrNull()?.first
    }

    fun route(): MailRoute {
        val network = selected() ?: throw SocketException("没有可用网络，请连接 Wi-Fi 或移动网络后重试")
        return MailRoute(
            { host -> NetworkPolicy.resolveMail(host, network::getAllByName) },
            network::bindSocket,
        )
    }

    companion object {
        fun request(): NetworkRequest =
            NetworkRequest.Builder()
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                .build()
    }
}

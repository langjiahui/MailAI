package com.mailai.mobile

import android.content.Context
import android.net.*
import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.mail.*
import com.mailai.mobile.ui.ConnectionMonitor
import java.net.InetAddress
import java.net.Socket
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowNetworkInfo

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class IntranetNetworkTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val manager
        get() = context.getSystemService(ConnectivityManager::class.java)

    private fun install(id: Int, type: Int, transport: Int): Network {
        val network = ShadowNetwork.newInstance(id)
        shadowOf(manager)
            .addNetwork(
                network,
                ShadowNetworkInfo.newInstance(
                    NetworkInfo.DetailedState.CONNECTED,
                    type,
                    0,
                    true,
                    true,
                ),
            )
        shadowOf(manager)
            .setNetworkCapabilities(
                network,
                org.robolectric.shadows.ShadowNetworkCapabilities.newInstance().apply {
                    shadowOf(this).addTransportType(transport)
                    shadowOf(this).removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    shadowOf(this).removeCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                },
            )
        return network
    }

    @Test
    fun splitDnsAndPrivateMailAddressesAreAcceptedButExternalResourcesStayPublicOnly() {
        for (ip in listOf("10.20.30.40", "172.16.1.2", "192.168.8.9", "100.64.1.2", "fd12::8")) {
            val address = InetAddress.getByName(ip)
            assertEquals(address, NetworkPolicy.resolveMail("mail.corp.test") { arrayOf(address) })
            assertFalse(NetworkPolicy.isPublic(address))
            assertThrows(IllegalArgumentException::class.java) { NetworkPolicy.resolve(ip) }
        }
        val private = InetAddress.getByName("10.20.30.40")
        assertEquals(
            private,
            NetworkPolicy.resolveMail("mail.corp.test") {
                arrayOf(InetAddress.getByName("fd12::8"), private)
            },
        )
    }

    @Test
    fun invalidDestinationsAreRejectedBeforeConnecting() {
        for (ip in
            listOf(
                "0.0.0.0",
                "127.0.0.1",
                "169.254.169.254",
                "224.0.0.1",
                "255.255.255.255",
                "::1",
                "fe80::1",
                "ff02::1",
            )) assertThrows(ip, IllegalArgumentException::class.java) {
            NetworkPolicy.resolveMail("mail.corp.test") { arrayOf(InetAddress.getByName(ip)) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            NetworkPolicy.resolveMail("mail.corp.test") {
                arrayOf(InetAddress.getByName("10.1.2.3"), InetAddress.getByName("127.0.0.1"))
            }
        }
    }

    @Test
    fun companyWifiIsUsedEvenWhenMobileDataIsTheDefault() {
        shadowOf(manager).clearAllNetworks()
        install(0, ConnectivityManager.TYPE_MOBILE, NetworkCapabilities.TRANSPORT_CELLULAR)
        shadowOf(manager)
            .setActiveNetworkInfo(manager.getNetworkInfo(ConnectivityManager.TYPE_MOBILE))
        val wifi = install(1, ConnectivityManager.TYPE_WIFI, NetworkCapabilities.TRANSPORT_WIFI)
        assertEquals(wifi, MailNetworks(context).selected())
        Socket().use { socket ->
            MailNetworks(context).route().bind(socket)
            assertTrue(shadowOf(wifi).isSocketBound(socket))
        }
        assertNull(manager.boundNetworkForProcess)
    }

    @Test
    fun vpnIsNotBypassedAndNetworkChangesUseAFreshRoute() {
        shadowOf(manager).clearAllNetworks()
        val wifi = install(1, ConnectivityManager.TYPE_WIFI, NetworkCapabilities.TRANSPORT_WIFI)
        val vpn = install(42, ConnectivityManager.TYPE_VPN, NetworkCapabilities.TRANSPORT_VPN)
        val networks = MailNetworks(context)
        assertEquals(vpn, networks.selected())
        shadowOf(manager).removeNetwork(vpn)
        assertEquals(wifi, networks.selected())
        shadowOf(manager).clearAllNetworks()
        assertNull(networks.selected())
        assertThrows(java.net.SocketException::class.java) { networks.route() }
    }

    @Test
    fun localOnlyWifiIsOnlineAndLosingOneNetworkDoesNotLoseTheOther() {
        shadowOf(manager).clearAllNetworks()
        val wifi = install(1, ConnectivityManager.TYPE_WIFI, NetworkCapabilities.TRANSPORT_WIFI)
        val mobile =
            install(0, ConnectivityManager.TYPE_MOBILE, NetworkCapabilities.TRANSPORT_CELLULAR)
        val monitor = ConnectionMonitor(context)
        try {
            assertTrue(monitor.online.value)
            val callback = shadowOf(manager).networkCallbacks.single()
            callback.onLost(wifi)
            assertTrue(monitor.online.value)
            callback.onLost(mobile)
            assertFalse(monitor.online.value)
            callback.onAvailable(wifi)
            callback.onCapabilitiesChanged(
                wifi,
                org.robolectric.shadows.ShadowNetworkCapabilities.newInstance().apply {
                    shadowOf(this).addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                },
            )
            assertTrue(monitor.online.value)
        } finally {
            monitor.close()
        }
        assertTrue(shadowOf(manager).networkCallbacks.isEmpty())
    }
}

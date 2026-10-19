package com.mailai.mobile

import android.net.ConnectivityManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mailai.mobile.mail.*
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.security.KeyStore
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** A native Android TLS handshake to the device's real private Wi-Fi address. No real mailbox. */
@RunWith(AndroidJUnit4::class)
class IntranetConnectionTest {
    private fun fixture(): SSLContext {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val keys =
            KeyStore.getInstance("PKCS12").apply {
                instrumentation.context.assets.open("intranet-test-only.p12").use {
                    load(it, "test-only".toCharArray())
                }
            }
        val km =
            KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                init(keys, "test-only".toCharArray())
            }
        val tm =
            TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
                init(keys)
            }
        return SSLContext.getInstance("TLS").apply { init(km.keyManagers, tm.trustManagers, null) }
    }

    private fun handshake(host: String): String {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val networks = MailNetworks(context)
        val selected = requireNotNull(networks.selected())
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val ip =
            requireNotNull(manager.getLinkProperties(selected))
                .linkAddresses
                .map { it.address }
                .first { it is Inet4Address && NetworkPolicy.isMailServer(it) }
        assertFalse("The server must actually use a private address", NetworkPolicy.isPublic(ip))
        val route = networks.route()
        assertEquals(ip, route.resolve(ip.hostAddress!!))
        assertThrows(IllegalArgumentException::class.java) {
            NetworkPolicy.resolve(ip.hostAddress!!)
        }
        val ssl = fixture()
        val server = ssl.serverSocketFactory.createServerSocket() as SSLServerSocket
        val executor = Executors.newSingleThreadExecutor()
        val op = Operation()
        try {
            server.bind(InetSocketAddress(ip, 0))
            server.soTimeout = 10000
            val accepted =
                executor.submit {
                    try {
                        (server.accept() as SSLSocket).use {
                            it.soTimeout = 10000
                            it.startHandshake()
                            it.outputStream.write("OK\n".toByteArray())
                            it.outputStream.flush()
                        }
                    } catch (
                        _:
                            javax.net.ssl.SSLException) {} // Expected when the client rejects
                                                           // identity.
                }
            val factory = PinnedTlsFactory(host, ip, op, ssl.socketFactory, route.bind)
            val result =
                (factory.createSocket(host, server.localPort) as SSLSocket).use {
                    it.soTimeout = 10000
                    it.startHandshake()
                    it.inputStream.bufferedReader().readLine()
                }
            accepted.get(10, TimeUnit.SECONDS)
            return result
        } finally {
            op.release()
            server.close()
            executor.shutdownNow()
        }
    }

    @Test
    fun privateAddressSupportsTlsAndKeepsTheOriginalServerIdentity() {
        assertEquals("OK", handshake("localhost"))
    }

    @Test
    fun privateAddressDoesNotDisableCertificateHostnameVerification() {
        assertThrows(SSLHandshakeException::class.java) { handshake("wrong-host.example.test") }
    }
}

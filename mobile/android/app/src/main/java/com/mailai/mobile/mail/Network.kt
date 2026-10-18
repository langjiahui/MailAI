package com.mailai.mobile.mail

import java.net.*
import java.util.concurrent.CancellationException
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.SocketFactory
import javax.net.ssl.SSLSocketFactory

class Operation {
    companion object {
        private val closer =
            java.util.concurrent.Executors.newCachedThreadPool { task ->
                Thread(task, "MailAI-connection-close").apply { isDaemon = true }
            }
    }

    @Volatile private var cancelled = false
    private val sockets = CopyOnWriteArrayList<Socket>()

    fun check() {
        if (cancelled) throw CancellationException("已取消")
    }

    fun track(socket: Socket): Socket {
        sockets.add(socket)
        if (cancelled) {
            socket.close()
            check()
        }
        return socket
    }

    fun cancel() {
        cancelled = true
        val closing = sockets.toList()
        sockets.clear()
        closer.execute { closing.forEach { runCatching { it.close() } } }
    }

    fun release() {
        sockets.forEach { runCatching { it.close() } }
        sockets.clear()
    }
}

object NetworkPolicy {
    fun isPublic(ip: InetAddress): Boolean {
        if (
            ip.isAnyLocalAddress ||
                ip.isLoopbackAddress ||
                ip.isLinkLocalAddress ||
                ip.isSiteLocalAddress ||
                ip.isMulticastAddress
        )
            return false
        val b = ip.address.map { it.toInt() and 255 }
        return if (b.size == 4)
            !(b[0] == 0 ||
                b[0] >= 224 ||
                b[0] == 127 ||
                (b[0] == 100 && b[1] in 64..127) ||
                (b[0] == 169 && b[1] == 254) ||
                (b[0] == 192 && b[1] == 0) ||
                (b[0] == 198 && b[1] in 18..19))
        else
            (b[0] and 0xe0) == 0x20 &&
                !(b[0] == 0x20 &&
                    (b[1] == 0x02 ||
                        b[1] == 0x01 &&
                            b[2] == 0 &&
                            b[3] ==
                                0)) // Global unicast only; excludes ULA, mapped/transition/private
        // ranges.
    }

    fun resolve(host: String): InetAddress {
        require(
            host.isNotBlank() &&
                !host.contains('/') &&
                !host.contains('@') &&
                host.none { it.isWhitespace() }
        ) {
            "请填写有效的服务器域名"
        }
        val addresses = InetAddress.getAllByName(host)
        require(addresses.isNotEmpty() && addresses.all(::isPublic)) { "当前预览版只支持公网邮箱服务器" }
        return addresses.first()
    }
}

/** Pin the validated DNS result, retaining the original TLS hostname for identity checks. */
internal class PinnedSocketFactory(private val address: InetAddress, private val op: Operation) :
    SocketFactory() {
    override fun createSocket(): Socket =
        op.track(
            object : Socket() {
                override fun connect(endpoint: SocketAddress, timeout: Int) {
                    op.check()
                    super.connect(
                        InetSocketAddress(address, (endpoint as InetSocketAddress).port),
                        timeout,
                    )
                }

                override fun connect(endpoint: SocketAddress) = connect(endpoint, 15000)
            }
        )

    private fun connect(port: Int, local: InetAddress? = null, localPort: Int = 0): Socket {
        op.check()
        val s = op.track(Socket())
        if (local != null) s.bind(InetSocketAddress(local, localPort))
        s.connect(InetSocketAddress(address, port), 15000)
        s.soTimeout = 20000
        return s
    }

    override fun createSocket(host: String, port: Int) = connect(port)

    override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int) =
        connect(port, local, localPort)

    override fun createSocket(host: InetAddress, port: Int) = connect(port)

    override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int) =
        connect(port, local, localPort)
}

internal class PinnedTlsFactory(
    private val host: String,
    private val address: InetAddress,
    private val op: Operation,
    private val delegate: SSLSocketFactory,
) : SSLSocketFactory() {
    override fun getDefaultCipherSuites() = delegate.defaultCipherSuites

    override fun getSupportedCipherSuites() = delegate.supportedCipherSuites

    // JavaMail prefers the layered overload, after creating a pinned plain socket.
    override fun createSocket(s: Socket, ignoredHost: String, port: Int, close: Boolean): Socket =
        op.track(
            delegate.createSocket(s, host, port, close).apply {
                // JSSE verifies the original hostname (not the pinned IP) during handshake.
                val ssl = this as javax.net.ssl.SSLSocket
                ssl.sslParameters =
                    ssl.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
            }
        )

    private fun connect(port: Int): Socket {
        val raw = op.track(Socket())
        raw.connect(InetSocketAddress(address, port), 15000)
        raw.soTimeout = 20000
        return createSocket(raw, host, port, true)
    }

    override fun createSocket(): Socket {
        throw java.net.SocketException("Layered TLS required")
    }

    override fun createSocket(host: String, port: Int) = connect(port)

    override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int) =
        connect(port)

    override fun createSocket(host: InetAddress, port: Int) = connect(port)

    override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int) =
        connect(port)
}

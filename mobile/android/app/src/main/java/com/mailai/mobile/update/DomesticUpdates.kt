package com.mailai.mobile.update

import java.security.MessageDigest
import java.util.Base64
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import org.json.JSONArray
import org.json.JSONObject

internal const val DOMESTIC_MANIFEST =
    "https://raw.atomgit.com/langjiahui2011/MailAI/raw/updates/android-latest.signed.json"
internal const val DOMESTIC_RELEASES = "https://atomgit.com/langjiahui2011/MailAI/releases/"

/** Independent signed Android channel; never consult the shared desktop latest release. */
internal object DomesticUpdates {
    private const val PUBLIC_KEY = "eZ9V84iPGy4Sx2AwSvVG/xLWGFqZ8iyd7Az9YiDWAZY="

    fun mirror(candidate: UpdateCandidate): String {
        val tag = "android-v${candidate.version}"
        require(candidate.url == "$RELEASE_PREFIX$tag/MailAI-Android-${candidate.version}.apk")
        return "${DOMESTIC_RELEASES}download/$tag/MailAI-Android-${candidate.version}.apk"
    }

    fun discover(raw: String): UpdateCandidate = verify(raw, PUBLIC_KEY)

    internal fun verify(raw: String, publicKey: String): UpdateCandidate {
        val envelope = JSONObject(raw)
        require(envelope.getString("algorithm") == "ed25519") { "更新清单签名算法无效" }
        val payload = Base64.getDecoder().decode(envelope.getString("payload"))
        require(payload.size <= 128 * 1024)
        val curve = EdDSANamedCurveTable.getByName("Ed25519")
        val key = EdDSAPublicKey(EdDSAPublicKeySpec(Base64.getDecoder().decode(publicKey), curve))
        val verifier = EdDSAEngine(MessageDigest.getInstance("SHA-512"))
        verifier.initVerify(key)
        verifier.update(payload)
        require(verifier.verify(Base64.getDecoder().decode(envelope.getString("signature")))) {
            "更新清单签名校验失败"
        }
        // Parse only the verified payload; unauthenticated envelope fields never affect an update.
        val manifest = JSONObject(payload.toString(Charsets.UTF_8))
        val version = manifest.getString("version")
        require(version.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+")))
        val assets =
            JSONArray()
                .put(
                    JSONObject()
                        .put("browser_download_url", manifest.getString("url"))
                        .put("size", manifest.getLong("size"))
                )
        val candidate = UpdatePolicy.manifest(manifest, "android-v$version", assets)
        return candidate.copy(mirrorUrl = mirror(candidate))
    }
}

package com.mailai.mobile.assistant

import org.json.JSONArray
import org.json.JSONObject

internal data class AssistantModel(val id: String, val name: String)

internal data class AssistantProvider(
    val id: String,
    val name: String,
    val endpoint: String = "",
    val models: List<AssistantModel> = emptyList(),
) {
    val preset
        get() = endpoint.isNotBlank()
}

/**
 * Web provider choices, with explicit mobile defaults. This catalog never makes network requests.
 */
internal object AssistantProviders {
    val all =
        listOf(
            AssistantProvider(
                "deepseek",
                "DeepSeek",
                "https://api.deepseek.com/v1/chat/completions",
                listOf(
                    AssistantModel("deepseek-flash", "DeepSeek Flash"),
                    AssistantModel("deepseek-v4-pro", "DeepSeek V4 Pro"),
                ),
            ),
            AssistantProvider(
                "kimi",
                "Kimi（月之暗面）",
                "https://api.moonshot.cn/v1/chat/completions",
                listOf(
                    AssistantModel("kimi-k2.6", "Kimi K2.6"),
                    AssistantModel("kimi-k3", "Kimi K3"),
                ),
            ),
            AssistantProvider("custom", "自部署模型"),
            AssistantProvider("other", "其他厂商（通用 API）"),
            AssistantProvider(
                "kimi_code",
                "Kimi Code（编程订阅）",
                "https://api.kimi.com/coding/v1/chat/completions",
                listOf(
                    AssistantModel("kimi-for-coding", "Kimi for Coding"),
                    AssistantModel("k3-256k", "K3 · 256K"),
                ),
            ),
        )

    fun get(id: String) = all.firstOrNull { it.id == id } ?: all.first { it.id == "other" }

    fun detect(endpoint: String): AssistantProvider? =
        all.firstOrNull {
            it.preset && it.endpoint == runCatching { completionEndpoint(endpoint) }.getOrNull()
        }

    fun completionEndpoint(value: String, privateNetwork: Boolean = false): String {
        val url = AssistantConfig(endpoint = value.trim(), privateNetwork = privateNetwork).url()
        val path = url.encodedPath.trimEnd('/')
        return url.newBuilder()
            .encodedPath(
                when {
                    path.endsWith("/chat/completions") -> path
                    path.endsWith("/v1") -> "$path/chat/completions"
                    else -> "$path/v1/chat/completions"
                }
            )
            .build()
            .toString()
    }

    /**
     * Only exact official endpoints get provider-specific fields; arbitrary gateways stay generic.
     */
    fun request(config: AssistantConfig, messages: JSONArray): JSONObject {
        val modelId = config.model.lowercase()
        val provider = detect(config.endpoint)?.id
        val body =
            JSONObject()
                .put("model", config.model)
                .put("messages", messages)
                .put("stream", true)
                .put(
                    "max_tokens",
                    if (
                        provider == "kimi_code" ||
                            modelId.startsWith("kimi-for-coding") ||
                            (provider == null && modelId.startsWith("kimi-k2."))
                    )
                        4096
                    else 1600,
                )
        if (provider in setOf("deepseek", "kimi", "kimi_code"))
            body.put("stream_options", JSONObject().put("include_usage", true))
        when (provider) {
            "deepseek" -> body.put("thinking", JSONObject().put("type", "disabled"))
            "kimi" ->
                if (config.model.startsWith("kimi-k2.")) {
                    body.put("thinking", JSONObject().put("type", "disabled"))
                } else if (config.model.startsWith("kimi-k3")) {
                    body.remove("max_tokens")
                    body.put("max_completion_tokens", 1600).put("reasoning_effort", "low")
                }
            // Match Web: no temperature / reasoning_effort override for the coding subscription.
            "kimi_code" -> Unit
        }
        return body
    }
}

/**
 * Classify bounded vendor errors without echoing response text, credentials, URLs or mail content.
 */
internal object AssistantServiceErrors {
    fun message(config: AssistantConfig, code: Int, raw: String): String {
        val error = runCatching { JSONObject(raw.take(4096)).optJSONObject("error") }.getOrNull()
        val detail =
            listOf("message", "type", "code")
                .joinToString(" ") { error?.optString(it).orEmpty() }
                .lowercase()
        val isCode = AssistantProviders.detect(config.endpoint)?.id == "kimi_code"
        val status = "（HTTP $code）"
        return when {
            isCode &&
                listOf(
                        "coding agent",
                        "coding tools",
                        "only available for coding",
                        "access_terminated",
                        "user-agent",
                        "client not allowed",
                    )
                    .any { it in detail } ->
                "Kimi Code 未开放当前客户端的调用权限$status。请改选 Kimi（月之暗面），使用开放平台 API Key。"
            listOf(
                    "insufficient_balance",
                    "insufficient_quota",
                    "balance is not enough",
                    "credit balance",
                )
                .any { it in detail } -> "模型服务额度不足$status，请检查当前服务的余额与权限"
            code == 401 || code == 403 ->
                if (isCode) "Kimi Code 未接受密钥或客户端权限$status；编程订阅 Key 与 Kimi 开放平台 Key 不能混用"
                else "模型服务未接受 API Key$status，请核对所选服务、密钥与权限"
            code == 429 -> "模型服务限流或额度不足$status，请稍后手动重试"
            code == 404 || "model_not_found" in detail || "invalid_model" in detail ->
                "接口或模型未找到$status，请核对服务商和模型；自定义服务请展开高级设置"
            code == 400 || code == 422 -> "模型与请求参数不兼容$status，请更换预设模型或核对自定义模型名称"
            code in 300..399 -> "模型接口发生跳转$status，请填写最终接口地址；HTTP 仅限企业内网"
            code in 500..599 -> "模型服务暂时不可用$status，原邮件和草稿未改动"
            else -> "模型服务未接受请求$status，请在模型设置中测试连接"
        }
    }
}

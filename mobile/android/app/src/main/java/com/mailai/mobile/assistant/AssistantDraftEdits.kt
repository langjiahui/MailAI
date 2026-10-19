package com.mailai.mobile.assistant

import com.mailai.mobile.data.*

/** Pure optimistic edit: preserve every field outside the exact captured body selection. */
internal object AssistantDraftEdits {
    fun polish(current: Draft, source: AssistantContext, result: String): Draft {
        check(
            current.id == source.sourceId &&
                current.body == source.text &&
                current.styles == source.draft?.styles &&
                current.state in setOf(SendState.DRAFT, SendState.FAILED)
        ) {
            "正文已变化，请重新生成；当前编辑内容不会被覆盖"
        }
        require(result.isNotBlank() && result.length <= 32000)
        require(source.start in 0..source.end && source.end <= current.body.length)
        val body = current.body.replaceRange(source.start, source.end, result)
        require(body.toByteArray(Charsets.UTF_8).size <= MAX_TEXT_BYTES) { "采用后的正文过长，请缩小处理范围" }
        return current.copy(
            body = body,
            styles = RichBody.edit(current.body, body, current.styles),
            state = SendState.DRAFT,
        )
    }
}

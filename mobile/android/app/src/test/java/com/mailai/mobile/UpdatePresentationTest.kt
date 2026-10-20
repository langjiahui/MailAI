package com.mailai.mobile

import com.mailai.mobile.ui.updateHeading
import com.mailai.mobile.ui.updateHighlights
import com.mailai.mobile.update.*
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import org.junit.Assert.*
import org.junit.Test

class UpdatePresentationTest {
    @Test
    fun productSummaryOmitsEngineeringMetadataAndValidationSections() {
        val notes =
            """
            # MailAI Android 1.3.1
            - 基准版本：1.3.0
            - 变更类型：PATCH
            - 目标版本：1.3.1；versionCode 2100109
            - 判断依据：兼容修复
            ## 阅读体验
            - **正文** 随主题切换。
            - 下载后可直接安装。
            ## 验证与升级
            - 执行内部工具检查。
            ## 交互优化
            - 点击后有清楚反馈。
        """
                .trimIndent()
        assertEquals(listOf("正文 随主题切换。", "下载后可直接安装。", "点击后有清楚反馈。"), updateHighlights(notes))
    }

    @Test
    fun cachedCandidateDoesNotTurnACheckFailureIntoDownloadFailure() {
        val state = UpdateState(failed = true, failureStage = UpdateFailureStage.CHECK)
        assertEquals("检查失败", updateHeading(state))
        assertEquals("下载未完成", updateHeading(state.copy(failureStage = UpdateFailureStage.DOWNLOAD)))
        assertEquals(
            "安装包需要重新下载",
            updateHeading(state.copy(failureStage = UpdateFailureStage.VERIFY)),
        )
        assertEquals("检查可用更新", updateHeading(UpdateState(checkedAt = 1, message = "检查已取消")))
    }

    @Test
    fun actionableFailureMessagesNeverEchoSensitiveServerText() {
        assertTrue(
            updateFailureMessage(SocketTimeoutException(), UpdateFailureStage.DOWNLOAD)
                .contains("超时")
        )
        assertTrue(
            updateFailureMessage(UnknownHostException(), UpdateFailureStage.CHECK).contains("检查网络")
        )
        assertTrue(
            updateFailureMessage(UpdateHttpException(403), UpdateFailureStage.CHECK)
                .contains("限制访问")
        )
        assertTrue(
            updateFailureMessage(IOException("ENOSPC"), UpdateFailureStage.DOWNLOAD)
                .contains("空间不足")
        )
        val message =
            updateFailureMessage(IOException("synthetic-private-token"), UpdateFailureStage.VERIFY)
        assertFalse(message.contains("synthetic-private-token"))
        assertTrue(message.contains("阻止安装"))
    }
}

package com.mailai.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.mailai.mobile.ui.Dark
import com.mailai.mobile.ui.Light
import com.mailai.mobile.ui.MailBottomSheet
import com.mailai.mobile.ui.UpdatePanelContent
import com.mailai.mobile.update.*
import java.io.File
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalMaterial3Api::class)
class UpdatePanelTest {
    @get:Rule val compose = createEmptyComposeRule()
    private var scenario: ActivityScenario<MainActivity>? = null
    private val candidate =
        UpdateCandidate(
            "1.3.2",
            BuildConfig.VERSION_CODE + 1L,
            "https://github.com/langjiahui/MailAI/releases/download/android-v1.3.2/MailAI-Android-1.3.2.apk",
            "a".repeat(64),
            24000000,
            "# MailAI Android\n- 基准版本：1.3.1\n## 体验\n" +
                (1..16).joinToString("\n") { "- 第 $it 项：改进更新体验和反馈，保留邮箱与草稿。" },
            "https://github.com/langjiahui/MailAI/releases/tag/android-v1.3.2",
        )
    private val current = mutableStateOf(UpdateState(candidate = candidate))
    private var action = ""

    @After
    fun close() {
        scenario?.close()
    }

    private fun show() {
        scenario =
            ActivityScenario.launch(MainActivity::class.java).also { launched ->
                launched.onActivity { activity ->
                    activity.setContent {
                        MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light) {
                            MailBottomSheet("应用更新", {}) {
                                UpdatePanelContent(
                                    current.value,
                                    "1.3.1",
                                    true,
                                    false,
                                    onCheck = { action = "check" },
                                    onDownload = { action = "download" },
                                    onInstall = { action = "install" },
                                    onCancel = { action = "cancel" },
                                    onBrowser = { action = "browser" },
                                    onAutoCheck = {},
                                    onAutoDownload = {},
                                )
                            }
                        }
                    }
                }
            }
        compose.waitForIdle()
    }

    private fun screenshot(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val dir =
            File(instrumentation.targetContext.getExternalFilesDir(null), "update-panel-checks")
                .apply { mkdirs() }
        assertTrue(UiDevice.getInstance(instrumentation).takeScreenshot(File(dir, "$name.png")))
    }

    @Test
    fun primaryActionRemainsVisibleAfterExpandingLongNotesAndPreferences() {
        show()
        compose.onNodeWithText("下载更新").assertIsDisplayed()
        screenshot("available")
        compose.onNodeWithText("展开更新内容").performScrollTo().performClick()
        compose.onNodeWithText("更新偏好").performScrollTo().performClick()
        compose.onNodeWithText("Wi-Fi 自动下载").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("下载更新").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("download", action) }
        compose.onNodeWithText("基准版本", substring = true).assertDoesNotExist()
    }

    @Test
    fun failureRetryAndCancelledDownloadReturnToClearActions() {
        current.value =
            current.value.copy(
                failed = true,
                failureStage = UpdateFailureStage.CHECK,
                message = "连接超时，请换个网络后重试",
            )
        show()
        screenshot("check-failed")
        compose.onNodeWithText("重试检查").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals("check", action)
            current.value =
                current.value.copy(
                    failed = false,
                    failureStage = null,
                    queued = true,
                    waitingForWifi = true,
                )
        }
        compose.onNodeWithText("取消下载").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals("cancel", action)
            current.value =
                current.value.copy(queued = false, waitingForWifi = false, message = "下载已取消，可稍后重试")
        }
        compose.onNodeWithText("下载更新").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals("download", action)
            current.value = current.value.copy(ready = true)
        }
        compose.onNodeWithText("安装更新").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("install", action) }
    }

    @Test
    fun waitingForWifiCanUseCurrentNetworkAndVerificationCannotInstallEarly() {
        current.value = current.value.copy(queued = true, waitingForWifi = true)
        show()
        compose.onNodeWithTag("update-primary").assertIsNotEnabled()
        compose.onNodeWithText("使用当前网络下载").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals("download", action)
            current.value = current.value.copy(queued = false, downloading = true, verifying = true)
        }
        compose.onNodeWithTag("update-primary").assertIsNotEnabled()
        compose.onNodeWithText("取消下载").assertIsDisplayed()
        compose.onNodeWithText("安装更新").assertDoesNotExist()
    }
}

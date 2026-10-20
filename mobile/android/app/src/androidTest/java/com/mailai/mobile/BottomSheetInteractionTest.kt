package com.mailai.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import com.mailai.mobile.ui.MailBottomSheet
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalMaterial3Api::class)
class BottomSheetInteractionTest {
    @get:Rule val compose = createEmptyComposeRule()
    private var scenario: ActivityScenario<MainActivity>? = null

    @After
    fun close() {
        scenario?.close()
    }

    private lateinit var sheet: SheetState
    private var density = 1f
    private val rowCount = mutableIntStateOf(40)
    private var dismissed = false

    private fun show() {
        val launched = ActivityScenario.launch(MainActivity::class.java)
        scenario = launched
        launched.onActivity { activity ->
            activity.setContent {
                MaterialTheme {
                    var visible by remember { mutableStateOf(true) }
                    val state = rememberModalBottomSheetState()
                    val scale = LocalDensity.current.density
                    SideEffect {
                        sheet = state
                        density = scale
                    }
                    if (visible) {
                        MailBottomSheet(
                            "应用更新",
                            onDismiss = {
                                dismissed = true
                                visible = false
                            },
                            sheetState = state,
                        ) {
                            LazyColumn(
                                Modifier.fillMaxWidth().testTag("sheet-scroll"),
                                state = rememberLazyListState(),
                            ) {
                                items((1..rowCount.intValue).toList()) {
                                    Text("第 $it 项", Modifier.fillMaxWidth().padding(20.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun headerIsCompactAndCanExpandCollapseAndDismissWithoutLosingContent() {
        show()
        compose.runOnIdle { assertEquals(SheetValue.Expanded, sheet.currentValue) }
        val header = compose.onNodeWithTag("mail-sheet-header", useUnmergedTree = true)
        val handle = compose.onNodeWithTag("mail-sheet-handle", useUnmergedTree = true)
        handle.assertIsDisplayed()
        // The Surface modifier sits outside Material's offset placement; use the actual
        // draggable anchor to measure the painted panel's top edge.
        val gap = handle.getUnclippedBoundsInRoot().top - (sheet.requireOffset() / density).dp
        assertTrue("横杠距面板顶边应保持紧凑，不应叠加状态栏留白: $gap", gap in 6.dp..12.dp)
        header.assertHeightIsAtLeast(68.dp)
        header.performTouchInput { swipeDown() }
        compose.runOnIdle { assertEquals(SheetValue.PartiallyExpanded, sheet.currentValue) }
        header.performTouchInput { swipeUp() }
        compose.runOnIdle { assertEquals(SheetValue.Expanded, sheet.currentValue) }
        compose.onNodeWithText("第 1 项").assertIsDisplayed()
        header.performTouchInput { swipeDown() }
        compose.runOnIdle {
            assertEquals(SheetValue.PartiallyExpanded, sheet.currentValue)
            assertFalse(dismissed)
        }
        header.performTouchInput { swipeDown() }
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(dismissed) }
    }

    @Test
    fun aShorterLoadedResultKeepsTheExpandedPanelAndLastRowVisible() {
        show()
        compose.runOnIdle { rowCount.intValue = 6 }
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(SheetValue.Expanded, sheet.currentValue) }
        compose.onNodeWithTag("sheet-scroll").performScrollToIndex(5)
        compose.onNodeWithText("第 6 项").assertIsDisplayed()
        compose.onNodeWithText("完成").assertIsDisplayed()
    }

    @Test
    fun scrollingAnEarlierPartOfTheListDoesNotDismissTheSheet() {
        show()
        compose.onNodeWithTag("mail-sheet-header", useUnmergedTree = true).performTouchInput {
            swipeUp()
        }
        compose.onNodeWithTag("sheet-scroll").performScrollToIndex(25)
        compose.onNodeWithTag("sheet-scroll").performTouchInput { swipeDown() }
        compose.runOnIdle {
            assertFalse(dismissed)
            assertEquals(SheetValue.Expanded, sheet.currentValue)
        }
        compose.onNodeWithText("完成").assertIsDisplayed()
    }

    @Test
    fun explicitCloseStillWorksWithDraggableHeader() {
        show()
        compose.onNodeWithText("完成").performClick()
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(dismissed) }
        compose.onNodeWithTag("mail-sheet-header", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun contentFinishingDuringCloseDoesNotReopenThePanel() {
        show()
        compose.mainClock.autoAdvance = false
        try {
            compose.onNodeWithText("完成").performClick()
            compose.mainClock.advanceTimeByFrame()
            compose.runOnIdle { rowCount.intValue = 2 }
            compose.mainClock.advanceTimeBy(1000)
            compose.waitForIdle()
            compose.runOnIdle { assertTrue(dismissed) }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }
}

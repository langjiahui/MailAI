package com.mailai.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.ComposeTestRule

/** Large fonts move the reader's star into details; both routes perform the same real action. */
internal fun ComposeTestRule.toggleReaderStar(label: String) {
    if (onAllNodesWithContentDescription(label).fetchSemanticsNodes().isNotEmpty())
        onNodeWithContentDescription(label).performClick()
    else {
        onNodeWithContentDescription("详情").performClick()
        onNodeWithText(label, substring = false).assertIsDisplayed().performClick()
        onNodeWithText("完成", substring = false).performClick()
    }
}

internal fun ComposeTestRule.assertReaderStar(label: String) {
    if (onAllNodesWithContentDescription(label).fetchSemanticsNodes().isNotEmpty())
        onNodeWithContentDescription(label).assertExists()
    else {
        onNodeWithContentDescription("详情").performClick()
        onNodeWithText(label, substring = false).assertIsDisplayed()
        onNodeWithText("完成", substring = false).performClick()
    }
}

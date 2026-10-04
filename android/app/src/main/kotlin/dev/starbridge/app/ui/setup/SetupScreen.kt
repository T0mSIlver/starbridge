package dev.starbridge.app.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.starbridge.app.data.Store
import dev.starbridge.app.ui.Label
import dev.starbridge.app.ui.Panel
import dev.starbridge.app.ui.Title
import dev.starbridge.app.ui.theme.Radius
import dev.starbridge.app.ui.theme.Sizes
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import javax.inject.Inject

@HiltViewModel
class SetupViewModel @Inject constructor(private val store: Store) : ViewModel() {
    val words = store.recoveryWords
    fun finish() = store.finishSetup()
}

enum class SetupStep { SignIn, RecoveryKey }

/**
 * The first device: sign in, make this phone's keys, then show the recovery
 * key once. Later devices join by approval from this one.
 */
@Composable
fun SetupScreen(step: SetupStep, words: List<String>, onSignIn: () -> Unit, onDone: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.s4, vertical = Spacing.s4),
        verticalArrangement = Arrangement.spacedBy(Spacing.s3),
    ) {
        when (step) {
            SetupStep.SignIn -> SignIn(onSignIn)
            SetupStep.RecoveryKey -> RecoveryKey(words, onDone)
        }
    }
}

@Composable
private fun SignIn(onSignIn: () -> Unit) {
    val colors = StarbridgeTheme.colors
    Title("Starbridge")
    Text(
        "Answer your agents' questions and watch your AI plans' quotas, from this phone and the web.",
        style = StarbridgeTheme.type.body,
        color = colors.fg2,
    )
    Panel(Modifier.fillMaxWidth().padding(top = Spacing.s4)) {
        Label("This phone becomes your first device")
        Spacer(Modifier.padding(top = Spacing.s2))
        Text(
            "It makes its own keys. Your agents encrypt every question to them, so the server stores only ciphertext. The keys never leave the phone.",
            style = StarbridgeTheme.type.body,
            color = colors.fg,
        )
    }
    Spacer(Modifier.padding(top = Spacing.s4))
    Button(
        onClick = onSignIn,
        shape = RoundedCornerShape(Radius.pill),
        modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
    ) { Text("Sign in with GitHub", style = StarbridgeTheme.type.action) }
}

@Composable
private fun RecoveryKey(words: List<String>, onDone: () -> Unit) {
    val colors = StarbridgeTheme.colors
    var saved by rememberSaveable { mutableStateOf(false) }
    Title("Your recovery key")
    Text(
        "Write these ${words.size} words down and keep them offline. If you lose every device, they approve a new one. This is the only time they are shown.",
        style = StarbridgeTheme.type.body,
        color = colors.fg2,
    )
    Panel(Modifier.fillMaxWidth().padding(top = Spacing.s2), border = colors.lineStrong) {
        words.chunked(3).forEachIndexed { row, three ->
            Row(Modifier.padding(vertical = Spacing.s1)) {
                three.forEachIndexed { col, word ->
                    Row(Modifier.weight(1f)) {
                        Text("${row * 3 + col + 1}".padStart(2), style = StarbridgeTheme.type.machine, color = colors.fg3)
                        Spacer(Modifier.width(Spacing.s2))
                        Text(word, style = StarbridgeTheme.type.machine, color = colors.fg)
                    }
                }
            }
        }
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = Sizes.tap).toggleable(value = saved, role = Role.Checkbox, onValueChange = { saved = it }),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = saved, onCheckedChange = null)
        Spacer(Modifier.width(Spacing.s3))
        Text("I wrote these words down", style = StarbridgeTheme.type.body, color = colors.fg)
    }
    Button(
        onClick = onDone,
        enabled = saved,
        shape = RoundedCornerShape(Radius.pill),
        modifier = Modifier.fillMaxWidth().heightIn(min = Sizes.tap),
    ) { Text("Continue", style = StarbridgeTheme.type.action) }
}

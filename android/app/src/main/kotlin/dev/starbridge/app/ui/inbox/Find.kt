package dev.starbridge.app.ui.inbox

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SearchBar
import androidx.compose.material3.SearchBarDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.toShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.ui.Sym
import dev.starbridge.app.ui.Symbol
import dev.starbridge.app.ui.rowShape
import dev.starbridge.app.ui.theme.Spacing
import dev.starbridge.app.ui.theme.StarbridgeTheme
import java.time.Instant

/** The query's words, lowercased; empty while there is nothing to find. */
internal fun findWords(query: String) = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }

/** Whether every word appears in one of [texts], ignoring case: the web's rule. */
internal fun matches(words: List<String>, texts: List<String?>): Boolean {
    val hay = texts.filterNot { it.isNullOrEmpty() }.joinToString(" ").lowercase()
    return words.all { it in hay }
}

/** [text] with each of [words] marked in [style], wherever it appears, ignoring case. */
internal fun highlight(text: String, words: List<String>, style: SpanStyle): AnnotatedString {
    val lower = text.lowercase()
    // A few letters change length in lower case; those texts go unmarked rather than mismarked.
    if (words.isEmpty() || lower.length != text.length) return AnnotatedString(text)
    val hit = BooleanArray(text.length)
    for (w in words) {
        var i = lower.indexOf(w)
        while (i >= 0) {
            hit.fill(true, i, i + w.length)
            i = lower.indexOf(w, i + 1)
        }
    }
    return buildAnnotatedString {
        append(text)
        var i = 0
        while (i < text.length) {
            if (!hit[i]) { i++; continue }
            val start = i
            while (i < text.length && hit[i]) i++
            addStyle(style, start, i)
        }
    }
}

/** A Find match: bold on `surface2`, never amber, which means "needs you". */
@Composable
internal fun hitStyle() = SpanStyle(fontWeight = FontWeight.SemiBold, background = StarbridgeTheme.colors.surface2)

/** What Find matches on, as the web's: the machine, the repo, the agent's words and the session. */
private fun Decision.texts() = listOf(source.machine, source.project, question, context, source.title)
private fun Prompt.texts() = listOf(source.machine, source.project, tool, summary, source.title)

/**
 * Find (#244's rules, option A): Material 3's search view over the inbox. The open items that
 * match, under "Needs you", then the answered ones under "History", which also match by their
 * answer. Enter opens the first result, Down moves into the list, Escape clears the query and then
 * closes; Back closes, leaving the inbox as it was.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FindScreen(
    decisions: List<Decision>,
    prompts: List<Prompt>,
    now: Instant,
    openDecision: (String) -> Unit,
    openPrompt: (String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    initial: String = "",
) {
    var query by rememberSaveable { mutableStateOf(initial) }
    val words = findWords(query)
    val needs = remember(words, decisions, prompts, now) {
        if (words.isEmpty()) emptyList()
        else prompts.filter { it.waiting(now) && matches(words, it.texts()) } +
            decisions.filter { it.isOpen(now) && matches(words, it.texts()) }
                .sortedWith(compareByDescending<Decision> { it.waiting }.thenByDescending { it.createdAt })
    }
    val past = remember(words, decisions, prompts, now) {
        if (words.isEmpty()) emptyList()
        else History(decisions.filterNot { it.isOpen(now) }, prompts.filterNot { it.waiting(now) }, now).rows.filter { (at, it) ->
            when (it) {
                is Decision -> matches(words, it.texts() + outcome(it, at))
                else -> matches(words, (it as Prompt).texts() + closedHow(it))
            }
        }
    }
    val open = { item: Any -> if (item is Decision) openDecision(item.id) else openPrompt((item as Prompt).id) }
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) { focus.requestFocus() }
    SearchBar(
        inputField = {
            SearchBarDefaults.InputField(
                query = query,
                onQueryChange = { query = it },
                onSearch = { (needs.firstOrNull() ?: past.firstOrNull()?.second)?.let { keyboard?.hide(); open(it) } },
                expanded = true,
                onExpandedChange = { if (!it) onBack() },
                placeholder = { Text("Find") },
                leadingIcon = { IconButton(onClick = onBack) { Symbol(Sym.Back, size = 22.dp, contentDescription = "Back") } },
                trailingIcon = {
                    if (query.isNotEmpty()) IconButton(onClick = { query = ""; focus.requestFocus() }) { Symbol(Sym.Close, size = 22.dp, contentDescription = "Clear") }
                },
                modifier = Modifier.focusRequester(focus).onPreviewKeyEvent {
                    if (it.type == KeyEventType.KeyDown && it.key == Key.DirectionDown && (needs.isNotEmpty() || past.isNotEmpty())) {
                        focusManager.moveFocus(FocusDirection.Down)
                    } else false
                },
            )
        },
        expanded = true,
        onExpandedChange = { if (!it) onBack() },
        // The scaffold under it already keeps clear of the system bars.
        windowInsets = WindowInsets(0),
        modifier = modifier.onPreviewKeyEvent {
            if (it.type != KeyEventType.KeyDown || it.key != Key.Escape) return@onPreviewKeyEvent false
            if (query.isEmpty()) onBack() else { query = ""; focus.requestFocus() }
            true
        },
    ) {
        val accent = StarbridgeTheme.colors.accent
        val dim = MaterialTheme.colorScheme.onSurfaceVariant
        LazyColumn(
            contentPadding = PaddingValues(start = Spacing.s3, end = Spacing.s3, top = Spacing.s2, bottom = Spacing.s6),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (words.isNotEmpty() && needs.isEmpty() && past.isEmpty()) item(key = "none") { NothingMatches() }
            results("needs", "Needs you", accent, needs.map { now to it }, words, now, open)
            results("history", "History", dim, past, words, now, open)
        }
    }
}

private fun LazyListScope.results(key: String, name: String, countColor: Color, rows: List<Pair<Instant, Any>>, words: List<String>, now: Instant, open: (Any) -> Unit) {
    if (rows.isEmpty()) return
    item(key = "group/$key") { GroupHeader(name, rows.size, countColor) }
    itemsIndexed(rows, key = { _, (_, it) -> "$key/" + if (it is Decision) "d/${it.id}" else "p/${(it as Prompt).id}" }) { i, (at, it) ->
        val shape = rowShape(i, rows.size)
        val closed = key == "history"
        when (it) {
            is Decision -> HistoryRow(
                it.source, it.question, false, if (closed) closedHow(it, at) else "", shape, words,
                ground = if (!closed && it.waiting) promptGround() else MaterialTheme.colorScheme.surfaceContainer,
                time = if (closed) "" else timeSlot(it.waitingSince, it.createdAt, now),
                clock = !closed && it.waiting,
            ) { open(it) }
            is Prompt -> HistoryRow(
                it.source, it.summary, true, if (closed) closedHow(it) else it.tool, shape, words,
                ground = if (closed) MaterialTheme.colorScheme.surfaceContainer else promptGround(),
                time = if (closed) "" else waited(it.createdAt, now),
                clock = !closed,
            ) { open(it) }
        }
    }
}

/** Nothing matches the query: the inbox's empty shape, on `surface` since the search view stands on `surface2`. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun NothingMatches() {
    Column(Modifier.fillMaxWidth().padding(top = 56.dp, bottom = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.s4)) {
        Box(Modifier.size(120.dp).background(MaterialTheme.colorScheme.surface, MaterialShapes.Cookie9Sided.toShape()), contentAlignment = Alignment.Center) {
            Symbol(Sym.Search, size = 48.dp, tint = MaterialTheme.colorScheme.onSurface)
        }
        Text("Nothing matches", style = StarbridgeTheme.type.heading, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
    }
}

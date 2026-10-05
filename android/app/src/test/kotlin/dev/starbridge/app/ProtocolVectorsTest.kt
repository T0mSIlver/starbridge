package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.protocol.Bip39
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.JoinRequestBody
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.KeyPair
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.ProtocolException
import dev.starbridge.app.protocol.RecoveryKeys
import dev.starbridge.app.protocol.recoverySignSeed
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.SealedItem
import dev.starbridge.app.protocol.SignedEnvelope
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.fromB64
import dev.starbridge.app.protocol.parseBody
import dev.starbridge.app.protocol.parseJsonText
import dev.starbridge.app.protocol.codeFromLink
import dev.starbridge.app.protocol.pairingLink
import dev.starbridge.app.protocol.parsePairingCode
import dev.starbridge.app.protocol.toB64
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

// Every case in packages/protocol/vectors that a client checks, against the Kotlin port. The
// TypeScript tests run the same files, so both clients agree byte for byte.
class ProtocolVectorsTest {
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val envelopes = Envelopes(sodium)
    private val directories = Directories(sodium, envelopes)
    private val pairings = Pairings(sodium)
    private val joins = Joins(sodium)

    private fun load(name: String): JsonObject {
        val dir = File(System.getProperty("starbridge.vectors") ?: error("starbridge.vectors not set"))
        return ProtocolJson.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private val JsonElement.str get() = jsonPrimitive.content
    private fun JsonObject.str(key: String) = getValue(key).str
    private fun JsonObject.opt(key: String) = get(key)?.takeIf { it !is kotlinx.serialization.json.JsonNull }

    private fun code(fn: () -> Unit): String = try {
        fn()
        "ok"
    } catch (e: ProtocolException) {
        e.code
    }

    private val keys = load("keys.json")
    private val directory = load("directory.json")

    @Test
    fun directory() {
        for (case in directory.getValue("cases").jsonArray.map { it.jsonObject }) {
            val name = case.str("name")
            val entries = case.getValue("entries").jsonArray
            val opts = case.opt("options")?.jsonObject
            val pin = opts?.opt("pin")?.let { ProtocolJson.decodeFromJsonElement(Pin.serializer(), it) }
            val run = { directories.verify(entries, opts?.opt("account")?.str, pin, opts?.opt("recoveryPk")?.str) }
            val expect = case.getValue("expect").jsonObject
            val error = expect.opt("error")
            if (error != null) {
                assertEquals(name, error.str, code { run() })
                continue
            }
            val dir = run()
            assertEquals(name, expect.getValue("length").jsonPrimitive.int, dir.length)
            assertEquals(name, expect.str("head"), dir.head)
            val ids = { active: Boolean -> dir.members.values.filter { it.active == active }.map { it.member.id } }
            assertEquals(name, expect.getValue("active").jsonArray.map { it.str }, ids(true))
            assertEquals(name, expect.getValue("revoked").jsonArray.map { it.str }, ids(false))
        }
    }

    @Test
    fun envelopes() {
        val v = load("envelopes.json")
        for (case in v.getValue("signatures").jsonArray.map { it.jsonObject }) {
            val env = ProtocolJson.decodeFromJsonElement(SignedEnvelope.serializer(), case.getValue("envelope"))
            assertEquals(case.str("name"), case.str("expect"), code { envelopes.verify(env, case.str("signPk")) })
        }
        val dir = directories.verify(directory.getValue("cases").jsonArray[0].jsonObject.getValue("entries").jsonArray)
        val members = keys.getValue("members").jsonArray.map { it.jsonObject }
        fun box(id: String) = members.first { it.str("id") == id }.let { KeyPair(fromB64(it.str("boxPk")), fromB64(it.str("boxSk"))) }
        for (case in v.getValue("sealed").jsonArray.map { it.jsonObject }) {
            val name = case.str("name")
            val item = ProtocolJson.decodeFromJsonElement(SealedItem.serializer(), case.getValue("item"))
            val me = case.str("recipient")
            val run = { envelopes.open(item, me, box(me), dir) }
            val expect = case.getValue("expect").jsonObject
            val error = expect.opt("error")
            if (error != null) {
                assertEquals(name, error.str, code { run() })
                continue
            }
            val opened = run()
            assertEquals(name, expect.str("signer"), opened.signer.id)
            assertEquals(name, expect.getValue("body"), parseJsonText(opened.bodyText))
            // The typed parse round-trips to the same body, so nothing the vectors carry is dropped.
            assertEquals(name, parseBody(item.kind, opened.bodyText), opened.body)
        }
    }

    @Test
    fun pairing() {
        val v = load("pairing.json")
        val code = parsePairingCode(v.str("code"))
        assertEquals(v.str("rendezvous"), code.rendezvous)
        assertEquals(v.str("secret"), code.secret)
        assertEquals(v.str("key"), toB64(pairings.key(code)))
        val claim = v.getValue("claim").jsonObject
        assertEquals(claim.str("hash"), pairings.claimHash(claim.str("secret")))

        for (case in v.getValue("parse").jsonArray.map { it.jsonObject }) {
            val got = try {
                parsePairingCode(case.str("input")).formatted()
            } catch (e: ProtocolException) {
                e.code
            }
            assertEquals(case.str("input"), case.str("expect"), got)
        }

        val request = v.getValue("request").jsonObject
        val opened = pairings.openRequest(request.getValue("message"), code)
        assertEquals(request.getValue("body"), ProtocolJson.encodeToJsonElement(opened))
        val approval = v.getValue("approval").jsonObject
        assertEquals(approval.getValue("body"), ProtocolJson.encodeToJsonElement(pairings.openApproval(approval.getValue("message"), code)))

        for (case in v.getValue("bad").jsonArray.map { it.jsonObject }) {
            val c = parsePairingCode(case.str("code"))
            val run = if (case.str("kind") == "request") {
                { pairings.openRequest(case.getValue("message"), c) }
            } else {
                { pairings.openApproval(case.getValue("message"), c) }
            }
            assertEquals(case.str("name"), case.str("expect"), code { run() })
        }

        // The session-bind signature: Ed25519 is deterministic, so the bytes match.
        val bind = v.getValue("bind").jsonObject
        val message = dev.starbridge.app.protocol.bindMessage(bind.str("account"), bind.str("member"), bind.str("nonce"))
        assertEquals(bind.str("message"), toB64(message))
        val phoneSk = fromB64(keys.getValue("members").jsonArray.map { it.jsonObject }.first { it.str("id") == bind.str("member") }.str("signSk"))
        assertEquals(bind.str("sig"), toB64(sodium.sign(message, phoneSk)))

        // What this client makes, the vectors' opener accepts.
        val made = pairings.request(opened, code)
        assertEquals(opened, pairings.openRequest(ProtocolJson.encodeToJsonElement(made), code))

        val links = v.getValue("links").jsonArray.map { it.jsonObject }
        assertEquals(links[0].str("link"), pairingLink(links[0].str("server"), code))
        assertEquals(links[0].str("expect"), codeFromLink(links[0].str("link")).formatted())
        for (case in links.drop(1)) {
            val got = try {
                codeFromLink(case.str("input")).formatted()
            } catch (e: ProtocolException) {
                e.code
            }
            assertEquals(case.str("input"), case.str("expect"), got)
        }
    }

    @Test
    fun join() {
        val v = load("join.json")
        fun pair(name: String) = v.getValue(name).jsonObject.let { KeyPair(fromB64(it.str("publicKey")), fromB64(it.str("privateKey"))) }
        val seeded = sodium.boxSeedKeyPair(fromB64(v.getValue("joiner").jsonObject.str("seed")))
        assertEquals(v.getValue("joiner").jsonObject.str("publicKey"), toB64(seeded.public))
        val request = v.getValue("request").jsonObject
        val text = request.str("text")
        val body = ProtocolJson.decodeFromJsonElement(JoinRequestBody.serializer(), request.getValue("body"))
        assertEquals(text, joins.request(body))
        assertEquals(body, joins.openRequest(text))
        assertEquals(v.str("commitment"), joins.commitment(pair("joiner").public, text))

        val approver = joins.approverKeys(pair("approver"), v.getValue("joiner").jsonObject.str("publicKey"), text, v.str("commitment"))
        val joiner = joins.joinerKeys(pair("joiner"), v.getValue("approver").jsonObject.str("publicKey"), text)
        assertEquals(v.str("digits"), approver.digits)
        assertEquals(v.str("digits"), joiner.digits)
        assertEquals(v.str("mac"), toB64(joiner.mac))
        val approval = v.getValue("approval").jsonObject
        assertEquals(approval.getValue("message"), ProtocolJson.encodeToJsonElement(joins.approval(ProtocolJson.decodeFromJsonElement(dev.starbridge.app.protocol.JoinApprovalBody.serializer(), approval.getValue("body")), approver)))
        assertEquals(approval.getValue("body"), ProtocolJson.encodeToJsonElement(joins.openApproval(approval.getValue("message"), joiner, body.join)))

        for (case in v.getValue("bad").jsonArray.map { it.jsonObject }) {
            val got = code {
                when (case.str("side")) {
                    "approver" -> joins.approverKeys(pair("approver"), case.str("joinerKey"), case.str("request"), case.str("commitment"))
                    "joiner" -> joins.joinerKeys(pair("joiner"), case.str("approverKey"), case.str("request"))
                    else -> joins.openApproval(case.getValue("message"), joiner, body.join)
                }
            }
            assertEquals(case.str("name"), case.str("expect"), got)
        }
    }

    @Test
    fun schemas() {
        val v = load("schemas.json")
        for (kind in listOf("decision", "answer", "permission", "permission-answer", "settled", "waiting", "run")) {
            for (case in v.getValue(kind).jsonArray.map { it.jsonObject }) {
                val valid = try {
                    parseBody(kind, case.getValue("body").toString())
                    true
                } catch (e: ProtocolException) {
                    false
                }
                assertEquals("$kind: ${case.str("name")}", case.getValue("valid").jsonPrimitive.boolean, valid)
            }
        }
    }

    @Test
    fun recoveryWords() {
        for (name in listOf("recovery", "recovery12")) {
            val recovery = keys.getValue(name).jsonObject
            assertEquals(recovery.str("seed"), toB64(Bip39.mnemonicToEntropy(recovery.str("words"))))
            assertEquals(recovery.str("words"), Bip39.entropyToMnemonic(fromB64(recovery.str("seed"))))
            assertEquals(recovery.str("signPk"), toB64(sodium.signSeedKeyPair(recoverySignSeed(fromB64(recovery.str("seed")), sodium)).public))
        }
    }

    @Test
    fun recoveryKey() {
        val recovery = keys.getValue("recovery12").jsonObject
        val key = recovery.str("key")
        assertEquals(key, RecoveryKeys.encode(fromB64(recovery.str("seed")), sodium))
        for (typed in listOf(key, key.lowercase(), key.replace("-", ""), key.replace("-", " "), key.replace('0', 'O').replace('1', 'l'), recovery.str("words"))) {
            assertEquals(recovery.str("seed"), toB64(RecoveryKeys.seed(typed, sodium)))
        }
        assertEquals("Character 5, \"U\", is not in a recovery key.", RecoveryKeys.read(key.take(5) + "U" + key.drop(6)).problem)
        assertEquals("A character is wrong. Check each group against what you wrote down.", RecoveryKeys.read(key.take(5) + (if (key[5] == '2') '3' else '2') + key.drop(6), sodium).problem)
        assertEquals(null, RecoveryKeys.read(key.take(9)).problem)
        assertEquals("A recovery key has 28 characters; this has 8.", RecoveryKeys.read(key.take(9), sodium).problem)
        assertEquals(true, RecoveryKeys.read(keys.getValue("recovery").jsonObject.str("words")).words)
    }

    @Test
    fun recoveryWordEntry() {
        val words = keys.getValue("recovery12").jsonObject.str("words").split(" ")
        for (typed in listOf(words.joinToString("-"), words.joinToString(", "), words.mapIndexed { i, w -> "${i + 1}. $w" }.joinToString("\n"), words.joinToString("  ").uppercase())) {
            assertEquals(words, Bip39.split(typed))
            assertEquals(null, Bip39.problem(Bip39.split(typed)))
        }
        assertEquals("Word 3, \"mountian\", is not on the word list.", Bip39.problem(words.toMutableList().also { it[2] = "mountian" }))
        assertEquals("Older accounts recover with 12 or 24 words; this has 11.", Bip39.problem(words.drop(1)))
        assertEquals("One word is wrong, or two are swapped. Check each word and the order.", Bip39.problem(listOf(words[1], words[0]) + words.drop(2)))
    }

    /** Entries this client writes pass its own verifier, and so the vectors' rules. */
    @Test
    fun writtenEntriesVerify() {
        val members = keys.getValue("members").jsonArray.map { it.jsonObject }
        fun member(id: String) = members.first { it.str("id") == id }.let {
            Member(id, it.str("role"), it.str("name"), it.str("boxPk"), it.str("signPk")) to fromB64(it.str("signSk"))
        }
        val (phone, phoneSk) = member("phone")
        val (devbox, _) = member("devbox")
        val recovery = sodium.signSeedKeyPair(fromB64(keys.getValue("recovery").jsonObject.str("seed")))
        val at = "2026-10-04T10:00:00Z"
        val genesis = directories.genesisEntry("acct_1", phone, phoneSk, recovery, at)
        val json = { e: SignedEnvelope -> ProtocolJson.encodeToJsonElement(e) }
        var dir = directories.verify(listOf(json(genesis)), account = "acct_1", recoveryPk = toB64(recovery.public))
        val add = directories.addEntry(dir, phone.id, phoneSk, devbox, at)
        dir = directories.verify(listOf(json(genesis), json(add)))
        val revoke = directories.revokeEntry(dir, phone.id, phoneSk, devbox.id, at)
        dir = directories.verify(listOf(json(genesis), json(add), json(revoke)), pin = dir.let { Pin(it.length, it.head) })
        assertEquals(listOf("phone"), dir.active("device").map { it.id })
        assertEquals(emptyList<Member>(), dir.active("machine"))
    }

    /** An answer this client seals opens for the machine that asked, and only names it. */
    @Test
    fun sealedAnswerOpensForTheMachine() {
        val dir = directories.verify(directory.getValue("cases").jsonArray[0].jsonObject.getValue("entries").jsonArray)
        val members = keys.getValue("members").jsonArray.map { it.jsonObject }
        fun key(id: String, k: String) = fromB64(members.first { it.str("id") == id }.str(k))
        val body = kotlinx.serialization.json.buildJsonObject {
            put("v", kotlinx.serialization.json.JsonPrimitive(1))
            put("id", kotlinx.serialization.json.JsonPrimitive("ans_9"))
            put("decisionId", kotlinx.serialization.json.JsonPrimitive("dec_1"))
            put("to", kotlinx.serialization.json.JsonPrimitive("devbox"))
            put("answeredAt", kotlinx.serialization.json.JsonPrimitive("2026-10-04T10:03:00Z"))
            put("choice", kotlinx.serialization.json.JsonPrimitive("Yes"))
        }
        val machine = dir.members.getValue("devbox").member
        val item = envelopes.seal("answer", body, "phone", key("phone", "signSk"), listOf(machine))
        assertEquals("dec_1", item.re)
        val opened = envelopes.open(item, "devbox", KeyPair(key("devbox", "boxPk"), key("devbox", "boxSk")), dir)
        assertEquals("phone", opened.signer.id)
        val browser = dir.members.getValue("browser").member
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            envelopes.seal("answer", body, "phone", key("phone", "signSk"), listOf(machine, browser))
        }
    }
}

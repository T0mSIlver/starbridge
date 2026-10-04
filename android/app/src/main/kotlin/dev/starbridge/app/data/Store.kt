package dev.starbridge.app.data

import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/** What the screens read and do. Fake data until the server (#5) and the wiring (#9). */
interface Store {
    val setUp: StateFlow<Boolean>
    val decisions: StateFlow<List<Decision>>
    val windows: StateFlow<List<QuotaWindow>>
    val members: StateFlow<List<Member>>
    val pairings: StateFlow<List<Pairing>>
    val recoveryWords: List<String>

    fun finishSetup()
    fun answer(id: String, answer: String)
    fun approve(pairingId: String)
    fun deny(pairingId: String)
    fun revoke(memberId: String)
}

@Singleton
class FakeStore @Inject constructor() : Store {
    private val fake = Fake(Instant.now())

    override val setUp = MutableStateFlow(false)
    override val decisions = MutableStateFlow(fake.decisions)
    override val windows = MutableStateFlow(fake.windows)
    override val members = MutableStateFlow(fake.members)
    override val pairings = MutableStateFlow(fake.pairings)
    override val recoveryWords = fake.recoveryWords

    override fun finishSetup() {
        setUp.value = true
    }

    override fun answer(id: String, answer: String) {
        decisions.update { all -> all.map { if (it.id == id) it.copy(answer = answer, answeredAt = Instant.now()) else it } }
    }

    override fun approve(pairingId: String) {
        val pairing = pairings.value.find { it.id == pairingId } ?: return
        pairings.update { all -> all.filterNot { it.id == pairingId } }
        members.update { it + Member(pairing.id, pairing.machine, Kind.Machine, Instant.now()) }
    }

    override fun deny(pairingId: String) {
        pairings.update { all -> all.filterNot { it.id == pairingId } }
    }

    override fun revoke(memberId: String) {
        members.update { all -> all.filterNot { it.id == memberId && !it.current } }
    }
}

@Module
@InstallIn(SingletonComponent::class)
abstract class StoreModule {
    @Binds abstract fun store(fake: FakeStore): Store
}

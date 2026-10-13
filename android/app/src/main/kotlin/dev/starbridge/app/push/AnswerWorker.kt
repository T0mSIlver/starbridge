package dev.starbridge.app.push

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.starbridge.app.di.app
import java.util.concurrent.TimeUnit

/** Sends the answers tapped offline once a network is up, the app closed or not (#329). */
class AnswerWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = if (applicationContext.app().store().flushAnswers()) Result.success() else Result.retry()

    companion object {
        /**
         * One run at a time, and it sends every queued answer. A new failure replaces a run waiting
         * in backoff, so the answer goes now rather than after an earlier answer's backoff (#1390).
         * Only the store calls this, holding its lock, so the run it replaces is never mid-post;
         * the worker's own failures retry by its backoff instead.
         */
        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<AnswerWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("answers", ExistingWorkPolicy.REPLACE, request)
        }
    }
}

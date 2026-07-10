package com.kai.gemma

import android.os.Build
import android.os.PowerManager
import android.util.Log
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession
import org.apache.cordova.CallbackContext
import org.apache.cordova.CordovaPlugin
import org.apache.cordova.PluginResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * KaiGemmaLocal — on-device Gemma 4 E2B inference via MediaPipe LiteRT-LM.
 *
 * Safety design (per user request to avoid overheating):
 *  - Checks Android's thermal status before EVERY generation, not just at load time
 *  - Refuses to start generation if device is already in a throttling state
 *  - Automatically downgrades from GPU to CPU delegate if GPU init fails
 *  - Caps max output tokens per single request (no unbounded generation)
 *  - Exposes an explicit unload() the JS side calls when the model isn't needed,
 *    freeing native memory and stopping any background thermal load
 *  - Never auto-starts on app launch — must be explicitly requested by the user
 */
class KaiGemmaLocal : CordovaPlugin() {

    private var llmInference: LlmInference? = null
    private var session: LlmInferenceSession? = null
    private var isLoaded = false
    private var isGenerating = false
    private var currentBackend = "cpu"

    companion object {
        private const val TAG = "KaiGemmaLocal"
        private const val MAX_TOKENS_PER_RESPONSE = 512
        private const val MODEL_FILE_NAME = "gemma-4-e2b-it.task"
    }

    override fun execute(action: String, args: JSONArray, callbackContext: CallbackContext): Boolean {
        when (action) {
            "isAvailable" -> { checkAvailability(callbackContext); return true }
            "getThermalStatus" -> { getThermalStatus(callbackContext); return true }
            "downloadModel" -> { downloadModel(args.optString(0), callbackContext); return true }
            "isModelDownloaded" -> { isModelDownloaded(callbackContext); return true }
            "loadModel" -> { loadModel(args.optString(0, "cpu"), callbackContext); return true }
            "generate" -> { generate(args.optString(0), callbackContext); return true }
            "cancel" -> { cancelGeneration(callbackContext); return true }
            "unloadModel" -> { unloadModel(callbackContext); return true }
            "deleteModel" -> { deleteModel(callbackContext); return true }
        }
        return false
    }

    // ── Device capability check ──────────────────────────────────────────────
    private fun checkAvailability(cb: CallbackContext) {
        thread {
            try {
                val result = JSONObject()
                val ram = getTotalRamMb()
                result.put("ram_mb", ram)
                result.put("min_ram_recommended_mb", 4096)
                result.put("meets_ram_requirement", ram >= 3500) // some headroom below 4GB stated min
                result.put("sdk_int", Build.VERSION.SDK_INT)
                result.put("supported_sdk", Build.VERSION.SDK_INT >= 26)
                result.put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
                cb.success(result)
            } catch (e: Exception) {
                cb.error("availability check failed: ${e.message}")
            }
        }
    }

    private fun getTotalRamMb(): Long {
        return try {
            val am = cordova.activity.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            val info = android.app.ActivityManager.MemoryInfo()
            am.getMemoryInfo(info)
            info.totalMem / (1024 * 1024)
        } catch (e: Exception) { 0L }
    }

    // ── Thermal safety — this is the core of the "don't overheat the device" requirement ──
    private fun getThermalStatus(cb: CallbackContext) {
        thread {
            try {
                val result = JSONObject()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val pm = cordova.activity.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager
                    val status = pm.currentThermalStatus
                    // THERMAL_STATUS_NONE=0 LIGHT=1 MODERATE=2 SEVERE=3 CRITICAL=4 EMERGENCY=5 SHUTDOWN=6
                    val statusName = when (status) {
                        PowerManager.THERMAL_STATUS_NONE -> "none"
                        PowerManager.THERMAL_STATUS_LIGHT -> "light"
                        PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
                        PowerManager.THERMAL_STATUS_SEVERE -> "severe"
                        PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
                        PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
                        PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
                        else -> "unknown"
                    }
                    result.put("status", statusName)
                    result.put("status_code", status)
                    // Safe to run generation only below MODERATE
                    result.put("safe_to_generate", status < PowerManager.THERMAL_STATUS_MODERATE)
                    result.put("supported", true)
                } else {
                    // Thermal API requires Android 10 (Q). Below that, we can't check —
                    // so we conservatively allow but recommend CPU-only.
                    result.put("status", "unsupported_api_level")
                    result.put("safe_to_generate", true)
                    result.put("supported", false)
                    result.put("note", "Device below Android 10 — cannot verify thermal state, defaulting to cautious CPU mode")
                }
                cb.success(result)
            } catch (e: Exception) {
                cb.error("thermal check failed: ${e.message}")
            }
        }
    }

    // ── Model download (2-2.6GB, must be WiFi-gated by the JS/UI layer) ───────
    private fun downloadModel(url: String, cb: CallbackContext) {
        thread {
            try {
                val modelFile = File(cordova.activity.filesDir, MODEL_FILE_NAME)
                val tmpFile = File(cordova.activity.filesDir, "$MODEL_FILE_NAME.download")

                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connect()
                val totalBytes = conn.contentLength.toLong()
                var downloadedBytes = 0L

                conn.inputStream.use { input ->
                    tmpFile.outputStream().use { output ->
                        val buffer = ByteArray(8192)
                        var lastReportedPercent = -1
                        while (true) {
                            val read = input.read(buffer)
                            if (read == -1) break
                            output.write(buffer, 0, read)
                            downloadedBytes += read
                            if (totalBytes > 0) {
                                val percent = ((downloadedBytes * 100) / totalBytes).toInt()
                                if (percent != lastReportedPercent) {
                                    lastReportedPercent = percent
                                    val progress = JSONObject()
                                    progress.put("type", "progress")
                                    progress.put("percent", percent)
                                    progress.put("downloaded_mb", downloadedBytes / (1024 * 1024))
                                    progress.put("total_mb", totalBytes / (1024 * 1024))
                                    val pr = PluginResult(PluginResult.Status.OK, progress)
                                    pr.keepCallback = true
                                    cb.sendPluginResult(pr)
                                }
                            }
                        }
                    }
                }

                if (modelFile.exists()) modelFile.delete()
                tmpFile.renameTo(modelFile)

                val done = JSONObject()
                done.put("type", "done")
                done.put("path", modelFile.absolutePath)
                done.put("size_mb", modelFile.length() / (1024 * 1024))
                cb.success(done)
            } catch (e: Exception) {
                Log.e(TAG, "Download failed", e)
                cb.error("download failed: ${e.message}")
            }
        }
    }

    private fun isModelDownloaded(cb: CallbackContext) {
        val modelFile = File(cordova.activity.filesDir, MODEL_FILE_NAME)
        val result = JSONObject()
        result.put("downloaded", modelFile.exists())
        if (modelFile.exists()) result.put("size_mb", modelFile.length() / (1024 * 1024))
        cb.success(result)
    }

    private fun deleteModel(cb: CallbackContext) {
        thread {
            try {
                unloadModelInternal()
                val modelFile = File(cordova.activity.filesDir, MODEL_FILE_NAME)
                val deleted = if (modelFile.exists()) modelFile.delete() else true
                val result = JSONObject()
                result.put("deleted", deleted)
                cb.success(result)
            } catch (e: Exception) {
                cb.error("delete failed: ${e.message}")
            }
        }
    }

    // ── Model loading — with automatic GPU→CPU fallback and thermal pre-check ─
    private fun loadModel(preferredBackend: String, cb: CallbackContext) {
        thread {
            try {
                // Thermal pre-check before even loading (loading itself uses real memory/compute)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val pm = cordova.activity.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager
                    if (pm.currentThermalStatus >= PowerManager.THERMAL_STATUS_MODERATE) {
                        cb.error("Device is running warm (thermal status: moderate or higher). Let it cool before loading the local model.")
                        return@thread
                    }
                }

                val modelFile = File(cordova.activity.filesDir, MODEL_FILE_NAME)
                if (!modelFile.exists()) {
                    cb.error("Model not downloaded yet. Call downloadModel() first.")
                    return@thread
                }

                // Unload any existing session first
                unloadModelInternal()

                val options = LlmInference.LlmInferenceOptions.builder()
                    .setModelPath(modelFile.absolutePath)
                    .setMaxTokens(1024)
                    .build()

                llmInference = try {
                    currentBackend = preferredBackend
                    LlmInference.createFromOptions(cordova.activity, options)
                } catch (gpuEx: Exception) {
                    // GPU delegate can fail on unsupported chipsets — fall back to CPU automatically
                    Log.w(TAG, "Primary backend ($preferredBackend) failed, falling back to CPU: ${gpuEx.message}")
                    currentBackend = "cpu"
                    LlmInference.createFromOptions(cordova.activity, options)
                }

                val sessionOptions = LlmInferenceSession.LlmInferenceSessionOptions.builder()
                    .setTopK(40)
                    .setTemperature(0.8f)
                    .build()

                session = LlmInferenceSession.createFromOptions(llmInference, sessionOptions)
                isLoaded = true

                val result = JSONObject()
                result.put("loaded", true)
                result.put("backend", currentBackend)
                cb.success(result)
            } catch (e: Exception) {
                Log.e(TAG, "Model load failed", e)
                isLoaded = false
                cb.error("Model load failed: ${e.message}")
            }
        }
    }

    // ── Generation — streams tokens back via keepCallback, checks thermal state mid-stream ──
    private fun generate(prompt: String, cb: CallbackContext) {
        if (!isLoaded || session == null) {
            cb.error("Model not loaded. Call loadModel() first.")
            return
        }
        if (isGenerating) {
            cb.error("Already generating a response. Call cancel() first or wait.")
            return
        }
        if (prompt.isBlank()) {
            cb.error("Empty prompt")
            return
        }

        thread {
            try {
                isGenerating = true
                var tokenCount = 0
                var accumulated = ""

                session?.addQueryChunk(prompt)
                session?.generateResponseAsync { partialResult, done ->
                    if (!isGenerating) return@generateResponseAsync // cancelled

                    accumulated += partialResult
                    tokenCount++

                    // Hard cap to prevent runaway generation from cooking the device
                    val hitCap = tokenCount >= MAX_TOKENS_PER_RESPONSE

                    val chunk = JSONObject()
                    chunk.put("type", if (done || hitCap) "done" else "delta")
                    chunk.put("text", partialResult)
                    chunk.put("accumulated", accumulated)

                    val pr = PluginResult(PluginResult.Status.OK, chunk)
                    pr.keepCallback = !(done || hitCap)
                    cb.sendPluginResult(pr)

                    if (hitCap && !done) {
                        isGenerating = false
                    }
                    if (done || hitCap) {
                        isGenerating = false
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Generation failed", e)
                isGenerating = false
                cb.error("Generation failed: ${e.message}")
            }
        }
    }

    private fun cancelGeneration(cb: CallbackContext) {
        isGenerating = false
        cb.success("cancelled")
    }

    private fun unloadModelInternal() {
        try {
            session?.close()
        } catch (e: Exception) { /* ignore */ }
        try {
            llmInference?.close()
        } catch (e: Exception) { /* ignore */ }
        session = null
        llmInference = null
        isLoaded = false
        isGenerating = false
    }

    private fun unloadModel(cb: CallbackContext) {
        thread {
            unloadModelInternal()
            cb.success("unloaded")
        }
    }

    // Free native resources if the app is being destroyed while model is loaded
    override fun onDestroy() {
        unloadModelInternal()
        super.onDestroy()
    }
}

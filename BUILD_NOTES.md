# KAI Build System — Debugging Log & Architecture Notes

This file documents non-obvious decisions in the CI/build pipeline so future changes don't
accidentally reintroduce fixed bugs. Read this before touching `.github/workflows/build-apk.yml`
or anything under `plugins/`.

## On-device Gemma 4 E2B local model — build failure chain (2026-07-10/11)

### The goal
Add `cordova-plugin-kai-gemma`, a native Kotlin plugin wrapping MediaPipe's `tasks-genai`
(LlmInference API) for on-device Gemma 4 E2B inference, with thermal-safety checks before
every generation to avoid overheating the device.

### Bugs found, in the order they were hit

1. **Missing `package.json`** — Cordova requires any locally-referenced plugin
   (`cordova plugin add ../path/to/plugin`) to have a `package.json` alongside `plugin.xml`,
   even though `plugin.xml` alone is sufficient for npm-published plugins. Without it:
   `Invalid Plugin! plugins/cordova-plugin-kai-gemma needs a valid package.json`.
   **Fixed**: added `plugins/cordova-plugin-kai-gemma/package.json`.

2. **Wrong Maven coordinate** — `com.google.mediapipe:tasks-genai:0.10.27` does not exist on
   Maven Central. The confirmed-published version at time of writing is `0.10.24`.
   **Fixed**: pinned to `0.10.24` in `plugin.xml`'s `<framework>` tag.

3. **`cordova-android@12`'s bundled Gradle wrapper is 7.6`, not whatever version is
   system-installed** — the CI step "Pin Gradle 8.7" downloads a system Gradle binary and
   sets `GRADLE_HOME`/`PATH`, but this has **no effect** on the actual build, because
   `cordova build android` invokes the project's own `gradlew` script, which always uses
   the Gradle version pinned in `platforms/android/gradle/wrapper/gradle-wrapper.properties`
   — a file `cordova platform add android@12` generates fresh, ignoring system Gradle entirely.
   **Fixed**: after `cordova platform add android@12`, explicitly overwrite
   `platforms/android/gradle/wrapper/gradle-wrapper.properties` to force Gradle 8.9.

4. **`Unsupported class file major version 65` from Jetifier — the actual root cause.**
   `tasks-genai`'s AAR contains classes compiled with a newer javac targeting Java 21
   bytecode (class file major version 65). This error came from **Jetifier**, a Gradle
   build-time tool that rewrites legacy `android.support.*` package references into
   AndroidX equivalents. Cordova enables Jetifier by default
   (`android.enableJetifier=true` in `gradle.properties`) because older Cordova plugins used
   to depend on the Support Library. Jetifier's own bytecode parser can't read Java 21
   class files and throws `IllegalArgumentException` on ANY dependency compiled that way,
   regardless of what JDK the rest of the build runs under.
   **The actual fix**: since all plugins in this app (file, inappbrowser,
   android-permissions, kai-gemma) are already AndroidX-native and have zero legitimate
   Support Library references to convert, Jetifier has nothing to do — so disable it
   entirely: `android.enableJetifier=false` in `platforms/android/gradle.properties`,
   set right after the wrapper override, before any `cordova plugin add` calls.

   **Important**: earlier attempts (bumping CI's JDK to 21, forcing `JAVA_HOME` via
   `JAVA_HOME_21_X64`) were addressing the wrong layer — they change what JDK *compiles*
   the project, not what JVM Jetifier's *transform step* runs under, and Jetifier is what
   was actually failing. Those changes are harmless to leave in place but were not the fix.

### Reference material used
- Google's own `mediapipe-samples` repo (specifically the `pose_landmarker` Android example,
  same MediaPipe Tasks family) uses `compileSdk 33`, `minSdk 24`, Java 8 source/target
  compatibility — evidence that the bytecode-version problem is about the pre-built AAR
  itself, not about what compileOptions the consuming app declares.
- Google's LLM Inference API docs note it is **"in maintenance-only mode"** and recommend
  migrating to **LiteRT-LM** for new projects — worth revisiting if `tasks-genai` continues
  to be troublesome; LiteRT-LM may have cleaner AndroidX/Jetifier compatibility.

## Why cordova-android@12 needs minSdkVersion 26

MediaPipe's LLM Inference API requires Android 8.0 (API 26) minimum. The app's default
`minSdkVersion` was 22 (Android 5.1) — bumped to 26 in `config.xml`. This raises the real
minimum supported device for the whole app, not just the local-model feature — worth
knowing if minSdk ever needs lowering again for unrelated reasons (that would break Gemma).

## Thermal safety design (KaiGemmaLocal.kt)

Per explicit request to avoid overheating devices during on-device inference:
- Checks `PowerManager.currentThermalStatus` (Android 10+/API 29+) before EVERY load AND
  every generate call, not just once at startup
- Refuses to start if status >= `THERMAL_STATUS_MODERATE`
- Hard caps output at 512 tokens per response (no unbounded generation loops)
- GPU backend attempt auto-falls-back to CPU if GPU delegate init throws
- Explicit `unloadModel()` frees native memory; called automatically when user switches
  away from the local model in the picker
- Below API 29 (no thermal API access): defaults to allowing generation but the JS layer
  should bias toward CPU backend and shorter responses since there's no way to verify
  device temperature at all on those OS versions

## Known unresolved risk

A recent MediaPipe GitHub issue reports SIGSEGV (native crash) using `tasks-genai` v0.10.26
built from source, unrelated to our specific version. `tasks-genai` as a package has shown
more instability than the rest of the MediaPipe Tasks suite recently. If native crashes
occur on-device after this build succeeds, consider migrating to LiteRT-LM directly instead
of continuing to patch around `tasks-genai`.

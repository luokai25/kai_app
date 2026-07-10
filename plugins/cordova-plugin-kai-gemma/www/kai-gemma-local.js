// KaiGemmaLocal — JS bridge to the native Gemma 4 E2B on-device inference plugin
// Wraps cordova.exec calls with a clean Promise-based API for app.js to use.

var KaiGemmaLocal = {

  // Check device meets minimum requirements (RAM, SDK version)
  isAvailable: function() {
    return new Promise(function(resolve, reject) {
      cordova.exec(resolve, reject, 'KaiGemmaLocal', 'isAvailable', []);
    });
  },

  // Check current thermal status — MUST be checked before loading/generating
  getThermalStatus: function() {
    return new Promise(function(resolve, reject) {
      cordova.exec(resolve, reject, 'KaiGemmaLocal', 'getThermalStatus', []);
    });
  },

  // Check if model file already downloaded to device
  isModelDownloaded: function() {
    return new Promise(function(resolve, reject) {
      cordova.exec(resolve, reject, 'KaiGemmaLocal', 'isModelDownloaded', []);
    });
  },

  // Download model with progress callback. onProgress({percent, downloaded_mb, total_mb})
  downloadModel: function(url, onProgress) {
    return new Promise(function(resolve, reject) {
      cordova.exec(function(result) {
        if (result && result.type === 'progress') {
          if (onProgress) onProgress(result);
        } else {
          resolve(result);
        }
      }, reject, 'KaiGemmaLocal', 'downloadModel', [url]);
    });
  },

  // Load the model. backend: 'gpu' or 'cpu'. Auto-falls-back to CPU if GPU unavailable.
  loadModel: function(backend) {
    return new Promise(function(resolve, reject) {
      cordova.exec(resolve, reject, 'KaiGemmaLocal', 'loadModel', [backend || 'cpu']);
    });
  },

  // Generate a response. onDelta(text) called per token/chunk, resolves with full text when done.
  generate: function(prompt, onDelta) {
    return new Promise(function(resolve, reject) {
      cordova.exec(function(result) {
        if (result.type === 'delta') {
          if (onDelta) onDelta(result.text, result.accumulated);
        } else if (result.type === 'done') {
          if (onDelta) onDelta(result.text, result.accumulated);
          resolve(result.accumulated);
        }
      }, reject, 'KaiGemmaLocal', 'generate', [prompt]);
    });
  },

  // Cancel an in-progress generation
  cancel: function() {
    return new Promise(function(resolve, reject) {
      cordova.exec(resolve, reject, 'KaiGemmaLocal', 'cancel', []);
    });
  },

  // Unload model from memory (call when switching away from local model)
  unloadModel: function() {
    return new Promise(function(resolve, reject) {
      cordova.exec(resolve, reject, 'KaiGemmaLocal', 'unloadModel', []);
    });
  },

  // Delete the downloaded model file entirely (frees disk space)
  deleteModel: function() {
    return new Promise(function(resolve, reject) {
      cordova.exec(resolve, reject, 'KaiGemmaLocal', 'deleteModel', []);
    });
  }
};

module.exports = KaiGemmaLocal;

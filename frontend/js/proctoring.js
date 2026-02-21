/**
 * proctoring.js
 * Handles: Webcam, Microphone, Tab-Switch, Fullscreen, BeforeUnload
 */

window.Proctor = (() => {
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let micAnimFrame = null;
  let noiseViolationTimeout = null;
  let onViolationCallback = null;
  let quizActive = false;

  // ─── Init (request permissions) ───────────────────────────────────────────
  async function init() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      _startCamera();
      _startMic();
      return true;
    } catch (err) {
      console.error('Proctor: Permission denied', err);
      return false;
    }
  }

  function _startCamera() {
    const video = document.getElementById('cam-preview');
    if (video && stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
      const dot = document.getElementById('cam-dot');
      const lbl = document.getElementById('cam-label');
      if (dot) dot.classList.remove('red');
      if (lbl) lbl.textContent = 'Camera Active';
    }
  }

  function _startMic() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      _monitorNoise();
    } catch (e) {
      console.warn('Proctor: Mic monitor failed', e);
    }
  }

  // Noise level: average 0-255, threshold ~60 for "unusual"
  const NOISE_THRESHOLD = 60;
  const NOISE_DURATION_MS = 3000;
  let noiseTriggerStart = null;

  function _monitorNoise() {
    const dataArr = new Uint8Array(analyser.frequencyBinCount);
    const micBar = document.getElementById('mic-bar');

    function tick() {
      analyser.getByteFrequencyData(dataArr);
      const avg = dataArr.reduce((s, v) => s + v, 0) / dataArr.length;
      const pct = Math.min(100, (avg / 128) * 100);

      if (micBar) {
        micBar.style.width = pct + '%';
        micBar.style.background = pct > 50 ? 'var(--pink)' : pct > 25 ? 'var(--yellow)' : 'var(--lime)';
      }

      if (quizActive && avg > NOISE_THRESHOLD) {
        if (!noiseTriggerStart) noiseTriggerStart = Date.now();
        else if (Date.now() - noiseTriggerStart > NOISE_DURATION_MS) {
          noiseTriggerStart = null;
          _triggerViolation('noise', 'Unusual noise detected');
        }
      } else {
        noiseTriggerStart = null;
      }
      micAnimFrame = requestAnimationFrame(tick);
    }
    tick();
  }

  // ─── Tab / Visibility ──────────────────────────────────────────────────────
  function _setupTabDetection() {
    document.addEventListener('visibilitychange', () => {
      if (!quizActive) return;
      if (document.hidden) {
        _triggerViolation('tab_switch', 'Tab switched — quiz auto-failed');
      }
    });
  }

  // ─── Fullscreen ────────────────────────────────────────────────────────────
  function requestFullscreen() {
    const el = document.documentElement;
    return (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen).call(el);
  }

  function _setupFullscreenDetection() {
    document.addEventListener('fullscreenchange', () => {
      if (!quizActive) return;
      if (!document.fullscreenElement) {
        _triggerViolation('fullscreen_exit', 'Fullscreen exited — violation logged');
      }
    });
  }

  // ─── BeforeUnload ─────────────────────────────────────────────────────────
  function _setupBeforeUnload() {
    window.addEventListener('beforeunload', (e) => {
      if (!quizActive) return;
      // Force fail via sendBeacon (synchronous-safe)
      const qid = window._quizId;
      const token = localStorage.getItem('token');
      const started = window._startedAt;
      if (qid && token) {
        const payload = JSON.stringify({ answers: {}, started_at: started || new Date().toISOString(), force_fail: true });
        navigator.sendBeacon(
          `http://localhost:8000/quiz/${qid}/submit?_beaconToken=${encodeURIComponent(token)}`,
          new Blob([payload], { type: 'application/json' })
        );
      }
      e.preventDefault();
      e.returnValue = '';
    });
  }

  // ─── Violation Handler ─────────────────────────────────────────────────────
  function _triggerViolation(type, message) {
    console.warn('🚨 Violation:', type, message);
    if (onViolationCallback) {
      onViolationCallback(type, message);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  function activate(quizId, startedAt, violationCallback) {
    quizActive = true;
    window._quizId = quizId;
    window._startedAt = startedAt;
    onViolationCallback = violationCallback;
    _setupTabDetection();
    _setupFullscreenDetection();
    _setupBeforeUnload();
  }

  function deactivate() {
    quizActive = false;
    if (micAnimFrame) cancelAnimationFrame(micAnimFrame);
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    const dot = document.getElementById('cam-dot');
    const lbl = document.getElementById('cam-label');
    if (dot) dot.classList.add('red');
    if (lbl) lbl.textContent = 'Camera Off';
  }

  return { init, activate, deactivate, stopCamera, requestFullscreen };
})();

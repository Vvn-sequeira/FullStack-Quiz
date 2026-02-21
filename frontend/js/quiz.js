/**
 * quiz.js
 * Main quiz logic: load questions, timer, answers, submission, violations
 */

const API = "https://fullstack-quiz-mhq2.onrender.com";
const token = localStorage.getItem('token');
const role  = localStorage.getItem('role');

if (!token || role !== 'student') window.location.href = 'login.html';

// ─── State ──────────────────────────────────────────────────────────────────
let questions     = [];
let answers       = {};
let timerInterval = null;
let timeLeft      = 0;
let startedAt     = null;
let quizId        = null;
let quizTitle     = '';
let violationCount = 0;
let submitted     = false;

// ─── URL params ─────────────────────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
quizId = urlParams.get('id');
if (!quizId) window.location.href = 'dashboard.html';

function authH() {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// ─── Load quiz info ──────────────────────────────────────────────────────────
async function loadQuizSetup() {
  try {
    const res = await fetch(`${API}/quiz/${quizId}/questions`, { headers: authH() });
    if (!res.ok) throw new Error('Quiz not found');
    const data = await res.json();
    questions = data.questions || [];
    quizTitle = data.title;
    timeLeft  = data.duration_minutes * 60;

    document.getElementById('quiz-setup-title').textContent = data.title;
    document.getElementById('quiz-setup-meta').textContent =
      `${questions.length} Questions  •  ${data.duration_minutes} Minutes`;
    document.getElementById('quiz-title-bar').textContent = data.title;
    document.getElementById('result-quiz-title').textContent = data.title;
  } catch (e) {
    alert('Failed to load quiz. Returning to dashboard.');
    window.location.href = 'dashboard.html';
  }
}

// ─── Start quiz (called by button) ──────────────────────────────────────────
async function startQuiz() {
  const btn = document.getElementById('start-btn');
  btn.textContent = 'Initializing camera...';
  btn.disabled = true;

  // Request webcam + mic
  const granted = await Proctor.init();
  if (!granted) {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('perm-denied').classList.remove('hidden');
    return;
  }

  // Enter fullscreen
  try {
    await Proctor.requestFullscreen();
  } catch (e) {
    console.warn('Fullscreen denied');
  }

  // Show quiz screen
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('quiz-screen').classList.add('visible');

  // Record start time
  startedAt = new Date().toISOString();

  // Activate proctoring
  Proctor.activate(quizId, startedAt, handleViolation);

  // Render questions
  renderQuestions();
  renderNavButtons();
  startTimer();
}

// ─── Render questions ────────────────────────────────────────────────────────
function renderQuestions() {
  const pane = document.getElementById('questions-pane');
  pane.innerHTML = questions.map((q, idx) => `
    <div class="question-card" id="qcard-${idx}">
      <div class="question-num">Question ${idx + 1} of ${questions.length}</div>
      <div class="question-text">${q.question_text}</div>
      <div class="options-grid">
        ${['A','B','C','D'].map(opt => `
          <button class="option-btn" id="opt-${idx}-${opt}" onclick="selectAnswer(${idx},'${opt}','${q._id}')">
            <div class="option-label">${opt}</div>
            <span>${q.options[opt]}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');

  updateProgressText();
}

function renderNavButtons() {
  const nav = document.getElementById('question-nav');
  nav.innerHTML = questions.map((_, i) => `
    <button class="nav-btn" id="nav-${i}" onclick="scrollToQuestion(${i})">${i + 1}</button>
  `).join('');
}

function scrollToQuestion(idx) {
  const el = document.getElementById(`qcard-${idx}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Answer selection ────────────────────────────────────────────────────────
function selectAnswer(qIdx, option, qId) {
  answers[qId] = option;

  // Update option button styles
  ['A','B','C','D'].forEach(o => {
    const btn = document.getElementById(`opt-${qIdx}-${o}`);
    if (btn) btn.classList.toggle('selected', o === option);
  });

  // Update nav button
  const navBtn = document.getElementById(`nav-${qIdx}`);
  if (navBtn) navBtn.classList.add('answered');

  updateProgressText();
}

function updateProgressText() {
  const answered = Object.keys(answers).length;
  document.getElementById('progress-text').textContent = `${answered}/${questions.length} Answered`;
}

// ─── Timer ──────────────────────────────────────────────────────────────────
function startTimer() {
  const timerEl = document.getElementById('timer');
  updateTimerDisplay(timerEl);

  timerInterval = setInterval(() => {
    timeLeft--;
    updateTimerDisplay(timerEl);

    if (timeLeft <= 60) timerEl.classList.add('urgent');
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      submitQuiz(false);
    }
  }, 1000);
}

function updateTimerDisplay(el) {
  const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
  const s = (timeLeft % 60).toString().padStart(2, '0');
  el.textContent = `${m}:${s}`;
}

// ─── Violations ────────────────────────────────────────────────────────────────────
async function handleViolation(type, message) {
  if (submitted) return;

  violationCount++;
  console.log('Violation:', type, '| Count:', violationCount);

  // Report to backend
  try {
    const res = await fetch(`${API}/quiz/${quizId}/violation`, {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify({ violation_type: type })
    });
    const data = await res.json();

    // Backend says FAILED (tab switch or 2+ violations)
    if (data.status === 'FAILED') {
      triggerForceFail(message);
      return;
    }

    // Still has warnings left — show banner
    const warningsLeft = 2 - violationCount;
    showViolationBanner(
      warningsLeft > 0
        ? `⚠️ ${message} — ${warningsLeft} warning${warningsLeft === 1 ? '' : 's'} left!`
        : `⚠️ Last warning used! Submitting as FAIL...`,
      warningsLeft === 0 ? 'danger' : 'warn'
    );

    // Safety: if frontend count already at 0 warnings, force fail too
    if (warningsLeft <= 0) {
      setTimeout(() => triggerForceFail(message), 1500);
    }

  } catch (e) {
    console.error('Failed to report violation', e);
    // Offline fallback: still enforce on tab_switch
    if (type === 'tab_switch' || violationCount >= 2) {
      triggerForceFail(message);
    } else {
      showViolationBanner(`⚠️ ${message} — 1 warning left!`, 'warn');
    }
  }
}

// Force stop & fail the quiz immediately
function triggerForceFail(reason) {
  if (submitted) return;
  clearInterval(timerInterval);
  Proctor.deactivate();

  // Show a full-screen block overlay before submitting
  const overlay = document.createElement('div');
  overlay.id = 'fail-overlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'background:#0a0a0a', 'z-index:99999',
    'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
    'font-family:Space Grotesk,sans-serif', 'color:#fff', 'text-align:center', 'padding:40px'
  ].join(';');
  overlay.innerHTML = `
    <div style="font-size:72px;margin-bottom:20px;">🚫</div>
    <div style="font-size:32px;font-weight:800;text-transform:uppercase;letter-spacing:-1px;color:#FF3BFF;">
      Quiz Terminated
    </div>
    <div style="font-size:16px;font-weight:600;color:rgba(255,255,255,0.6);margin-top:12px;text-transform:uppercase;letter-spacing:1px;">
      ${reason || 'Violation limit reached'}
    </div>
    <div style="margin-top:32px;font-size:13px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:2px;">
      Submitting your attempt as FAIL...
    </div>
  `;
  document.body.appendChild(overlay);

  // Submit after short delay so student sees the message
  setTimeout(() => submitQuiz(true), 2000);
}

function showViolationBanner(text, level = 'warn') {
  const banner = document.getElementById('violation-banner');
  banner.textContent = text;
  banner.style.background = level === 'danger' ? '#FF3BFF' : '#FFE500';
  banner.style.color = '#0a0a0a';
  banner.classList.add('show');
  setTimeout(() => banner.classList.remove('show'), level === 'danger' ? 3000 : 5000);
}

// ─── Submit ──────────────────────────────────────────────────────────────────
function confirmSubmit() {
  const unanswered = questions.length - Object.keys(answers).length;
  let msg = `Submit quiz now?`;
  if (unanswered > 0) msg = `You have ${unanswered} unanswered question(s). ${msg}`;
  if (confirm(msg)) submitQuiz(false);
}

async function submitQuiz(forceFail = false) {
  if (submitted) return;
  submitted = true;
  clearInterval(timerInterval);

  const submitBtn = document.getElementById('submit-btn');
  if (submitBtn) { submitBtn.textContent = 'Submitting...'; submitBtn.disabled = true; }

  // First, create the attempt record if it doesn't exist
  try {
    // If no existing attempt, we need to init one first for violation tracking
    await fetch(`${API}/quiz/${quizId}/violation`, {
      method: 'POST', headers: authH(),
      body: JSON.stringify({ violation_type: '__init__' })
    }).catch(() => {});
  } catch(e) {}

  try {
    const payload = {
      answers,
      started_at: startedAt || new Date().toISOString(),
      force_fail: forceFail,
    };

    const res = await fetch(`${API}/quiz/${quizId}/submit`, {
      method: 'POST',
      headers: authH(),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.detail || 'Submission failed');
      window.location.href = 'dashboard.html';
      return;
    }

    Proctor.deactivate();
    showResult(data);

    // Exit fullscreen
    try { if (document.exitFullscreen) document.exitFullscreen(); } catch(e) {}

  } catch (e) {
    console.error('Submit error:', e);
    Proctor.deactivate();
    showResult({ score: 0, status: 'FAILED', violation_count: violationCount, rank: '—' });
  }
}

// ─── Show Result ──────────────────────────────────────────────────────────────
function showResult(data) {
  document.getElementById('quiz-screen').style.display = 'none';
  const resultEl = document.getElementById('result-screen');
  resultEl.classList.remove('hidden');

  const statusEl = document.getElementById('result-status-text');
  statusEl.textContent = data.status;
  statusEl.className = 'result-status ' + (data.status === 'PASSED' ? 'passed' : 'failed');

  document.getElementById('result-score').textContent = data.score ?? '0';
  document.getElementById('result-rank').textContent = '#' + (data.rank ?? '—');
  document.getElementById('result-violations').textContent = data.violation_count ?? '0';

  // Time taken
  if (startedAt) {
    const seconds = Math.round((new Date() - new Date(startedAt)) / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    document.getElementById('result-time').textContent = `${m}m ${s}s`;
  }

  // Leaderboard link
  document.getElementById('result-leaderboard-btn').href = `leaderboard.html?quiz=${quizId}`;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
loadQuizSetup();

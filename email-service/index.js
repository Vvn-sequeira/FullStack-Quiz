require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3001;

// ─── Nodemailer Transport ──────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ─── Email Template ────────────────────────────────────────────────────────────
function buildEmailHTML({ name, university_number, score, status, violation_count, rank, quiz_title }) {
  const statusColor = status === "PASSED" ? "#00FF85" : "#FF3BFF";
  const statusBg = status === "PASSED" ? "#003d1e" : "#3d0029";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Arial Black', Arial, sans-serif; background: #f0f0f0; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border: 4px solid #000; box-shadow: 8px 8px 0 #000; }
    .header { background: #FFE500; padding: 24px; border-bottom: 4px solid #000; }
    .header h1 { margin: 0; font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; }
    .body { padding: 24px; }
    .greeting { font-size: 18px; font-weight: 700; margin-bottom: 20px; }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 20px 0; }
    .stat-box { border: 3px solid #000; padding: 16px; box-shadow: 4px 4px 0 #000; }
    .stat-label { font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; color: #666; }
    .stat-value { font-size: 28px; font-weight: 900; margin-top: 4px; }
    .status-box { background: ${statusBg}; border: 3px solid #000; padding: 16px; margin: 20px 0; text-align: center; box-shadow: 4px 4px 0 #000; }
    .status-text { color: ${statusColor}; font-size: 32px; font-weight: 900; letter-spacing: 4px; }
    .footer { background: #000; color: #FFE500; padding: 16px 24px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .divider { border: none; border-top: 3px solid #000; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📋 Quiz Result</h1>
      <div style="font-weight:700; margin-top:8px;">${quiz_title}</div>
    </div>
    <div class="body">
      <div class="greeting">Hey ${name}! 👋</div>
      <p style="font-weight:600;">Your quiz has been submitted. Here are your results:</p>
      
      <div class="status-box">
        <div class="stat-label" style="color:#aaa;">Final Status</div>
        <div class="status-text">${status}</div>
      </div>

      <div class="stat-grid">
        <div class="stat-box" style="background:#FFE500;">
          <div class="stat-label">Score</div>
          <div class="stat-value">${score}</div>
        </div>
        <div class="stat-box" style="background:#00D9FF;">
          <div class="stat-label">Leaderboard Rank</div>
          <div class="stat-value">#${rank}</div>
        </div>
        <div class="stat-box" style="background:#f0f0f0;">
          <div class="stat-label">University No.</div>
          <div class="stat-value" style="font-size:16px;">${university_number}</div>
        </div>
        <div class="stat-box" style="background:${violation_count > 0 ? '#FF3BFF' : '#e0e0e0'};">
          <div class="stat-label">Violations</div>
          <div class="stat-value">${violation_count}</div>
        </div>
      </div>

      <hr class="divider">
      <p style="font-size:13px; color:#555; font-weight:600;">
        ${status === "PASSED" 
          ? "🎉 Congratulations! You passed the quiz. Keep up the great work!" 
          : "📚 Better luck next time! Review the material and try again."}
      </p>
    </div>
    <div class="footer">AI-Proctored Quiz System &bull; Results are final</div>
  </div>
</body>
</html>`;
}

// ─── Send Email Route ──────────────────────────────────────────────────────────
app.post("/send-result", async (req, res) => {
  const { to, name, university_number, score, status, violation_count, rank, quiz_title } = req.body;

  if (!to || !name) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const mailOptions = {
    from: `"Quiz System" <${process.env.EMAIL_USER}>`,
    to,
    subject: `📋 Quiz Result: ${status} - ${quiz_title}`,
    html: buildEmailHTML({ name, university_number, score, status, violation_count, rank, quiz_title }),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${to}`);
    res.json({ success: true, message: "Email sent" });
  } catch (err) {
    console.error("❌ Email error:", err.message);
    res.status(500).json({ error: "Failed to send email", details: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`📧 Email service running on http://localhost:${PORT}`);
});

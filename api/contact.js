const RESEND_URL = "https://api.resend.com/emails";

// Per-IP rate limit (in-memory; persists across warm invocations, resets on cold start).
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 min
const RATE_MAX       = 3;              // max submissions per window
const __ipHits = new Map();

function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const hits = (__ipHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  __ipHits.set(ip, hits);
  return false;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try {
        if (ct.includes("application/json")) resolve(JSON.parse(raw || "{}"));
        else {
          const params = new URLSearchParams(raw);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          resolve(obj);
        }
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function pickField(body, ...cands) {
  for (const k of Object.keys(body))
    for (const c of cands)
      if (k === c || k.toLowerCase().includes(c)) {
        const v = body[k];
        if (v && String(v).trim()) return String(v).trim();
      }
  return "";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end("Method Not Allowed");
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { res.statusCode = 500; return res.end("Server misconfigured: RESEND_API_KEY missing"); }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  if (rateLimited(ip)) {
    res.statusCode = 303;
    res.setHeader("Location", "/thank-you");
    return res.end();
  }

  let body;
  try { body = await parseBody(req); }
  catch { res.statusCode = 400; return res.end("Bad request"); }

  // --- spam filters (silent drop — pretend success so bots don't retry) ---
  // Honeypots: any of these filled = bot
  const traps = ["_website", "_url", "_phone_secondary", "_company"];
  for (const t of traps) {
    if (body[t] && String(body[t]).trim()) {
      res.statusCode = 303;
      res.setHeader("Location", "/thank-you");
      return res.end();
    }
  }
  // Time-based: form must have been on the page at least 2s
  const formLoadedAt = Number(body._t || 0);
  if (formLoadedAt > 0 && Date.now() - formLoadedAt < 2000) {
    res.statusCode = 303;
    res.setHeader("Location", "/thank-you");
    return res.end();
  }
  // ---

  const name        = pickField(body, "name");
  const email       = pickField(body, "email");
  const phone       = pickField(body, "phone");
  const address     = pickField(body, "address");
  const description = pickField(body, "description", "message", "comment");

  if (!name || !email) {
    res.statusCode = 303;
    res.setHeader("Location", "/contact-us?error=missing");
    return res.end();
  }

  const to   = process.env.CONTACT_TO_EMAIL   || "owen@founditmarketing.com";
  const from = process.env.CONTACT_FROM_EMAIL || "Linzay Antique Wood <leads@linzayantiquewood.com>";

  const subject = `New lead from linzayantiquewood.com — ${name}`;
  const text =
`Name: ${name}
Email: ${email}
Phone: ${phone}
Address: ${address}

Message:
${description}

—
Sent from the contact form on linzayantiquewood.com`;
  const html = `
<h2>New lead from Linzay Antique Wood</h2>
<table cellpadding="6" style="font-family:system-ui,Arial,sans-serif;border-collapse:collapse;font-size:15px">
  <tr><td><b>Name</b></td><td>${escapeHtml(name)}</td></tr>
  <tr><td><b>Email</b></td><td><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
  <tr><td><b>Phone</b></td><td>${escapeHtml(phone)}</td></tr>
  <tr><td><b>Address</b></td><td>${escapeHtml(address)}</td></tr>
  <tr><td valign="top"><b>Message</b></td><td>${escapeHtml(description).replace(/\n/g, "<br>")}</td></tr>
</table>
<p style="color:#666;font-size:13px">Sent from the contact form on linzayantiquewood.com</p>`;

  try {
    const resp = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], reply_to: email, subject, text, html }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Resend error", resp.status, detail);
      res.statusCode = 303;
      res.setHeader("Location", "/contact-us?error=send");
      return res.end();
    }
  } catch (e) {
    console.error("contact handler exception", e);
    res.statusCode = 303;
    res.setHeader("Location", "/contact-us?error=send");
    return res.end();
  }

  res.statusCode = 303;
  res.setHeader("Location", "/thank-you");
  return res.end();
};

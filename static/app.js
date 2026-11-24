/* ==========================================================================
   StudyFlow — Bachelor Study Planner & Gemini AI Study Companion
   ========================================================================== */

const state = {
  view: "dashboard", // dashboard | charts | planner | detail | courses | documents | overview | settings
  selectedItemId: null,
  selectedItem: null,
  settings: {},
  courses: [],
  items: [],
  documents: [],
  themes: [],
  overviews: [],
  quizHistory: [],
  selectedOverviewId: null,
  modelsAutoFetchedOnce: false,
  plannerFilter: {
    tab: "all", // all | test | assignment | submitted
    courseId: "",
    search: "",
  },
  docFilter: {
    courseId: "",
    role: "",
  },
};

const COURSE_COLORS = [
  "#4F46E5", "#0D9488", "#D97706", "#DC2626",
  "#7C3AED", "#0284C7", "#059669", "#DB2777",
];

// --------------------------------------------------------------------------
// API & Utilities
// --------------------------------------------------------------------------

async function api(path, options = {}) {
  const opts = {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  };
  if (opts.body && typeof opts.body !== "string") {
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || "Unexpected server response" };
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.retryable = Boolean(data.retryable);
    err.localRateLimit = Boolean(data.local_rate_limit);
    err.rateLimitReason = data.rate_limit_reason || "";
    err.upstreamStatus = data.upstream_status || res.status;
    err.retryAfter = data.retry_after || null;
    throw err;
  }
  return data;
}

/**
 * Call a Gemini-backed endpoint with automatic visible retry when Gemini servers
 * are busy, overloaded, rate-limited (429/500/502/503/504), or paused by the
 * local per-minute Rate Guard.
 */
async function apiGemini(path, body = {}, { label = "Gemini request", maxRetries = 4, onStatus = null } = {}) {
  const banner = document.getElementById("retryBanner");
  const titleEl = document.getElementById("retryBannerTitle");
  const subEl = document.getElementById("retryBannerSub");
  const fillEl = document.getElementById("retryProgressFill");
  const nowBtn = document.getElementById("retryNowBtn");
  const cancelBtn = document.getElementById("retryCancelBtn");

  const hideBanner = () => {
    if (banner) banner.classList.add("hidden");
  };

  const waitWithCountdown = (seconds, attemptNum, totalAttempts, code, isLocalGuard = false) =>
    new Promise((resolve, reject) => {
      const totalMs = Math.max(1000, Math.round(seconds * 1000));
      const start = Date.now();
      let settled = false;
      let timerId = null;

      const cleanup = () => {
        if (timerId) clearInterval(timerId);
        nowBtn?.removeEventListener("click", onNow);
        cancelBtn?.removeEventListener("click", onCancel);
      };

      const onNow = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onCancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
        hideBanner();
        reject(new Error(`${label} cancelled while waiting.`));
      };

      nowBtn?.addEventListener("click", onNow);
      cancelBtn?.addEventListener("click", onCancel);
      if (nowBtn) nowBtn.classList.toggle("hidden", isLocalGuard);

      const tick = () => {
        const elapsed = Date.now() - start;
        const leftMs = Math.max(0, totalMs - elapsed);
        const leftSec = Math.ceil(leftMs / 1000);
        const pct = Math.max(0, Math.min(100, (leftMs / totalMs) * 100));

        if (banner) {
          banner.classList.remove("hidden");
          if (isLocalGuard) {
            titleEl.textContent = `Rate Limit Guard active — Queued "${label}"`;
            subEl.textContent = `Protecting your Gemini RPM limit · Sending in ${leftSec}s...`;
          } else {
            titleEl.textContent = `Gemini servers are busy (HTTP ${code}) — Retrying "${label}"`;
            subEl.textContent = `Attempt ${attemptNum} of ${totalAttempts} · Retrying in ${leftSec}s...`;
          }
          fillEl.style.width = `${pct}%`;
        }
        if (onStatus) {
          onStatus(
            isLocalGuard
              ? `Rate limit guard — waiting ${leftSec}s...`
              : `Gemini busy (${code}) — retrying (${attemptNum}/${totalAttempts}) in ${leftSec}s...`
          );
        }

        if (leftMs <= 0 && !settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };

      tick();
      timerId = setInterval(tick, 200);
    });

  const totalAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      if (attempt > 1) {
        if (banner) {
          banner.classList.remove("hidden");
          titleEl.textContent = `Sending "${label}" to Gemini...`;
          subEl.textContent = `Attempt ${attempt} of ${totalAttempts}`;
          fillEl.style.width = "100%";
        }
        if (onStatus) {
          onStatus(`Retrying (${attempt}/${totalAttempts})...`);
        }
      }
      const res = await api(path, {
        method: "POST",
        headers: { "X-Client-Retry": "1" },
        body,
      });
      hideBanner();
      if (attempt > 1) {
        toast(`${label} completed!`, "success");
      }
      return res;
    } catch (err) {
      // Never auto-retry if the user's own Daily Safety Cap was reached
      if (err.localRateLimit && !err.retryable) {
        hideBanner();
        throw err;
      }

      const busyStatuses = new Set([429, 500, 502, 503, 504]);
      const isNetworkErr = err.name === "TypeError" && !err.status;
      const isLocalRpm = Boolean(err.localRateLimit && err.retryable);
      const isBusy = isLocalRpm || Boolean(err.retryable) || busyStatuses.has(err.upstreamStatus) || busyStatuses.has(err.status) || isNetworkErr;

      if (!isBusy || attempt >= totalAttempts) {
        hideBanner();
        throw err;
      }

      const code = err.upstreamStatus || err.status || "Busy";
      const backoffSec = isLocalRpm
        ? Math.min(61, Math.max(1, Number(err.retryAfter || 5)))
        : err.retryAfter
        ? Math.min(30, Math.max(1, Number(err.retryAfter)))
        : Math.min(12, 2 * Math.pow(2, attempt - 1));

      await waitWithCountdown(backoffSec, attempt + 1, totalAttempts, code, isLocalRpm);
    }
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.25s ease";
    setTimeout(() => el.remove(), 260);
  }, 3800);
}

function formatMinutes(totalMinutes) {
  const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
  if (mins === 0) return "0m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function splitMinutes(totalMinutes) {
  const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return { hours: Math.floor(mins / 60), minutes: mins % 60 };
}

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function dueBadgeInfo(dueDateStr, status) {
  if (!dueDateStr) return { text: "No deadline", cls: "badge-status-todo" };
  if (status === "submitted" || status === "graded") {
    return { text: `Due ${dueDateStr}`, cls: "badge-status-done" };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDateStr + "T00:00:00");
  const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { text: `Overdue ${Math.abs(diffDays)}d`, cls: "badge-urgent" };
  if (diffDays === 0) return { text: "Due Today", cls: "badge-urgent" };
  if (diffDays === 1) return { text: "Due Tomorrow", cls: "badge-soon" };
  if (diffDays <= 4) return { text: `In ${diffDays} days`, cls: "badge-soon" };
  return { text: `${dueDateStr} (${diffDays}d)`, cls: "badge-status-todo" };
}

function roleLabel(role) {
  const map = {
    lecture: "Lecture Slides",
    study_material: "Study Material",
    submission: "Submission",
    reference: "Reference",
  };
  return map[role] || role;
}

function statusLabel(status) {
  const map = {
    todo: "To Do",
    in_progress: "In Progress",
    submitted: "Submitted",
    graded: "Graded",
    done: "Done",
  };
  return map[status] || status;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      const idx = res.indexOf(",");
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// Lightweight safe Markdown -> HTML renderer
function renderMarkdown(md) {
  if (!md) return "";
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let inCode = false;
  let codeBuf = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) { html += "</ul>"; inUl = false; }
    if (inOl) { html += "</ol>"; inOl = false; }
  };

  const inlineFmt = (raw) => {
    let s = escapeHtml(raw);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return s;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      closeLists();
      if (!inCode) {
        inCode = true;
        codeBuf = [];
      } else {
        html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeLists();
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      closeLists();
      const lvl = hMatch[1].length;
      html += `<h${lvl}>${inlineFmt(hMatch[2])}</h${lvl}>`;
      continue;
    }

    if (trimmed.startsWith("> ")) {
      closeLists();
      html += `<blockquote>${inlineFmt(trimmed.slice(2))}</blockquote>`;
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (inOl) { html += "</ol>"; inOl = false; }
      if (!inUl) { html += "<ul>"; inUl = true; }
      html += `<li>${inlineFmt(ulMatch[1])}</li>`;
      continue;
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (!inOl) { html += "<ol>"; inOl = true; }
      html += `<li>${inlineFmt(olMatch[1])}</li>`;
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      closeLists();
      html += "<hr />";
      continue;
    }

    closeLists();
    html += `<p>${inlineFmt(trimmed)}</p>`;
  }

  closeLists();
  if (inCode) {
    html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
  }
  return html;
}

// --------------------------------------------------------------------------
// Modal Helper
// --------------------------------------------------------------------------

function openModal(title, bodyHtml, { subtitle = "", wide = false } = {}) {
  const backdrop = document.getElementById("modalBackdrop");
  const dialog = document.getElementById("modalDialog");
  document.getElementById("modalTitle").textContent = title;
  const subEl = document.getElementById("modalSubtitle");
  if (subtitle) {
    subEl.textContent = subtitle;
    subEl.classList.remove("hidden");
  } else {
    subEl.classList.add("hidden");
  }
  dialog.classList.toggle("modal-wide", wide);
  document.getElementById("modalBody").innerHTML = bodyHtml;
  backdrop.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modalBackdrop").classList.add("hidden");
  document.getElementById("modalBody").innerHTML = "";
}

// --------------------------------------------------------------------------
// Bootstrap & Navigation
// --------------------------------------------------------------------------

async function refreshData() {
  const data = await api("/api/bootstrap");
  state.settings = data.settings || {};
  state.courses = data.courses || [];
  state.items = data.items || [];
  state.documents = data.documents || [];
  state.themes = data.themes || [];
  state.overviews = data.overviews || [];
  state.quizHistory = data.quiz_history || [];
  if (!state.selectedOverviewId && state.overviews.length > 0) {
    state.selectedOverviewId = state.overviews[0].id;
  }
  updateSidebarStatus();
  if (state.view === "detail" && state.selectedItemId) {
    try {
      state.selectedItem = await api(`/api/items/${state.selectedItemId}`);
    } catch {
      state.view = "planner";
      state.selectedItemId = null;
      state.selectedItem = null;
    }
  }
  renderView();
}

function updateSidebarStatus() {
  const s = state.settings;
  document.getElementById("sidebarSemester").textContent = s.semester_name || "Bachelor Planner";
  const activeCount = state.items.filter((i) => i.status !== "submitted" && i.status !== "graded").length;
  document.getElementById("navActiveCount").textContent = String(activeCount);
  document.getElementById("navDocsCount").textContent = String(state.documents.length);

  const dot = document.getElementById("apiStatusDot");
  const sub = document.getElementById("apiStatusSub");
  const rl = s.rate_limit_status || {};
  if (s.gemini_api_key_configured) {
    dot.classList.add("connected");
    const rpmTag = rl.rpm_limit > 0 ? ` · max ${rl.rpm_limit}/min` : "";
    sub.textContent = `${s.gemini_model || "gemini-2.5-flash"}${rpmTag}`;
  } else {
    dot.classList.remove("connected");
    sub.textContent = "Click to add API token";
  }
}

function navigate(view, itemId = null) {
  state.view = view;
  if (view === "detail" && itemId) {
    state.selectedItemId = itemId;
  }
  document.getElementById("sidebar").classList.remove("open");

  document.querySelectorAll(".nav-item").forEach((btn) => {
    const v = btn.dataset.view;
    const isActive = v === view || (view === "detail" && v === "planner");
    btn.classList.toggle("active", isActive);
  });

  if (view === "detail" && itemId) {
    loadItemDetail(itemId);
  } else {
    renderView();
  }
}

async function loadItemDetail(itemId) {
  try {
    state.selectedItem = await api(`/api/items/${itemId}`);
    state.selectedItemId = itemId;
    state.view = "detail";
    renderView();
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderView() {
  const titles = {
    dashboard: "Dashboard",
    charts: "General Chart Overview",
    planner: "Assignments & Upcoming Tests",
    detail: state.selectedItem ? state.selectedItem.title : "Task Detail",
    courses: "Courses & Lectures",
    documents: "Documents & Study Materials",
    overview: "AI Lecture & Themes Overview",
    settings: "Settings & Gemini Backend",
  };
  document.getElementById("pageTitle").textContent = titles[state.view] || "StudyFlow";

  const container = document.getElementById("viewContainer");
  switch (state.view) {
    case "dashboard":
      renderDashboard(container);
      break;
    case "charts":
      renderChartsView(container);
      break;
    case "planner":
      renderPlanner(container);
      break;
    case "detail":
      renderItemDetail(container);
      break;
    case "courses":
      renderCourses(container);
      break;
    case "documents":
      renderDocumentsView(container);
      break;
    case "overview":
      renderOverviewView(container);
      break;
    case "settings":
      renderSettingsView(container);
      break;
  }
}

// --------------------------------------------------------------------------
// View 1: Dashboard
// --------------------------------------------------------------------------

function renderDashboard(container) {
  const activeItems = state.items.filter((i) => i.status !== "submitted" && i.status !== "graded");
  const upcomingTests = activeItems.filter((i) => i.type === "test");
  const activeAssignments = activeItems.filter((i) => i.type === "assignment");
  const remainingMins = activeItems.reduce((acc, it) => acc + (it.effective_remaining_minutes || 0), 0);
  const totalChapters = state.items.reduce((acc, it) => acc + (it.chapters_total || 0), 0);
  const doneChapters = state.items.reduce((acc, it) => acc + (it.chapters_done || 0), 0);
  const dailyHours = Number(state.settings.daily_study_hours) || 4;
  const estDays = remainingMins > 0 ? (remainingMins / 60 / dailyHours).toFixed(1) : "0";

  const isEmpty = state.items.length === 0 && state.courses.length === 0;

  let html = "";

  if (isEmpty) {
    html += `
      <div class="welcome-banner">
        <div>
          <h2>Welcome to StudyFlow, ${escapeHtml(state.settings.student_name || "Bachelor Student")}!</h2>
          <p>Track assignments &amp; upcoming exams, break them into chapter subtasks with time estimates, attach lecture slides, and generate Gemini AI overviews, explanations &amp; practice tests.</p>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-white" id="seedDemoBtn">Load Sample Semester</button>
          <button class="btn btn-secondary" style="background:rgba(255,255,255,0.16);color:#fff;border-color:rgba(255,255,255,0.35);" id="welcomeSettingsBtn">Configure Gemini Token</button>
        </div>
      </div>
    `;
  } else if (!state.settings.gemini_api_key_configured) {
    html += `
      <div class="card" style="margin-bottom:20px;border-color:rgba(217,119,6,0.4);background:var(--warning-soft);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
        <div>
          <strong>Configure your Gemini API token to unlock AI features</strong>
          <div class="field-hint" style="color:var(--text-secondary);">Enable AI Lecture &amp; Themes Overview plus per-subtask Practice Tests and Explanations.</div>
        </div>
        <button class="btn btn-primary btn-sm" id="bannerConfigBtn">Open Settings</button>
      </div>
    `;
  }

  html += `
    <div class="kpi-grid">
      <div class="kpi-card">
        <span class="kpi-label">Upcoming Tests</span>
        <span class="kpi-value">${upcomingTests.length}</span>
        <span class="kpi-sub">${state.items.filter((i) => i.type === "test" && (i.status === "submitted" || i.status === "graded")).length} submitted/graded</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Active Assignments</span>
        <span class="kpi-value">${activeAssignments.length}</span>
        <span class="kpi-sub">${state.items.filter((i) => i.type === "assignment" && (i.status === "submitted" || i.status === "graded")).length} completed</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Estimated Study Time Left</span>
        <span class="kpi-value mono">${formatMinutes(remainingMins)}</span>
        <span class="kpi-sub">~${estDays} days at ${dailyHours}h/day</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Chapters Completed</span>
        <span class="kpi-value mono">${doneChapters}/${totalChapters}</span>
        <span class="kpi-sub">${state.documents.length} documents attached</span>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="card">
        <div class="section-header">
          <h2 class="section-title">Next Deadlines &amp; Upcoming Tests</h2>
          <button class="btn btn-ghost btn-sm" id="dashViewAllBtn">View all &rarr;</button>
        </div>
        ${
          activeItems.length === 0
            ? `<div class="empty-state"><h3>All caught up!</h3><p>Add an upcoming test or assignment to start planning your chapters and time estimates.</p></div>`
            : `<div class="items-list">${activeItems.slice(0, 6).map(renderItemCardHtml).join("")}</div>`
        }
      </div>

      <div style="display:flex;flex-direction:column;gap:20px;">
        <div class="card" style="border-color:rgba(124,58,237,0.3);">
          <div class="section-header">
            <h2 class="section-title">Gemini AI Study Companion</h2>
            <span class="badge badge-ai">Gemini</span>
          </div>
          <p style="margin:0 0 14px;color:var(--text-secondary);font-size:13.5px;">
            Upload a course document and enter how much time you have left — Gemini automatically creates your themes, tasks, and chapter subtasks, or synthesizes all lectures into an AI overview.
          </p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-ai btn-sm" id="dashUploadAutoBtn">&#10024; Upload Doc &amp; Auto-Plan</button>
            <button class="btn btn-ai-soft btn-sm" id="dashOpenOverviewBtn">AI Lecture Overview</button>
            <button class="btn btn-secondary btn-sm" id="dashConfigGeminiBtn">API Settings</button>
          </div>
        </div>

        <div class="card">
          <div class="section-header">
            <h2 class="section-title">Courses (${state.courses.length})</h2>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-ghost btn-sm" id="dashOpenChartsBtn">Charts &rarr;</button>
              <button class="btn btn-ghost btn-sm" id="dashAddCourseBtn">+ Add Course</button>
            </div>
          </div>
          ${
            state.courses.length === 0
              ? `<p class="field-hint">No courses yet. Organize your semester by adding your modules.</p>`
              : `<div style="display:flex;flex-direction:column;gap:8px;">
                  ${state.courses
                    .map((c) => {
                      const cItems = state.items.filter((i) => i.course_id === c.id && i.status !== "submitted" && i.status !== "graded");
                      const cMins = cItems.reduce((a, b) => a + (b.effective_remaining_minutes || 0), 0);
                      return `
                        <div class="doc-row" style="cursor:pointer;" data-course-jump="${c.id}">
                          <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                            <span style="width:10px;height:10px;border-radius:50%;background:${escapeHtml(c.color)};flex-shrink:0;"></span>
                            <div class="doc-info">
                              <div class="doc-name">${escapeHtml(c.name)}</div>
                              <div class="doc-meta">
                                <span>${escapeHtml(c.code || "Course")}</span>
                                <span>${cItems.length} active</span>
                                <span>${c.docs_count || 0} docs</span>
                              </div>
                            </div>
                          </div>
                          <span class="badge badge-time">${formatMinutes(cMins)}</span>
                        </div>
                      `;
                    })
                    .join("")}
                </div>`
          }
        </div>
      </div>
    </div>
  `;

  container.innerHTML = html;

  document.getElementById("seedDemoBtn")?.addEventListener("click", handleSeedDemo);
  document.getElementById("welcomeSettingsBtn")?.addEventListener("click", () => navigate("settings"));
  document.getElementById("bannerConfigBtn")?.addEventListener("click", () => navigate("settings"));
  document.getElementById("dashViewAllBtn")?.addEventListener("click", () => navigate("planner"));
  document.getElementById("dashUploadAutoBtn")?.addEventListener("click", () => openUploadDocumentModal());
  document.getElementById("dashOpenOverviewBtn")?.addEventListener("click", () => navigate("overview"));
  document.getElementById("dashConfigGeminiBtn")?.addEventListener("click", () => navigate("settings"));
  document.getElementById("dashOpenChartsBtn")?.addEventListener("click", () => navigate("charts"));
  document.getElementById("dashAddCourseBtn")?.addEventListener("click", () => openCourseModal());

  bindItemCardEvents(container);
  container.querySelectorAll("[data-course-jump]").forEach((el) => {
    el.addEventListener("click", () => {
      state.plannerFilter.courseId = el.dataset.courseJump;
      state.plannerFilter.tab = "all";
      navigate("planner");
    });
  });
}

// --------------------------------------------------------------------------
// View 1B: General Chart Overview (SVG & CSS Analytics — Zero External Deps)
// --------------------------------------------------------------------------

function buildDonutSvg(segments, size = 176, strokeWidth = 22) {
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const total = segments.reduce((a, s) => a + s.value, 0);

  if (total <= 0) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-subtle)" stroke-width="${strokeWidth}" />
    </svg>`;
  }

  let offset = 0;
  const circles = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / total) * circ;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${s.color}" stroke-width="${strokeWidth}"
        stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})">
        <title>${escapeHtml(s.label)}: ${s.value} (${Math.round((s.value / total) * 100)}%)</title>
      </circle>`;
      offset += len;
      return el;
    })
    .join("");

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-subtle)" stroke-width="${strokeWidth}" />
    ${circles}
  </svg>`;
}

function buildDeadlineTimelineSvg(items, dailyTargetHours = 4) {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const label = i === 0 ? "Today" : `${d.getDate()}/${d.getMonth() + 1}`;
    days.push({ iso, label, testHours: 0, assignHours: 0, titles: [] });
  }

  const dayMap = new Map(days.map((d) => [d.iso, d]));
  let overdueMins = 0;
  let beyondMins = 0;

  for (const it of items) {
    if (it.status === "submitted" || it.status === "graded") continue;
    const rem = it.effective_remaining_minutes || 0;
    if (!it.due_date) continue;
    const slot = dayMap.get(it.due_date);
    if (slot) {
      if (it.type === "test") slot.testHours += rem / 60;
      else slot.assignHours += rem / 60;
      slot.titles.push(`${it.title} (${formatMinutes(rem)})`);
    } else {
      const due = new Date(it.due_date + "T00:00:00");
      if (due < today) overdueMins += rem;
      else beyondMins += rem;
    }
  }

  const maxH = Math.max(dailyTargetHours * 1.25, 2, ...days.map((d) => d.testHours + d.assignHours));
  const W = 720;
  const H = 200;
  const padL = 36;
  const padR = 14;
  const padT = 18;
  const padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const slotW = chartW / days.length;
  const barW = Math.max(16, slotW - 14);

  const yFor = (val) => padT + chartH - (val / maxH) * chartH;
  const targetY = yFor(dailyTargetHours);

  const yTicks = [0, Math.round(maxH / 2), Math.ceil(maxH)];
  const gridLines = yTicks
    .map((v) => {
      const y = yFor(v);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1" />
        <text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10.5" fill="var(--text-muted)">${v}h</text>`;
    })
    .join("");

  const bars = days
    .map((d, idx) => {
      const x = padL + idx * slotW + (slotW - barW) / 2;
      const totalH = d.testHours + d.assignHours;
      const assignPx = (d.assignHours / maxH) * chartH;
      const testPx = (d.testHours / maxH) * chartH;
      const yAssign = padT + chartH - assignPx;
      const yTest = yAssign - testPx;
      const tip = d.titles.length ? `${d.iso}: ${d.titles.join(" · ")}` : `${d.iso}: No deadlines`;

      return `<g>
        <title>${escapeHtml(tip)}</title>
        ${assignPx > 0 ? `<rect x="${x}" y="${yAssign}" width="${barW}" height="${assignPx}" rx="4" fill="#0284c7" />` : ""}
        ${testPx > 0 ? `<rect x="${x}" y="${yTest}" width="${barW}" height="${testPx}" rx="4" fill="#dc2626" />` : ""}
        ${totalH > 0 ? `<text x="${x + barW / 2}" y="${Math.max(11, yTest - 4)}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--text)">${totalH.toFixed(1)}h</text>` : ""}
        <text x="${x + barW / 2}" y="${H - 10}" text-anchor="middle" font-size="10.5" fill="${idx === 0 ? "var(--primary)" : "var(--text-muted)"}" font-weight="${idx === 0 ? "700" : "400"}">${d.label}</text>
      </g>`;
    })
    .join("");

  const targetLine = `<line x1="${padL}" y1="${targetY}" x2="${W - padR}" y2="${targetY}" stroke="var(--ai)" stroke-width="1.5" stroke-dasharray="5 4" />
    <text x="${W - padR}" y="${targetY - 5}" text-anchor="end" font-size="10.5" font-weight="600" fill="var(--ai)">Daily Target (${dailyTargetHours}h)</text>`;

  return {
    svg: `<svg class="timeline-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${gridLines}
      ${bars}
      ${targetLine}
    </svg>`,
    overdueMins,
    beyondMins,
  };
}

function renderChartsView(container) {
  const items = state.items;
  const courses = state.courses;
  const quizzes = state.quizHistory || [];
  const dailyHours = Number(state.settings.daily_study_hours) || 4;

  const totalBudgetMins = items.reduce((a, i) => a + (i.effective_estimated_minutes || 0), 0);
  const remainingMins = items.reduce((a, i) => a + (i.effective_remaining_minutes || 0), 0);
  const doneMins = Math.max(0, totalBudgetMins - remainingMins);

  const totalChapters = items.reduce((a, i) => a + (i.chapters_total || 0), 0);
  const doneChapters = items.reduce((a, i) => a + (i.chapters_done || 0), 0);
  const chapterPct = totalChapters > 0 ? Math.round((doneChapters / totalChapters) * 100) : 0;

  const avgQuizPct =
    quizzes.length > 0
      ? Math.round(
          quizzes.reduce((a, q) => a + ((Number(q.last_score) || 0) / Math.max(1, Number(q.last_total) || 1)) * 100, 0) /
            quizzes.length
        )
      : null;

  // 1. Status Donut Data
  const statusCounts = {
    graded: items.filter((i) => i.status === "graded").length,
    submitted: items.filter((i) => i.status === "submitted").length,
    in_progress: items.filter((i) => i.status === "in_progress").length,
    todo: items.filter((i) => i.status === "todo").length,
  };
  const donutSegments = [
    { label: "Graded", value: statusCounts.graded, color: "#059669" },
    { label: "Submitted", value: statusCounts.submitted, color: "#10b981" },
    { label: "In Progress", value: statusCounts.in_progress, color: "#d97706" },
    { label: "To Do", value: statusCounts.todo, color: "#6366f1" },
  ];
  const completedItems = statusCounts.graded + statusCounts.submitted;
  const itemPct = items.length > 0 ? Math.round((completedItems / items.length) * 100) : 0;

  // 2. Workload by Course Data
  const courseBuckets = courses.map((c) => {
    const cItems = items.filter((i) => i.course_id === c.id);
    const total = cItems.reduce((a, i) => a + (i.effective_estimated_minutes || 0), 0);
    const rem = cItems.reduce((a, i) => a + (i.effective_remaining_minutes || 0), 0);
    const done = Math.max(0, total - rem);
    const themesCount = state.themes.filter((t) => t.course_id === c.id).length;
    return { id: c.id, name: c.name, code: c.code, color: c.color || "#4f46e5", total, rem, done, count: cItems.length, themesCount };
  });
  const unassignedItems = items.filter((i) => !i.course_id);
  if (unassignedItems.length > 0) {
    const total = unassignedItems.reduce((a, i) => a + (i.effective_estimated_minutes || 0), 0);
    const rem = unassignedItems.reduce((a, i) => a + (i.effective_remaining_minutes || 0), 0);
    courseBuckets.push({
      id: "",
      name: "Unassigned / General",
      code: "",
      color: "#64748b",
      total,
      rem,
      done: Math.max(0, total - rem),
      count: unassignedItems.length,
      themesCount: 0,
    });
  }
  const maxCourseMins = Math.max(60, ...courseBuckets.map((b) => b.total));

  // 3. 14-day Timeline
  const timeline = buildDeadlineTimelineSvg(items, dailyHours);

  // 4. Estimated vs Actual Time Accuracy
  const accuracyItems = items
    .filter((i) => (i.status === "submitted" || i.status === "graded") && (i.actual_minutes > 0 || i.effective_estimated_minutes > 0))
    .slice(0, 8);
  const maxAccMins = Math.max(60, ...accuracyItems.map((i) => Math.max(i.effective_estimated_minutes || 0, i.actual_minutes || 0)));

  container.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card">
        <span class="kpi-label">Total Study Time Budget</span>
        <span class="kpi-value mono">${formatMinutes(totalBudgetMins)}</span>
        <span class="kpi-sub">${formatMinutes(doneMins)} completed · ${formatMinutes(remainingMins)} left</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Chapter Completion</span>
        <span class="kpi-value mono">${chapterPct}%</span>
        <span class="kpi-sub">${doneChapters} of ${totalChapters} subtasks done</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Tests &amp; Assignments</span>
        <span class="kpi-value mono">${completedItems}/${items.length}</span>
        <span class="kpi-sub">${items.filter((i) => i.type === "test").length} tests · ${items.filter((i) => i.type === "assignment").length} assignments</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Avg Practice Test Score</span>
        <span class="kpi-value mono">${avgQuizPct !== null ? `${avgQuizPct}%` : "—"}</span>
        <span class="kpi-sub">${quizzes.length > 0 ? `Across ${quizzes.length} graded AI quiz${quizzes.length > 1 ? "zes" : ""}` : "Take a chapter practice test"}</span>
      </div>
    </div>

    ${
      items.length === 0 && courses.length === 0
        ? `<div class="empty-state">
            <h3>No study data to chart yet</h3>
            <p>Upload a course document, add your assignments &amp; upcoming tests, or load sample semester data to see your full chart overview.</p>
            <div style="display:flex;justify-content:center;gap:10px;margin-top:14px;">
              <button class="btn btn-ai" id="chartsUploadDocBtn">&#10024; Upload Course Doc</button>
              <button class="btn btn-secondary" id="chartsSeedBtn">Load Sample Semester</button>
            </div>
          </div>`
        : `
          <div class="charts-grid">
            <!-- Chart 1: 14-Day Upcoming Workload Timeline -->
            <div class="chart-card chart-full">
              <div class="section-header" style="margin-bottom:0;flex-wrap:wrap;">
                <div>
                  <h3 class="section-title">Upcoming 14-Day Workload by Due Date</h3>
                  <div class="field-hint">Remaining study hours grouped by deadline day, compared against your ${dailyHours}h/day study target.</div>
                </div>
                <div style="display:flex;align-items:center;gap:14px;font-size:12.5px;flex-wrap:wrap;">
                  <span style="display:inline-flex;align-items:center;gap:6px;"><span class="legend-swatch" style="background:#dc2626;"></span>Tests / Exams</span>
                  <span style="display:inline-flex;align-items:center;gap:6px;"><span class="legend-swatch" style="background:#0284c7;"></span>Assignments</span>
                  ${timeline.overdueMins > 0 ? `<span class="badge badge-urgent">Overdue: ${formatMinutes(timeline.overdueMins)}</span>` : ""}
                  ${timeline.beyondMins > 0 ? `<span class="badge badge-status-todo">After 14d: ${formatMinutes(timeline.beyondMins)}</span>` : ""}
                </div>
              </div>
              ${timeline.svg}
            </div>

            <!-- Chart 2: Task Status Donut Chart -->
            <div class="chart-card">
              <div class="section-header" style="margin-bottom:0;">
                <div>
                  <h3 class="section-title">Tasks &amp; Tests Status</h3>
                  <div class="field-hint">Distribution across all ${items.length} tracked tests &amp; assignments.</div>
                </div>
              </div>
              <div class="donut-layout">
                <div class="donut-svg-wrap">
                  ${buildDonutSvg(donutSegments)}
                  <div class="donut-center">
                    <strong>${itemPct}%</strong>
                    <span>submitted</span>
                  </div>
                </div>
                <div class="chart-legend">
                  ${donutSegments
                    .map(
                      (s) => `
                    <div class="legend-item">
                      <span class="legend-left">
                        <span class="legend-swatch" style="background:${s.color}"></span>
                        <span>${s.label}</span>
                      </span>
                      <strong style="font-family:var(--font-mono);">${s.value} (${items.length ? Math.round((s.value / items.length) * 100) : 0}%)</strong>
                    </div>
                  `
                    )
                    .join("")}
                </div>
              </div>
            </div>

            <!-- Chart 3: Study Time by Course -->
            <div class="chart-card">
              <div class="section-header" style="margin-bottom:0;">
                <div>
                  <h3 class="section-title">Study Workload by Course</h3>
                  <div class="field-hint">Solid = completed · Faded = remaining time left.</div>
                </div>
              </div>
              ${
                courseBuckets.length === 0
                  ? `<p class="field-hint">Add courses to compare study time per module.</p>`
                  : `<div class="hbar-list">
                      ${courseBuckets
                        .map((b) => {
                          const doneW = (b.done / maxCourseMins) * 100;
                          const remW = (b.rem / maxCourseMins) * 100;
                          const pct = b.total > 0 ? Math.round((b.done / b.total) * 100) : 0;
                          return `
                            <div class="hbar-row">
                              <div class="hbar-head">
                                <span style="display:flex;align-items:center;gap:7px;min-width:0;">
                                  <span class="legend-swatch" style="background:${escapeHtml(b.color)};"></span>
                                  <strong style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(b.code ? `${b.code} — ${b.name}` : b.name)}</strong>
                                </span>
                                <span style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);white-space:nowrap;">
                                  ${formatMinutes(b.rem)} left / ${formatMinutes(b.total)} (${pct}%)
                                </span>
                              </div>
                              <div class="hbar-track" title="Done: ${formatMinutes(b.done)} · Remaining: ${formatMinutes(b.rem)} · Themes: ${b.themesCount}">
                                <div class="hbar-seg" style="width:${doneW.toFixed(1)}%;background:${escapeHtml(b.color)};"></div>
                                <div class="hbar-seg" style="width:${remW.toFixed(1)}%;background:${escapeHtml(b.color)};opacity:0.32;"></div>
                              </div>
                            </div>
                          `;
                        })
                        .join("")}
                    </div>`
              }
            </div>

            <!-- Chart 4: Estimated vs Actual Time Accuracy -->
            <div class="chart-card">
              <div class="section-header" style="margin-bottom:0;">
                <div>
                  <h3 class="section-title">Estimated vs. Actual Time</h3>
                  <div class="field-hint">Compare your estimates against actual hours on submitted tests &amp; assignments.</div>
                </div>
              </div>
              ${
                accuracyItems.length === 0
                  ? `<p class="field-hint">Submit a test or assignment with actual time spent to track your estimation accuracy.</p>`
                  : `<div style="display:flex;gap:14px;font-size:12px;margin-bottom:4px;">
                      <span style="display:inline-flex;align-items:center;gap:5px;"><span class="legend-swatch" style="background:#6366f1;"></span>Estimated</span>
                      <span style="display:inline-flex;align-items:center;gap:5px;"><span class="legend-swatch" style="background:#059669;"></span>Actual</span>
                    </div>
                    <div class="hbar-list">
                      ${accuracyItems
                        .map((it) => {
                          const estW = ((it.effective_estimated_minutes || 0) / maxAccMins) * 100;
                          const actW = ((it.actual_minutes || 0) / maxAccMins) * 100;
                          return `
                            <div class="hbar-row">
                              <div class="hbar-head">
                                <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(it.title)}</span>
                                <span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-muted);white-space:nowrap;">
                                  Est ${formatMinutes(it.effective_estimated_minutes)} vs Act ${formatMinutes(it.actual_minutes)}
                                </span>
                              </div>
                              <div class="hbar-track" style="height:8px;">
                                <div class="hbar-seg" style="width:${estW.toFixed(1)}%;background:#6366f1;"></div>
                              </div>
                              <div class="hbar-track" style="height:8px;">
                                <div class="hbar-seg" style="width:${actW.toFixed(1)}%;background:#059669;"></div>
                              </div>
                            </div>
                          `;
                        })
                        .join("")}
                    </div>`
              }
            </div>

            <!-- Chart 5: Practice Test Scores -->
            <div class="chart-card">
              <div class="section-header" style="margin-bottom:0;">
                <div>
                  <h3 class="section-title">AI Practice Test Scores</h3>
                  <div class="field-hint">Recent quiz performance across chapters and courses.</div>
                </div>
              </div>
              ${
                quizzes.length === 0
                  ? `<p class="field-hint">Generate and submit a chapter practice test to track your exam readiness scores here.</p>`
                  : `<div class="hbar-list">
                      ${quizzes
                        .slice(-8)
                        .reverse()
                        .map((q) => {
                          const pct = Math.round(((Number(q.last_score) || 0) / Math.max(1, Number(q.last_total) || 1)) * 100);
                          const color = pct >= 80 ? "#059669" : pct >= 60 ? "#d97706" : "#dc2626";
                          return `
                            <div class="hbar-row">
                              <div class="hbar-head">
                                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                                  <strong>${escapeHtml(q.chapter_label ? `${q.chapter_label}: ${q.chapter_title}` : q.chapter_title)}</strong>
                                  ${q.course_name ? `<span class="field-hint"> · ${escapeHtml(q.course_name)}</span>` : ""}
                                </span>
                                <span style="font-family:var(--font-mono);font-weight:700;color:${color};">${pct}% (${q.last_score}/${q.last_total})</span>
                              </div>
                              <div class="hbar-track" style="height:10px;">
                                <div class="hbar-seg" style="width:${pct}%;background:${color};"></div>
                              </div>
                            </div>
                          `;
                        })
                        .join("")}
                    </div>`
              }
            </div>
          </div>
        `
    }
  `;

  document.getElementById("chartsUploadDocBtn")?.addEventListener("click", () => openUploadDocumentModal());
  document.getElementById("chartsSeedBtn")?.addEventListener("click", handleSeedDemo);
}

// --------------------------------------------------------------------------
// View 2: Assignments & Tests Planner
// --------------------------------------------------------------------------

function renderItemCardHtml(item) {
  const due = dueBadgeInfo(item.due_date, item.status);
  const pct =
    item.chapters_total > 0
      ? Math.round((item.chapters_done / item.chapters_total) * 100)
      : item.status === "submitted" || item.status === "graded"
      ? 100
      : 0;
  const isSubmitted = item.status === "submitted" || item.status === "graded";

  return `
    <div class="item-card" data-open-item="${item.id}">
      <div class="item-card-top">
        <div style="min-width:0;flex:1;">
          <div class="item-card-badges">
            <span class="badge ${item.type === "test" ? "badge-test" : "badge-assignment"}">
              ${item.type === "test" ? "Test / Exam" : "Assignment"}
            </span>
            ${
              item.course
                ? `<span class="badge badge-course" style="background:${escapeHtml(item.course.color)}">${escapeHtml(item.course.code || item.course.name)}</span>`
                : ""
            }
            <span class="badge badge-status-${item.status}">${statusLabel(item.status)}</span>
            ${item.grade ? `<span class="badge badge-status-done">Grade: ${escapeHtml(item.grade)}</span>` : ""}
          </div>
          <h3 class="item-card-title">${escapeHtml(item.title)}</h3>
        </div>
        <span class="badge ${due.cls}">${escapeHtml(due.text)}</span>
      </div>
      ${item.description ? `<p class="item-card-desc">${escapeHtml(item.description)}</p>` : ""}
      <div class="item-card-footer">
        <div class="progress-inline">
          <div class="progress-bar">
            <div class="progress-fill ${pct === 100 ? "done" : ""}" style="width:${pct}%"></div>
          </div>
          <span style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);">
            ${item.chapters_total > 0 ? `${item.chapters_done}/${item.chapters_total} ch.` : `${pct}%`}
          </span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="badge badge-time" title="Remaining / Total time budget">
            Time left: ${formatMinutes(item.effective_remaining_minutes)} / ${formatMinutes(item.effective_estimated_minutes)}
          </span>
          <span class="badge badge-status-todo">${item.documents_count || 0} docs</span>
          <button class="btn btn-secondary btn-sm" data-quick-edit="${item.id}">Edit</button>
          ${
            !isSubmitted
              ? `<button class="btn btn-success btn-sm" data-quick-submit="${item.id}">Submit ${item.type === "test" ? "Test" : "Work"}</button>`
              : `<button class="btn btn-ghost btn-sm" data-quick-submit="${item.id}">Update Submission</button>`
          }
        </div>
      </div>
    </div>
  `;
}

function bindItemCardEvents(root) {
  root.querySelectorAll("[data-open-item]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      navigate("detail", card.dataset.openItem);
    });
  });
  root.querySelectorAll("[data-quick-edit]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = state.items.find((i) => i.id === btn.dataset.quickEdit);
      if (item) openItemModal(item.type, item);
    });
  });
  root.querySelectorAll("[data-quick-submit]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = state.items.find((i) => i.id === btn.dataset.quickSubmit);
      if (item) openSubmitItemModal(item);
    });
  });
}

function renderPlanner(container) {
  const { tab, courseId, search } = state.plannerFilter;
  const filtered = state.items.filter((item) => {
    const isSub = item.status === "submitted" || item.status === "graded";
    if (tab === "test" && (item.type !== "test" || isSub)) return false;
    if (tab === "assignment" && (item.type !== "assignment" || isSub)) return false;
    if (tab === "submitted" && !isSub) return false;
    if (courseId && item.course_id !== courseId) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${item.title} ${item.description} ${item.course?.name || ""} ${item.course?.code || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  container.innerHTML = `
    <div class="filter-bar">
      <div class="tabs">
        <button class="tab-btn ${tab === "all" ? "active" : ""}" data-tab="all">All (${state.items.length})</button>
        <button class="tab-btn ${tab === "test" ? "active" : ""}" data-tab="test">Upcoming Tests</button>
        <button class="tab-btn ${tab === "assignment" ? "active" : ""}" data-tab="assignment">Assignments</button>
        <button class="tab-btn ${tab === "submitted" ? "active" : ""}" data-tab="submitted">Submitted &amp; Graded</button>
      </div>
      <div class="filter-controls">
        <select class="select" id="plannerCourseFilter">
          <option value="">All Courses</option>
          ${state.courses
            .map((c) => `<option value="${c.id}" ${courseId === c.id ? "selected" : ""}>${escapeHtml(c.code ? `${c.code} — ${c.name}` : c.name)}</option>`)
            .join("")}
        </select>
        <input class="input" id="plannerSearch" placeholder="Search tasks & tests..." value="${escapeHtml(search)}" />
      </div>
    </div>

    ${
      filtered.length === 0
        ? `<div class="empty-state">
            <h3>No matching assignments or tests</h3>
            <p>Create a new upcoming test or assignment, or adjust your filters.</p>
            <div style="display:flex;justify-content:center;gap:10px;margin-top:14px;">
              <button class="btn btn-secondary" id="emptyNewAssignBtn">+ New Assignment</button>
              <button class="btn btn-primary" id="emptyNewTestBtn">+ New Upcoming Test</button>
            </div>
          </div>`
        : `<div class="items-list">${filtered.map(renderItemCardHtml).join("")}</div>`
    }
  `;

  container.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.plannerFilter.tab = btn.dataset.tab;
      renderPlanner(container);
    });
  });
  document.getElementById("plannerCourseFilter")?.addEventListener("change", (e) => {
    state.plannerFilter.courseId = e.target.value;
    renderPlanner(container);
  });
  document.getElementById("plannerSearch")?.addEventListener("input", (e) => {
    state.plannerFilter.search = e.target.value;
    renderPlanner(container);
  });
  document.getElementById("emptyNewAssignBtn")?.addEventListener("click", () => openItemModal("assignment"));
  document.getElementById("emptyNewTestBtn")?.addEventListener("click", () => openItemModal("test"));

  bindItemCardEvents(container);
}

// --------------------------------------------------------------------------
// View 3: Assignment / Test Detail Workspace
// --------------------------------------------------------------------------

function renderItemDetail(container) {
  const item = state.selectedItem;
  if (!item) {
    navigate("planner");
    return;
  }

  const due = dueBadgeInfo(item.due_date, item.status);
  const estParts = splitMinutes(item.estimated_minutes);
  const chapters = item.chapters || [];
  const docs = item.documents || [];
  const isSubmitted = item.status === "submitted" || item.status === "graded";

  container.innerHTML = `
    <button class="detail-back" id="backToPlannerBtn">&larr; Back to Assignments &amp; Tests</button>

    <div class="detail-hero">
      <div class="detail-hero-top">
        <div style="flex:1;min-width:260px;">
          <div class="item-card-badges">
            <span class="badge ${item.type === "test" ? "badge-test" : "badge-assignment"}">
              ${item.type === "test" ? "Test / Exam" : "Assignment"}
            </span>
            ${
              item.course
                ? `<span class="badge badge-course" style="background:${escapeHtml(item.course.color)}">${escapeHtml(item.course.code ? `${item.course.code} — ${item.course.name}` : item.course.name)}</span>`
                : ""
            }
            <span class="badge badge-status-${item.status}">${statusLabel(item.status)}</span>
            <span class="badge ${due.cls}">${escapeHtml(due.text)}</span>
            ${item.weight_percent ? `<span class="badge badge-status-todo">Weight: ${item.weight_percent}%</span>` : ""}
            ${item.grade ? `<span class="badge badge-status-done">Grade: ${escapeHtml(item.grade)}</span>` : ""}
          </div>
          <h2 class="detail-title">${escapeHtml(item.title)}</h2>
          ${item.description ? `<p style="margin:0;color:var(--text-secondary);white-space:pre-wrap;">${escapeHtml(item.description)}</p>` : ""}
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn ${isSubmitted ? "btn-secondary" : "btn-success"}" id="detailSubmitBtn">
            ${isSubmitted ? "Update Submission / Grade" : `Submit ${item.type === "test" ? "Test" : "Assignment"}`}
          </button>
          <button class="btn btn-secondary" id="detailEditBtn">Edit ${item.type === "test" ? "Test" : "Task"}</button>
          ${item.course ? `<button class="btn btn-secondary" id="detailEditCourseBtn">Edit Course</button>` : ""}
          <button class="btn btn-danger-ghost" id="detailDeleteBtn">Delete</button>
        </div>
      </div>

      ${
        isSubmitted
          ? `<div style="margin-top:12px;padding:12px 14px;border-radius:10px;background:var(--success-soft);border:1px solid rgba(5,150,105,0.28);font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
              <div>
                <strong>Submitted</strong>${item.submitted_at ? ` on ${new Date(item.submitted_at).toLocaleString()}` : ""}
                ${item.grade ? ` &middot; <strong>Grade: ${escapeHtml(item.grade)}</strong>` : ""}
                ${item.actual_minutes ? ` &middot; Actual time: ${formatMinutes(item.actual_minutes)}` : ""}
                ${item.submission_notes ? `<div style="margin-top:4px;color:var(--text-secondary);">${escapeHtml(item.submission_notes)}</div>` : ""}
              </div>
              <button class="btn btn-secondary btn-sm" id="reopenEditBtn">Edit Test / Course</button>
            </div>`
          : ""
      }

      <div class="detail-meta-grid">
        <!-- Dedicated Time Left Box -->
        <div class="time-estimate-box" style="grid-column: span 2;">
          <div class="time-estimate-header">
            <span>How Much Time Do You Have Left?</span>
            <span style="font-family:var(--font-mono);">Subtasks total: ${formatMinutes(item.chapters_estimated_minutes)} (${formatMinutes(item.chapters_remaining_minutes)} left)</span>
          </div>
          <div class="time-inputs-row" style="flex-wrap:wrap;">
            <input type="number" min="0" max="500" id="detailEstHours" value="${estParts.hours}" aria-label="Hours left" />
            <span style="font-size:12.5px;color:var(--text-secondary);">hrs</span>
            <input type="number" min="0" max="59" step="5" id="detailEstMins" value="${estParts.minutes}" aria-label="Minutes left" />
            <span style="font-size:12.5px;color:var(--text-secondary);">min</span>
            <button class="btn btn-primary btn-sm" id="saveItemEstimateBtn">Save Time Left</button>
            ${
              chapters.some((c) => c.status !== "done")
                ? `<button class="btn btn-secondary btn-sm" id="rescaleSubtasksBtn" title="Proportionally adjust remaining subtasks to fit your time left">Fit Subtasks to Time Left</button>`
                : ""
            }
            <button class="btn btn-ai btn-sm" id="heroGenSubtasksBtn">&#10024; Let Gemini Generate Subtasks</button>
          </div>
          <div class="time-presets">
            ${[30, 60, 120, 180, 300, 480, 600]
              .map((m) => `<button type="button" class="preset-chip" data-item-preset="${m}">${formatMinutes(m)}</button>`)
              .join("")}
          </div>
        </div>

        <div class="card" style="padding:14px;">
          <div class="kpi-label">Progress</div>
          <div class="kpi-value mono" style="font-size:22px;margin-top:4px;">${item.chapters_done}/${item.chapters_total}</div>
          <div class="kpi-sub">chapters completed</div>
        </div>

        <div class="card" style="padding:14px;">
          <div class="kpi-label">Attached Files</div>
          <div class="kpi-value mono" style="font-size:22px;margin-top:4px;">${docs.length}</div>
          <div class="kpi-sub">used by Gemini AI</div>
        </div>
      </div>
    </div>

    <div class="detail-columns">
      <!-- Left Column: Chapters / Subtasks -->
      <div class="card">
        <div class="section-header" style="flex-wrap:wrap;">
          <div>
            <h3 class="section-title">Chapters &amp; Subtasks — What Needs to Be Done</h3>
            <div class="field-hint">Upload course docs and let Gemini generate subtasks fitted to your time left, or add/edit manually.</div>
          </div>
          <button class="btn btn-ai btn-sm" id="genSubtasksHeaderBtn">&#10024; Generate Subtasks (Gemini)</button>
        </div>

        <!-- Inline Add Chapter Form -->
        <form class="chapter-add-box" id="addChapterForm">
          <div style="display:grid;grid-template-columns:110px 1fr;gap:8px;margin-bottom:8px;">
            <input class="input" id="newChLabel" placeholder="Ch. ${chapters.length + 1}" value="Ch. ${chapters.length + 1}" />
            <input class="input" id="newChTitle" placeholder="Chapter or subtask title (e.g., Eigenvalues & Proofs)" required />
          </div>
          <textarea class="textarea" id="newChNotes" style="min-height:58px;margin-bottom:8px;" placeholder="What do you need to do? (e.g., Read lecture slides 12-28, solve exercises 3-5, memorize theorem proof)"></textarea>
          <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="field-label" style="margin:0;">Time Estimate:</span>
              <input class="input" type="number" min="0" max="100" id="newChHours" value="0" style="width:62px;padding:6px 8px;text-align:center;" />
              <span class="field-hint">h</span>
              <input class="input" type="number" min="0" max="59" step="5" id="newChMins" value="45" style="width:62px;padding:6px 8px;text-align:center;" />
              <span class="field-hint">m</span>
            </div>
            <button class="btn btn-primary btn-sm" type="submit">+ Add Chapter / Subtask</button>
          </div>
        </form>

        <!-- Chapter List -->
        ${
          chapters.length === 0
            ? `<div class="empty-state"><h3>No subtasks yet</h3><p>Upload a course document on the right or click <strong>Generate Subtasks (Gemini)</strong> — just fill in how much time you have left above!</p></div>`
            : `<div class="chapter-list">
                ${chapters.map((ch) => renderChapterCardHtml(ch)).join("")}
              </div>`
        }
      </div>

      <!-- Right Column: Relevant Documents -->
      <div class="card">
        <div class="section-header">
          <div>
            <h3 class="section-title">Relevant Documents</h3>
            <div class="field-hint">Attach PDFs, slides (.pptx), notes (.md/.txt/.docx), or images. Gemini reads them automatically.</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
          <select class="select" id="uploadDocRole">
            <option value="lecture" selected>Lecture Slides / Course Doc</option>
            <option value="study_material">Study Material</option>
            <option value="reference">Past Exam / Reference</option>
            <option value="submission">Test / Assignment Submission</option>
          </select>
          <select class="select" id="uploadDocChapter">
            <option value="">Link to entire ${item.type}</option>
            ${chapters
              .map((c) => `<option value="${c.id}">${escapeHtml(c.chapter_label ? `${c.chapter_label}: ${c.title}` : c.title)}</option>`)
              .join("")}
          </select>
        </div>

        <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:10px;padding:8px 10px;border-radius:8px;background:var(--ai-soft);color:var(--text);cursor:pointer;">
          <input type="checkbox" id="autoGenAfterItemUpload" ${state.settings.gemini_api_key_configured ? "checked" : ""} />
          <span><strong>Auto-generate subtasks &amp; themes with Gemini</strong> after upload (fitted to my time left)</span>
        </label>

        <div class="dropzone" id="itemDropzone">
          <div style="font-weight:600;margin-bottom:3px;">Drop course documents here or click to attach</div>
          <div class="field-hint">PDF, PPTX, DOCX, TXT, MD, PNG, JPG (up to 25 MB)</div>
          <input type="file" id="itemFileInput" multiple class="hidden" />
        </div>

        ${
          docs.length === 0
            ? `<p class="field-hint" style="text-align:center;">No documents attached to this ${item.type} yet.</p>`
            : `<div class="doc-list">${docs.map((d) => renderDocRowHtml(d, chapters)).join("")}</div>`
        }
      </div>
    </div>
  `;

  // Event bindings
  const getTimeLeftMinutes = () => {
    const h = parseInt(document.getElementById("detailEstHours").value || "0", 10);
    const m = parseInt(document.getElementById("detailEstMins").value || "0", 10);
    return Math.max(0, h * 60 + m);
  };

  document.getElementById("backToPlannerBtn").addEventListener("click", () => navigate("planner"));
  document.getElementById("detailSubmitBtn").addEventListener("click", () => openSubmitItemModal(item));
  document.getElementById("detailEditBtn").addEventListener("click", () => openItemModal(item.type, item));
  document.getElementById("reopenEditBtn")?.addEventListener("click", () => openItemModal(item.type, item));
  document.getElementById("detailEditCourseBtn")?.addEventListener("click", () => {
    const c = state.courses.find((x) => x.id === item.course_id);
    if (c) openCourseModal(c);
  });
  document.getElementById("detailDeleteBtn").addEventListener("click", async () => {
    if (!confirm(`Delete "${item.title}" and all its chapters?`)) return;
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    toast("Deleted successfully", "success");
    state.selectedItem = null;
    state.selectedItemId = null;
    await refreshData();
    navigate("planner");
  });

  // Time Left box handlers
  const saveEst = async (totalMins) => {
    await api(`/api/items/${item.id}`, {
      method: "PUT",
      body: { estimated_minutes: Math.max(0, totalMins) },
    });
    toast(`Time left saved (${formatMinutes(totalMins)})`, "success");
    await refreshData();
  };

  document.getElementById("saveItemEstimateBtn").addEventListener("click", () => {
    saveEst(getTimeLeftMinutes());
  });

  document.getElementById("rescaleSubtasksBtn")?.addEventListener("click", async () => {
    const mins = getTimeLeftMinutes();
    if (mins <= 0) {
      toast("Enter how much time you have left first.", "warning");
      return;
    }
    await api(`/api/items/${item.id}/rescale-time`, {
      method: "POST",
      body: { available_minutes: mins },
    });
    toast(`Subtasks scaled to fit ${formatMinutes(mins)}!`, "success");
    await refreshData();
  });

  const openGenModal = () => openGenerateSubtasksModal(item, getTimeLeftMinutes());
  document.getElementById("heroGenSubtasksBtn").addEventListener("click", openGenModal);
  document.getElementById("genSubtasksHeaderBtn").addEventListener("click", openGenModal);

  container.querySelectorAll("[data-item-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mins = parseInt(btn.dataset.itemPreset, 10);
      const sp = splitMinutes(mins);
      document.getElementById("detailEstHours").value = sp.hours;
      document.getElementById("detailEstMins").value = sp.minutes;
      saveEst(mins);
    });
  });

  // Add Chapter Form
  document.getElementById("addChapterForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("newChTitle").value.trim();
    if (!title) return;
    const h = parseInt(document.getElementById("newChHours").value || "0", 10);
    const m = parseInt(document.getElementById("newChMins").value || "0", 10);
    await api(`/api/items/${item.id}/chapters`, {
      method: "POST",
      body: {
        chapter_label: document.getElementById("newChLabel").value.trim(),
        title,
        todo_notes: document.getElementById("newChNotes").value.trim(),
        estimated_minutes: Math.max(0, h * 60 + m),
      },
    });
    toast("Chapter subtask added", "success");
    await refreshData();
  });

  // Chapter actions
  container.querySelectorAll("[data-cycle-ch]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ch = chapters.find((c) => c.id === btn.dataset.cycleCh);
      if (!ch) return;
      const next = ch.status === "todo" ? "in_progress" : ch.status === "in_progress" ? "done" : "todo";
      await api(`/api/chapters/${ch.id}`, { method: "PUT", body: { status: next } });
      await refreshData();
    });
  });

  container.querySelectorAll("[data-edit-ch]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ch = chapters.find((c) => c.id === btn.dataset.editCh);
      if (ch) openEditChapterModal(ch);
    });
  });

  container.querySelectorAll("[data-del-ch]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ch = chapters.find((c) => c.id === btn.dataset.delCh);
      if (!ch || !confirm(`Delete chapter "${ch.title}"?`)) return;
      await api(`/api/chapters/${ch.id}`, { method: "DELETE" });
      toast("Chapter removed", "success");
      await refreshData();
    });
  });

  container.querySelectorAll("[data-explain-ch]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ch = chapters.find((c) => c.id === btn.dataset.explainCh);
      if (ch) openExplanationModal(ch, item);
    });
  });

  container.querySelectorAll("[data-test-ch]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ch = chapters.find((c) => c.id === btn.dataset.testCh);
      if (ch) openPracticeTestModal(ch, item);
    });
  });

  // Document Dropzone & Upload
  const dropzone = document.getElementById("itemDropzone");
  const fileInput = document.getElementById("itemFileInput");
  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const role = document.getElementById("uploadDocRole").value;
    const chapterId = document.getElementById("uploadDocChapter").value || null;
    const shouldAutoGen = document.getElementById("autoGenAfterItemUpload")?.checked && role !== "submission";
    const uploadedDocIds = [];

    for (const file of files) {
      try {
        const b64 = await fileToBase64(file);
        const createdDoc = await api("/api/documents", {
          method: "POST",
          body: {
            filename: file.name,
            mime_type: file.type,
            content_base64: b64,
            course_id: item.course_id || null,
            item_id: item.id,
            chapter_id: chapterId,
            doc_role: role,
          },
        });
        uploadedDocIds.push(createdDoc.id);
        toast(`Attached "${file.name}"`, "success");
      } catch (err) {
        toast(`Failed to upload ${file.name}: ${err.message}`, "error");
      }
    }

    if (shouldAutoGen && uploadedDocIds.length > 0) {
      if (!state.settings.gemini_api_key_configured) {
        toast("Document saved! Add your Gemini API token in Settings to auto-generate subtasks.", "warning");
      } else {
        const availMins = getTimeLeftMinutes() || item.estimated_minutes || 120;
        dropzone.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;font-weight:600;"><span class="spinner"></span> Gemini is generating subtasks &amp; themes (${formatMinutes(availMins)} budget)...</div>`;
        try {
          const genRes = await apiGemini(
            `/api/items/${item.id}/generate-subtasks`,
            {
              available_minutes: availMins,
              document_ids: uploadedDocIds,
              create_themes: true,
              replace_existing: false,
            },
            {
              label: "Generate Subtasks",
              onStatus: (msg) => {
                dropzone.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;font-weight:600;color:var(--warning);"><span class="spinner"></span> ${escapeHtml(msg)}</div>`;
              },
            }
          );
          toast(
            `Gemini generated ${genRes.subtasks_created} subtask${genRes.subtasks_created !== 1 ? "s" : ""}${genRes.themes_created ? ` and ${genRes.themes_created} theme${genRes.themes_created !== 1 ? "s" : ""}` : ""} for your ${formatMinutes(availMins)} left!`,
            "success"
          );
        } catch (err) {
          toast(`Uploaded, but Gemini subtask generation failed: ${err.message}`, "error");
        }
      }
    }

    await refreshData();
  };

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => uploadFiles(fileInput.files));
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    uploadFiles(e.dataTransfer.files);
  });

  bindDocRowEvents(container);
}

function renderChapterCardHtml(ch) {
  const icon =
    ch.status === "done"
      ? "&#10003;"
      : ch.status === "in_progress"
      ? "&bull;"
      : "";
  return `
    <div class="chapter-card ${ch.status === "done" ? "is-done" : ""}">
      <div class="chapter-top">
        <button class="chapter-check status-${ch.status}" data-cycle-ch="${ch.id}" title="Click to toggle status (${statusLabel(ch.status)})">
          ${icon}
        </button>
        <div class="chapter-main">
          <div class="chapter-title-row">
            ${ch.chapter_label ? `<span class="chapter-pill">${escapeHtml(ch.chapter_label)}</span>` : ""}
            <span class="chapter-title-text">${escapeHtml(ch.title)}</span>
            <span class="badge badge-status-${ch.status}">${statusLabel(ch.status)}</span>
          </div>
          ${ch.todo_notes ? `<p class="chapter-notes">${escapeHtml(ch.todo_notes)}</p>` : ""}
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-ghost btn-sm" data-edit-ch="${ch.id}" title="Edit chapter & time estimate">Edit</button>
          <button class="btn btn-danger-ghost btn-sm" data-del-ch="${ch.id}" title="Delete">&times;</button>
        </div>
      </div>

      <div class="chapter-actions-bar">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="chapter-time-inline" title="Estimated time for this chapter">
            Est: ${formatMinutes(ch.estimated_minutes)}
          </span>
          ${ch.docs_count > 0 ? `<span class="badge badge-status-todo">${ch.docs_count} doc${ch.docs_count > 1 ? "s" : ""}</span>` : ""}
        </div>

        <div class="chapter-ai-buttons">
          <button class="btn btn-ai-soft btn-sm" data-explain-ch="${ch.id}">
            <span>&#10024; Explain${ch.explanations_count > 0 ? ` (${ch.explanations_count})` : ""}</span>
          </button>
          <button class="btn btn-ai btn-sm" data-test-ch="${ch.id}">
            <span>&#9997; Generate Test${ch.tests_count > 0 ? ` (${ch.tests_count})` : ""}</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderDocRowHtml(doc, chapters = []) {
  const ch = chapters.find((c) => c.id === doc.chapter_id);
  return `
    <div class="doc-row">
      <div class="doc-info">
        <div class="doc-name" title="${escapeHtml(doc.original_name)}">${escapeHtml(doc.original_name)}</div>
        <div class="doc-meta">
          <span>${roleLabel(doc.doc_role)}</span>
          <span>${formatBytes(doc.size_bytes)}</span>
          ${ch ? `<span>${escapeHtml(ch.chapter_label || ch.title)}</span>` : ""}
        </div>
      </div>
      <div class="doc-actions">
        <a class="btn btn-ghost btn-sm" href="/api/documents/${doc.id}/download?inline=1" target="_blank" rel="noopener">View</a>
        <a class="btn btn-ghost btn-sm" href="/api/documents/${doc.id}/download">Save</a>
        <button class="btn btn-danger-ghost btn-sm" data-del-doc="${doc.id}">&times;</button>
      </div>
    </div>
  `;
}

function bindDocRowEvents(root) {
  root.querySelectorAll("[data-del-doc]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this document permanently?")) return;
      await api(`/api/documents/${btn.dataset.delDoc}`, { method: "DELETE" });
      toast("Document deleted", "success");
      await refreshData();
    });
  });
}

// --------------------------------------------------------------------------
// View 4: Courses & Lectures
// --------------------------------------------------------------------------

function renderCourses(container) {
  container.innerHTML = `
    <div class="section-header" style="margin-bottom:18px;flex-wrap:wrap;">
      <div>
        <h2 class="section-title">Your Bachelor Courses &amp; Modules</h2>
        <div class="field-hint">Upload a course document and fill in how much time you have left — Gemini automatically creates the course themes, tasks, and chapter subtasks.</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-ai-soft" id="coursesUploadAutoBtn">&#10024; Upload Course Doc</button>
        <button class="btn btn-primary" id="newCourseBtn">+ New Course</button>
      </div>
    </div>

    ${
      state.courses.length === 0
        ? `<div class="empty-state">
            <h3>No courses added yet</h3>
            <p>Add your current semester courses (e.g., Algorithms, Linear Algebra, Macroeconomics), then upload a syllabus or lecture slides to let Gemini generate your tasks, themes, and subtasks.</p>
            <button class="btn btn-primary" style="margin-top:12px;" id="emptyAddCourseBtn">+ Add Your First Course</button>
          </div>`
        : `<div class="courses-grid">
            ${state.courses
              .map((c) => {
                const cItems = state.items.filter((i) => i.course_id === c.id);
                const active = cItems.filter((i) => i.status !== "submitted" && i.status !== "graded");
                const remMins = active.reduce((a, b) => a + (b.effective_remaining_minutes || 0), 0);
                const cDocs = state.documents.filter((d) => d.course_id === c.id);
                const cThemes = state.themes.filter((t) => t.course_id === c.id);
                return `
                  <div class="course-card">
                    <div class="course-accent" style="background:${escapeHtml(c.color)}"></div>
                    <div class="course-body">
                      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                        <div>
                          <span class="badge badge-status-todo">${escapeHtml(c.code || "Module")}</span>
                          <h3 style="margin:6px 0 2px;font-size:16px;">${escapeHtml(c.name)}</h3>
                          <div class="field-hint">${escapeHtml(c.instructor || "No instructor")}${c.semester ? ` &middot; ${escapeHtml(c.semester)}` : ""}</div>
                        </div>
                        <div style="display:flex;gap:4px;">
                          <button class="btn btn-ghost btn-sm" data-edit-course="${c.id}">Edit</button>
                          <button class="btn btn-danger-ghost btn-sm" data-del-course="${c.id}">&times;</button>
                        </div>
                      </div>
                      ${c.description ? `<p style="margin:0;font-size:13px;color:var(--text-secondary);">${escapeHtml(c.description)}</p>` : ""}

                      ${
                        cThemes.length > 0
                          ? `<div>
                              <div class="field-label" style="margin-bottom:5px;">Extracted Themes (${cThemes.length})</div>
                              <div class="chip-list">
                                ${cThemes
                                  .map(
                                    (th) =>
                                      `<button type="button" class="chip" style="cursor:pointer;" data-open-theme="${th.id}" title="Click to view/edit theme">${escapeHtml(th.title)}</button>`
                                  )
                                  .join("")}
                              </div>
                            </div>`
                          : ""
                      }

                      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:10px;border-top:1px solid var(--border);">
                        <span class="badge badge-status-todo">${active.length} active / ${cItems.length} total</span>
                        <span class="badge badge-time">${formatMinutes(remMins)} left</span>
                        <span class="badge badge-status-todo">${cDocs.length} docs</span>
                      </div>
                      <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        <button class="btn btn-ai btn-sm" data-course-upload="${c.id}">&#10024; Upload Doc &amp; Auto-Plan</button>
                        ${
                          cDocs.length > 0
                            ? `<button class="btn btn-secondary btn-sm" data-course-gen-existing="${c.id}">Generate from Docs</button>`
                            : ""
                        }
                        <button class="btn btn-ai-soft btn-sm" data-course-ai="${c.id}">AI Overview</button>
                      </div>
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>`
    }
  `;

  document.getElementById("coursesUploadAutoBtn")?.addEventListener("click", () => openUploadDocumentModal());
  document.getElementById("newCourseBtn")?.addEventListener("click", () => openCourseModal());
  document.getElementById("emptyAddCourseBtn")?.addEventListener("click", () => openCourseModal());

  container.querySelectorAll("[data-edit-course]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.courses.find((x) => x.id === btn.dataset.editCourse);
      if (c) openCourseModal(c);
    });
  });

  container.querySelectorAll("[data-del-course]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const c = state.courses.find((x) => x.id === btn.dataset.delCourse);
      if (!c || !confirm(`Delete course "${c.name}"? Linked tasks will remain unassigned.`)) return;
      await api(`/api/courses/${c.id}`, { method: "DELETE" });
      toast("Course deleted", "success");
      await refreshData();
    });
  });

  container.querySelectorAll("[data-open-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const th = state.themes.find((t) => t.id === btn.dataset.openTheme);
      if (th) openThemeModal(th);
    });
  });

  container.querySelectorAll("[data-course-upload]").forEach((btn) => {
    btn.addEventListener("click", () => openUploadDocumentModal(btn.dataset.courseUpload));
  });

  container.querySelectorAll("[data-course-gen-existing]").forEach((btn) => {
    btn.addEventListener("click", () => openGenerateFromDocsModal({ courseId: btn.dataset.courseGenExisting }));
  });

  container.querySelectorAll("[data-course-ai]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.overviewCourseScope = btn.dataset.courseAi;
      navigate("overview");
    });
  });
}

// --------------------------------------------------------------------------
// View 5: Documents Library
// --------------------------------------------------------------------------

function renderDocumentsView(container) {
  const { courseId, role } = state.docFilter;
  const filtered = state.documents.filter((d) => {
    if (courseId && d.course_id !== courseId) return false;
    if (role && d.doc_role !== role) return false;
    return true;
  });

  container.innerHTML = `
    <div class="filter-bar">
      <div class="filter-controls">
        <select class="select" id="docCourseFilter">
          <option value="">All Courses</option>
          ${state.courses.map((c) => `<option value="${c.id}" ${courseId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
        </select>
        <select class="select" id="docRoleFilter">
          <option value="">All Types</option>
          <option value="lecture" ${role === "lecture" ? "selected" : ""}>Lecture Slides / Notes</option>
          <option value="study_material" ${role === "study_material" ? "selected" : ""}>Study Material</option>
          <option value="reference" ${role === "reference" ? "selected" : ""}>Past Exam / Reference</option>
          <option value="submission" ${role === "submission" ? "selected" : ""}>Submissions</option>
        </select>
      </div>
      <button class="btn btn-ai" id="globalUploadDocBtn">&#10024; Upload Course Doc &amp; Auto-Plan</button>
    </div>

    ${
      filtered.length === 0
        ? `<div class="empty-state">
            <h3>No documents uploaded yet</h3>
            <p>Upload lecture PDFs, PowerPoint slides (.pptx), Word docs (.docx), Markdown notes, or images. Gemini creates your tasks, themes, and subtasks automatically based on the time you have left.</p>
            <button class="btn btn-ai" style="margin-top:12px;" id="emptyUploadDocBtn">&#10024; Upload Course Document</button>
          </div>`
        : `<div class="card">
            <div class="doc-list">
              ${filtered
                .map((d) => {
                  const course = state.courses.find((c) => c.id === d.course_id);
                  const item = state.items.find((i) => i.id === d.item_id);
                  return `
                    <div class="doc-row">
                      <div class="doc-info">
                        <div class="doc-name">${escapeHtml(d.original_name)}</div>
                        <div class="doc-meta">
                          <span class="badge badge-status-todo">${roleLabel(d.doc_role)}</span>
                          <span>${formatBytes(d.size_bytes)}</span>
                          ${course ? `<span style="color:${escapeHtml(course.color)};font-weight:600;">${escapeHtml(course.code || course.name)}</span>` : ""}
                          ${item ? `<span>Linked: ${escapeHtml(item.title)}</span>` : ""}
                          ${d.has_extracted_text ? `<span style="color:var(--success);">Text indexed</span>` : ""}
                        </div>
                      </div>
                      <div class="doc-actions">
                        <button class="btn btn-ai-soft btn-sm" data-gen-from-doc="${d.id}">&#10024; Build Tasks &amp; Themes</button>
                        <a class="btn btn-secondary btn-sm" href="/api/documents/${d.id}/download?inline=1" target="_blank" rel="noopener">Preview</a>
                        <a class="btn btn-ghost btn-sm" href="/api/documents/${d.id}/download">Download</a>
                        <button class="btn btn-danger-ghost btn-sm" data-del-doc="${d.id}">&times;</button>
                      </div>
                    </div>
                  `;
                })
                .join("")}
            </div>
          </div>`
    }
  `;

  document.getElementById("docCourseFilter")?.addEventListener("change", (e) => {
    state.docFilter.courseId = e.target.value;
    renderDocumentsView(container);
  });
  document.getElementById("docRoleFilter")?.addEventListener("change", (e) => {
    state.docFilter.role = e.target.value;
    renderDocumentsView(container);
  });
  document.getElementById("globalUploadDocBtn")?.addEventListener("click", () => openUploadDocumentModal());
  document.getElementById("emptyUploadDocBtn")?.addEventListener("click", () => openUploadDocumentModal());
  container.querySelectorAll("[data-gen-from-doc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const doc = state.documents.find((x) => x.id === btn.dataset.genFromDoc);
      if (doc) openGenerateFromDocsModal({ courseId: doc.course_id || "", docIds: [doc.id], docName: doc.original_name });
    });
  });
  bindDocRowEvents(container);
}

// --------------------------------------------------------------------------
// View 6: AI Lecture & Themes Overview (Gemini Backend)
// --------------------------------------------------------------------------

function renderOverviewView(container) {
  const scopeVal = state.overviewCourseScope || "";
  const selectedOv = state.overviews.find((o) => o.id === state.selectedOverviewId) || state.overviews[0] || null;
  let parsedOv = null;
  if (selectedOv && selectedOv.overview_json) {
    try {
      parsedOv = JSON.parse(selectedOv.overview_json);
    } catch {
      parsedOv = null;
    }
  }

  container.innerHTML = `
    <div class="ai-hero-card">
      <div style="display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px;">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span class="badge badge-ai">Gemini AI Backend</span>
            <span class="field-hint">${escapeHtml(state.settings.gemini_model || "gemini-2.5-flash")}</span>
          </div>
          <h2 style="margin:0 0 5px;font-size:20px;">AI Overview of All Lectures &amp; Themes</h2>
          <p style="margin:0;color:var(--text-secondary);max-width:680px;">
            Gemini analyzes your courses, chapters, deadlines, time estimates, and attached lecture slides/PDFs to map out key themes, cross-topic connections, likely exam questions, and a prioritized study plan.
          </p>
        </div>
        ${
          !state.settings.gemini_api_key_configured
            ? `<button class="btn btn-secondary" id="ovConfigKeyBtn">Set Gemini API Token</button>`
            : ""
        }
      </div>

      <div style="display:grid;grid-template-columns:240px 1fr auto;gap:10px;margin-top:18px;align-items:end;">
        <div>
          <label class="field-label">Scope</label>
          <select class="select" id="ovScopeSelect">
            <option value="">All Courses &amp; Lectures</option>
            ${state.courses
              .map((c) => `<option value="${c.id}" ${scopeVal === c.id ? "selected" : ""}>${escapeHtml(c.code ? `${c.code} — ${c.name}` : c.name)}</option>`)
              .join("")}
          </select>
        </div>
        <div>
          <label class="field-label">Optional Focus Prompt</label>
          <input class="input" id="ovFocusInput" placeholder="e.g., Focus on exam-critical proofs and connections between algorithms and linear algebra..." />
        </div>
        <button class="btn btn-ai" id="generateOverviewBtn" style="height:39px;">
          &#10024; Generate AI Overview
        </button>
      </div>
    </div>

    ${
      state.overviews.length > 0
        ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="field-label" style="margin:0;">Saved Overviews:</span>
              <select class="select" id="ovHistorySelect" style="width:auto;min-width:260px;">
                ${state.overviews
                  .map(
                    (o) =>
                      `<option value="${o.id}" ${selectedOv && selectedOv.id === o.id ? "selected" : ""}>${escapeHtml(o.scope_label)} — ${new Date(o.created_at).toLocaleString()}</option>`
                  )
                  .join("")}
              </select>
            </div>
            ${selectedOv ? `<button class="btn btn-danger-ghost btn-sm" id="deleteOverviewBtn">Delete Snapshot</button>` : ""}
          </div>`
        : ""
    }

    <div id="overviewResultArea">
      ${
        !selectedOv
          ? `<div class="empty-state">
              <h3>No AI Lecture Overview generated yet</h3>
              <p>Click <strong>Generate AI Overview</strong> above to synthesize your lectures, chapters, and uploaded documents with Gemini.</p>
            </div>`
          : renderParsedOverviewHtml(selectedOv, parsedOv)
      }
    </div>
  `;

  document.getElementById("ovConfigKeyBtn")?.addEventListener("click", () => navigate("settings"));
  document.getElementById("ovScopeSelect")?.addEventListener("change", (e) => {
    state.overviewCourseScope = e.target.value;
  });
  document.getElementById("ovHistorySelect")?.addEventListener("change", (e) => {
    state.selectedOverviewId = e.target.value;
    renderOverviewView(container);
  });
  document.getElementById("deleteOverviewBtn")?.addEventListener("click", async () => {
    if (!selectedOv || !confirm("Delete this saved AI overview?")) return;
    await api(`/api/ai/overviews/${selectedOv.id}`, { method: "DELETE" });
    state.selectedOverviewId = null;
    toast("Overview deleted", "success");
    await refreshData();
  });

  document.getElementById("generateOverviewBtn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Analyzing lectures with Gemini...`;
    try {
      const courseId = document.getElementById("ovScopeSelect").value || null;
      const focusPrompt = document.getElementById("ovFocusInput").value.trim();
      const created = await apiGemini(
        "/api/ai/overview",
        { course_id: courseId, focus_prompt: focusPrompt },
        {
          label: "AI Lecture Overview",
          onStatus: (msg) => {
            btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
          },
        }
      );
      state.selectedOverviewId = created.id;
      toast("AI Lecture & Themes Overview generated!", "success");
      await refreshData();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });
}

function renderParsedOverviewHtml(ov, parsed) {
  if (!parsed) {
    return `<div class="card md-content">${renderMarkdown(ov.content_md || "No overview content.")}</div>`;
  }

  const themes = parsed.themes || [];
  const lectures = parsed.lecture_summaries || [];
  const connections = parsed.connections || [];
  const plan = parsed.study_plan || [];
  const usedDocs = parsed.used_documents || [];

  return `
    <div style="display:flex;flex-direction:column;gap:20px;">
      <!-- Executive Summary -->
      <div class="card">
        <div class="section-header">
          <h3 class="section-title">Executive Summary — ${escapeHtml(ov.scope_label)}</h3>
          <span class="field-hint">Model: ${escapeHtml(ov.model_used || "Gemini")} &middot; ${usedDocs.length} docs read</span>
        </div>
        <p style="margin:0;font-size:14.5px;line-height:1.65;">${escapeHtml(parsed.executive_summary || "")}</p>
        ${
          usedDocs.length > 0
            ? `<div class="chip-list" style="margin-top:12px;">
                ${usedDocs.map((n) => `<span class="chip">&#128196; ${escapeHtml(n)}</span>`).join("")}
              </div>`
            : ""
        }
      </div>

      <!-- Major Themes -->
      ${
        themes.length > 0
          ? `<div>
              <h3 class="section-title">Core Themes &amp; Concepts (${themes.length})</h3>
              <div class="themes-grid">
                ${themes
                  .map(
                    (t) => `
                  <div class="theme-card">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                      <span class="badge badge-ai">${escapeHtml(t.course || "Theme")}</span>
                      <span class="badge ${t.importance === "high" ? "badge-urgent" : "badge-status-todo"}">${escapeHtml(t.importance || "medium")} priority</span>
                    </div>
                    <h4 style="margin:0;font-size:15.5px;">${escapeHtml(t.title)}</h4>
                    <p style="margin:0;font-size:13px;color:var(--text-secondary);">${escapeHtml(t.summary)}</p>
                    ${
                      (t.key_concepts || []).length > 0
                        ? `<div class="chip-list">${t.key_concepts.map((kc) => `<span class="chip">${escapeHtml(kc)}</span>`).join("")}</div>`
                        : ""
                    }
                    ${
                      (t.related_chapters || []).length > 0
                        ? `<div class="field-hint">Related: ${escapeHtml(t.related_chapters.join(", "))}</div>`
                        : ""
                    }
                  </div>
                `
                  )
                  .join("")}
              </div>
            </div>`
          : ""
      }

      <!-- Lecture Breakdown -->
      ${
        lectures.length > 0
          ? `<div class="card">
              <h3 class="section-title" style="margin-bottom:12px;">Lecture &amp; Material Breakdown</h3>
              <div style="display:flex;flex-direction:column;gap:12px;">
                ${lectures
                  .map(
                    (lec) => `
                  <div style="padding:14px;border-radius:10px;border:1px solid var(--border);background:var(--surface-subtle);">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
                      <strong>${escapeHtml(lec.lecture_or_source)}</strong>
                      <span class="badge badge-status-todo">${escapeHtml(lec.course || "")}</span>
                    </div>
                    ${
                      (lec.key_takeaways || []).length > 0
                        ? `<div style="margin-bottom:8px;">
                            <div class="field-label">Key Takeaways</div>
                            <ul style="margin:4px 0 0;padding-left:18px;font-size:13px;">
                              ${lec.key_takeaways.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}
                            </ul>
                          </div>`
                        : ""
                    }
                    ${
                      (lec.likely_exam_questions || []).length > 0
                        ? `<div>
                            <div class="field-label" style="color:var(--ai);">Likely Exam Questions</div>
                            <ul style="margin:4px 0 0;padding-left:18px;font-size:13px;">
                              ${lec.likely_exam_questions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}
                            </ul>
                          </div>`
                        : ""
                    }
                  </div>
                `
                  )
                  .join("")}
              </div>
            </div>`
          : ""
      }

      <!-- Study Plan & Connections -->
      <div class="dashboard-grid">
        ${
          plan.length > 0
            ? `<div class="card">
                <h3 class="section-title" style="margin-bottom:12px;">Recommended Study Plan</h3>
                <div style="display:flex;flex-direction:column;gap:10px;">
                  ${plan
                    .map(
                      (p, idx) => `
                    <div class="study-plan-step">
                      <span class="step-num">${p.priority_order || idx + 1}</span>
                      <div style="flex:1;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                          <strong>${escapeHtml(p.focus_area)}</strong>
                          ${p.recommended_hours ? `<span class="badge badge-time">${p.recommended_hours}h</span>` : ""}
                        </div>
                        <div class="field-hint" style="margin-top:2px;">${escapeHtml(p.reason || "")}</div>
                      </div>
                    </div>
                  `
                    )
                    .join("")}
                </div>
              </div>`
            : ""
        }

        ${
          connections.length > 0
            ? `<div class="card">
                <h3 class="section-title" style="margin-bottom:12px;">Cross-Topic Connections</h3>
                <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;font-size:13.5px;">
                  ${connections.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}
                </ul>
              </div>`
            : ""
        }
      </div>

      ${
        parsed.markdown_notes
          ? `<div class="card md-content"><h3 class="section-title" style="margin-top:0;">Additional Study Notes</h3>${renderMarkdown(parsed.markdown_notes)}</div>`
          : ""
      }
    </div>
  `;
}

// --------------------------------------------------------------------------
// View 7: Settings & Gemini Backend Config
// --------------------------------------------------------------------------

function formatTokenCount(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
  if (num >= 1_000) return `${Math.round(num / 1_000)}k`;
  return num ? String(num) : "";
}

function renderSettingsView(container) {
  const s = state.settings;
  const fallbackModels = [
    { id: "gemini-2.5-flash", display_name: "Gemini 2.5 Flash", description: "Fast, well-rounded multimodal model.", input_token_limit: 1048576, output_token_limit: 65536 },
    { id: "gemini-2.5-pro", display_name: "Gemini 2.5 Pro", description: "Deep reasoning, math, and proofs.", input_token_limit: 1048576, output_token_limit: 65536 },
    { id: "gemini-2.0-flash", display_name: "Gemini 2.0 Flash", description: "Previous-gen fast flash model.", input_token_limit: 1048576, output_token_limit: 8192 },
  ];
  const cachedModels = Array.isArray(s.gemini_models_cache) && s.gemini_models_cache.length > 0 ? s.gemini_models_cache : [];
  const availableModels = cachedModels.length > 0 ? cachedModels : fallbackModels;
  const knownIds = new Set(availableModels.map((m) => m.id));
  const isCustom = Boolean(s.gemini_model && !knownIds.has(s.gemini_model));

  container.innerHTML = `
    <div style="max-width:760px;display:flex;flex-direction:column;gap:20px;">
      <form class="card" id="geminiSettingsForm">
        <div class="section-header">
          <div>
            <h2 class="section-title">Gemini AI Backend Configuration</h2>
            <div class="field-hint">Your API token is stored locally in SQLite. Models can be fetched live from Google's API and busy requests retry automatically with live progress.</div>
          </div>
          <span class="badge ${s.gemini_api_key_configured ? "badge-status-done" : "badge-soon"}">
            ${s.gemini_api_key_configured ? `Configured (${s.gemini_api_key_masked})` : "Not Configured"}
          </span>
        </div>

        <div class="field-group">
          <label class="field-label" for="geminiKeyInput">Gemini API Token</label>
          <div style="display:flex;gap:8px;">
            <input class="input" type="password" id="geminiKeyInput" placeholder="${s.gemini_api_key_configured ? "Enter new key to replace current token (" + escapeHtml(s.gemini_api_key_masked) + ")" : "AIza..."}" autocomplete="off" />
            <button type="button" class="btn btn-secondary" id="toggleKeyVisBtn">Show</button>
          </div>
          <div class="field-hint">
            Get a key from Google AI Studio (aistudio.google.com/apikey) or set the <code>GEMINI_API_KEY</code> environment variable.
          </div>
        </div>

        <div class="field-group">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <label class="field-label" for="geminiModelSelect" style="margin:0;">
              Gemini Model ${cachedModels.length > 0 ? `<span class="badge badge-status-done" style="margin-left:6px;">${cachedModels.length} live Google models</span>` : `<span class="field-hint">(default list — click Fetch to load latest)</span>`}
            </label>
            <button type="button" class="btn btn-ai-soft btn-sm" id="fetchModelsBtn">&#8635; Fetch Latest Models from Google</button>
          </div>

          <div style="display:grid;grid-template-columns:${isCustom ? "1fr 1fr" : "1fr"};gap:10px;margin-top:6px;" id="modelSelectGrid">
            <select class="select" id="geminiModelSelect">
              ${availableModels
                .map((m) => {
                  const ctx = m.input_token_limit ? ` · ${formatTokenCount(m.input_token_limit)} ctx` : "";
                  const label = m.display_name && m.display_name !== m.id ? `${m.display_name} (${m.id})${ctx}` : `${m.id}${ctx}`;
                  return `<option value="${escapeHtml(m.id)}" ${s.gemini_model === m.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
                })
                .join("")}
              <option value="custom" ${isCustom ? "selected" : ""}>Custom Model ID...</option>
            </select>
            <input class="input ${isCustom ? "" : "hidden"}" id="customModelInput" value="${isCustom ? escapeHtml(s.gemini_model) : ""}" placeholder="e.g., gemini-2.5-flash-lite" />
          </div>

          <div id="selectedModelInfo" class="model-meta-box hidden"></div>
          ${
            s.gemini_models_updated_at
              ? `<div class="field-hint" style="margin-top:4px;">Model catalog last synced from Google: ${new Date(s.gemini_models_updated_at).toLocaleString()}</div>`
              : ""
          }
        </div>

        <!-- Rate Limit & Cost Guard -->
        ${(() => {
          const rl = s.rate_limit_status || { rpm_limit: 5, daily_limit: 50, used_last_minute: 0, used_today: 0 };
          const rpmPct = rl.rpm_limit > 0 ? Math.min(100, Math.round((rl.used_last_minute / rl.rpm_limit) * 100)) : 0;
          const dayPct = rl.daily_limit > 0 ? Math.min(100, Math.round((rl.used_today / rl.daily_limit) * 100)) : 0;
          return `
            <div style="margin:14px 0;padding:14px 16px;border-radius:12px;background:var(--surface-subtle);border:1px solid var(--border);">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
                <strong style="font-size:13.5px;">Rate Limit &amp; Cost Guard</strong>
                <button type="button" class="btn btn-ghost btn-sm" id="resetUsageBtn">Reset Counter</button>
              </div>
              <div class="form-row">
                <div class="field-group" style="margin-bottom:8px;">
                  <label class="field-label" for="geminiRpmInput">Max Connections / Minute (RPM)</label>
                  <input class="input" type="number" min="0" max="1000" id="geminiRpmInput" value="${rl.rpm_limit}" />
                  <div class="time-presets" style="margin-top:5px;">
                    ${[2, 5, 10, 15, 0]
                      .map((v) => `<button type="button" class="preset-chip" data-rpm-preset="${v}">${v === 0 ? "Unlimited" : `${v}/min`}</button>`)
                      .join("")}
                  </div>
                </div>
                <div class="field-group" style="margin-bottom:8px;">
                  <label class="field-label" for="geminiDailyInput">Daily Safety Cap (Requests / Day)</label>
                  <input class="input" type="number" min="0" max="10000" id="geminiDailyInput" value="${rl.daily_limit}" />
                  <div class="time-presets" style="margin-top:5px;">
                    ${[25, 50, 100, 250, 0]
                      .map((v) => `<button type="button" class="preset-chip" data-daily-preset="${v}">${v === 0 ? "Unlimited" : `${v}/day`}</button>`)
                      .join("")}
                  </div>
                </div>
              </div>

              <div class="form-row" style="margin-top:6px;">
                <div>
                  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                    <span class="field-hint">Used in last 60s</span>
                    <strong style="font-family:var(--font-mono);">${rl.used_last_minute} / ${rl.rpm_limit || "&infin;"}</strong>
                  </div>
                  <div class="hbar-track" style="height:7px;">
                    <div class="hbar-seg" style="width:${rpmPct}%;background:${rpmPct >= 100 ? "var(--danger)" : "var(--primary)"};"></div>
                  </div>
                </div>
                <div>
                  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                    <span class="field-hint">Used today</span>
                    <strong style="font-family:var(--font-mono);">${rl.used_today} / ${rl.daily_limit || "&infin;"}</strong>
                  </div>
                  <div class="hbar-track" style="height:7px;">
                    <div class="hbar-seg" style="width:${dayPct}%;background:${dayPct >= 100 ? "var(--danger)" : "var(--success)"};"></div>
                  </div>
                </div>
              </div>

              <div class="field-hint" style="margin-top:10px;line-height:1.45;">
                <strong>Billing Tip (Google AI Pro vs. Gemini API):</strong> A Google AI Pro subscription covers Gemini apps, while Google AI Studio API keys use their own quota. Keep your API project on the <strong>Free Tier</strong> (no Cloud Billing attached) + keep this Rate Guard enabled (e.g., <strong>5/min</strong> &amp; <strong>50/day</strong>) so you will never be charged or hit burst rate limits.
              </div>
            </div>
          `;
        })()}

        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px;">
          <button class="btn btn-primary" type="submit">Save Gemini Settings</button>
          <button class="btn btn-ai-soft" type="button" id="testGeminiBtn">Test Gemini Connection</button>
          ${
            s.gemini_api_key_source === "settings"
              ? `<button class="btn btn-danger-ghost" type="button" id="clearKeyBtn">Clear Saved Token</button>`
              : ""
          }
        </div>
        <div id="geminiTestResult" style="margin-top:12px;"></div>
      </form>

      <form class="card" id="profileSettingsForm">
        <h2 class="section-title" style="margin-bottom:14px;">Study Profile</h2>
        <div class="form-row-3">
          <div class="field-group">
            <label class="field-label">Your Name</label>
            <input class="input" id="studentNameInput" value="${escapeHtml(s.student_name || "")}" />
          </div>
          <div class="field-group">
            <label class="field-label">Current Semester</label>
            <input class="input" id="semesterNameInput" value="${escapeHtml(s.semester_name || "")}" placeholder="e.g., Fall 2026 / B.Sc. Sem 3" />
          </div>
          <div class="field-group">
            <label class="field-label">Daily Study Target (hrs)</label>
            <input class="input" type="number" min="0.5" max="16" step="0.5" id="dailyHoursInput" value="${escapeHtml(s.daily_study_hours || 4)}" />
          </div>
        </div>
        <button class="btn btn-secondary" type="submit">Save Profile</button>
      </form>

      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
        <div>
          <h3 class="section-title" style="margin-bottom:3px;">Sample Bachelor Semester Data</h3>
          <div class="field-hint">Load 3 sample courses, upcoming exams/assignments, chapters with time estimates, and lecture notes to test all features right away.</div>
        </div>
        <button class="btn btn-secondary" id="settingsSeedDemoBtn">Load Sample Data</button>
      </div>
    </div>
  `;

  const keyInput = document.getElementById("geminiKeyInput");
  document.getElementById("toggleKeyVisBtn").addEventListener("click", (e) => {
    const isPw = keyInput.type === "password";
    keyInput.type = isPw ? "text" : "password";
    e.target.textContent = isPw ? "Hide" : "Show";
  });

  const modelSelect = document.getElementById("geminiModelSelect");
  const customInput = document.getElementById("customModelInput");
  const modelGrid = document.getElementById("modelSelectGrid");
  const modelInfoBox = document.getElementById("selectedModelInfo");

  const updateModelMeta = () => {
    const val = modelSelect.value;
    const isC = val === "custom";
    customInput.classList.toggle("hidden", !isC);
    modelGrid.style.gridTemplateColumns = isC ? "1fr 1fr" : "1fr";
    const found = availableModels.find((m) => m.id === val);
    if (found && !isC) {
      const limits = [
        found.input_token_limit ? `Input: ${formatTokenCount(found.input_token_limit)} tokens` : "",
        found.output_token_limit ? `Output: ${formatTokenCount(found.output_token_limit)} tokens` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      modelInfoBox.innerHTML = `<strong>${escapeHtml(found.display_name || found.id)}</strong> <code>${escapeHtml(found.id)}</code>${limits ? ` &mdash; ${escapeHtml(limits)}` : ""}${found.description ? `<div style="margin-top:3px;">${escapeHtml(found.description)}</div>` : ""}`;
      modelInfoBox.classList.remove("hidden");
    } else {
      modelInfoBox.classList.add("hidden");
    }
  };
  updateModelMeta();
  modelSelect.addEventListener("change", updateModelMeta);

  const getSelectedModel = () =>
    modelSelect.value === "custom"
      ? customInput.value.trim() || "gemini-2.5-flash"
      : modelSelect.value;

  const doFetchModels = async (silent = false) => {
    const btn = document.getElementById("fetchModelsBtn");
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Fetching from Google...`;
    try {
      const res = await apiGemini(
        "/api/settings/gemini-models",
        { api_key: keyInput.value.trim() },
        {
          label: "Fetch Google Gemini models",
          onStatus: (msg) => {
            btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
          },
        }
      );
      if (!silent) {
        toast(`Loaded ${res.count} available Gemini models from Google!`, "success");
      }
      await refreshData();
    } catch (err) {
      if (!silent) toast(err.message, "error");
      btn.disabled = false;
      btn.innerHTML = `&#8635; Fetch Latest Models from Google`;
    }
  };

  document.getElementById("fetchModelsBtn").addEventListener("click", () => doFetchModels(false));

  // Auto-fetch live Google models once if API key is configured and cache is still empty
  if (s.gemini_api_key_configured && cachedModels.length === 0 && !state.modelsAutoFetchedOnce) {
    state.modelsAutoFetchedOnce = true;
    doFetchModels(true);
  }

  container.querySelectorAll("[data-rpm-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("geminiRpmInput").value = btn.dataset.rpmPreset;
    });
  });

  container.querySelectorAll("[data-daily-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("geminiDailyInput").value = btn.dataset.dailyPreset;
    });
  });

  document.getElementById("resetUsageBtn")?.addEventListener("click", async () => {
    await api("/api/settings/reset-usage", { method: "POST", body: {} });
    toast("Local Gemini usage counter reset.", "info");
    await refreshData();
  });

  document.getElementById("geminiSettingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      gemini_model: getSelectedModel(),
      gemini_rpm_limit: Math.max(0, parseInt(document.getElementById("geminiRpmInput").value || "0", 10)),
      gemini_daily_limit: Math.max(0, parseInt(document.getElementById("geminiDailyInput").value || "0", 10)),
    };
    const enteredKey = keyInput.value.trim();
    if (enteredKey) payload.gemini_api_key = enteredKey;
    await api("/api/settings", { method: "PUT", body: payload });
    toast("Gemini backend & rate-limit settings saved!", "success");
    if (enteredKey) {
      await doFetchModels(true);
    } else {
      await refreshData();
    }
  });

  document.getElementById("clearKeyBtn")?.addEventListener("click", async () => {
    if (!confirm("Remove the saved Gemini API token?")) return;
    await api("/api/settings", { method: "PUT", body: { gemini_api_key: "" } });
    toast("Saved API token cleared", "info");
    await refreshData();
  });

  document.getElementById("testGeminiBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const out = document.getElementById("geminiTestResult");
    btn.disabled = true;
    out.innerHTML = `<span class="field-hint">Contacting Gemini API...</span>`;
    try {
      const res = await apiGemini(
        "/api/settings/test-gemini",
        {
          api_key: keyInput.value.trim(),
          model: getSelectedModel(),
        },
        {
          label: "Test Gemini Connection",
          onStatus: (msg) => {
            out.innerHTML = `<div class="quiz-feedback-box" style="border-color:var(--warning);background:var(--warning-soft);">${escapeHtml(msg)}</div>`;
          },
        }
      );
      out.innerHTML = `<div class="quiz-feedback-box ok"><strong>Connected!</strong> Model <code>${escapeHtml(res.model)}</code> responded "${escapeHtml(res.reply)}" in ${res.latency_ms} ms.</div>`;
    } catch (err) {
      out.innerHTML = `<div class="quiz-feedback-box bad"><strong>Connection failed:</strong> ${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("profileSettingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await api("/api/settings", {
      method: "PUT",
      body: {
        student_name: document.getElementById("studentNameInput").value.trim(),
        semester_name: document.getElementById("semesterNameInput").value.trim(),
        daily_study_hours: document.getElementById("dailyHoursInput").value,
      },
    });
    toast("Study profile updated", "success");
    await refreshData();
  });

  document.getElementById("settingsSeedDemoBtn").addEventListener("click", handleSeedDemo);
}

async function handleSeedDemo() {
  try {
    await api("/api/seed-demo", { method: "POST", body: {} });
    toast("Sample bachelor semester loaded!", "success");
    await refreshData();
    navigate("dashboard");
  } catch (err) {
    toast(err.message, "error");
  }
}

// --------------------------------------------------------------------------
// Modals: Create / Edit Item (Assignment or Test)
// --------------------------------------------------------------------------

function openItemModal(defaultType = "assignment", existing = null) {
  const isEdit = Boolean(existing);
  const type = existing ? existing.type : defaultType;
  const est = splitMinutes(existing ? existing.estimated_minutes : type === "test" ? 180 : 120);
  const actual = splitMinutes(existing ? existing.actual_minutes : 0);

  openModal(
    isEdit ? `Edit ${type === "test" ? "Test / Exam" : "Assignment"}` : `New ${type === "test" ? "Upcoming Test" : "Assignment"}`,
    `
      <form id="itemForm">
        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Type</label>
            <select class="select" id="itemTypeInput">
              <option value="test" ${type === "test" ? "selected" : ""}>Upcoming Test / Exam</option>
              <option value="assignment" ${type === "assignment" ? "selected" : ""}>Assignment / Lab / Essay</option>
            </select>
          </div>
          <div class="field-group">
            <label class="field-label">Course</label>
            <div style="display:flex;gap:6px;">
              <select class="select" id="itemCourseInput">
                <option value="">No specific course</option>
                ${state.courses
                  .map((c) => `<option value="${c.id}" ${existing?.course_id === c.id ? "selected" : ""}>${escapeHtml(c.code ? `${c.code} — ${c.name}` : c.name)}</option>`)
                  .join("")}
              </select>
              ${
                existing?.course_id
                  ? `<button type="button" class="btn btn-secondary btn-sm" id="modalEditCourseBtn" title="Edit this course">Edit</button>`
                  : ""
              }
            </div>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Title *</label>
          <input class="input" id="itemTitleInput" required value="${escapeHtml(existing?.title || "")}" placeholder="${type === "test" ? "e.g., Midterm Exam: Calculus II" : "e.g., Problem Set 4: Graph Theory"}" />
        </div>

        <div class="field-group">
          <label class="field-label">Description / Scope</label>
          <textarea class="textarea" id="itemDescInput" placeholder="Topics covered, exam format, submission instructions...">${escapeHtml(existing?.description || "")}</textarea>
        </div>

        <div class="form-row-3">
          <div class="field-group">
            <label class="field-label">Due / Test Date</label>
            <input class="input" type="date" id="itemDueInput" value="${escapeHtml(existing?.due_date || "")}" />
          </div>
          <div class="field-group">
            <label class="field-label">Status</label>
            <select class="select" id="itemStatusInput">
              <option value="todo" ${!existing || existing.status === "todo" ? "selected" : ""}>To Do</option>
              <option value="in_progress" ${existing?.status === "in_progress" ? "selected" : ""}>In Progress</option>
              <option value="submitted" ${existing?.status === "submitted" ? "selected" : ""}>Submitted</option>
              <option value="graded" ${existing?.status === "graded" ? "selected" : ""}>Graded</option>
            </select>
          </div>
          <div class="field-group">
            <label class="field-label">Priority</label>
            <select class="select" id="itemPriorityInput">
              <option value="low" ${existing?.priority === "low" ? "selected" : ""}>Low</option>
              <option value="medium" ${!existing || existing.priority === "medium" ? "selected" : ""}>Medium</option>
              <option value="high" ${existing?.priority === "high" ? "selected" : ""}>High</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Grade Weight (%)</label>
            <input class="input" type="number" min="0" max="100" step="0.5" id="itemWeightInput" value="${existing?.weight_percent ?? ""}" placeholder="e.g., 30" />
          </div>
          <div class="field-group">
            <label class="field-label">Grade / Score (editable anytime)</label>
            <input class="input" id="itemGradeInput" value="${escapeHtml(existing?.grade || "")}" placeholder="e.g., 1.3 or 92%" />
          </div>
        </div>

        <div class="time-estimate-box" style="margin-bottom:14px;">
          <div class="time-estimate-header">
            <span>How Much Time Do You Have Left?</span>
          </div>
          <div class="time-inputs-row">
            <input type="number" min="0" max="500" id="modalEstHours" value="${est.hours}" />
            <span style="font-size:12.5px;">hours</span>
            <input type="number" min="0" max="59" step="5" id="modalEstMins" value="${est.minutes}" />
            <span style="font-size:12.5px;">minutes</span>
          </div>
          <div class="time-presets">
            ${[45, 90, 120, 240, 360].map((m) => `<button type="button" class="preset-chip" data-modal-preset="${m}">${formatMinutes(m)}</button>`).join("")}
          </div>
        </div>

        ${
          isEdit
            ? `<div class="form-row">
                <div class="field-group">
                  <label class="field-label">Actual Time Spent</label>
                  <div style="display:flex;align-items:center;gap:6px;">
                    <input class="input" type="number" min="0" max="500" id="itemActualH" value="${actual.hours}" />
                    <span class="field-hint">h</span>
                    <input class="input" type="number" min="0" max="59" step="5" id="itemActualM" value="${actual.minutes}" />
                    <span class="field-hint">m</span>
                  </div>
                </div>
                <div class="field-group">
                  <label class="field-label">Submission Notes</label>
                  <input class="input" id="itemSubNotesInput" value="${escapeHtml(existing?.submission_notes || "")}" placeholder="Reflection or submission notes..." />
                </div>
              </div>`
            : `<div class="field-group">
                <label class="field-label">Initial Chapters / Subtasks (optional — or let Gemini generate them after uploading a doc!)</label>
                <textarea class="textarea" id="itemInitChapters" style="min-height:62px;" placeholder="Leave blank to let Gemini generate subtasks from your uploaded course document..."></textarea>
              </div>`
        }

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="cancelItemModalBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? "Save Changes" : "Create"}</button>
        </div>
      </form>
    `
  );

  document.getElementById("cancelItemModalBtn").addEventListener("click", closeModal);
  document.getElementById("modalEditCourseBtn")?.addEventListener("click", () => {
    const cid = document.getElementById("itemCourseInput").value;
    const course = state.courses.find((c) => c.id === cid);
    if (course) openCourseModal(course);
  });
  document.querySelectorAll("[data-modal-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sp = splitMinutes(parseInt(btn.dataset.modalPreset, 10));
      document.getElementById("modalEstHours").value = sp.hours;
      document.getElementById("modalEstMins").value = sp.minutes;
    });
  });

  document.getElementById("itemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const h = parseInt(document.getElementById("modalEstHours").value || "0", 10);
    const m = parseInt(document.getElementById("modalEstMins").value || "0", 10);
    const payload = {
      type: document.getElementById("itemTypeInput").value,
      course_id: document.getElementById("itemCourseInput").value || null,
      title: document.getElementById("itemTitleInput").value.trim(),
      description: document.getElementById("itemDescInput").value.trim(),
      due_date: document.getElementById("itemDueInput").value,
      status: document.getElementById("itemStatusInput").value,
      priority: document.getElementById("itemPriorityInput").value,
      weight_percent: document.getElementById("itemWeightInput").value,
      grade: document.getElementById("itemGradeInput").value.trim(),
      estimated_minutes: Math.max(0, h * 60 + m),
    };

    if (!isEdit) {
      const rawLines = (document.getElementById("itemInitChapters").value || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (rawLines.length > 0) {
        const perCh = Math.max(15, Math.round((payload.estimated_minutes || 60) / rawLines.length));
        payload.chapters = rawLines.map((line, idx) => {
          const split = line.match(/^([^:]{2,18}):\s*(.+)$/);
          return {
            chapter_label: split ? split[1].trim() : `Ch. ${idx + 1}`,
            title: split ? split[2].trim() : line,
            estimated_minutes: perCh,
          };
        });
      }
      const created = await api("/api/items", { method: "POST", body: payload });
      closeModal();
      toast(`${payload.type === "test" ? "Test" : "Assignment"} created!`, "success");
      await refreshData();
      navigate("detail", created.id);
    } else {
      const ah = parseInt(document.getElementById("itemActualH")?.value || "0", 10);
      const am = parseInt(document.getElementById("itemActualM")?.value || "0", 10);
      payload.actual_minutes = Math.max(0, ah * 60 + am);
      payload.submission_notes = document.getElementById("itemSubNotesInput")?.value.trim() || "";
      await api(`/api/items/${existing.id}`, { method: "PUT", body: payload });
      closeModal();
      toast("Changes saved!", "success");
      await refreshData();
    }
  });
}

// --------------------------------------------------------------------------
// Modal: Submit / Update Submitted Test or Assignment (Editable Course & Test!)
// --------------------------------------------------------------------------

function openSubmitItemModal(item) {
  const isAlreadySub = item.status === "submitted" || item.status === "graded";
  const actualParts = splitMinutes(item.actual_minutes || item.effective_estimated_minutes || 60);
  openModal(
    isAlreadySub
      ? `Edit Submitted ${item.type === "test" ? "Test" : "Assignment"}`
      : `Submit ${item.type === "test" ? "Test" : "Assignment"}`,
    `
      <form id="submitItemForm">
        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Title *</label>
            <input class="input" id="subTitleInput" required value="${escapeHtml(item.title)}" />
          </div>
          <div class="field-group">
            <label class="field-label">Course</label>
            <select class="select" id="subCourseInput">
              <option value="">No specific course</option>
              ${state.courses
                .map((c) => `<option value="${c.id}" ${item.course_id === c.id ? "selected" : ""}>${escapeHtml(c.code ? `${c.code} — ${c.name}` : c.name)}</option>`)
                .join("")}
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Test / Due Date</label>
            <input class="input" type="date" id="subDueInput" value="${escapeHtml(item.due_date || "")}" />
          </div>
          <div class="field-group">
            <label class="field-label">Status</label>
            <select class="select" id="subStatusInput">
              <option value="submitted" ${!isAlreadySub || item.status === "submitted" ? "selected" : ""}>Submitted</option>
              <option value="graded" ${item.status === "graded" ? "selected" : ""}>Graded</option>
              <option value="in_progress">Reopen as In Progress</option>
              <option value="todo">Reopen as To Do</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Actual Time Spent</label>
            <div style="display:flex;align-items:center;gap:6px;">
              <input class="input" type="number" min="0" max="500" id="subActualH" value="${actualParts.hours}" />
              <span class="field-hint">h</span>
              <input class="input" type="number" min="0" max="59" step="5" id="subActualM" value="${actualParts.minutes}" />
              <span class="field-hint">m</span>
            </div>
          </div>
          <div class="field-group">
            <label class="field-label">Grade / Score (optional)</label>
            <input class="input" id="subGradeInput" value="${escapeHtml(item.grade || "")}" placeholder="e.g., 1.7 or 88% (leave blank if pending)" />
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Attach Submission Document(s) (optional)</label>
          <input class="input" type="file" id="subFilesInput" multiple />
          <div class="field-hint">PDF report, scanned test sheet, ZIP, notebook, or screenshot.</div>
        </div>

        <div class="field-group">
          <label class="field-label">Submission Notes / Reflection</label>
          <textarea class="textarea" id="subNotesInput" placeholder="Where you submitted it, what went well, topics to review for finals...">${escapeHtml(item.submission_notes || "")}</textarea>
        </div>

        <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:8px;cursor:pointer;">
          <input type="checkbox" id="subMarkChaptersDone" ${!isAlreadySub ? "checked" : ""} />
          Mark all chapters / subtasks as Done
        </label>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="cancelSubmitBtn">Cancel</button>
          <button type="submit" class="btn btn-success">${isAlreadySub ? "Save Submission Changes" : "Confirm Submission"}</button>
        </div>
      </form>
    `
  );

  document.getElementById("cancelSubmitBtn").addEventListener("click", closeModal);
  document.getElementById("submitItemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const selectedCourseId = document.getElementById("subCourseInput").value || null;
    const files = Array.from(document.getElementById("subFilesInput").files || []);
    for (const file of files) {
      const b64 = await fileToBase64(file);
      await api("/api/documents", {
        method: "POST",
        body: {
          filename: file.name,
          mime_type: file.type,
          content_base64: b64,
          course_id: selectedCourseId,
          item_id: item.id,
          doc_role: "submission",
        },
      });
    }
    const h = parseInt(document.getElementById("subActualH").value || "0", 10);
    const m = parseInt(document.getElementById("subActualM").value || "0", 10);
    const gradeVal = document.getElementById("subGradeInput").value.trim();
    let statusVal = document.getElementById("subStatusInput").value;
    if (gradeVal && statusVal === "submitted") statusVal = "graded";

    await api(`/api/items/${item.id}/submit`, {
      method: "POST",
      body: {
        title: document.getElementById("subTitleInput").value.trim(),
        course_id: selectedCourseId,
        due_date: document.getElementById("subDueInput").value,
        status: statusVal,
        grade: gradeVal,
        submission_notes: document.getElementById("subNotesInput").value.trim(),
        actual_minutes: Math.max(0, h * 60 + m),
        mark_chapters_done: document.getElementById("subMarkChaptersDone").checked,
      },
    });
    closeModal();
    toast(isAlreadySub ? "Submitted item updated!" : `${item.type === "test" ? "Test" : "Assignment"} submitted!`, "success");
    await refreshData();
  });
}

// --------------------------------------------------------------------------
// Modal: Edit Chapter / Subtask
// --------------------------------------------------------------------------

function openEditChapterModal(ch) {
  const est = splitMinutes(ch.estimated_minutes);
  openModal(
    "Edit Chapter / Subtask",
    `
      <form id="editChapterForm">
        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Chapter / Section Label</label>
            <input class="input" id="editChLabel" value="${escapeHtml(ch.chapter_label || "")}" placeholder="e.g., Ch. 3" />
          </div>
          <div class="field-group">
            <label class="field-label">Status</label>
            <select class="select" id="editChStatus">
              <option value="todo" ${ch.status === "todo" ? "selected" : ""}>To Do</option>
              <option value="in_progress" ${ch.status === "in_progress" ? "selected" : ""}>In Progress</option>
              <option value="done" ${ch.status === "done" ? "selected" : ""}>Done</option>
            </select>
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">Subtask Title *</label>
          <input class="input" id="editChTitle" required value="${escapeHtml(ch.title)}" />
        </div>
        <div class="field-group">
          <label class="field-label">What Needs to Be Done</label>
          <textarea class="textarea" id="editChNotes">${escapeHtml(ch.todo_notes || "")}</textarea>
        </div>
        <div class="time-estimate-box">
          <div class="time-estimate-header"><span>Estimated Time for This Chapter</span></div>
          <div class="time-inputs-row">
            <input type="number" min="0" max="200" id="editChHours" value="${est.hours}" />
            <span style="font-size:12.5px;">hours</span>
            <input type="number" min="0" max="59" step="5" id="editChMins" value="${est.minutes}" />
            <span style="font-size:12.5px;">minutes</span>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="cancelEditChBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Chapter</button>
        </div>
      </form>
    `
  );

  document.getElementById("cancelEditChBtn").addEventListener("click", closeModal);
  document.getElementById("editChapterForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const h = parseInt(document.getElementById("editChHours").value || "0", 10);
    const m = parseInt(document.getElementById("editChMins").value || "0", 10);
    await api(`/api/chapters/${ch.id}`, {
      method: "PUT",
      body: {
        chapter_label: document.getElementById("editChLabel").value.trim(),
        title: document.getElementById("editChTitle").value.trim(),
        todo_notes: document.getElementById("editChNotes").value.trim(),
        status: document.getElementById("editChStatus").value,
        estimated_minutes: Math.max(0, h * 60 + m),
      },
    });
    closeModal();
    toast("Chapter updated", "success");
    await refreshData();
  });
}

// --------------------------------------------------------------------------
// Modal: Course Create / Edit & Global Upload Document
// --------------------------------------------------------------------------

function openCourseModal(existing = null) {
  const isEdit = Boolean(existing);
  const selectedColor = existing?.color || COURSE_COLORS[state.courses.length % COURSE_COLORS.length];

  openModal(
    isEdit ? "Edit Course" : "New Course / Module",
    `
      <form id="courseForm">
        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Course Name *</label>
            <input class="input" id="courseNameInput" required value="${escapeHtml(existing?.name || "")}" placeholder="e.g., Linear Algebra II" />
          </div>
          <div class="field-group">
            <label class="field-label">Course Code</label>
            <input class="input" id="courseCodeInput" value="${escapeHtml(existing?.code || "")}" placeholder="e.g., MATH-202" />
          </div>
        </div>
        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Instructor / Professor</label>
            <input class="input" id="courseInstInput" value="${escapeHtml(existing?.instructor || "")}" placeholder="Prof. Dr. ..." />
          </div>
          <div class="field-group">
            <label class="field-label">Semester</label>
            <input class="input" id="courseSemInput" value="${escapeHtml(existing?.semester || state.settings.semester_name || "")}" />
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">Description / Syllabus Themes</label>
          <textarea class="textarea" id="courseDescInput" placeholder="Main lecture topics covered in this module...">${escapeHtml(existing?.description || "")}</textarea>
        </div>
        <div class="field-group">
          <label class="field-label">Accent Color</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;" id="colorSwatches">
            ${COURSE_COLORS.map(
              (hex) => `<button type="button" data-color="${hex}" style="width:28px;height:28px;border-radius:8px;background:${hex};border:${hex === selectedColor ? "3px solid var(--text)" : "2px solid transparent"};cursor:pointer;"></button>`
            ).join("")}
          </div>
          <input type="hidden" id="courseColorInput" value="${escapeHtml(selectedColor)}" />
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="cancelCourseBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? "Save Changes" : "Create Course"}</button>
        </div>
      </form>
    `
  );

  document.getElementById("cancelCourseBtn").addEventListener("click", closeModal);
  document.querySelectorAll("#colorSwatches button").forEach((b) => {
    b.addEventListener("click", () => {
      document.getElementById("courseColorInput").value = b.dataset.color;
      document.querySelectorAll("#colorSwatches button").forEach((x) => {
        x.style.border = x === b ? "3px solid var(--text)" : "2px solid transparent";
      });
    });
  });

  document.getElementById("courseForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById("courseNameInput").value.trim(),
      code: document.getElementById("courseCodeInput").value.trim(),
      instructor: document.getElementById("courseInstInput").value.trim(),
      semester: document.getElementById("courseSemInput").value.trim(),
      description: document.getElementById("courseDescInput").value.trim(),
      color: document.getElementById("courseColorInput").value,
    };
    if (isEdit) {
      await api(`/api/courses/${existing.id}`, { method: "PUT", body: payload });
      toast("Course updated", "success");
    } else {
      await api("/api/courses", { method: "POST", body: payload });
      toast("Course created!", "success");
    }
    closeModal();
    await refreshData();
  });
}

function openUploadDocumentModal(defaultCourseId = "") {
  const aiConfigured = Boolean(state.settings.gemini_api_key_configured);
  openModal(
    "Upload Course Document & Auto-Generate Plan",
    `
      <form id="uploadDocModalForm">
        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Course</label>
            <select class="select" id="upCourseSel">
              <option value="">Unassigned / Auto-detect</option>
              ${state.courses.map((c) => `<option value="${c.id}" ${defaultCourseId === c.id ? "selected" : ""}>${escapeHtml(c.code ? `${c.code} — ${c.name}` : c.name)}</option>`).join("")}
            </select>
          </div>
          <div class="field-group">
            <label class="field-label">Document Type</label>
            <select class="select" id="upRoleSel">
              <option value="lecture" selected>Lecture Slides / Course Script</option>
              <option value="study_material">Study Material / Syllabus</option>
              <option value="reference">Past Exam / Reference</option>
              <option value="submission">Submission</option>
            </select>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Select Course Document(s) *</label>
          <input class="input" type="file" id="upFilesInput" multiple required />
          <div class="field-hint">PDF, PPTX, DOCX, Markdown, TXT, PNG, JPG (up to 25 MB each).</div>
        </div>

        <div class="time-estimate-box" style="margin-bottom:14px;">
          <div class="time-estimate-header">
            <span>How Much Time Do You Have Left?</span>
            <span style="font-size:11px;font-weight:500;">Gemini budgets all generated subtasks to fit this time</span>
          </div>
          <div class="time-inputs-row">
            <input type="number" min="0" max="500" id="upAvailHours" value="4" />
            <span style="font-size:12.5px;">hours</span>
            <input type="number" min="0" max="59" step="5" id="upAvailMins" value="0" />
            <span style="font-size:12.5px;">minutes</span>
          </div>
          <div class="time-presets">
            ${[60, 120, 240, 480, 720, 1200]
              .map((m) => `<button type="button" class="preset-chip" data-up-preset="${m}">${formatMinutes(m)}</button>`)
              .join("")}
          </div>
        </div>

        <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:12px;padding:10px 12px;border-radius:10px;background:var(--ai-soft);cursor:pointer;">
          <input type="checkbox" id="upAutoGenCheck" ${aiConfigured ? "checked" : ""} />
          <span><strong>Let Gemini automatically create Themes, Tasks &amp; Subtasks</strong> from this document</span>
        </label>

        <div id="upAiOptionsWrap">
          <div class="form-row-3">
            <div class="field-group">
              <label class="field-label">Generate Into</label>
              <select class="select" id="upItemSel">
                <option value="">Create new Tasks &amp; Themes</option>
                ${state.items.map((i) => `<option value="${i.id}">Add subtasks to: ${escapeHtml(i.title)}</option>`).join("")}
              </select>
            </div>
            <div class="field-group">
              <label class="field-label">Primary Task Type</label>
              <select class="select" id="upDefaultTypeSel">
                <option value="test" selected>Upcoming Test / Exam</option>
                <option value="assignment">Assignment / Lab</option>
              </select>
            </div>
            <div class="field-group">
              <label class="field-label">Target Date (optional)</label>
              <input class="input" type="date" id="upDueDateInput" />
            </div>
          </div>
          <div class="field-group">
            <label class="field-label">Optional Goal / Focus</label>
            <input class="input" id="upGoalInput" placeholder="e.g., Prepare for midterm exam, focus on proofs and worked exercises..." />
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="cancelUpDocBtn">Cancel</button>
          <button type="submit" class="btn btn-ai" id="submitUpDocBtn">&#10024; Upload &amp; Generate with Gemini</button>
        </div>
      </form>
    `,
    { subtitle: "Upload your lecture material, enter your time left, and let Gemini build your tasks, themes, and subtasks.", wide: true }
  );

  const autoCheck = document.getElementById("upAutoGenCheck");
  const aiWrap = document.getElementById("upAiOptionsWrap");
  const submitBtn = document.getElementById("submitUpDocBtn");
  const syncAiUi = () => {
    aiWrap.classList.toggle("hidden", !autoCheck.checked);
    submitBtn.innerHTML = autoCheck.checked ? "&#10024; Upload &amp; Generate with Gemini" : "Upload Document";
    submitBtn.className = autoCheck.checked ? "btn btn-ai" : "btn btn-primary";
  };
  syncAiUi();
  autoCheck.addEventListener("change", syncAiUi);

  document.querySelectorAll("[data-up-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sp = splitMinutes(parseInt(btn.dataset.upPreset, 10));
      document.getElementById("upAvailHours").value = sp.hours;
      document.getElementById("upAvailMins").value = sp.minutes;
    });
  });

  document.getElementById("cancelUpDocBtn").addEventListener("click", closeModal);
  document.getElementById("uploadDocModalForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const files = Array.from(document.getElementById("upFilesInput").files || []);
    if (!files.length) return;
    const courseId = document.getElementById("upCourseSel").value || null;
    const itemId = document.getElementById("upItemSel").value || null;
    const role = document.getElementById("upRoleSel").value;
    const doAi = autoCheck.checked;
    const availH = parseInt(document.getElementById("upAvailHours").value || "0", 10);
    const availM = parseInt(document.getElementById("upAvailMins").value || "0", 10);
    const availableMinutes = Math.max(15, availH * 60 + availM);

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner"></span> Uploading ${files.length} file${files.length > 1 ? "s" : ""}...`;

    try {
      const uploadedIds = [];
      for (const file of files) {
        const b64 = await fileToBase64(file);
        const doc = await api("/api/documents", {
          method: "POST",
          body: {
            filename: file.name,
            mime_type: file.type,
            content_base64: b64,
            course_id: courseId,
            item_id: itemId,
            doc_role: role,
          },
        });
        uploadedIds.push(doc.id);
      }

      if (doAi) {
        if (!state.settings.gemini_api_key_configured) {
          closeModal();
          toast("Document uploaded! Configure your Gemini API token in Settings to auto-generate tasks & themes.", "warning");
          await refreshData();
          return;
        }
        submitBtn.innerHTML = `<span class="spinner"></span> Gemini is creating themes, tasks &amp; subtasks...`;
        const onRetryStatus = (msg) => {
          submitBtn.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
        };
        if (itemId) {
          const gen = await apiGemini(
            `/api/items/${itemId}/generate-subtasks`,
            {
              available_minutes: availableMinutes,
              document_ids: uploadedIds,
              focus: document.getElementById("upGoalInput").value.trim(),
              create_themes: true,
              replace_existing: false,
            },
            { label: "Generate Subtasks", onStatus: onRetryStatus }
          );
          closeModal();
          toast(`Generated ${gen.subtasks_created} subtasks (${formatMinutes(availableMinutes)}) & ${gen.themes_created} themes!`, "success");
          await refreshData();
          navigate("detail", itemId);
        } else {
          const gen = await apiGemini(
            "/api/ai/generate-from-documents",
            {
              course_id: courseId,
              document_ids: uploadedIds,
              available_minutes: availableMinutes,
              due_date: document.getElementById("upDueDateInput").value,
              default_type: document.getElementById("upDefaultTypeSel").value,
              goal_hint: document.getElementById("upGoalInput").value.trim(),
            },
            { label: "Auto-Generate Course Plan", onStatus: onRetryStatus }
          );
          closeModal();
          const tCount = (gen.themes || []).length;
          const iCount = (gen.items || []).length;
          toast(
            `Gemini created ${tCount} theme${tCount !== 1 ? "s" : ""}, ${iCount} task${iCount !== 1 ? "s" : ""}, and ${gen.subtasks_created} subtasks budgeted for ${formatMinutes(availableMinutes)}!`,
            "success"
          );
          await refreshData();
          if (gen.items && gen.items.length > 0) {
            navigate("detail", gen.items[0].id);
          } else {
            navigate("courses");
          }
        }
      } else {
        closeModal();
        toast(`Uploaded ${files.length} document${files.length > 1 ? "s" : ""}`, "success");
        await refreshData();
      }
    } catch (err) {
      toast(err.message, "error");
      submitBtn.disabled = false;
      syncAiUi();
    }
  });
}

function openGenerateFromDocsModal({ courseId = "", docIds = [], docName = "" } = {}) {
  const course = state.courses.find((c) => c.id === courseId);
  const label = docName || (course ? `${course.name} documents` : "selected documents");

  openModal(
    "Generate Tasks, Themes & Subtasks with Gemini",
    `
      <form id="genFromDocsForm">
        <div style="margin-bottom:14px;padding:12px;border-radius:10px;background:var(--surface-subtle);">
          <strong>Source: ${escapeHtml(label)}</strong>
          <div class="field-hint">Just enter how much time you have left — Gemini will extract themes, create tasks, and generate time-budgeted chapter subtasks.</div>
        </div>

        <div class="time-estimate-box" style="margin-bottom:14px;">
          <div class="time-estimate-header"><span>How Much Time Do You Have Left?</span></div>
          <div class="time-inputs-row">
            <input type="number" min="0" max="500" id="gfdHours" value="4" />
            <span style="font-size:12.5px;">hours</span>
            <input type="number" min="0" max="59" step="5" id="gfdMins" value="0" />
            <span style="font-size:12.5px;">minutes</span>
          </div>
          <div class="time-presets">
            ${[60, 120, 240, 480, 720]
              .map((m) => `<button type="button" class="preset-chip" data-gfd-preset="${m}">${formatMinutes(m)}</button>`)
              .join("")}
          </div>
        </div>

        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Primary Task Type</label>
            <select class="select" id="gfdTypeSel">
              <option value="test" selected>Upcoming Test / Exam</option>
              <option value="assignment">Assignment / Lab</option>
            </select>
          </div>
          <div class="field-group">
            <label class="field-label">Target Date (optional)</label>
            <input class="input" type="date" id="gfdDueInput" />
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Optional Goal / Focus</label>
          <input class="input" id="gfdGoalInput" placeholder="e.g., Focus on chapters 3-6 for next week's test..." />
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="cancelGfdBtn">Cancel</button>
          <button type="submit" class="btn btn-ai" id="runGfdBtn">&#10024; Generate with Gemini</button>
        </div>
      </form>
    `
  );

  document.getElementById("cancelGfdBtn").addEventListener("click", closeModal);
  document.querySelectorAll("[data-gfd-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sp = splitMinutes(parseInt(btn.dataset.gfdPreset, 10));
      document.getElementById("gfdHours").value = sp.hours;
      document.getElementById("gfdMins").value = sp.minutes;
    });
  });

  document.getElementById("genFromDocsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("runGfdBtn");
    const h = parseInt(document.getElementById("gfdHours").value || "0", 10);
    const m = parseInt(document.getElementById("gfdMins").value || "0", 10);
    const availableMinutes = Math.max(15, h * 60 + m);
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Gemini is analyzing documents...`;
    try {
      const gen = await apiGemini(
        "/api/ai/generate-from-documents",
        {
          course_id: courseId || null,
          document_ids: docIds,
          available_minutes: availableMinutes,
          due_date: document.getElementById("gfdDueInput").value,
          default_type: document.getElementById("gfdTypeSel").value,
          goal_hint: document.getElementById("gfdGoalInput").value.trim(),
        },
        {
          label: "Generate from Documents",
          onStatus: (msg) => {
            btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
          },
        }
      );
      closeModal();
      toast(
        `Created ${(gen.themes || []).length} themes, ${(gen.items || []).length} tasks, and ${gen.subtasks_created} subtasks (${formatMinutes(availableMinutes)})!`,
        "success"
      );
      await refreshData();
      if (gen.items && gen.items.length > 0) {
        navigate("detail", gen.items[0].id);
      }
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.innerHTML = `&#10024; Generate with Gemini`;
    }
  });
}

function openGenerateSubtasksModal(item, initialMinutes = 120) {
  const sp = splitMinutes(initialMinutes || item.estimated_minutes || 120);
  const hasExisting = (item.chapters || []).length > 0;

  openModal(
    `Let Gemini Generate Subtasks`,
    `
      <form id="genSubtasksForm">
        <div style="margin-bottom:14px;padding:12px;border-radius:10px;background:var(--surface-subtle);">
          <strong>${escapeHtml(item.title)}</strong>
          <div class="field-hint">Gemini reads your attached ${item.type} and course documents, creates chapter subtasks, and budgets them to fit the exact time you have left.</div>
        </div>

        <div class="time-estimate-box" style="margin-bottom:14px;">
          <div class="time-estimate-header"><span>How Much Time Do You Have Left?</span></div>
          <div class="time-inputs-row">
            <input type="number" min="0" max="500" id="gsHours" value="${sp.hours}" />
            <span style="font-size:12.5px;">hours</span>
            <input type="number" min="0" max="59" step="5" id="gsMins" value="${sp.minutes}" />
            <span style="font-size:12.5px;">minutes</span>
          </div>
          <div class="time-presets">
            ${[45, 90, 120, 240, 360, 600]
              .map((m) => `<button type="button" class="preset-chip" data-gs-preset="${m}">${formatMinutes(m)}</button>`)
              .join("")}
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Optional Focus</label>
          <input class="input" id="gsFocusInput" placeholder="e.g., Emphasize practice problems and exam formulas..." />
        </div>

        ${
          hasExisting
            ? `<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px;cursor:pointer;">
                <input type="checkbox" id="gsReplaceCheck" />
                Replace existing ${item.chapters.length} subtask${item.chapters.length > 1 ? "s" : ""} (leave unchecked to append)
              </label>`
            : ""
        }

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="cancelGsBtn">Cancel</button>
          <button type="submit" class="btn btn-ai" id="runGsBtn">&#10024; Generate Subtasks</button>
        </div>
      </form>
    `
  );

  document.getElementById("cancelGsBtn").addEventListener("click", closeModal);
  document.querySelectorAll("[data-gs-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = splitMinutes(parseInt(btn.dataset.gsPreset, 10));
      document.getElementById("gsHours").value = p.hours;
      document.getElementById("gsMins").value = p.minutes;
    });
  });

  document.getElementById("genSubtasksForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("runGsBtn");
    const h = parseInt(document.getElementById("gsHours").value || "0", 10);
    const m = parseInt(document.getElementById("gsMins").value || "0", 10);
    const availableMinutes = Math.max(15, h * 60 + m);
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Generating subtasks...`;
    try {
      const res = await apiGemini(
        `/api/items/${item.id}/generate-subtasks`,
        {
          available_minutes: availableMinutes,
          focus: document.getElementById("gsFocusInput").value.trim(),
          replace_existing: Boolean(document.getElementById("gsReplaceCheck")?.checked),
          create_themes: true,
        },
        {
          label: "Generate Subtasks",
          onStatus: (msg) => {
            btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
          },
        }
      );
      closeModal();
      toast(
        `Gemini created ${res.subtasks_created} subtasks fitted to ${formatMinutes(availableMinutes)}!`,
        "success"
      );
      await refreshData();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.innerHTML = `&#10024; Generate Subtasks`;
    }
  });
}

function openThemeModal(theme) {
  openModal(
    "Course Theme",
    `
      <form id="themeEditForm">
        <div class="form-row">
          <div class="field-group">
            <label class="field-label">Theme Title *</label>
            <input class="input" id="thTitleInput" required value="${escapeHtml(theme.title)}" />
          </div>
          <div class="field-group">
            <label class="field-label">Importance</label>
            <select class="select" id="thImpSelect">
              <option value="high" ${theme.importance === "high" ? "selected" : ""}>High</option>
              <option value="medium" ${theme.importance === "medium" ? "selected" : ""}>Medium</option>
              <option value="low" ${theme.importance === "low" ? "selected" : ""}>Low</option>
            </select>
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">Summary</label>
          <textarea class="textarea" id="thSummaryInput">${escapeHtml(theme.summary || "")}</textarea>
        </div>
        <div class="field-group">
          <label class="field-label">Key Concepts (comma separated)</label>
          <input class="input" id="thConceptsInput" value="${escapeHtml((theme.key_concepts || []).join(", "))}" />
        </div>
        <div class="modal-footer" style="justify-content:space-between;">
          <button type="button" class="btn btn-danger-ghost" id="delThemeBtn">Delete Theme</button>
          <div style="display:flex;gap:8px;">
            <button type="button" class="btn btn-secondary" id="cancelThemeBtn">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Theme</button>
          </div>
        </div>
      </form>
    `
  );

  document.getElementById("cancelThemeBtn").addEventListener("click", closeModal);
  document.getElementById("delThemeBtn").addEventListener("click", async () => {
    if (!confirm(`Delete theme "${theme.title}"?`)) return;
    await api(`/api/themes/${theme.id}`, { method: "DELETE" });
    closeModal();
    toast("Theme deleted", "success");
    await refreshData();
  });
  document.getElementById("themeEditForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const concepts = (document.getElementById("thConceptsInput").value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await api(`/api/themes/${theme.id}`, {
      method: "PUT",
      body: {
        title: document.getElementById("thTitleInput").value.trim(),
        importance: document.getElementById("thImpSelect").value,
        summary: document.getElementById("thSummaryInput").value.trim(),
        key_concepts: concepts,
      },
    });
    closeModal();
    toast("Theme updated", "success");
    await refreshData();
  });
}

// --------------------------------------------------------------------------
// AI Modal 1: Per-Subtask Explanation Generator
// --------------------------------------------------------------------------

async function openExplanationModal(chapter, item) {
  openModal(
    `AI Explanation: ${chapter.chapter_label ? chapter.chapter_label + " — " : ""}${chapter.title}`,
    `<div style="padding:20px;text-align:center;"><span class="spinner"></span> Loading saved explanations...</div>`,
    { subtitle: `${item.title} · Powered by Gemini`, wide: true }
  );

  let explanations = [];
  try {
    explanations = await api(`/api/chapters/${chapter.id}/explanations`);
  } catch (err) {
    toast(err.message, "error");
  }

  let activeIdx = 0;

  const renderBody = () => {
    const activeExp = explanations[activeIdx] || null;
    document.getElementById("modalBody").innerHTML = `
      <div style="background:var(--surface-subtle);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px;">
        <div class="field-label" style="margin-bottom:6px;">Generate a New Gemini Explanation</div>
        <div class="chip-list" style="margin-bottom:8px;">
          ${["Exam-focused summary", "Explain simply with intuition", "Step-by-step worked examples", "Key proofs & edge cases"]
            .map((p) => `<button type="button" class="preset-chip" data-exp-focus="${escapeHtml(p)}">${escapeHtml(p)}</button>`)
            .join("")}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input class="input" id="expFocusInput" style="flex:1;min-width:220px;" placeholder="Optional focus (e.g., focus on time complexity proof)..." />
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;white-space:nowrap;">
            <input type="checkbox" id="expIncludeDocs" checked /> Use attached docs
          </label>
          <button class="btn btn-ai" id="runExplainBtn">&#10024; Generate Explanation</button>
        </div>
      </div>

      ${
        explanations.length > 0
          ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
              <select class="select" id="expHistorySelect" style="width:auto;min-width:240px;">
                ${explanations
                  .map(
                    (ex, i) =>
                      `<option value="${i}" ${i === activeIdx ? "selected" : ""}>${escapeHtml(ex.prompt_focus || "Standard Explanation")} — ${new Date(ex.created_at).toLocaleString()}</option>`
                  )
                  .join("")}
              </select>
              <button class="btn btn-danger-ghost btn-sm" id="delExpBtn">Delete</button>
            </div>
            <div class="card md-content" style="max-height:52vh;overflow-y:auto;">
              ${renderMarkdown(activeExp.content_md)}
            </div>`
          : `<div class="empty-state">
              <h3>No explanation generated yet</h3>
              <p>Click <strong>Generate Explanation</strong> above to get a tailored bachelor-level breakdown of "${escapeHtml(chapter.title)}" using your attached lecture documents.</p>
            </div>`
      }
    `;

    document.querySelectorAll("[data-exp-focus]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("expFocusInput").value = btn.dataset.expFocus;
      });
    });

    document.getElementById("expHistorySelect")?.addEventListener("change", (e) => {
      activeIdx = parseInt(e.target.value, 10);
      renderBody();
    });

    document.getElementById("delExpBtn")?.addEventListener("click", async () => {
      if (!activeExp) return;
      await api(`/api/explanations/${activeExp.id}`, { method: "DELETE" });
      explanations.splice(activeIdx, 1);
      activeIdx = 0;
      renderBody();
      refreshData();
    });

    document.getElementById("runExplainBtn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span> Thinking...`;
      try {
        const created = await apiGemini(
          `/api/chapters/${chapter.id}/explain`,
          {
            focus: document.getElementById("expFocusInput").value.trim(),
            include_docs: document.getElementById("expIncludeDocs").checked,
          },
          {
            label: "Generate Explanation",
            onStatus: (msg) => {
              btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
            },
          }
        );
        explanations.unshift(created);
        activeIdx = 0;
        toast("Explanation generated!", "success");
        renderBody();
        refreshData();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
        btn.innerHTML = `&#10024; Generate Explanation`;
      }
    });
  };

  renderBody();
}

// --------------------------------------------------------------------------
// AI Modal 2: Per-Subtask Interactive Practice Test Generator
// --------------------------------------------------------------------------

async function openPracticeTestModal(chapter, item) {
  openModal(
    `Practice Test: ${chapter.chapter_label ? chapter.chapter_label + " — " : ""}${chapter.title}`,
    `<div style="padding:20px;text-align:center;"><span class="spinner"></span> Loading practice tests...</div>`,
    { subtitle: `${item.title} · Interactive Gemini Quiz & Grading`, wide: true }
  );

  let tests = [];
  try {
    tests = await api(`/api/chapters/${chapter.id}/tests`);
  } catch (err) {
    toast(err.message, "error");
  }

  let activeIdx = 0;
  let draftAnswers = {};

  const loadDraftFromActive = () => {
    const t = tests[activeIdx];
    draftAnswers = t && t.last_answers ? { ...t.last_answers } : {};
  };
  loadDraftFromActive();

  const renderBody = () => {
    const activeTest = tests[activeIdx] || null;
    const hasGraded = activeTest && activeTest.last_score !== null && activeTest.last_score !== undefined;
    const feedback = activeTest?.last_feedback || {};

    document.getElementById("modalBody").innerHTML = `
      <div style="background:var(--surface-subtle);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px;">
        <div class="field-label" style="margin-bottom:8px;">Generate New Practice Test with Gemini</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
          <select class="select" id="quizDiffSelect" style="width:auto;">
            <option value="easy">Easy (Fundamentals)</option>
            <option value="medium" selected>Medium (Exam Standard)</option>
            <option value="hard">Hard (Deep / Proof Level)</option>
          </select>
          <select class="select" id="quizCountSelect" style="width:auto;">
            <option value="4">4 Questions</option>
            <option value="5" selected>5 Questions</option>
            <option value="8">8 Questions</option>
            <option value="10">10 Questions</option>
          </select>
          <label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;">
            <input type="checkbox" id="quizOpenCheck" checked /> Include short-answer
          </label>
          <label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;">
            <input type="checkbox" id="quizDocsCheck" checked /> Use attached docs
          </label>
          <button class="btn btn-ai" id="genQuizBtn" style="margin-left:auto;">&#9997; Generate Test</button>
        </div>
      </div>

      ${
        tests.length === 0
          ? `<div class="empty-state">
              <h3>No practice tests for this chapter yet</h3>
              <p>Click <strong>Generate Test</strong> above to create an interactive quiz based on "${escapeHtml(chapter.title)}" and your uploaded lecture materials.</p>
            </div>`
          : `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
              <select class="select" id="quizHistorySelect" style="width:auto;min-width:260px;">
                ${tests
                  .map(
                    (t, i) =>
                      `<option value="${i}" ${i === activeIdx ? "selected" : ""}>${escapeHtml(t.title)} (${t.difficulty})${t.last_score !== null && t.last_score !== undefined ? ` — ${t.last_score}/${t.last_total}` : ""}</option>`
                  )
                  .join("")}
              </select>
              <button class="btn btn-danger-ghost btn-sm" id="delQuizBtn">Delete Test</button>
            </div>

            ${
              hasGraded
                ? `<div class="score-banner">
                    <div>
                      <strong>Last Score: ${activeTest.last_score} / ${activeTest.last_total} (${activeTest.last_total > 0 ? Math.round((activeTest.last_score / activeTest.last_total) * 100) : 0}%)</strong>
                      <div class="field-hint">Review the explanations below or adjust your answers and re-submit.</div>
                    </div>
                    <button class="btn btn-secondary btn-sm" id="resetQuizBtn">Clear Answers</button>
                  </div>`
                : ""
            }

            <div id="quizQuestionsWrap">
              ${(activeTest.questions || [])
                .map((q, qIdx) => {
                  const fb = feedback[q.id];
                  const userAns = draftAnswers[q.id];
                  if (q.type === "mcq") {
                    return `
                      <div class="quiz-question-card">
                        <div style="font-weight:700;margin-bottom:4px;">Q${qIdx + 1}. ${escapeHtml(q.question)}</div>
                        <div class="quiz-options">
                          ${(q.options || [])
                            .map((opt, oIdx) => {
                              const isSel = String(userAns) === String(oIdx);
                              let cls = isSel ? "selected" : "";
                              if (fb) {
                                if (oIdx === q.correct_index) cls = "correct";
                                else if (isSel && oIdx !== q.correct_index) cls = "incorrect";
                              }
                              return `
                                <label class="quiz-option ${cls}" data-mcq-q="${q.id}" data-mcq-o="${oIdx}">
                                  <input type="radio" name="mcq_${q.id}" value="${oIdx}" ${isSel ? "checked" : ""} />
                                  <span>${escapeHtml(opt)}</span>
                                </label>
                              `;
                            })
                            .join("")}
                        </div>
                        ${
                          fb
                            ? `<div class="quiz-feedback-box ${fb.correct ? "ok" : "bad"}">
                                <strong>${fb.correct ? "Correct!" : "Incorrect."}</strong> ${escapeHtml(fb.feedback || q.explanation || "")}
                              </div>`
                            : ""
                        }
                      </div>
                    `;
                  }
                  return `
                    <div class="quiz-question-card">
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
                        <div style="font-weight:700;">Q${qIdx + 1}. ${escapeHtml(q.question)}</div>
                        <span class="badge badge-ai">Short Answer</span>
                      </div>
                      <textarea class="textarea" data-short-q="${q.id}" placeholder="Type your answer, derivation, or key points...">${escapeHtml(userAns || "")}</textarea>
                      ${
                        fb
                          ? `<div class="quiz-feedback-box ${fb.correct ? "ok" : "bad"}">
                              <div><strong>Score: ${fb.score}/${fb.max_score}</strong> &mdash; ${escapeHtml(fb.feedback || "")}</div>
                              ${q.model_answer ? `<div style="margin-top:6px;"><strong>Model Answer:</strong> ${escapeHtml(q.model_answer)}</div>` : ""}
                              ${
                                (q.key_points || []).length > 0
                                  ? `<ul style="margin:4px 0 0;padding-left:18px;">${q.key_points.map((kp) => `<li>${escapeHtml(kp)}</li>`).join("")}</ul>`
                                  : ""
                              }
                            </div>`
                          : ""
                      }
                    </div>
                  `;
                })
                .join("")}
            </div>

            <div class="modal-footer">
              <button class="btn btn-primary" id="submitQuizAnswersBtn">Submit &amp; Grade Answers</button>
            </div>
          `
      }
    `;

    document.getElementById("quizHistorySelect")?.addEventListener("change", (e) => {
      activeIdx = parseInt(e.target.value, 10);
      loadDraftFromActive();
      renderBody();
    });

    document.getElementById("delQuizBtn")?.addEventListener("click", async () => {
      if (!activeTest) return;
      await api(`/api/tests/${activeTest.id}`, { method: "DELETE" });
      tests.splice(activeIdx, 1);
      activeIdx = 0;
      loadDraftFromActive();
      renderBody();
      refreshData();
    });

    document.getElementById("resetQuizBtn")?.addEventListener("click", () => {
      draftAnswers = {};
      if (activeTest) {
        activeTest.last_feedback = {};
        activeTest.last_score = null;
      }
      renderBody();
    });

    document.querySelectorAll("[data-mcq-q]").forEach((lbl) => {
      lbl.addEventListener("click", () => {
        draftAnswers[lbl.dataset.mcqQ] = parseInt(lbl.dataset.mcqO, 10);
        // Update visual selection
        const qid = lbl.dataset.mcqQ;
        document.querySelectorAll(`[data-mcq-q="${qid}"]`).forEach((x) => {
          x.classList.toggle("selected", x === lbl);
        });
      });
    });

    document.querySelectorAll("[data-short-q]").forEach((ta) => {
      ta.addEventListener("input", () => {
        draftAnswers[ta.dataset.shortQ] = ta.value;
      });
    });

    document.getElementById("genQuizBtn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span> Generating...`;
      try {
        const created = await apiGemini(
          `/api/chapters/${chapter.id}/generate-test`,
          {
            difficulty: document.getElementById("quizDiffSelect").value,
            question_count: parseInt(document.getElementById("quizCountSelect").value, 10),
            include_open_ended: document.getElementById("quizOpenCheck").checked,
            include_docs: document.getElementById("quizDocsCheck").checked,
          },
          {
            label: "Generate Practice Test",
            onStatus: (msg) => {
              btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
            },
          }
        );
        tests.unshift(created);
        activeIdx = 0;
        draftAnswers = {};
        toast("Practice test generated!", "success");
        renderBody();
        refreshData();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
        btn.innerHTML = `&#9997; Generate Test`;
      }
    });

    document.getElementById("submitQuizAnswersBtn")?.addEventListener("click", async (e) => {
      if (!activeTest) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span> Grading...`;
      try {
        const res = await apiGemini(
          `/api/tests/${activeTest.id}/grade`,
          { answers: draftAnswers, use_ai_grading: true },
          {
            label: "Grade Practice Test",
            onStatus: (msg) => {
              btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
            },
          }
        );
        activeTest.last_answers = { ...draftAnswers };
        activeTest.last_score = res.score;
        activeTest.last_total = res.total;
        activeTest.last_feedback = res.feedback;
        toast(`Graded: ${res.score}/${res.total} (${res.percent}%)`, res.percent >= 70 ? "success" : "warning");
        renderBody();
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
        btn.textContent = "Submit & Grade Answers";
      }
    });
  };

  renderBody();
}

// --------------------------------------------------------------------------
// Global Init & Event Wiring
// --------------------------------------------------------------------------

function initTheme() {
  const saved = localStorage.getItem("studyflow_theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  document.getElementById("themeToggleBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("studyflow_theme", next);
  });
}

function initApp() {
  initTheme();

  document.querySelectorAll("[data-view]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.view));
  });

  document.getElementById("quickUploadCourseDocBtn").addEventListener("click", () => openUploadDocumentModal());
  document.getElementById("quickAddAssignmentBtn").addEventListener("click", () => openItemModal("assignment"));
  document.getElementById("quickAddTestBtn").addEventListener("click", () => openItemModal("test"));

  document.getElementById("mobileMenuBtn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });

  document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  document.getElementById("modalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "modalBackdrop") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  refreshData().catch((err) => {
    toast(`Failed to load workspace: ${err.message}`, "error");
  });
}

document.addEventListener("DOMContentLoaded", initApp);

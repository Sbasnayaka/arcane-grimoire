(() => {
  const STATE_KEY = "grimoire_dashboard_state";
  const MODE = document.body.dataset.mode || "newtab";

  const DEFAULT_STATE = {
    updatedAt: 0,
    tracks: [
      {
        id: "cv-mails",
        title: "CV Mails Sent",
        icon: "📜",
        type: "log",
        accent: "gold",
        statuses: ["Sent", "Follow-up", "Interview", "Replied", "Closed"],
        followUpDays: 7,
        items: []
      },
      {
        id: "job-portals",
        title: "Job Portal Applications",
        icon: "🌐",
        type: "log",
        accent: "rose",
        statuses: ["Applied", "Follow-up", "Interview", "Offer", "Closed"],
        followUpDays: 7,
        items: []
      },
      {
        id: "english-learning",
        title: "English Learning",
        icon: "🕯️",
        type: "habit",
        accent: "emerald",
        completedDates: [],
        items: []
      },
      {
        id: "learning-goals",
        title: "New Learning Goals",
        icon: "🔮",
        type: "progress",
        accent: "amethyst",
        items: []
      },
      {
        id: "research-side",
        title: "Research Side",
        icon: "🧪",
        type: "log",
        accent: "emerald",
        statuses: ["Idea", "Reading", "Drafting", "Submitted"],
        followUpDays: 0,
        items: []
      },
      {
        id: "ongoing-projects",
        title: "Ongoing Projects",
        icon: "✨",
        type: "progress",
        accent: "gold",
        items: []
      }
    ]
  };

  let state = structuredClone(DEFAULT_STATE);
  let activeFilter = "all";
  let modal = null; // null | "new-track" | "sync"
  let syncStatus = { kind: "local", text: "Local Cache" };
  let syncTimer = null;

  // Helpers
  function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function daysBetween(isoDate) {
    if (!isoDate) return 0;
    const [y, m, d] = isoDate.split("-").map(Number);
    const start = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((today - start) / 86400000);
  }

  function calcStreak(dates = []) {
    const set = new Set(dates);
    let streak = 0;
    const cursor = new Date();
    const toISO = (d) => {
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    if (!set.has(toISO(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (set.has(toISO(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function escapeHtml(str = "") {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function safeUrl(url = "") {
    const trimmed = url.trim();
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return "";
  }

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // Persistence & Cloud Sync
  async function loadInitialState() {
    const stored = await chrome.storage.local.get(STATE_KEY);
    if (stored[STATE_KEY] && Array.isArray(stored[STATE_KEY].tracks)) {
      state = stored[STATE_KEY];
    } else {
      state = structuredClone(DEFAULT_STATE);
      await chrome.storage.local.set({ [STATE_KEY]: state });
    }
    render();
    await syncWithCloud();
  }

  async function commitState() {
    state.updatedAt = Date.now();
    await chrome.storage.local.set({ [STATE_KEY]: state });
    render();
    scheduleCloudPush();
  }

  function scheduleCloudPush() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      const auth = await window.FirebaseSync.getAuthConfig();
      if (!auth) {
        syncStatus = { kind: "local", text: "Local Only" };
        render();
        return;
      }
      syncStatus = { kind: "syncing", text: "Syncing..." };
      render();
      try {
        await window.FirebaseSync.pushState(state);
        syncStatus = { kind: "synced", text: "Firestore Synced ✨" };
      } catch (err) {
        syncStatus = { kind: "error", text: `Sync Error` };
        console.error(err);
      }
      render();
    }, 600);
  }

  async function syncWithCloud() {
    const auth = await window.FirebaseSync.getAuthConfig();
    if (!auth) {
      syncStatus = { kind: "local", text: "Local Only" };
      render();
      return;
    }
    syncStatus = { kind: "syncing", text: "Syncing..." };
    render();
    try {
      const remote = await window.FirebaseSync.pullState();
      if (remote && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
        state = remote;
        await chrome.storage.local.set({ [STATE_KEY]: state });
      } else if (!remote || (state.updatedAt || 0) > (remote.updatedAt || 0)) {
        await window.FirebaseSync.pushState(state);
      }
      syncStatus = { kind: "synced", text: "Firestore Synced ✨" };
    } catch (err) {
      syncStatus = { kind: "error", text: "Sync Error" };
      console.error(err);
    }
    render();
  }

  // Keep New Tab and Side Panel live-synced via chrome.storage
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STATE_KEY]?.newValue) {
      const incoming = changes[STATE_KEY].newValue;
      if (incoming.updatedAt !== state.updatedAt) {
        state = incoming;
        render();
      }
    }
  });

  // Oracle Alerts ("Don't Miss")
  function getOracleAlerts() {
    const alerts = [];
    const today = todayISO();

    for (const track of state.tracks) {
      if (track.type === "habit") {
        const doneToday = (track.completedDates || []).includes(today);
        if (!doneToday) {
          alerts.push(`${track.icon} ${track.title}: ritual pending today`);
        }
      }
      if (track.type === "log" && track.followUpDays > 0) {
        const overdueCount = (track.items || []).filter((item) => {
          const isWaiting = item.status === "Sent" || item.status === "Applied";
          return isWaiting && daysBetween(item.date) >= track.followUpDays;
        }).length;
        if (overdueCount > 0) {
          alerts.push(`${track.icon} ${track.title}: ${overdueCount} follow-up${overdueCount > 1 ? "s" : ""} due (${track.followUpDays}+ days)`);
        }
      }
    }
    return alerts;
  }

  // Renderers
  function renderTrackCard(track) {
    const today = todayISO();
    const items = track.items || [];
    const countLabel =
      track.type === "habit"
        ? `🔥 ${calcStreak(track.completedDates)}d`
        : `${items.length} ${items.length === 1 ? "entry" : "entries"}`;

    let bodyHtml = "";

    if (track.type === "habit") {
      const doneToday = (track.completedDates || []).includes(today);
      const streak = calcStreak(track.completedDates);
      bodyHtml += `
        <div class="ritual-box">
          <button class="ritual-toggle ${doneToday ? "done" : ""}" data-action="toggle-habit" data-track="${track.id}">
            ${doneToday ? "✓ Completed Today" : "○ Mark Done Today"}
          </button>
          <span class="streak-badge">🔥 ${streak} day streak</span>
        </div>
      `;
    }

    if (items.length === 0) {
      const emptyMsg =
        track.type === "habit"
          ? "Log today's vocab, phrases, or practice notes below."
          : "No entries inscribed yet.";
      bodyHtml += `<div class="empty-hint">${emptyMsg}</div>`;
    } else {
      bodyHtml += `<div class="entry-list">`;
      for (const item of items) {
        const link = safeUrl(item.url);
        const titleContent = link
          ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)} ↗</a>`
          : escapeHtml(item.title);

        if (track.type === "progress") {
          bodyHtml += `
            <div class="entry-item">
              <div class="entry-top">
                <span class="entry-title">${titleContent}</span>
                <button class="icon-btn" title="Delete" data-action="delete-item" data-track="${track.id}" data-item="${item.id}">✕</button>
              </div>
              ${item.note ? `<div class="entry-note">Next: ${escapeHtml(item.note)}</div>` : ""}
              <div class="progress-row">
                <input type="range" min="0" max="100" step="5" value="${Number(item.progress || 0)}"
                  class="progress-slider" data-action="update-progress" data-track="${track.id}" data-item="${item.id}" />
                <span class="progress-val">${Number(item.progress || 0)}%</span>
              </div>
            </div>
          `;
        } else if (track.type === "log") {
          const age = daysBetween(item.date);
          const isOverdue =
            track.followUpDays > 0 &&
            (item.status === "Sent" || item.status === "Applied") &&
            age >= track.followUpDays;

          bodyHtml += `
            <div class="entry-item">
              <div class="entry-top">
                <span class="entry-title">${titleContent}</span>
                <button class="icon-btn" title="Delete" data-action="delete-item" data-track="${track.id}" data-item="${item.id}">✕</button>
              </div>
              ${item.note ? `<div class="entry-note">${escapeHtml(item.note)}</div>` : ""}
              <div class="entry-footer">
                <span>${escapeHtml(item.date || today)}</span>
                <button class="status-badge ${isOverdue ? "overdue" : ""}"
                  title="Click to cycle status"
                  data-action="cycle-status" data-track="${track.id}" data-item="${item.id}">
                  ${escapeHtml(item.status || "Active")}${isOverdue ? " • Follow up!" : ""}
                </button>
              </div>
            </div>
          `;
        } else {
          // Habit note log
          bodyHtml += `
            <div class="entry-item">
              <div class="entry-top">
                <span class="entry-title">${escapeHtml(item.title)}</span>
                <button class="icon-btn" title="Delete" data-action="delete-item" data-track="${track.id}" data-item="${item.id}">✕</button>
              </div>
              <div class="entry-footer"><span>${escapeHtml(item.date || today)}</span></div>
            </div>
          `;
        }
      }
      bodyHtml += `</div>`;
    }

    // Quick-add form per track type
    const placeholderTitle =
      track.type === "habit"
        ? "Quick vocab, phrase, or session note..."
        : track.type === "progress"
        ? "Goal or project name..."
        : "Company, role, or paper title...";

    const placeholderNote =
      track.type === "progress"
        ? "Next immediate milestone (optional)"
        : "Email, note, or quick context (optional)";

    bodyHtml += `
      <form class="quick-form" data-action="add-item" data-track="${track.id}">
        <div class="quick-row">
          <input class="input" name="title" placeholder="${placeholderTitle}" required />
          ${
            track.type === "log"
              ? `<button type="button" class="btn btn-ghost" title="Grab active browser tab" data-action="grab-tab" data-track="${track.id}">✨ Tab</button>`
              : ""
          }
        </div>
        ${
          track.type !== "habit"
            ? `<div class="quick-row">
                <input class="input" name="note" placeholder="${placeholderNote}" />
                ${
                  track.type === "log"
                    ? `<input class="input" name="url" placeholder="https:// link (optional)" />`
                    : ""
                }
              </div>`
            : ""
        }
        <button type="submit" class="btn">+ Inscribe</button>
      </form>
    `;

    return `
      <section class="track-card" data-accent="${escapeHtml(track.accent || "amethyst")}">
        <div class="track-header">
          <div class="track-title-wrap">
            <span class="track-icon">${escapeHtml(track.icon || "🌙")}</span>
            <h2 class="track-title">${escapeHtml(track.title)}</h2>
            <span class="track-meta">${countLabel}</span>
          </div>
          <div class="track-controls">
            <button class="icon-btn" title="Remove track" data-action="delete-track" data-track="${track.id}">🗑</button>
          </div>
        </div>
        ${bodyHtml}
      </section>
    `;
  }

  function renderModal() {
    if (modal === "new-track") {
      return `
        <div class="modal-backdrop" data-action="close-modal-bg">
          <form class="modal-card" data-action="create-track">
            <h3 class="modal-title">✨ Conjure New Tracking Goal</h3>
            <div>
              <label class="field-label">Track Name</label>
              <input class="input" name="title" placeholder="e.g., Freelance Outreach, System Design, Reading" required />
            </div>
            <div class="quick-row">
              <div style="flex:1">
                <label class="field-label">Icon / Glyph</label>
                <input class="input" name="icon" value="🌙" maxlength="4" />
              </div>
              <div style="flex:2">
                <label class="field-label">Accent Glow</label>
                <select class="select" name="accent">
                  <option value="amethyst">Enchanted Amethyst</option>
                  <option value="gold">Starlight Gold</option>
                  <option value="rose">Mystic Rose</option>
                  <option value="emerald">Potion Emerald</option>
                </select>
              </div>
            </div>
            <div>
              <label class="field-label">Tracking Style</label>
              <select class="select" name="type">
                <option value="log">Entry Log (Links, Status Tags, Follow-ups)</option>
                <option value="progress">Progress & Milestones (0–100% Bar)</option>
                <option value="habit">Daily Ritual & Streak (Daily Check-off + Notes)</option>
              </select>
            </div>
            <div>
              <label class="field-label">Custom Status Tags (for Entry Log, comma-separated)</label>
              <input class="input" name="statuses" value="To Do, In Progress, Waiting, Done" />
            </div>
            <div class="modal-actions">
              <button type="button" class="btn" data-action="close-modal">Cancel</button>
              <button type="submit" class="btn btn-primary">Create Track</button>
            </div>
          </form>
        </div>
      `;
    }

    if (modal === "sync") {
      return `
        <div class="modal-backdrop" data-action="close-modal-bg">
          <div class="modal-card" id="sync-modal-card">
            <h3 class="modal-title">☁️ Firebase Firestore Sync</h3>
            <p class="helper-text">
              Sign in with your Firebase project's Email/Password auth to sync your grimoire across Chrome, Brave, and other devices.
            </p>
            <div id="sync-modal-body">Loading...</div>
          </div>
        </div>
      `;
    }

    return "";
  }

  async function hydrateSyncModal() {
    const body = document.getElementById("sync-modal-body");
    if (!body) return;
    const auth = await window.FirebaseSync.getAuthConfig();

    if (auth) {
      body.innerHTML = `
        <div class="entry-item">
          <div class="entry-title">Connected to: ${escapeHtml(auth.projectId)}</div>
          <div class="entry-note">Signed in as: ${escapeHtml(auth.email)}</div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-danger" data-action="firebase-signout">Disconnect</button>
          <button type="button" class="btn btn-primary" data-action="sync-now">Sync Now</button>
          <button type="button" class="btn" data-action="close-modal">Close</button>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <form id="firebase-auth-form" style="display:flex;flex-direction:column;gap:10px;">
        <div>
          <label class="field-label">Firebase Project ID</label>
          <input class="input" name="projectId" placeholder="my-grimoire-app" required />
        </div>
        <div>
          <label class="field-label">Firebase Web API Key</label>
          <input class="input" name="apiKey" placeholder="AIzaSy..." required />
        </div>
        <div>
          <label class="field-label">Email</label>
          <input class="input" type="email" name="email" placeholder="you@example.com" required />
        </div>
        <div>
          <label class="field-label">Password</label>
          <input class="input" type="password" name="password" placeholder="••••••••" minlength="6" required />
        </div>
        <div id="auth-error" class="error-text"></div>
        <div class="modal-actions">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          <button type="button" class="btn" data-action="firebase-auth" data-mode="signup">Create Account</button>
          <button type="button" class="btn btn-primary" data-action="firebase-auth" data-mode="signin">Sign In</button>
        </div>
      </form>
    `;
  }

  function render() {
    const app = document.getElementById("app");
    const alerts = getOracleAlerts();
    const visibleTracks =
      activeFilter === "all"
        ? state.tracks
        : state.tracks.filter((t) => t.id === activeFilter);

    const dateStr = new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric"
    });

    app.innerHTML = `
      <header class="topbar">
        <div class="brand-wrap">
          <h1 class="brand-title">🌙 Arcane Grimoire</h1>
          <span class="brand-sub">${escapeHtml(dateStr)} • Stay on track</span>
        </div>
        <div class="topbar-actions">
          <span class="sync-pill ${syncStatus.kind}">${escapeHtml(syncStatus.text)}</span>
          <button class="btn btn-primary" data-action="open-new-track">+ New Track</button>
          <button class="btn" data-action="open-sync">⚙️ Cloud Sync</button>
        </div>
      </header>

      <div class="oracle-strip">
        <span class="oracle-label">✦ Don't Miss</span>
        ${
          alerts.length
            ? alerts.map((a) => `<span class="oracle-chip">${escapeHtml(a)}</span>`).join("")
            : `<span class="oracle-chip all-clear">✨ All rituals & follow-ups are on track today</span>`
        }
      </div>

      ${
        MODE === "sidepanel"
          ? `<nav class="filter-bar">
              <button class="filter-pill ${activeFilter === "all" ? "active" : ""}" data-action="filter" data-track="all">All</button>
              ${state.tracks
                .map(
                  (t) =>
                    `<button class="filter-pill ${activeFilter === t.id ? "active" : ""}" data-action="filter" data-track="${t.id}">
                      ${escapeHtml(t.icon)} ${escapeHtml(t.title)}
                    </button>`
                )
                .join("")}
            </nav>`
          : ""
      }

      <main class="tracks-grid">
        ${visibleTracks.map(renderTrackCard).join("")}
      </main>

      ${renderModal()}
    `;

    if (modal === "sync") {
      hydrateSyncModal();
    }
  }

  // Event Handling
  document.getElementById("app").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;

    const action = el.dataset.action;
    const trackId = el.dataset.track;
    const itemId = el.dataset.item;

    if (action === "open-new-track") {
      modal = "new-track";
      render();
      return;
    }

    if (action === "open-sync") {
      modal = "sync";
      render();
      return;
    }

    if (action === "close-modal" || (action === "close-modal-bg" && e.target === el)) {
      modal = null;
      render();
      return;
    }

    if (action === "filter") {
      activeFilter = trackId;
      render();
      return;
    }

    if (action === "toggle-habit") {
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return;
      const today = todayISO();
      track.completedDates = track.completedDates || [];
      if (track.completedDates.includes(today)) {
        track.completedDates = track.completedDates.filter((d) => d !== today);
      } else {
        track.completedDates.push(today);
      }
      await commitState();
      return;
    }

    if (action === "cycle-status") {
      const track = state.tracks.find((t) => t.id === trackId);
      const item = track?.items?.find((i) => i.id === itemId);
      if (!track || !item) return;
      const list = track.statuses?.length ? track.statuses : ["Active", "Done"];
      const idx = list.indexOf(item.status);
      item.status = list[(idx + 1) % list.length];
      await commitState();
      return;
    }

    if (action === "delete-item") {
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return;
      track.items = (track.items || []).filter((i) => i.id !== itemId);
      await commitState();
      return;
    }

    if (action === "delete-track") {
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return;
      if (!confirm(`Delete "${track.title}" and all its entries?`)) return;
      state.tracks = state.tracks.filter((t) => t.id !== trackId);
      if (activeFilter === trackId) activeFilter = "all";
      await commitState();
      return;
    }

    if (action === "grab-tab") {
      const form = el.closest("form");
      if (!form) return;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          const titleInput = form.querySelector('input[name="title"]');
          const urlInput = form.querySelector('input[name="url"]');
          if (titleInput && !titleInput.value) titleInput.value = tab.title || "";
          if (urlInput && tab.url && /^https?:\/\//i.test(tab.url)) urlInput.value = tab.url;
        }
      } catch (err) {
        console.error("Tab grab failed:", err);
      }
      return;
    }

    if (action === "firebase-auth") {
      const form = document.getElementById("firebase-auth-form");
      const errBox = document.getElementById("auth-error");
      if (!form || !form.reportValidity()) return;
      const fd = new FormData(form);
      errBox.textContent = "Connecting to Firebase...";
      try {
        await window.FirebaseSync.authenticate(el.dataset.mode, {
          projectId: fd.get("projectId"),
          apiKey: fd.get("apiKey"),
          email: fd.get("email"),
          password: fd.get("password")
        });
        modal = null;
        await syncWithCloud();
      } catch (err) {
        errBox.textContent = err.message;
      }
      return;
    }

    if (action === "firebase-signout") {
      await window.FirebaseSync.clearAuthConfig();
      syncStatus = { kind: "local", text: "Local Only" };
      modal = null;
      render();
      return;
    }

    if (action === "sync-now") {
      modal = null;
      await syncWithCloud();
    }
  });

  document.getElementById("app").addEventListener("submit", async (e) => {
    const form = e.target.closest("form[data-action]");
    if (!form) return;
    e.preventDefault();

    const action = form.dataset.action;
    const fd = new FormData(form);

    if (action === "add-item") {
      const track = state.tracks.find((t) => t.id === form.dataset.track);
      if (!track) return;
      const title = String(fd.get("title") || "").trim();
      if (!title) return;

      const entry = {
        id: uid(),
        title,
        note: String(fd.get("note") || "").trim(),
        url: String(fd.get("url") || "").trim(),
        date: todayISO(),
        progress: 0,
        status: track.statuses?.[0] || "Active"
      };

      track.items = [entry, ...(track.items || [])];
      await commitState();
      return;
    }

    if (action === "create-track") {
      const title = String(fd.get("title") || "").trim();
      if (!title) return;
      const type = String(fd.get("type") || "log");
      const rawStatuses = String(fd.get("statuses") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const newTrack = {
        id: uid(),
        title,
        icon: String(fd.get("icon") || "🌙").trim() || "🌙",
        type,
        accent: String(fd.get("accent") || "amethyst"),
        statuses: rawStatuses.length ? rawStatuses : ["To Do", "In Progress", "Done"],
        followUpDays: 0,
        completedDates: [],
        items: []
      };

      state.tracks.push(newTrack);
      modal = null;
      await commitState();
    }
  });

  document.getElementById("app").addEventListener("change", async (e) => {
    const el = e.target.closest("[data-action='update-progress']");
    if (!el) return;
    const track = state.tracks.find((t) => t.id === el.dataset.track);
    const item = track?.items?.find((i) => i.id === el.dataset.item);
    if (!item) return;
    item.progress = Number(el.value);
    await commitState();
  });

  loadInitialState();
})();
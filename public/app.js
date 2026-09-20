// ============================================================
//  app.js  —  Walltap frontend logic
//  No frameworks, no build step. Plain ES2020 JavaScript.
//  Auth + data are backed by Supabase (see server.js).
// ============================================================

// ── Supabase client ───────────────────────────────────────────
const SUPABASE_URL      = window.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";

// Capture the recovery flag before the Supabase client consumes the URL hash.
const _hash   = new URLSearchParams((location.hash || "").replace(/^#/, ""));
const _query  = new URLSearchParams(location.search);
const isRecoveryLink = _hash.get("type") === "recovery" || _query.get("recovery") === "1";

const supabase = (window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// ── DOM references ────────────────────────────────────────────
const feed        = document.getElementById("feed");
const feedEmpty   = document.getElementById("feed-empty");
const input       = document.getElementById("post-input");
const postBtn     = document.getElementById("post-btn");
const micBtn      = document.getElementById("mic-btn");
const toast       = document.getElementById("toast");
const fileInput   = document.getElementById("file-input");
const fileLabel   = document.getElementById("file-label");
const authOverlay = document.getElementById("auth-overlay");
const authSubtitle = document.getElementById("auth-subtitle");
const authDisplay = document.getElementById("auth-display");
const authEmail   = document.getElementById("auth-email");
const authPass    = document.getElementById("auth-password");
const authBtn     = document.getElementById("auth-btn");
const authError   = document.getElementById("auth-error");
const authToggle  = document.getElementById("auth-toggle");
const authForgot  = document.getElementById("auth-forgot");
const resetPanel       = document.getElementById("reset-panel");
const resetNote        = document.getElementById("reset-note");
const resetRequestGroup = document.getElementById("reset-request-group");
const resetEmail       = document.getElementById("reset-email");
const resetRequestBtn  = document.getElementById("reset-request-btn");
const recoveryPanel    = document.getElementById("recovery-panel");
const recoveryNewPass  = document.getElementById("recovery-new-pass");
const recoveryConfirmPass = document.getElementById("recovery-confirm-pass");
const recoveryConfirmBtn  = document.getElementById("recovery-confirm-btn");
const resetError       = document.getElementById("reset-error");
const resetBack        = document.getElementById("reset-back");
const logoutBtn   = document.getElementById("logout-btn");
const headerUser  = document.getElementById("header-user");
const attachPrev  = document.getElementById("attach-preview");
const dropOverlay = document.getElementById("drop-overlay");
const recStatus   = document.getElementById("rec-status");
const recTime     = document.getElementById("rec-time");

let toastTimer  = null;
let currentUser = null;      // display name
let currentUserId = null;    // Supabase auth user id
let accessToken = null;      // current Supabase access token
let isLogin     = true;
let realtime    = null;
let attachments = [];
let recorder    = null;
let recChunks   = [];
let recMime     = "";
let recTimer    = null;
let recSeconds  = 0;
const localIds  = new Set();


// ============================================================
//  showToast(message)
// ============================================================
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}


// ============================================================
//  formatTime(timestamp)
// ============================================================
function formatTime(ts) {
  if (!ts) return "";
  const d   = new Date(Number(ts));
  const now = new Date();
  const isToday =
    d.getDate()     === now.getDate()  &&
    d.getMonth()    === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today at ${time}`;
  const month = d.toLocaleString("default", { month: "short" });
  return `${month} ${d.getDate()} at ${time}`;
}


// ============================================================
//  syncEmptyState()
// ============================================================
function syncEmptyState() {
  const hasPosts = feed.querySelector(".post") !== null;
  feedEmpty.style.display = hasPosts ? "none" : "block";
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch (_) {
    const text = await response.text();
    return { error: text || `Server error ${response.status}` };
  }
}

// ============================================================
//  apiFetch(url, options)
//  Adds the Supabase access token to every API request.
// ============================================================
async function apiFetch(url, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (accessToken) opts.headers.Authorization = `Bearer ${accessToken}`;
  return fetch(url, opts);
}

// Fire-and-forget analytics row (used by the admin dashboard).
function logEvent(event_type, metadata = {}) {
  if (!supabase || !currentUserId) return;
  supabase
    .from("events")
    .insert({ event_type, user_id: currentUserId, metadata })
    .then(() => {})
    .catch(() => {});
}


// ============================================================
//  createPostElement(post)
//  Builds a complete <section class="post"> DOM node.
// ============================================================
function createPostElement(post) {
  const section = document.createElement("section");
  section.classList.add("post");
  section.dataset.id = post.id;
  section.dataset.author = post.author;
  section.dataset.ts = post.timestamp;
  const isOwn = currentUserId && post.authorId === currentUserId;
  if (isOwn) section.classList.add("own");

  const authorEl = document.createElement("span");
  authorEl.classList.add("post-author");
  authorEl.textContent = post.author;
  section.appendChild(authorEl);

  const bubble = document.createElement("div");
  bubble.classList.add("bubble");

  if (post.text) {
    const textEl = document.createElement("p");
    textEl.classList.add("post-text");
    textEl.textContent = post.text;
    bubble.appendChild(textEl);
  }

  if (post.files && post.files.length) {
    post.files.forEach(file => {
      const url  = file.url || ("/uploads/" + file.filename);
      const mime = file.mimetype || "";
      if (mime.startsWith("image/")) {
        const a = document.createElement("a");
        a.href = url; a.target = "_blank"; a.rel = "noopener";
        const img = document.createElement("img");
        img.classList.add("post-image");
        img.src = url;
        img.alt = file.original;
        a.appendChild(img);
        bubble.appendChild(a);
      } else if (mime.startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.classList.add("post-audio");
        audio.controls = true;
        audio.src = url;
        bubble.appendChild(audio);
      } else if (mime.startsWith("video/")) {
        const video = document.createElement("video");
        video.classList.add("post-video");
        video.controls = true;
        video.src = url;
        bubble.appendChild(video);
      } else {
        const a = document.createElement("a");
        a.classList.add("post-file");
        a.href = url; a.target = "_blank"; a.rel = "noopener";
        const icon = document.createElement("span");
        icon.classList.add("post-file-icon");
        icon.textContent = "📎";
        const nameEl = document.createElement("span");
        nameEl.textContent = file.original;
        a.appendChild(icon);
        a.appendChild(nameEl);
        bubble.appendChild(a);
      }
    });
  }

  const meta = document.createElement("div");
  meta.classList.add("post-meta");

  const timeEl = document.createElement("span");
  timeEl.textContent = formatTime(post.timestamp);
  meta.appendChild(timeEl);

  const ticks = document.createElement("span");
  ticks.classList.add("post-ticks");
  ticks.textContent = "✓✓";
  meta.appendChild(ticks);

  if (isOwn) {
    const deleteBtn = document.createElement("button");
    deleteBtn.classList.add("post-delete");
    deleteBtn.title = "Erase this post";
    deleteBtn.textContent = "✕";
    deleteBtn.setAttribute("aria-label", "Delete post");
    deleteBtn.addEventListener("click", () => {
      localIds.add(post.id);
      deletePost(post.id, section);
    });
    meta.appendChild(deleteBtn);
  }

  bubble.appendChild(meta);
  section.appendChild(bubble);
  return section;
}


// ============================================================
//  Date separators + grouping
// ============================================================
function dateKey(ts) {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dateLabel(ts) {
  const d = new Date(Number(ts));
  const today = new Date();
  const yest  = new Date();
  yest.setDate(today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest))  return "Yesterday";
  return d.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric" });
}

function maybeAddDateChip(ts) {
  const posts = feed.querySelectorAll(".post");
  const prev  = posts[posts.length - 1];
  if (!prev) return;
  if (dateKey(Number(prev.dataset.ts)) === dateKey(ts)) return;
  const chip = document.createElement("div");
  chip.classList.add("date-chip");
  chip.textContent = dateLabel(ts);
  feed.appendChild(chip);
}

function maybeGroup(section) {
  const posts = feed.querySelectorAll(".post");
  const prev  = posts[posts.length - 1];
  if (prev && prev.dataset.author === section.dataset.author) {
    section.classList.add("grouped");
  }
}

function scrollToBottom(smooth) {
  feed.scrollIntoView({ block: "end", behavior: smooth ? "smooth" : "auto" });
}

function appendPost(section, scroll = true) {
  maybeAddDateChip(Number(section.dataset.ts));
  maybeGroup(section);
  feed.appendChild(section);
  syncEmptyState();
  if (scroll) scrollToBottom(true);
}


// ============================================================
//  loadPosts()
// ============================================================
async function loadPosts() {
  try {
    const res = await apiFetch("/api/posts");
    if (!res.ok) {
      const { error } = await parseJsonSafe(res);
      throw new Error(error || `Server error ${res.status}`);
    }
    const posts = await parseJsonSafe(res);

    posts.forEach(post => {
      if (feed.querySelector(`[data-id="${post.id}"]`)) return;
      const section = createPostElement(post);
      appendPost(section, false);
    });

    scrollToBottom(false);

  } catch (err) {
    console.error("loadPosts failed:", err);
    showToast("Could not load posts — is the server running?");
  }
}


// ============================================================
//  submitPost()
// ============================================================
async function submitPost() {
  if (postBtn.disabled) return;
  if (recorder) return;

  const text = input.value.trim();
  if (!text && attachments.length === 0) return;

  postBtn.disabled   = true;
  postBtn.classList.add("sending");

  try {
    const formData = new FormData();
    if (text) formData.append("text", text);
    attachments.forEach(file => formData.append("files", file));

    const res = await apiFetch("/api/posts", { method: "POST", body: formData });

    if (!res.ok) {
      const { error } = await parseJsonSafe(res);
      throw new Error(error || `Server error ${res.status}`);
    }

    const newPost = await parseJsonSafe(res);
    localIds.add(newPost.id);

    if (!feed.querySelector(`[data-id="${newPost.id}"]`)) {
      const section = createPostElement(newPost);
      appendPost(section);
    }

    input.value       = "";
    input.style.height = "auto";
    fileLabel.classList.remove("has-file");
    clearAttachments();

  } catch (err) {
    console.error("submitPost failed:", err);
    showToast(`Could not post: ${err.message}`);
  } finally {
    postBtn.disabled         = false;
    postBtn.classList.remove("sending");
    updateSendBtn();
    input.focus();
  }
}


// ============================================================
//  deletePost(id, sectionEl)
// ============================================================
async function deletePost(id, sectionEl) {
  try {
    const res = await apiFetch(`/api/posts/${id}`, { method: "DELETE" });
    if (res.status === 404) {
      sectionEl.remove();
      syncEmptyState();
      return;
    }
    if (!res.ok) {
      const { error } = await parseJsonSafe(res);
      throw new Error(error || `Server error ${res.status}`);
    }

    sectionEl.classList.add("erasing");
    setTimeout(() => {
      sectionEl.remove();
      syncEmptyState();
    }, 230);

  } catch (err) {
    console.error("deletePost failed:", err);
    showToast(`Could not erase that post: ${err.message}`);
  }
}


// ============================================================
//  Attachment helpers
// ============================================================
const MAX_FILES = 5;

function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function addAttachment(file) {
  if (attachments.length >= MAX_FILES) {
    showToast(`Maximum ${MAX_FILES} files per post.`);
    return;
  }
  attachments.push(file);
  renderAttachments();
  updateSendBtn();
}

function removeAttachment(index) {
  const file = attachments[index];
  attachments.splice(index, 1);
  if (file && file._thumbUrl) URL.revokeObjectURL(file._thumbUrl);
  renderAttachments();
  updateSendBtn();
}

function clearAttachments() {
  attachments.forEach(file => {
    if (file._thumbUrl) URL.revokeObjectURL(file._thumbUrl);
  });
  attachments = [];
  renderAttachments();
  updateSendBtn();
}

function renderAttachments() {
  attachPrev.innerHTML = "";
  attachPrev.classList.toggle("has-files", attachments.length > 0);
  fileLabel.classList.toggle("has-file", attachments.length > 0);
  attachments.forEach((file, i) => {
    const chip = document.createElement("div");
    chip.classList.add("attach-chip");

    const thumb = document.createElement("div");
    thumb.classList.add("attach-thumb");
    if (file.type && file.type.startsWith("image/")) {
      if (!file._thumbUrl) file._thumbUrl = URL.createObjectURL(file);
      const img = document.createElement("img");
      img.src = file._thumbUrl;
      img.alt = "";
      thumb.appendChild(img);
    } else {
      thumb.textContent = "📄";
    }
    chip.appendChild(thumb);

    const info = document.createElement("div");
    info.classList.add("attach-info");
    const name = document.createElement("div");
    name.classList.add("attach-name");
    name.textContent = file.name;
    const size = document.createElement("div");
    size.classList.add("attach-size");
    size.textContent = formatBytes(file.size);
    info.appendChild(name);
    info.appendChild(size);
    chip.appendChild(info);

    const rm = document.createElement("button");
    rm.classList.add("attach-remove");
    rm.textContent = "✕";
    rm.setAttribute("aria-label", "Remove attachment");
    rm.addEventListener("click", () => removeAttachment(i));
    chip.appendChild(rm);

    attachPrev.appendChild(chip);
  });
}

function updateSendBtn() {
  if (recorder) { postBtn.disabled = true; return; }
  postBtn.disabled = input.value.trim().length === 0 && attachments.length === 0;
}


// ============================================================
//  Voice notes
// ============================================================
const REC_MAX_SECONDS = 120;

function updateRecTimer() {
  const m = Math.floor(recSeconds / 60);
  const s = recSeconds % 60;
  recTime.textContent = `${m}:${s.toString().padStart(2, "0")}`;
  if (recSeconds >= REC_MAX_SECONDS) stopRecording();
}

async function toggleMic() {
  if (recorder) { stopRecording(); return; }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
      typeof MediaRecorder === "undefined") {
    showToast("Voice recording isn't supported in this browser.");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error("mic denied:", err);
    showToast("Microphone permission was denied.");
    return;
  }

  try {
    const mimeType = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
    recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    recMime   = recorder.mimeType || mimeType || "audio/webm";
    recChunks = [];

    recorder.addEventListener("dataavailable", e => {
      if (e.data && e.data.size) recChunks.push(e.data);
    });

    recorder.addEventListener("stop", () => {
      const blob = new Blob(recChunks, { type: recMime });
      stream.getTracks().forEach(t => t.stop());
      const ext = recMime.includes("mp4") ? "mp4" : "webm";
      const file = new File([blob], `voice-note.${ext}`, {
        type: recMime,
        lastModified: Date.now()
      });
      if (file.size > 0) addAttachment(file);
      else showToast("Recording was empty.");
    });

    recorder.addEventListener("error", () => {
      stopRecording();
      showToast("Recording failed.");
    });

    recorder.start();
    startRecUi();
  } catch (err) {
    console.error("mic start failed:", err);
    stream.getTracks().forEach(t => t.stop());
    showToast("Could not start recording.");
  }
}

function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  clearRecUi();
  if (r.state !== "inactive") r.stop();
}

function startRecUi() {
  micBtn.classList.add("recording");
  recSeconds = 0;
  updateRecTimer();
  recStatus.classList.add("show");
  recTimer = setInterval(() => {
    recSeconds++;
    updateRecTimer();
  }, 1000);
}

function clearRecUi() {
  micBtn.classList.remove("recording");
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  recStatus.classList.remove("show");
  updateSendBtn();
}


// ── Composer event listeners ──────────────────────────────────
postBtn.addEventListener("click", submitPost);
micBtn.addEventListener("click", toggleMic);

input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitPost();
  }
});

fileInput.addEventListener("change", () => {
  [...fileInput.files].forEach(f => addAttachment(f));
  fileInput.value = "";
  fileLabel.classList.toggle("has-file", attachments.length > 0);
});

document.addEventListener("paste", e => {
  if (authOverlay.classList.contains("hidden") === false) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let added = 0;
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) { addAttachment(file); added++; }
  }
  if (added > 0) e.preventDefault();
});

let dragDepth = 0;
function hasFiles(types) {
  return types && Array.prototype.indexOf.call(types, "Files") !== -1;
}
document.addEventListener("dragenter", e => {
  if (!hasFiles(e.dataTransfer && e.dataTransfer.types)) return;
  if (authOverlay.classList.contains("hidden") === false) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add("show");
});
document.addEventListener("dragover", e => {
  if (!hasFiles(e.dataTransfer && e.dataTransfer.types)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove("show");
});
document.addEventListener("drop", e => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove("show");
  if (authOverlay.classList.contains("hidden") === false) return;
  if (e.dataTransfer && e.dataTransfer.files) {
    [...e.dataTransfer.files].forEach(f => addAttachment(f));
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 130) + "px";
  updateSendBtn();
});


// ── Auth helpers ──────────────────────────────────────────────

function displayNameOf(user) {
  const md = user.user_metadata || {};
  return md.display_name || md.username || (user.email || "").split("@")[0] || "user";
}

function applySession(session) {
  if (session && session.user) {
    accessToken   = session.access_token || null;
    currentUserId = session.user.id;
    currentUser   = displayNameOf(session.user);
  } else {
    accessToken   = null;
    currentUserId = null;
    currentUser   = null;
  }
}

function setMainAuthVisible(v) {
  authSubtitle.classList.toggle("hidden", !v);
  authEmail.classList.toggle("hidden", !v);
  authPass.classList.toggle("hidden", !v);
  authDisplay.classList.toggle("hidden", !v || isLogin);
  authBtn.classList.toggle("hidden", !v);
  authError.classList.toggle("hidden", !v);
  authToggle.classList.toggle("hidden", !v);
  authForgot.classList.toggle("hidden", !v);
}

function syncAuthToggle() {
  authBtn.textContent    = isLogin ? "Sign in" : "Create account";
  authToggle.textContent = isLogin ? "No account? Create one" : "Already have an account? Sign in";
  authPass.setAttribute("autocomplete", isLogin ? "current-password" : "new-password");
  authDisplay.classList.toggle("hidden", isLogin);
}

function showSignInForm() {
  resetPanel.classList.add("hidden");
  setMainAuthVisible(true);
  resetError.textContent = "";
}

function showResetRequest() {
  resetPanel.classList.remove("hidden");
  setMainAuthVisible(false);
  resetRequestGroup.classList.remove("hidden");
  recoveryPanel.classList.add("hidden");
  resetNote.textContent = "Enter your email and we'll send a reset link.";
  resetError.textContent = "";
}

function enterRecoveryMode() {
  authOverlay.classList.remove("hidden");
  resetPanel.classList.remove("hidden");
  setMainAuthVisible(false);
  resetRequestGroup.classList.add("hidden");
  recoveryPanel.classList.remove("hidden");
  resetNote.textContent = "Choose a new password.";
  resetError.textContent = "";
}

function enterApp() {
  authOverlay.classList.add("hidden");
  headerUser.textContent = currentUser || "";
  loadPosts();
  connectRealtime();
  logEvent("page_view");
}

function showSignInOverlay() {
  authOverlay.classList.remove("hidden");
  showSignInForm();
}

async function checkAuth() {
  if (!supabase) {
    authOverlay.classList.remove("hidden");
    authError.textContent = "Supabase is not configured on the server.";
    return;
  }
  try {
    const { data } = await supabase.auth.getSession();
    applySession(data.session);

    if (isRecoveryLink && data.session) { enterRecoveryMode(); return; }
    if (data.session) enterApp();
    else showSignInOverlay();
  } catch (err) {
    console.error("checkAuth failed:", err);
    showSignInOverlay();
  }
}

async function handleAuth() {
  if (!supabase) return;
  const email    = authEmail.value.trim();
  const password = authPass.value;
  const display  = authDisplay.value.trim();

  if (!email || !password) {
    authError.textContent = "Email and password are required.";
    return;
  }

  authBtn.disabled = true;
  authBtn.textContent = isLogin ? "Signing in…" : "Creating account…";
  authError.textContent = "";

  try {
    if (isLogin) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      applySession(data.session);
      enterApp();
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: display || (email.split("@")[0]) } }
      });
      if (error) throw error;
      if (data.session) {
        applySession(data.session);
        enterApp();
      } else {
        showToast("Check your email to confirm your account, then sign in.");
        isLogin = true;
      }
    }
  } catch (err) {
    authError.textContent = err.message || "Something went wrong.";
  } finally {
    authBtn.disabled = false;
    syncAuthToggle();
  }
}

async function handleLogout() {
  try { if (supabase) await supabase.auth.signOut(); } catch (_) {}
  if (realtime) realtime.unsubscribe();
  location.reload();
}

async function handleResetRequest() {
  const email = resetEmail.value.trim();
  if (!email) return;
  if (!supabase) { resetError.textContent = "Supabase is not configured."; return; }

  resetRequestBtn.disabled    = true;
  resetRequestBtn.textContent = "Sending…";
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/?recovery=1"
    });
    if (error) throw error;
    resetNote.textContent = "If an account exists for that email, a reset link has been sent.";
    resetError.textContent = "";
  } catch (err) {
    resetError.textContent = err.message || "Something went wrong.";
  } finally {
    resetRequestBtn.disabled    = false;
    resetRequestBtn.textContent = "Send reset link";
  }
}

async function handleRecoveryConfirm() {
  const pass  = recoveryNewPass.value;
  const pass2 = recoveryConfirmPass.value;
  if (pass.length < 6) { resetError.textContent = "Password must be at least 6 characters."; return; }
  if (pass !== pass2)  { resetError.textContent = "Passwords don't match."; return; }
  if (!supabase)       { resetError.textContent = "Supabase is not configured."; return; }

  recoveryConfirmBtn.disabled    = true;
  recoveryConfirmBtn.textContent = "Saving…";
  try {
    const { error } = await supabase.auth.updateUser({ password: pass });
    if (error) throw error;
    history.replaceState(null, "", location.pathname);
    await supabase.auth.signOut();
    applySession(null);
    showToast("Password updated. Sign in with your new password.");
    showSignInForm();
    authPass.focus();
  } catch (err) {
    resetError.textContent = err.message || "Something went wrong.";
  } finally {
    recoveryConfirmBtn.disabled    = false;
    recoveryConfirmBtn.textContent = "Set new password";
  }
}


// ── Realtime — live updates via Supabase Realtime broadcast on
// the shared "board" channel (event parity with the old SSE stream).
// The server broadcasts post-created / post-deleted with the full
// post payload (already signed file URLs); the channel is private so
// the realtime.messages RLS policies apply (see server.js SCHEMA_SQL).
function connectRealtime() {
  if (!supabase || !accessToken) return;
  if (realtime) realtime.unsubscribe();
  supabase.realtime.setAuth(accessToken);
  realtime = supabase
    .channel("board", { config: { private: true } })
    .on("broadcast", { event: "post-created" }, ({ payload }) => {
      if (localIds.has(payload.id)) { localIds.delete(payload.id); return; }
      if (feed.querySelector(`[data-id="${payload.id}"]`)) return;
      const section = createPostElement(payload);
      appendPost(section);
    })
    .on("broadcast", { event: "post-deleted" }, ({ payload }) => {
      if (localIds.has(payload.id)) { localIds.delete(payload.id); return; }
      const section = feed.querySelector(`[data-id="${payload.id}"]`);
      if (!section) return;
      section.classList.add("erasing");
      setTimeout(() => { section.remove(); syncEmptyState(); }, 230);
    })
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") console.error("Realtime channel error.");
      if (status === "CLOSED") console.warn("Realtime channel closed.");
    });
}

// Keep our cached token/identity fresh as Supabase refreshes sessions.
if (supabase) {
  supabase.auth.onAuthStateChange((_event, session) => {
    applySession(session);
    if (session && currentUser) headerUser.textContent = currentUser;
  });
}


// ── Auth event listeners ─────────────────────────────────────
authBtn.addEventListener("click", handleAuth);

authEmail.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); authPass.focus(); }
});
authPass.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); handleAuth(); }
});

authToggle.addEventListener("click", () => {
  isLogin = !isLogin;
  authError.textContent = "";
  syncAuthToggle();
});

authForgot.addEventListener("click", showResetRequest);
resetBack.addEventListener("click", showSignInForm);
resetRequestBtn.addEventListener("click", handleResetRequest);
recoveryConfirmBtn.addEventListener("click", handleRecoveryConfirm);
resetEmail.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); handleResetRequest(); }
});
recoveryNewPass.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); recoveryConfirmPass.focus(); }
});
recoveryConfirmPass.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); handleRecoveryConfirm(); }
});

logoutBtn.addEventListener("click", handleLogout);

// ── Init ─────────────────────────────────────────────────────
syncAuthToggle();
updateSendBtn();
if (isRecoveryLink) enterRecoveryMode();
checkAuth();

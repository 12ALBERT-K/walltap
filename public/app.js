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

const onlineBar       = document.getElementById("online-bar");
const onlineList      = document.getElementById("online-list");
const incomingCall    = document.getElementById("incoming-call");
const incomingName    = document.getElementById("incoming-name");
const incomingAvatar  = document.getElementById("incoming-avatar");
const acceptCallBtn   = document.getElementById("call-accept-btn");
const declineCallBtn  = document.getElementById("call-decline-btn");
const activeCall      = document.getElementById("active-call");
const callFallback    = document.getElementById("call-fallback");
const callLocalVideo  = document.getElementById("call-local-video");
const callRemoteVideo = document.getElementById("call-remote-video");
const callPeerNameEl  = document.getElementById("call-peer-name");
const callStateEl     = document.getElementById("call-state");
const muteBtn         = document.getElementById("call-mute-btn");
const camBtn          = document.getElementById("call-cam-btn");
const hangupBtn       = document.getElementById("call-hangup-btn");

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

// ── Calls state (Phase 3) ────────────────────────────────────
const CALL_ICE        = [{ urls: "stun:stun.l.google.com:19302" }];
const CALL_TIMEOUT    = 30000;
let callState         = "idle";   // idle | outgoing | incoming | connecting | active
let callPeerId        = null;
let callPeerName      = null;
let callChannel       = null;
let pc                = null;
let localStream       = null;
let remoteStream      = null;
let pendingIce        = [];
let ringTimer         = null;
let ringPulseTimer    = null;   // ringtone pulse; kept separate from ringTimer so
                                // the interval is always clearable (they shared one
                                // handle, which leaked an uncleared interval)
let ringCtx           = null;
let ringGain          = null;
let ringOsc           = null;
let callTimer         = null;
let callTimerStart    = null;
let callSeconds       = 0;
let micEnabled        = true;
let camEnabled        = true;


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
  connectCalls();
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
  if (callChannel) { try { callChannel.unsubscribe(); } catch (_) {} callChannel = null; }
  teardownCall();
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

// ============================================================
//  Calls — 1:1 WebRTC voice/video via Supabase Realtime.
//  Signaling runs on a private "calls" channel (presence shows
//  who's online + targeted broadcast messages carry the call
//  flow: invite → accept/decline/busy → offer → answer → ICE).
//  Peer-to-peer media needs TURN for hostile NATs; ICE starts
//  STUN-only (see CALL_ICE) — add TURN servers there when
//  available (Cloudflare Calls / Twilio, ROADMAP Phase 3).
// ============================================================

function inCall() {
  return callState !== "idle";
}

function sendCallSignal(event, payload) {
  if (!callChannel || callChannel.state !== "joined") return;
  try {
    callChannel.send({ type: "broadcast", event, payload });
  } catch (_) {}
}

function currentPresencePeers() {
  const peers = new Map();
  if (!callChannel) return peers;
  const state = callChannel.presenceState() || {};
  for (const key of Object.keys(state)) {
    for (const p of state[key]) {
      if (!p || !p.id || p.id === currentUserId) continue;
      if (!peers.has(p.id)) {
        peers.set(p.id, String(p.name || "user").slice(0, 40));
      }
    }
  }
  return peers;
}

function renderOnlineUsers() {
  if (!onlineBar || !onlineList) return;
  const peers = currentPresencePeers();
  const peerIds = new Set(peers.keys());
  if (peerIds.size === 0) {
    onlineBar.classList.add("hidden-bar");
    onlineList.innerHTML = "";
    return;
  }
  onlineBar.classList.remove("hidden-bar");
  onlineList.innerHTML = "";
  for (const [id, name] of peers) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "online-chip";
    chip.title = `Call ${name}`;
    chip.setAttribute("aria-label", `Call ${name}`);

    const dot = document.createElement("span");
    dot.className = "pdot";
    const label = document.createElement("span");
    label.textContent = name;
    const icon = document.createElement("span");
    icon.className = "call-ic";
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="2" y="4" width="14" height="12" rx="2"/><path d="m16 9 6-3v8l-6-3z"/></svg>';

    chip.appendChild(dot);
    chip.appendChild(label);
    chip.appendChild(icon);
    chip.addEventListener("click", () => startCall(id, name));
    onlineList.appendChild(chip);
  }
}

function connectCalls() {
  if (!supabase || !accessToken) return;
  if (callChannel) {
    try { callChannel.unsubscribe(); } catch (_) {}
    callChannel = null;
  }

  callChannel = supabase
    .channel("calls", { config: { private: true } })
    .on("presence", { event: "sync" }, () => refreshPresence())
    .on("broadcast", { event: "call-invite" },  ({ payload }) => handleCallInvite(payload))
    .on("broadcast", { event: "call-accept" },  ({ payload }) => handleCallAccept(payload))
    .on("broadcast", { event: "call-decline" }, ({ payload }) => handleCallDecline(payload))
    .on("broadcast", { event: "call-busy" },   ({ payload }) => handleCallBusy(payload))
    .on("broadcast", { event: "call-cancel" },  ({ payload }) => handleCallCancel(payload))
    .on("broadcast", { event: "call-end" },    ({ payload }) => handleCallEnd(payload))
    .on("broadcast", { event: "call-error" },  ({ payload }) => handleCallError(payload))
    .on("broadcast", { event: "call-offer" },  ({ payload }) => handleCallOffer(payload))
    .on("broadcast", { event: "call-answer" }, ({ payload }) => handleCallAnswer(payload))
    .on("broadcast", { event: "call-ice" },    ({ payload }) => handleCallIce(payload))
    .subscribe(async (status) => {
      if (status === "CHANNEL_ERROR") console.error("Calls channel error.");
      if (status === "CLOSED") console.warn("Calls channel closed.");
      if (status === "SUBSCRIBED") {
        try {
          await callChannel.track({ id: currentUserId, name: currentUser || "user" });
        } catch (_) {}
        renderOnlineUsers();
      }
    });
}

function refreshPresence() {
  renderOnlineUsers();
  // If the person you're talking to (or ringing) disconnected, hang up.
  if (inCall() && callPeerId && !currentPresencePeers().has(callPeerId)) {
    showToast(`${callPeerName} went offline.`);
    teardownCall();
  }
}

// ── Local media ──────────────────────────────────────────────
async function getLocalStream(withVideo) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  } catch (err) {
    console.error("getUserMedia failed:", err);
    showToast(withVideo
      ? "Camera / microphone permission was denied."
      : "Microphone permission was denied.");
    return null;
  }
}

function attachLocalVideo() {
  if (localStream) callLocalVideo.srcObject = localStream;
  micEnabled = true;
  camEnabled = true;
  muteBtn.classList.remove("active-toggle");
  camBtn.classList.remove("active-toggle");
}

// ── Outgoing call ────────────────────────────────────────────
async function startCall(peerId, peerName) {
  if (inCall()) { showToast("You're already in a call."); return; }
  if (recorder) { showToast("Stop the voice note before calling."); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
      typeof RTCPeerConnection === "undefined") {
    showToast("Calls aren't supported in this browser.");
    return;
  }

  // Claim the call slot BEFORE awaiting the permission prompt. getUserMedia
  // yields across a real user gesture, so with the state set afterwards two fast
  // clicks both passed the inCall() guard: the second overwrote localStream
  // without stopping the first, leaving that camera live with no UI to end it.
  callPeerId   = peerId;
  callPeerName = peerName;
  callState    = "outgoing";

  const stream = await getLocalStream(true);
  if (!stream) {
    callState = "idle";
    callPeerId = null;
    callPeerName = null;
    return;
  }
  localStream  = stream;

  sendCallSignal("call-invite", {
    to: peerId,
    fromUser: { id: currentUserId, name: currentUser },
    mode: "video"
  });

  showActiveCall(peerName, "Ringing…");
  attachLocalVideo();
  callLogEvent("call_started", { direction: "outbound", mode: "video" });

  ringTimer = setTimeout(() => {
    showToast(`${peerName} didn't answer.`);
    endCall({ internal: true });
  }, CALL_TIMEOUT);
}

// ── Incoming call ────────────────────────────────────────────
function handleCallInvite(payload) {
  if (!payload || payload.to !== currentUserId || !payload.fromUser) return;
  if (inCall()) {
    sendCallSignal("call-busy", { to: payload.fromUser.id });
    return;
  }
  callPeerId = payload.fromUser.id;
  callPeerName = String(payload.fromUser.name || "user").slice(0, 40);
  callState = "incoming";
  incomingName.textContent = callPeerName;
  incomingAvatar.textContent = (callPeerName.trim()[0] || "?").toUpperCase();
  incomingCall.classList.remove("hidden-call");
  callLogEvent("call_received", { mode: payload.mode || "video" });
  startRing();

  ringTimer = setTimeout(() => {
    if (callState !== "incoming") return;
    stopRing();
    incomingCall.classList.add("hidden-call");
    callState = "idle";
    callPeerId = null;
    callPeerName = null;
    showToast("Missed call.");
  }, CALL_TIMEOUT);
}

async function acceptCall() {
  if (callState !== "incoming") return;
  stopRing();
  clearTimeout(ringTimer);
  ringTimer = null;
  incomingCall.classList.add("hidden-call");

  const stream = await getLocalStream(true);
  if (!stream) {
    // No media permission → let the caller know instead of hanging.
    sendCallSignal("call-error", { to: callPeerId });
    callState = "idle";
    callPeerId = null;
    callPeerName = null;
    return;
  }

  sendCallSignal("call-accept", { to: callPeerId });
  callState = "connecting";
  localStream = stream;
  showActiveCall(callPeerName, "Connecting…");
  attachLocalVideo();
  createPeerConnection();
}

function declineCall() {
  if (callState !== "incoming") return;
  stopRing();
  clearTimeout(ringTimer);
  ringTimer = null;
  sendCallSignal("call-decline", { to: callPeerId });
  incomingCall.classList.add("hidden-call");
  callState = "idle";
  callPeerId = null;
  callPeerName = null;
  renderOnlineUsers();
}

// ── Peer connection ──────────────────────────────────────────
function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: CALL_ICE });
  pc.onicecandidate = (e) => {
    if (e.candidate && callChannel && callPeerId) {
      sendCallSignal("call-ice", { to: callPeerId, candidate: e.candidate.toJSON() });
    }
  };
  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) {
      remoteStream = e.streams[0];
      callRemoteVideo.srcObject = remoteStream;
      callFallback.classList.add("hidden");
      if (callState !== "active") { callState = "active"; startCallTimer(); }
    }
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if ((st === "failed" || st === "closed") && inCall()) {
      showToast("The call dropped.");
      teardownCall();
    }
  };
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }
  pendingIce = [];
}

function flushPendingIce() {
  while (pendingIce.length) {
    const c = pendingIce.shift();
    if (pc) pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }
}

function handleCallAccept(payload) {
  if (!payload || payload.to !== currentUserId) return;
  if (callState !== "outgoing") return;
  clearTimeout(ringTimer);
  ringTimer = null;
  callState = "connecting";
  setCallStateLabel("Connecting…");
  createPeerConnection();
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => sendCallSignal("call-offer", { to: callPeerId, sdp: pc.localDescription }))
    .catch((err) => {
      console.error("createOffer failed:", err);
      teardownCall();
    });
}

async function handleCallOffer(payload) {
  if (!payload || payload.to !== currentUserId || !pc || !payload.sdp) return;
  // A second tab answered on our behalf — quietly stop ringing here.
  if (callState === "incoming") {
    stopRing();
    clearTimeout(ringTimer);
    ringTimer = null;
    incomingCall.classList.add("hidden-call");
    callState = "idle";
    callPeerId = null;
    callPeerName = null;
    return;
  }
  if (callState !== "connecting") return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    flushPendingIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendCallSignal("call-answer", { to: callPeerId, sdp: pc.localDescription });
  } catch (err) {
    console.error("Answer failed:", err);
    teardownCall();
  }
}

async function handleCallAnswer(payload) {
  if (!payload || payload.to !== currentUserId || !pc || !payload.sdp) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    flushPendingIce();
  } catch (err) {
    console.error("Remote answer failed:", err);
    teardownCall();
  }
}

async function handleCallIce(payload) {
  if (!payload || payload.to !== currentUserId || !payload.candidate || !pc) return;
  if (!pc.remoteDescription) { pendingIce.push(payload.candidate); return; }
  await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
}

// ── Call-terminating events ──────────────────────────────────
function handleCallDecline(payload) {
  if (!payload || payload.to !== currentUserId) return;
  if (callState !== "outgoing") return;
  clearTimeout(ringTimer);
  ringTimer = null;
  showToast(`${callPeerName} declined the call.`);
  teardownCall();
}

function handleCallBusy(payload) {
  if (!payload || payload.to !== currentUserId) return;
  if (callState !== "outgoing") return;
  clearTimeout(ringTimer);
  ringTimer = null;
  showToast(`${callPeerName} is already in a call.`);
  teardownCall();
}

function handleCallCancel(payload) {
  if (!payload || payload.to !== currentUserId) return;
  if (callState !== "incoming") return;
  stopRing();
  clearTimeout(ringTimer);
  ringTimer = null;
  incomingCall.classList.add("hidden-call");
  callState = "idle";
  callPeerId = null;
  callPeerName = null;
  showToast("The caller canceled.");
}

function handleCallEnd(payload) {
  if (!payload || payload.to !== currentUserId) return;
  if (!inCall()) return;
  showToast("The call ended.");
  teardownCall();
}

function handleCallError(payload) {
  if (!payload || payload.to !== currentUserId) return;
  if (callState !== "outgoing") return;
  clearTimeout(ringTimer);
  ringTimer = null;
  showToast(`${callPeerName} couldn't start the call.`);
  teardownCall();
}

// ── End / teardown ───────────────────────────────────────────
function endCall(opts = {}) {
  if (!inCall()) { teardownCall(); return; }
  const wasActive = callState === "active";
  if (!opts.internal && callPeerId && callChannel) {
    const ev = callState === "outgoing" ? "call-cancel"
      : callState === "incoming" ? "call-decline"
      : "call-end";
    sendCallSignal(ev, { to: callPeerId });
  }
  if (wasActive) {
    callLogEvent("call_ended", { duration_seconds: callSeconds });
  }
  teardownCall();
}

function teardownCall() {
  clearTimeout(ringTimer);
  ringTimer = null;
  stopRing();
  stopCallTimer();

  if (pc) {
    try {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    } catch (_) {}
    pc = null;
  }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (remoteStream) { remoteStream = null; }

  pendingIce = [];
  callSeconds = 0;
  callLocalVideo.srcObject = null;
  callRemoteVideo.srcObject = null;
  callFallback.classList.remove("hidden");
  callFallback.textContent = "Connecting…";

  incomingCall.classList.add("hidden-call");
  activeCall.classList.add("hidden-call");

  callState = "idle";
  callPeerId = null;
  callPeerName = null;
  renderOnlineUsers();
}

function callLogEvent(type, meta) {
  logEvent(type, { ...meta, peer_id: callPeerId, peer_name: callPeerName });
}

// ── Call controls (mute / camera / timer) ────────────────────
function toggleMute() {
  if (!localStream) return;
  const on = localStream.getAudioTracks().some(t => t.enabled);
  localStream.getAudioTracks().forEach(t => t.enabled = !on);
  micEnabled = !on;
  muteBtn.classList.toggle("active-toggle", !micEnabled);
}

function toggleCamera() {
  if (!localStream) return;
  const on = localStream.getVideoTracks().some(t => t.enabled);
  localStream.getVideoTracks().forEach(t => t.enabled = !on);
  camEnabled = !on;
  camBtn.classList.toggle("active-toggle", !camEnabled);
}

function showActiveCall(name, label) {
  callPeerNameEl.textContent = name;
  setCallStateLabel(label);
  activeCall.classList.remove("hidden-call");
}

function setCallStateLabel(text) {
  if (callStateEl) callStateEl.textContent = text;
}

function formatDuration(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function startCallTimer() {
  if (callTimer) return;
  callTimerStart = Date.now();
  tickCallTimer();
  callTimer = setInterval(tickCallTimer, 1000);
}

function tickCallTimer() {
  if (!callTimerStart) return;
  callSeconds = Math.floor((Date.now() - callTimerStart) / 1000);
  setCallStateLabel(formatDuration(callSeconds));
}

function stopCallTimer() {
  if (callTimer) { clearInterval(callTimer); callTimer = null; }
  callTimerStart = null;
}

// ── Ringtone (WebAudio, no asset file) ───────────────────────
function startRing() {
  if (ringPulseTimer || !window.AudioContext) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) {
    try {
      ringCtx = new Ctx();
      ringGain = ringCtx.createGain();
      ringGain.gain.value = 0;
      ringGain.connect(ringCtx.destination);
      ringOsc = ringCtx.createOscillator();
      ringOsc.type = "sine";
      ringOsc.frequency.value = 620;
      ringOsc.connect(ringGain);
      ringOsc.start();
    } catch (_) {}
  }
  let audible = false;
  ringPulseTimer = setInterval(() => {
    if (!ringCtx || !ringGain) return;
    audible = !audible;
    ringGain.gain.setTargetAtTime(audible ? 0.05 : 0, ringCtx.currentTime, 0.05);
  }, 450);
}

function stopRing() {
  // Only the pulse lives here. ringTimer is the call ringing/no-answer timeout
  // and is cleared explicitly by every state transition that ends the ringing.
  if (ringPulseTimer) { clearInterval(ringPulseTimer); ringPulseTimer = null; }
  if (ringOsc) { try { ringOsc.stop(); } catch (_) {} ringOsc = null; }
  if (ringCtx) { try { ringCtx.close(); } catch (_) {} ringCtx = null; ringGain = null; }
}

// ── Calls event listeners ────────────────────────────────────
acceptCallBtn.addEventListener("click", acceptCall);
declineCallBtn.addEventListener("click", declineCall);
muteBtn.addEventListener("click", toggleMute);
camBtn.addEventListener("click", toggleCamera);
hangupBtn.addEventListener("click", () => endCall());

window.addEventListener("pagehide", () => {
  if (inCall()) endCall({ internal: true });
});

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
